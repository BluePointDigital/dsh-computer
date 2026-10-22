/** Small, local-only Docker Engine transport. No CLI, credentials or mutation retries. */
import http from 'node:http'
import { Duplex, PassThrough, Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { isAbsolute } from 'node:path'

const MIN_API = 41, MAX_API = 47, DEFAULT_LIMIT = 8 * 1024 * 1024
const fullId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const apiMinor = value => typeof value === 'string' && /^1\.(\d+)$/.test(value) ? Number(value.slice(2)) : NaN
export class DockerError extends Error {
  constructor(message, { status, code = 'DOCKER_ERROR', cause } = {}) {
    super(message, { cause }); this.name = 'DockerError'; this.code = code
    if (status !== undefined) this.status = this.statusCode = status
  }
}
const invalid = message => new DockerError(message, { code: 'DOCKER_INVALID_ARGUMENT' })
const aborted = () => new DockerError('Docker request cancelled', { code: 'ABORT_ERR' })
function idPath(id) { if (!fullId(id)) throw invalid('A full Docker ID is required'); return encodeURIComponent(id) }
function number(value, fallback, max) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw invalid('Invalid Docker transport limit')
  return value
}
function withSignal(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(aborted())
  return new Promise((resolve, reject) => {
    const cancel = () => reject(aborted())
    signal.addEventListener('abort', cancel, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
  })
}

/** Decode Docker's stdcopy framing without retaining entire frames or splitting UTF-8. */
function decodedStream(source, { tty, maxBytes, channels = false }) {
  let header = Buffer.alloc(0), remaining = 0, channel = 1
  const decoders = [null, new StringDecoder('utf8'), new StringDecoder('utf8')]
  const rawDecoder = new StringDecoder('utf8')
  const output = new Transform({
    readableHighWaterMark: 64 * 1024,
    transform(chunk, _encoding, callback) {
      try {
        if (tty) { const text = rawDecoder.write(chunk); if (text) this.push(channels ? { channel: 1, text } : text); return callback() }
        let offset = 0
        while (offset < chunk.length) {
          if (!remaining) {
            const take = Math.min(8 - header.length, chunk.length - offset)
            header = Buffer.concat([header, chunk.subarray(offset, offset + take)]); offset += take
            if (header.length !== 8) break
            channel = header[0]; remaining = header.readUInt32BE(4)
            if (![1, 2].includes(channel) || header[1] || header[2] || header[3] || remaining > maxBytes) throw new DockerError('Invalid Docker stream framing', { code: 'DOCKER_PROTOCOL' })
            header = Buffer.alloc(0)
            if (!remaining) continue
          }
          const take = Math.min(remaining, chunk.length - offset)
          const text = decoders[channel].write(chunk.subarray(offset, offset + take))
          offset += take; remaining -= take
          if (text) this.push(channels ? { channel, text } : text)
        }
        callback()
      } catch (error) { callback(error) }
    },
    flush(callback) {
      if (!tty && (header.length || remaining)) return callback(new DockerError('Truncated Docker stream', { code: 'DOCKER_PROTOCOL' }))
      for (const index of tty ? [1] : [1, 2]) {
        const text = tty ? rawDecoder.end() : decoders[index].end()
        if (text) this.push(channels ? { channel: index, text } : text)
      }
      callback()
    },
    readableObjectMode: channels,
  })
  source.on('error', error => output.destroy(error))
  source.once('close', () => { if (!source.readableEnded && !output.destroyed) output.destroy(new DockerError('Docker stream disconnected', { code: 'DOCKER_CONNECTION' })) })
  output.once('close', () => source.destroy())
  source.pipe(output)
  return output
}

export class DockerEngine {
  constructor({ socketPath, env = process.env, timeout, maxBytes } = {}) {
    if (env.DOCKER_CONTEXT && env.DOCKER_CONTEXT !== 'default') throw invalid('Nondefault DOCKER_CONTEXT is not supported')
    if (['DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].some(key => env[key])) throw invalid('Docker TLS configuration is not supported; use a local Unix socket')
    if (env.DOCKER_HOST && !env.DOCKER_HOST.startsWith('unix://')) throw invalid('Only unix:// DOCKER_HOST endpoints are supported')
    this.socketPath = socketPath ?? (env.DOCKER_HOST ? env.DOCKER_HOST.slice(7) : '/var/run/docker.sock')
    if (typeof this.socketPath !== 'string' || !isAbsolute(this.socketPath) || /[\0\r\n]/.test(this.socketPath)) throw invalid('Invalid Docker Unix socket path')
    this.timeout = number(timeout, 10000, 24 * 60 * 60 * 1000)
    this.maxBytes = number(maxBytes, DEFAULT_LIMIT, DEFAULT_LIMIT)
    this.requestedVersion = env.DOCKER_API_VERSION || undefined
    if (this.requestedVersion && !Number.isInteger(apiMinor(this.requestedVersion))) throw invalid('Invalid DOCKER_API_VERSION')
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8 })
    this.pending = new Set(); this.streams = new Set(); this.closed = false
    this.execTty = new Map()
  }
  _transport(method, path, body, { signal, mode = 'json', timeout = this.timeout } = {}) {
    if (this.closed) return Promise.reject(new DockerError('Docker engine is closed', { code: 'DOCKER_CLOSED' }))
    if (signal?.aborted) return Promise.reject(aborted())
    if (!/^(GET|POST|DELETE|PUT|HEAD)$/.test(method) || typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\x00-\x20\x7f#]/.test(path)) return Promise.reject(invalid('Invalid Docker request'))
    let data
    try { data = body === undefined ? undefined : JSON.stringify(body) } catch { return Promise.reject(invalid('Invalid Docker JSON request')) }
    if (data && Buffer.byteLength(data) > this.maxBytes) return Promise.reject(invalid('Docker request exceeds size limit'))
    return new Promise((resolve, reject) => {
      let settled = false, activeStream
      const headers = data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
      if (mode === 'hijack') Object.assign(headers, { connection: 'Upgrade', upgrade: 'tcp' })
      const req = http.request({ socketPath: this.socketPath, agent: mode === 'hijack' ? false : this.agent, method, path, headers })
      this.pending.add(req)
      const timer = setTimeout(() => fail(new DockerError('Docker request timed out', { code: 'DOCKER_TIMEOUT' })), timeout)
      timer.unref?.()
      const cancel = () => fail(aborted())
      signal?.addEventListener('abort', cancel, { once: true })
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); this.pending.delete(req) }
      const fail = error => {
        if (!settled) { settled = true; cleanup(); reject(error) }
        activeStream?.destroy(error); req.destroy(error)
      }
      const adopt = stream => {
        activeStream = stream; settled = true; clearTimeout(timer)
        this.streams.add(stream)
        stream.once('close', () => { this.streams.delete(stream); cleanup() })
        // An aborted caller may not yet have attached its own listener.
        stream.on('error', () => {})
        resolve(stream)
      }
      req.on('error', error => fail(error instanceof DockerError ? error : new DockerError('Docker connection failed', { code: 'DOCKER_CONNECTION', cause: error })))
      req.once('upgrade', (res, socket, head) => {
        if (mode !== 'hijack' || res.statusCode !== 101) { socket.destroy(); return fail(new DockerError('Unexpected Docker upgrade', { code: 'DOCKER_PROTOCOL' })) }
        socket.setTimeout(0); socket.pause()
        if (head.length) socket.unshift(head)
        adopt(socket)
      })
      req.once('response', res => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.destroy(); return fail(new DockerError(`Docker request failed (HTTP ${res.statusCode})`, { status: res.statusCode, code: 'DOCKER_HTTP' }))
        }
        if (mode === 'hijack') {
          // Older daemons return a 200 raw TCP stream, without an HTTP Upgrade.
          // Detach Node's HTTP parser before handing the duplex socket to the caller.
          if (res.statusCode !== 200 || !/^application\/vnd\.docker\.(?:raw|multiplexed)-stream(?:;|$)/i.test(res.headers['content-type'] || '')) {
            res.destroy(); return fail(new DockerError('Invalid Docker exec handshake', { code: 'DOCKER_PROTOCOL' }))
          }
          const socket = res.socket
          socket.setTimeout(0)
          // Preserve IncomingMessage's already-buffered head and HTTP framing;
          // stdin still writes directly to the hijacked socket (not HTTP chunks).
          const duplex = Duplex.from({ readable: res, writable: socket })
          duplex.pause()
          adopt(duplex)
          return
        }
        if (mode === 'stream') { adopt(res); return }
        let bytes = 0; const chunks = []
        res.on('data', chunk => {
          bytes += chunk.length
          if (bytes > this.maxBytes) { res.destroy(); fail(new DockerError('Docker response exceeds size limit', { code: 'DOCKER_LIMIT' })) } else chunks.push(chunk)
        })
        res.on('error', error => fail(error instanceof DockerError ? error : new DockerError('Docker response interrupted', { code: 'DOCKER_CONNECTION' })))
        res.on('end', () => {
          if (settled) return
          try {
            const text = Buffer.concat(chunks).toString('utf8')
            const result = text ? JSON.parse(text) : {}
            settled = true; cleanup(); resolve(result)
          } catch { fail(new DockerError('Invalid Docker JSON response', { code: 'DOCKER_PROTOCOL' })) }
        })
      })
      req.end(data)
    })
  }
  version(options = {}) { return this._transport('GET', '/version', undefined, options) }
  async _ready(signal) {
    if (signal?.aborted) throw aborted()
    if (!this.negotiation) {
      const state = { controller: new AbortController(), waiters: 0, done: false }
      state.promise = this.version({ signal: state.controller.signal }).then(version => {
        const serverMax = apiMinor(version?.ApiVersion), serverMin = version?.MinAPIVersion === undefined ? MIN_API : apiMinor(version.MinAPIVersion)
        const low = Math.max(MIN_API, serverMin), high = Math.min(MAX_API, serverMax)
        if (!Number.isInteger(low) || !Number.isInteger(high) || low > high) throw new DockerError('Docker API versions do not overlap 1.41–1.47', { code: 'DOCKER_API_VERSION' })
        const selected = this.requestedVersion ? apiMinor(this.requestedVersion) : high
        if (selected < low || selected > high) throw new DockerError('DOCKER_API_VERSION is outside the supported daemon overlap', { code: 'DOCKER_API_VERSION' })
        return `1.${selected}`
      }).catch(error => { if (this.negotiation === state) this.negotiation = undefined; throw error }).finally(() => { state.done = true })
      this.negotiation = state
    }
    const state = this.negotiation
    state.waiters++
    try { return await withSignal(state.promise, signal) } finally {
      state.waiters--
      if (!state.done && !state.waiters) {
        // Shared negotiation continues only while someone is waiting for it.
        this.negotiation = undefined; state.controller.abort()
      }
    }
  }
  async request(method, path, body, options = {}) {
    const version = await this._ready(options.signal)
    return this._transport(method, `/v${version}${path}`, body, options)
  }
  listContainers(options = {}) { return this.request('GET', '/containers/json?all=1', undefined, options) }
  async inspectContainer(id, options = {}) {
    if (typeof id !== 'string' || !/^\/?[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(id)) throw invalid('Invalid Docker container ID or name')
    try {
      const info = await this.request('GET', `/containers/${encodeURIComponent(id)}/json`, undefined, options)
      if (!info || typeof info !== 'object' || Array.isArray(info)) throw new DockerError('Invalid Docker inspect response', { code: 'DOCKER_PROTOCOL' })
      return info
    } catch (error) { if (error instanceof DockerError && error.status === 404) return null; throw error }
  }
  async start(id, options = {}) { try { return await this.request('POST', `/containers/${idPath(id)}/start`, undefined, options) } catch (error) { if (error.status === 304) return {}; throw error } }
  async stop(id, options = {}) { try { return await this.request('POST', `/containers/${idPath(id)}/stop`, undefined, options) } catch (error) { if (error.status === 304) return {}; throw error } }
  restart(id, options = {}) { return this.request('POST', `/containers/${idPath(id)}/restart`, undefined, options) }
  remove(id, { volumes = false, force = false, ...options } = {}) {
    if (typeof volumes !== 'boolean' || typeof force !== 'boolean') throw invalid('Docker removal options must be explicitly boolean')
    return this.request('DELETE', `/containers/${idPath(id)}?v=${volumes ? 1 : 0}${force ? '&force=1' : ''}`, undefined, options)
  }
  removeVolume(name, options = {}) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(name)) throw invalid('Invalid Docker volume name')
    return this.request('DELETE', `/volumes/${encodeURIComponent(name)}`, undefined, options)
  }
  stats(id, options = {}) { return this.request('GET', `/containers/${idPath(id)}/stats?stream=false`, undefined, options) }
  async logs(id, { follow = false, tail = 300, timestamps = false, signal, tty } = {}) {
    const container = idPath(id)
    if (!(tail === 'all' || Number.isInteger(tail) && tail >= 0 && tail <= 100000)) throw invalid('Invalid Docker log tail')
    if (tty === undefined) {
      const info = await this.inspectContainer(id, { signal })
      if (!info) throw new DockerError('Docker request failed (HTTP 404)', { status: 404, code: 'DOCKER_HTTP' })
      tty = info.Config?.Tty === true
    }
    const source = await this.request('GET', `/containers/${container}/logs?stdout=1&stderr=1&follow=${follow ? 1 : 0}&tail=${tail}&timestamps=${timestamps ? 1 : 0}`, undefined, { signal, mode: 'stream' })
    const decoded = decodedStream(source, { tty, maxBytes: this.maxBytes })
    const output = new PassThrough({ highWaterMark: 64 * 1024 })
    output.setEncoding('utf8')
    decoded.on('error', error => output.destroy(error)); output.once('close', () => decoded.destroy())
    decoded.pipe(output)
    return output
  }
  async execCreate(id, body, options = {}) {
    const result = await this.request('POST', `/containers/${idPath(id)}/exec`, body, options)
    if (!fullId(result?.Id)) throw new DockerError('Invalid Docker exec ID', { code: 'DOCKER_PROTOCOL' })
    this.execTty.set(result.Id, body?.Tty === true)
    // Only handshake metadata is cached; never retain command/env bodies.
    if (this.execTty.size > 1024) this.execTty.delete(this.execTty.keys().next().value)
    return result
  }
  execStart(execId, options = {}) {
    return this.request('POST', `/exec/${idPath(execId)}/start`, { Detach: false, Tty: this.execTty.get(execId) ?? true }, { ...options, mode: 'hijack' })
  }
  execResize(id, cols, rows, options = {}) {
    if (!Number.isInteger(cols) || cols < 1 || cols > 1000 || !Number.isInteger(rows) || rows < 1 || rows > 1000) throw invalid('Invalid Docker terminal dimensions')
    return this.request('POST', `/exec/${idPath(id)}/resize?w=${cols}&h=${rows}`, undefined, options)
  }
  async exec(id, cmd, { signal, timeout = this.timeout } = {}) {
    idPath(id)
    if (!Array.isArray(cmd) || !cmd.length || cmd.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw invalid('Invalid Docker exec command')
    number(timeout, this.timeout, 24 * 60 * 60 * 1000)
    const controller = new AbortController(), cancel = () => controller.abort()
    if (signal?.aborted) controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    let expired = false, raw, decoded, execId
    const timer = setTimeout(() => { expired = true; controller.abort() }, timeout); timer.unref?.()
    try {
      const created = await this.execCreate(id, { AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false, Cmd: cmd }, { signal: controller.signal })
      execId = created.Id
      raw = await this.execStart(execId, { signal: controller.signal })
      decoded = decodedStream(raw, { tty: false, maxBytes: this.maxBytes, channels: true })
      let stdout = '', stderr = '', size = 0
      for await (const { channel, text } of decoded) {
        size += Buffer.byteLength(text)
        if (size > this.maxBytes) throw new DockerError('Docker exec output exceeds size limit', { code: 'DOCKER_LIMIT' })
        if (channel === 1) stdout += text; else stderr += text
      }
      const info = await this.request('GET', `/exec/${execId}/json`, undefined, { signal: controller.signal })
      if (info.Running || !Number.isInteger(info.ExitCode)) throw new DockerError('Docker exec has no exit status', { code: 'DOCKER_PROTOCOL' })
      return { code: info.ExitCode, stdout, stderr }
    } catch (error) {
      if (expired) throw new DockerError('Docker exec timed out', { code: 'DOCKER_TIMEOUT' })
      throw error
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel); raw?.destroy(); decoded?.destroy(); if (execId) this.execTty.delete(execId)
    }
  }
  close() {
    if (this.closed) return
    this.closed = true
    for (const req of this.pending) req.destroy(new DockerError('Docker engine is closed', { code: 'DOCKER_CLOSED' }))
    for (const stream of this.streams) stream.destroy(new DockerError('Docker engine is closed', { code: 'DOCKER_CLOSED' }))
    this.pending.clear(); this.streams.clear(); this.execTty.clear(); this.agent.destroy()
  }
}
export default DockerEngine
