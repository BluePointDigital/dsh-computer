/** Authenticated application logs and genuine Docker exec TTY sessions. */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { WebSocketServer, WebSocket } from 'ws'
import { StringDecoder } from 'node:string_decoder'

const socketPath = () => {
  const host = process.env.DOCKER_HOST
  if (host && !host.startsWith('unix://')) throw Error('Terminal currently requires a local Unix Docker endpoint')
  return host ? host.slice(7) : '/var/run/docker.sock'
}
function dockerRequest(method, pathname, body, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request({ socketPath: socketPath(), path: pathname, method, signal, timeout: 10000, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, res => {
      let text = ''; res.on('data', b => { text += b }); res.on('end', () => {
        if (res.statusCode >= 300) return reject(Error(`Docker terminal request failed (${res.statusCode})`))
        try { resolve(text ? JSON.parse(text) : {}) } catch { reject(Error('Invalid Docker terminal response')) }
      })
    }); req.once('timeout', () => req.destroy(Error('Docker terminal request timed out'))); req.on('error', reject); req.end(data)
  })
}
export class RuntimeConsole {
  constructor({ inventory, known = async () => [], spawnProcess = spawn, api = dockerRequest } = {}) {
    Object.assign(this, { inventory, known, spawnProcess, api })
    this.sessions = new Set(); this.streams = new Set(); this.closed = false
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false })
  }
  async logs(req, res, url) {
    const { containerId } = await this.inventory.resolve(url.searchParams.get('id'), url.searchParams.get('container') || undefined, await this.known())
    if (this.closed || req.destroyed || res.destroyed) return
    const download = url.searchParams.get('download') === '1'
    const tail = Math.max(1, Math.min(5000, Number(url.searchParams.get('tail')) || 300))
    const child = this.spawnProcess('docker', ['logs', ...(download ? [] : ['--follow']), '--timestamps', '--tail', String(tail), containerId], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.streams.add(child)
    res.writeHead(200, { 'content-type': download ? 'text/plain; charset=utf-8' : 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', ...(download ? { 'content-disposition': 'attachment; filename="application-logs.txt"' } : {}) })
    const send = text => { if (!res.destroyed) res.write(download ? text : `data: ${JSON.stringify({ text })}\n\n`) }
    const onData = data => { const ready = res.write(download ? data : `data: ${JSON.stringify({ text: data.toString('utf8') })}\n\n`); if (!ready) { child.stdout.pause(); child.stderr.pause() } }
    res.on('drain', () => { child.stdout.resume(); child.stderr.resume() })
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', onData); child.stderr.on('data', onData)
    const keepalive = download ? null : setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n') }, 15000).unref()
    const stop = () => { clearInterval(keepalive); child.kill(); this.streams.delete(child) }
    res.once('close', stop)
    child.once('error', () => { send('Log stream unavailable.'); res.end(); stop() })
    child.once('close', code => { if (!download && !res.destroyed) res.write(`event: complete\ndata: ${JSON.stringify({ code })}\n\n`); res.end(); stop() })
  }
  async upgrade(req, socket, head, url) {
    const selected = await this.inventory.resolve(url.searchParams.get('id'), url.searchParams.get('container') || undefined, await this.known())
    if (!selected.info.State?.Running) throw Error('Start the service before opening a terminal')
    if (this.closed || socket.destroyed) return socket.destroy()
    const shell = url.searchParams.get('shell') === '/bin/bash' ? '/bin/bash' : '/bin/sh'
    this.wss.handleUpgrade(req, socket, head, ws => { void this.terminal(ws, selected.containerId, shell) })
  }
  async terminal(ws, containerId, shell) {
    this.sessions.add(ws)
    let upstream, pending, execId
    const controller = new AbortController()
    const decoder = new StringDecoder('utf8')
    const end = () => { controller.abort(); pending?.destroy(); upstream?.destroy(); this.sessions.delete(ws) }
    ws.once('close', end); ws.on('error', end)
    const send = payload => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)) }
    try {
      const created = await this.api('POST', `/containers/${containerId}/exec`, { AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Cmd: [shell], Env: ['TERM=xterm-256color'] }, { signal: controller.signal })
      execId = created.Id
      if (!/^[a-f0-9]{64}$/.test(execId ?? '')) throw Error('Docker did not create a terminal')
      if (this.closed || ws.readyState !== WebSocket.OPEN) return end()
      await new Promise((resolve, reject) => {
        const body = JSON.stringify({ Detach: false, Tty: true })
        pending = http.request({ socketPath: socketPath(), method: 'POST', path: `/exec/${execId}/start`, signal: controller.signal, timeout: 10000, headers: { connection: 'Upgrade', upgrade: 'tcp', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } })
        pending.once('timeout', () => pending.destroy(Error('Docker terminal handshake timed out')))
        pending.once('error', reject)
        pending.once('response', res => { res.resume(); reject(Error('Docker terminal upgrade failed')) })
        pending.once('upgrade', (_response, stream, initial) => {
          upstream = stream
          stream.setTimeout(0)
          if (ws.readyState !== WebSocket.OPEN) { stream.destroy(); resolve(); return }
          if (initial.length) send({ type: 'output', data: decoder.write(initial) })
          stream.on('data', data => {
            if (ws.bufferedAmount > 1024 * 1024) return ws.close(1013, 'Terminal client is too slow')
            send({ type: 'output', data: decoder.write(data) })
          })
          stream.on('error', () => ws.close(1011, 'Terminal disconnected'))
          stream.on('end', () => { const remaining = decoder.end(); if (remaining) send({ type: 'output', data: remaining }); ws.close(1000, 'Shell exited') })
          stream.on('close', () => ws.close(1000, 'Shell exited'))
          ws.on('message', raw => {
            try {
              const message = JSON.parse(raw.toString())
              if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 32768) stream.write(message.data)
              else if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols >= 10 && message.cols <= 500 && message.rows >= 2 && message.rows <= 200) void this.api('POST', `/exec/${execId}/resize?w=${message.cols}&h=${message.rows}`, undefined, { signal: controller.signal }).catch(() => {})
            } catch { ws.close(1008, 'Invalid terminal message') }
          })
          send({ type: 'ready' }); resolve()
        })
        pending.end(body)
      })
    } catch (error) { send({ type: 'error', message: error.message }); ws.close(1011, 'Terminal unavailable'); end() }
  }
  close() {
    this.closed = true
    for (const child of this.streams) child.kill()
    for (const ws of this.sessions) ws.terminate()
    this.streams.clear(); this.sessions.clear(); this.wss.close()
  }
}
