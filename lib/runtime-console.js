/** Authenticated application logs and genuine Docker exec TTY sessions. */
import { WebSocketServer, WebSocket } from 'ws'
import { StringDecoder } from 'node:string_decoder'
import { DockerEngine } from './docker-engine.js'

export class RuntimeConsole {
  constructor({ inventory, known = async () => [], engine, api } = {}) {
    this.inventory = inventory; this.known = known
    this.engine = engine ?? new DockerEngine()
    // Retain the old JSON-injection seam for consumers testing exec-create/resize.
    this.api = api ?? this.engine.request?.bind(this.engine)
    this.customApi = Boolean(api)
    this.sessions = new Set(); this.streams = new Set(); this.controllers = new Set(); this.closed = false
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false })
  }
  async logs(req, res, url) {
    if (this.closed || req.destroyed || res.destroyed) return
    const controller = new AbortController()
    this.controllers.add(controller)
    let stream, keepalive, stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true; clearInterval(keepalive); controller.abort(); stream?.destroy()
      this.streams.delete(stream); this.controllers.delete(controller)
      res.off('drain', drain); res.off('close', stop)
    }
    const drain = () => stream?.resume()
    controller.signal.addEventListener('abort', () => {
      if (!stopped) { res.destroy?.(); stop() }
    }, { once: true })
    res.once('close', stop)
    try {
      const { containerId, info } = await this.inventory.resolve(url.searchParams.get('id'), url.searchParams.get('container') || undefined, await this.known())
      if (stopped || this.closed || req.destroyed || res.destroyed) return stop()
      const download = url.searchParams.get('download') === '1'
      const tail = Math.max(1, Math.min(5000, Math.trunc(Number(url.searchParams.get('tail')) || 300)))
      stream = await this.engine.logs(containerId, { follow: !download, timestamps: true, tail, signal: controller.signal, tty: info?.Config?.Tty })
      // Log setup can complete after the browser has already gone away.
      stream.on('error', () => {})
      if (stopped || this.closed || res.destroyed) { stream.destroy(); return stop() }
      this.streams.add(stream)
      res.writeHead(200, { 'content-type': download ? 'text/plain; charset=utf-8' : 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', ...(download ? { 'content-disposition': 'attachment; filename="application-logs.txt"' } : {}) })
      res.on('drain', drain)
      stream.on('data', text => {
        if (res.destroyed) return stop()
        const data = typeof text === 'string' ? text : text.toString('utf8')
        if (!res.write(download ? data : `data: ${JSON.stringify({ text: data })}\n\n`)) stream.pause()
      })
      stream.once('error', () => {
        if (!res.destroyed && !stopped) {
          res.write(download ? 'Log stream unavailable.' : `data: ${JSON.stringify({ text: 'Log stream unavailable.' })}\n\n`)
          res.end()
        }
        stop()
      })
      stream.once('end', () => {
        if (!res.destroyed && !stopped) {
          if (!download) res.write(`event: complete\ndata: ${JSON.stringify({ code: 0 })}\n\n`)
          res.end()
        }
        stop()
      })
      keepalive = download ? null : setInterval(() => {
        // Do not queue heartbeats behind a slow client's buffered log data.
        if (!res.destroyed && !res.writableNeedDrain && !res.write(': heartbeat\n\n')) stream.pause()
      }, 15000).unref()
    } catch (error) { const cancelled = stopped || controller.signal.aborted; stop(); if (!cancelled) throw error }
  }
  async upgrade(req, socket, head, url) {
    const selected = await this.inventory.resolve(url.searchParams.get('id'), url.searchParams.get('container') || undefined, await this.known())
    if (!selected.info.State?.Running) throw Error('Start the service before opening a terminal')
    if (this.closed || socket.destroyed) return socket.destroy()
    const shell = url.searchParams.get('shell') === '/bin/bash' ? '/bin/bash' : '/bin/sh'
    this.wss.handleUpgrade(req, socket, head, ws => { void this.terminal(ws, selected.containerId, shell) })
  }
  async terminal(ws, containerId, shell) {
    if (this.closed || ws.readyState !== WebSocket.OPEN) { ws.close(); return }
    this.sessions.add(ws)
    let upstream, execId, ending = false
    const controller = new AbortController()
    this.controllers.add(controller)
    const decoder = new StringDecoder('utf8')
    const end = () => {
      if (ending) return
      ending = true; controller.abort(); upstream?.destroy()
      this.sessions.delete(ws); this.controllers.delete(controller)
    }
    ws.once('close', end); ws.on('error', end)
    const send = payload => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)) }
    try {
      const body = { AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Cmd: [shell], Env: ['TERM=xterm-256color'] }
      const created = this.customApi
        ? await this.api('POST', `/containers/${containerId}/exec`, body, { signal: controller.signal })
        : await this.engine.execCreate(containerId, body, { signal: controller.signal })
      execId = created.Id
      if (!/^[a-f0-9]{64}$/.test(execId ?? '')) throw Error('Docker did not create a terminal')
      if (this.closed || ws.readyState !== WebSocket.OPEN) return end()
      upstream = await this.engine.execStart(execId, { signal: controller.signal })
      upstream.on('error', () => { if (!ending) ws.close(1011, 'Terminal disconnected'); end() })
      if (this.closed || ws.readyState !== WebSocket.OPEN) return end()
      const receive = raw => {
        try {
          const message = JSON.parse(raw.toString())
          if (message.type === 'input' && typeof message.data === 'string' && Buffer.byteLength(message.data) <= 32768) {
            // A blocked Docker stdin must not turn WS input into an unbounded queue.
            if (upstream.writableLength + Buffer.byteLength(message.data) > 1024 * 1024) { ws.close(1013, 'Terminal input is too fast'); return end() }
            upstream.write(message.data)
          } else if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols >= 10 && message.cols <= 500 && message.rows >= 2 && message.rows <= 200) {
            // Coalesce bursts of browser resizes to at most one request in flight.
            requestedSize = [message.cols, message.rows]; void resize()
          } else { ws.close(1008, 'Invalid terminal message'); end() }
        } catch { ws.close(1008, 'Invalid terminal message'); end() }
      }
      let requestedSize, resizing = false
      const resize = async () => {
        if (resizing) return
        resizing = true
        try {
          while (requestedSize && !ending) {
            const [cols, rows] = requestedSize; requestedSize = undefined
            if (this.customApi) await this.api('POST', `/exec/${execId}/resize?w=${cols}&h=${rows}`, undefined, { signal: controller.signal })
            else await this.engine.execResize(execId, cols, rows, { signal: controller.signal })
          }
        } catch { /* A closing shell can race a final browser resize. */ } finally { resizing = false }
      }
      upstream.on('data', data => {
        if (ws.bufferedAmount > 1024 * 1024) { ws.close(1013, 'Terminal client is too slow'); return end() }
        const text = decoder.write(data)
        if (text) send({ type: 'output', data: text })
      })
      upstream.once('end', () => { const text = decoder.end(); if (text) send({ type: 'output', data: text }); ws.close(1000, 'Shell exited'); end() })
      upstream.once('close', () => { if (!ending) ws.close(1000, 'Shell exited'); end() })
      ws.on('message', receive)
      ws.once('close', () => ws.off('message', receive))
      send({ type: 'ready' })
      upstream.resume()
    } catch (error) {
      // Transport messages are deliberately sanitized; never forward daemon bodies.
      if (!ending) { send({ type: 'error', message: error.message }); ws.close(1011, 'Terminal unavailable') }
      end()
    }
  }
  close() {
    if (this.closed) return
    this.closed = true
    for (const controller of this.controllers) controller.abort()
    for (const stream of this.streams) stream.destroy()
    for (const ws of this.sessions) ws.terminate()
    this.streams.clear(); this.sessions.clear(); this.controllers.clear(); this.wss.close()
    this.engine.close()
  }
}
