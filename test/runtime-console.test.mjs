import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { WebSocket } from 'ws'
import { RuntimeConsole } from '../lib/runtime-console.js'
import { DockerEngine } from '../lib/docker-engine.js'
const CID = 'a'.repeat(64), EID = 'b'.repeat(64)
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const frame = (channel, text) => { const data = Buffer.from(text), header = Buffer.alloc(8); header[0] = channel; header.writeUInt32BE(data.length, 4); return Buffer.concat([header, data]) }
const json = (res, value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))

async function fixture(t, handler) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-console-')), socketPath = path.join(root, 'docker.sock')
  const sockets = new Set(), calls = []
  const daemon = http.createServer((req, res) => {
    let text = ''; req.on('data', b => { text += b }); req.on('end', () => {
      const body = text ? JSON.parse(text) : undefined
      calls.push({ path: req.url, body })
      if (req.url === '/version') return json(res, { ApiVersion: '1.47', MinAPIVersion: '1.41' })
      handler(req, res, body)
    })
  })
  daemon.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise(resolve => daemon.listen(socketPath, resolve))
  const inventory = { resolve: async () => ({ containerId: CID, info: { State: { Running: true }, Config: { Tty: false } } }) }
  const engine = new DockerEngine({ socketPath, env: {} }), console = new RuntimeConsole({ inventory, engine })
  const front = http.createServer((req, res) => console.logs(req, res, new URL(req.url, 'http://control.test')).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() }))
  front.on('upgrade', (req, socket, head) => console.upgrade(req, socket, head, new URL(req.url, 'http://control.test')).catch(() => socket.destroy()))
  const port = await listen(front)
  t.after(async () => {
    console.close(); for (const socket of sockets) socket.destroy()
    front.closeAllConnections(); await new Promise(resolve => front.close(resolve)); await new Promise(resolve => daemon.close(resolve))
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'dsh-console-'))); await fs.rm(root, { recursive: true, force: true })
  })
  return { console, engine, inventory, front, port, daemon, calls }
}
function message(ws, type) { return new Promise(resolve => { const receive = raw => { const msg = JSON.parse(raw); if (msg.type === type) { ws.off('message', receive); resolve(msg) } }; ws.on('message', receive) }) }

test('real WS frontend creates genuine TTY exec, relays UTF8 input/output, resizes and closes upstream', { timeout: 5000 }, async t => {
  let resized
  const sizeReady = new Promise(resolve => { resized = resolve })
  const f = await fixture(t, (req, res, body) => {
    if (req.url.endsWith('/exec')) return json(res, { Id: EID })
    if (req.url.includes('/resize')) { resized(body); return res.writeHead(201).end() }
    assert.fail(req.url)
  })
  let upstream, socketClosed
  const ended = new Promise(resolve => { socketClosed = resolve })
  f.daemon.on('upgrade', (req, socket) => {
    assert.equal(req.url, `/v1.47/exec/${EID}/start`)
    upstream = socket; socket.once('end', () => { socket.end(); socketClosed() })
    socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n')
    socket.on('data', b => {
      const euro = Buffer.from('€')
      socket.write(euro.subarray(0, 1)); socket.write(euro.subarray(1)); socket.write('echo:' + b.toString())
    })
  })
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/apps/terminal?id=demo&container=${CID}`)
  await message(ws, 'ready')
  let output = ''
  const received = new Promise(resolve => ws.on('message', raw => { const msg = JSON.parse(raw); if (msg.type === 'output') { output += msg.data; if (output.includes('hello\r')) resolve() } }))
  ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 })); ws.send(JSON.stringify({ type: 'input', data: 'hello\r' }))
  await received; await sizeReady
  assert.equal(output, '€echo:hello\r')
  const create = f.calls.find(c => c.path.endsWith('/exec'))
  assert.equal(create.body.Tty, true); assert.equal(create.body.AttachStdin, true); assert.deepEqual(create.body.Cmd, ['/bin/sh'])
  assert.ok(f.calls.some(c => c.path === `/v1.47/exec/${EID}/resize?w=100&h=30`))
  const closed = once(ws, 'close'); f.console.close(); await closed; await ended
  assert.equal(f.console.sessions.size, 0); assert.equal(f.console.controllers.size, 0)
  assert.ok(upstream)
})

test('disconnect during exec creation aborts pending request and closes tracked session (legacy api injection)', async () => {
  const ws = new EventEmitter(); ws.readyState = WebSocket.OPEN; ws.close = () => { ws.readyState = WebSocket.CLOSED; ws.emit('close') }
  let started
  const creating = new Promise(resolve => { started = resolve })
  const console = new RuntimeConsole({ inventory: {}, api: async (_method, _path, _body, options) => {
    started()
    await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }))
  } })
  const task = console.terminal(ws, CID, '/bin/sh')
  await creating; ws.close(); await task
  assert.equal(console.sessions.size, 0); assert.equal(console.controllers.size, 0)
  console.close()
})

test('WS disconnect aborts real pending exec handshake', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_req, res) => json(res, { Id: EID }))
  let handshake
  const started = new Promise(resolve => { handshake = resolve })
  let cancelled
  const done = new Promise(resolve => { cancelled = resolve })
  f.daemon.on('upgrade', (_req, socket) => { socket.once('end', () => { socket.end(); cancelled() }); handshake() })
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/terminal?id=demo`)
  await started; ws.close(); await once(ws, 'close'); await done
  assert.equal(f.console.sessions.size, 0)
})

test('logs use framed Engine stream, SSE preserves UTF8 and disconnect cancels follower; download is finite', { timeout: 5000 }, async t => {
  let following, followClosed
  const ended = new Promise(resolve => { followClosed = resolve })
  const f = await fixture(t, (req, res) => {
    assert.ok(req.url.includes(`/containers/${CID}/logs?`)); assert.ok(req.url.includes('timestamps=1'))
    res.writeHead(200, { 'content-type': 'application/vnd.docker.raw-stream' })
    if (req.url.includes('follow=1')) {
      following = true; res.once('close', followClosed)
      const euro = Buffer.from('€')
      res.write(frame(1, euro.subarray(0, 1))); res.write(frame(2, 'error\n')); res.write(frame(1, euro.subarray(1))); res.write(frame(1, 'hello\n'))
    } else res.end(frame(2, 'error line\n'))
  })
  await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${f.port}/logs?id=demo`, res => {
    assert.match(res.headers['content-type'], /text\/event-stream/)
    let output = ''
    res.on('data', chunk => {
      output += chunk.toString()
      if (!output.includes('hello')) return
      assert.ok(output.includes('€')); assert.ok(output.includes('error')); assert.ok(!output.includes('�'))
      res.destroy(); resolve()
    })
  }).on('error', reject))
  await ended; assert.equal(following, true)
  const result = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${f.port}/logs?id=demo&download=1`, res => {
    let text = ''; res.on('data', b => { text += b }); res.on('end', () => resolve({ text, disposition: res.headers['content-disposition'] }))
  }).on('error', reject))
  assert.equal(result.text, 'error line\n'); assert.match(result.disposition, /attachment/)
  assert.equal(f.console.streams.size, 0)
})

test('log disconnect during setup aborts pending Engine request', { timeout: 5000 }, async t => {
  let entered, cancelled
  const started = new Promise(resolve => { entered = resolve }), stopped = new Promise(resolve => { cancelled = resolve })
  const f = await fixture(t, (req, res) => { res.once('close', cancelled); entered() })
  const req = http.get(`http://127.0.0.1:${f.port}/logs?id=demo`); req.on('error', () => {})
  await started; req.destroy(); await stopped
  assert.equal(f.console.controllers.size, 0)
})

test('log finite stream signals completion; malformed framing yields safe error', { timeout: 5000 }, async t => {
  let invalid = false
  const f = await fixture(t, (_req, res) => res.end(invalid ? Buffer.from([1, 0]) : frame(1, 'done')))
  const get = () => new Promise((resolve, reject) => http.get(`http://127.0.0.1:${f.port}/logs?id=demo`, res => {
    let text = ''; res.on('data', b => { text += b }); res.on('end', () => resolve(text))
  }).on('error', reject))
  const output = await get(); assert.match(output, /event: complete/); assert.match(output, /done/)
  invalid = true; assert.match(await get(), /Log stream unavailable/)
})

test('log backpressure pauses injected Engine stream and disposal aborts it', async t => {
  const upstream = new PassThrough(); upstream.setEncoding('utf8')
  let aborted = false
  const console = new RuntimeConsole({ inventory: { resolve: async () => ({ containerId: CID, info: { Config: { Tty: false } } }) }, engine: {
    logs: async (_id, { signal }) => { signal.addEventListener('abort', () => { aborted = true }, { once: true }); return upstream }, close() {},
  } })
  t.after(() => console.close())
  const req = { destroyed: false }, res = new EventEmitter()
  res.writeHead = () => {}; res.write = () => false; res.destroyed = false
  await console.logs(req, res, new URL('http://test/logs?id=demo'))
  upstream.write('blocked'); assert.equal(upstream.isPaused(), true)
  res.emit('drain'); assert.equal(upstream.isPaused(), false)
  console.close(); assert.equal(aborted, true); assert.equal(upstream.destroyed, true)
})

test('terminal rejects malformed WS input and closes daemon stream', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_req, res) => json(res, { Id: EID }))
  f.daemon.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 OK\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'); socket.on('end', () => socket.end())
  })
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/terminal?id=demo`)
  await message(ws, 'ready'); const closed = once(ws, 'close'); ws.send('{')
  assert.equal((await closed)[0], 1008)
  assert.equal(f.console.sessions.size, 0)
})
