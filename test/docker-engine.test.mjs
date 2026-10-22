import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { DockerEngine, DockerError } from '../lib/docker-engine.js'

const CID = 'a'.repeat(64), EID = 'b'.repeat(64)
const frame = (channel, value) => { const data = Buffer.from(value), header = Buffer.alloc(8); header[0] = channel; header.writeUInt32BE(data.length, 4); return Buffer.concat([header, data]) }
const json = (res, value, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
async function fixture(t, handler, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-engine-')), socketPath = path.join(dir, 'docker.sock'), sockets = new Set(), calls = []
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url })
    if (req.url === '/version') {
      if (options.versionHandler) return options.versionHandler(req, res)
      return json(res, options.version ?? { ApiVersion: '1.49', MinAPIVersion: '1.24' })
    }
    handler(req, res)
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(socketPath, resolve))
  const engine = new DockerEngine({ socketPath, env: {}, ...options.engine })
  t.after(async () => {
    engine.close(); for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    assert.ok(dir.startsWith(path.join(os.tmpdir(), 'dsh-engine-'))); await fs.rm(dir, { recursive: true, force: true })
  })
  return { server, engine, calls, sockets }
}
async function text(stream) { let result = ''; for await (const part of stream) result += part; return result }

test('failed initial negotiation recovers on the same engine without restart', async t => {
  let attempts = 0
  const { engine } = await fixture(t, (_req, res) => json(res, []), {
    versionHandler: (_req, res) => ++attempts === 1 ? json(res, { message: 'offline' }, 503) : json(res, { ApiVersion: '1.41', MinAPIVersion: '1.12' }),
  })
  await assert.rejects(engine.listContainers(), { status: 503 })
  assert.deepEqual(await engine.listContainers(), [])
  assert.equal(attempts, 2)
})

test('endpoint policy rejects unsupported Docker contexts, hosts, TLS and invalid limits', () => {
  for (const env of [{ DOCKER_CONTEXT: 'remote' }, { DOCKER_HOST: 'tcp://localhost:2375' }, { DOCKER_HOST: 'unix://relative' }, { DOCKER_TLS_VERIFY: '1' }, { DOCKER_CERT_PATH: '/private' }, { DOCKER_API_VERSION: 'latest' }]) {
    assert.throws(() => new DockerEngine({ env }), DockerError)
  }
  const defaultEngine = new DockerEngine({ env: { DOCKER_CONTEXT: 'default' } })
  assert.equal(defaultEngine.socketPath, '/var/run/docker.sock'); defaultEngine.close()
  const engine = new DockerEngine({ env: { DOCKER_HOST: 'unix:///tmp/test.sock' }, socketPath: '/tmp/explicit.sock' })
  assert.equal(engine.socketPath, '/tmp/explicit.sock'); engine.close()
  assert.throws(() => new DockerEngine({ env: {}, maxBytes: 8 * 1024 * 1024 + 1 }), DockerError)
})

test('negotiates once, caps at 1.47, uses full IDs, encodes inspect names and retains volumes by default', async t => {
  const { engine, calls } = await fixture(t, (req, res) => json(res, req.url.includes('/containers/json') ? [] : {}))
  await engine.version(); await Promise.all([engine.listContainers(), engine.stats(CID)])
  await engine.inspectContainer('/some.name'); await engine.start(CID); await engine.stop(CID); await engine.restart(CID)
  await engine.remove(CID); await engine.remove(CID, { volumes: true }); await engine.removeVolume('test-volume')
  assert.equal(calls.filter(c => c.url === '/version').length, 2)
  assert.ok(calls.some(c => c.url === '/v1.47/containers/%2Fsome.name/json'))
  assert.ok(calls.some(c => c.method === 'DELETE' && c.url === `/v1.47/containers/${CID}?v=0`))
  assert.ok(calls.some(c => c.url.endsWith('?v=1')))
  await assert.rejects(engine.start('short'), DockerError)
  assert.throws(() => engine.remove(CID, { volumes: 'false' }), DockerError)
  await assert.rejects(engine.inspectContainer('../escape'), DockerError)
  assert.throws(() => engine.removeVolume('bad/name'), DockerError)
})

test('already started/stopped 304 is idempotent success only for lifecycle endpoints', async t => {
  const {engine}=await fixture(t,(_req,res)=>res.writeHead(304).end())
  assert.deepEqual(await engine.start(CID),{});assert.deepEqual(await engine.stop(CID),{})
  await assert.rejects(engine.restart(CID),{status:304})
})

test('honors only explicit API versions in the supported daemon overlap', async t => {
  const f = await fixture(t, (_req, res) => json(res, []), { version: { ApiVersion: '1.44', MinAPIVersion: '1.42' }, engine: { env: { DOCKER_API_VERSION: '1.43' } } })
  await f.engine.listContainers(); assert.equal(f.calls.at(-1).url, '/v1.43/containers/json?all=1')
  for (const requested of ['1.41', '1.45']) {
    const engine = new DockerEngine({ socketPath: f.engine.socketPath, env: { DOCKER_API_VERSION: requested } })
    try { await assert.rejects(engine.listContainers(), { code: 'DOCKER_API_VERSION' }) } finally { engine.close() }
  }
  const old = await fixture(t, () => assert.fail('must not call versioned endpoint'), { version: { ApiVersion: '1.40', MinAPIVersion: '1.12' } })
  await assert.rejects(old.engine.listContainers(), { code: 'DOCKER_API_VERSION' })
})

test('only inspect 404 returns null; error bodies are sanitized and mutations are not retried', async t => {
  const { engine, calls } = await fixture(t, (req, res) => json(res, { message: 'secret password /root/private' }, req.url.includes('missing') ? 404 : 500))
  assert.equal(await engine.inspectContainer('missing'), null)
  await assert.rejects(engine.inspectContainer('failure'), e => e instanceof DockerError && e.status === 500 && !e.message.includes('secret'))
  await assert.rejects(engine.start(CID), { status: 500 })
  assert.equal(calls.filter(c => c.url.endsWith('/start')).length, 1)
})

test('bounded JSON, invalid JSON, absolute timeout, cancellation and close', async t => {
  const { engine } = await fixture(t, (req, res) => {
    if (req.url.endsWith('/large')) return res.end(JSON.stringify('x'.repeat(1024)))
    if (req.url.endsWith('/bad')) return res.end('{')
    if (req.url.endsWith('/json')) return res.end('null')
    // Intentionally never respond.
  }, { engine: { maxBytes: 128, timeout: 60 } })
  await assert.rejects(engine.request('GET', '/large'), { code: 'DOCKER_LIMIT' })
  await assert.rejects(engine.request('GET', '/bad'), { code: 'DOCKER_PROTOCOL' })
  await assert.rejects(engine.inspectContainer(CID), { code: 'DOCKER_PROTOCOL' })
  await assert.rejects(engine.request('GET', '/wait'), { code: 'DOCKER_TIMEOUT' })
  const controller = new AbortController(), pending = engine.request('GET', '/cancel', undefined, { signal: controller.signal })
  controller.abort(); await assert.rejects(pending, { code: 'ABORT_ERR' })
  const closed = engine.request('GET', '/close'); engine.close()
  await assert.rejects(closed, { code: 'DOCKER_CLOSED' })
})

test('logs demux fragmented frames, maintain per-channel UTF8, and support raw TTY', async t => {
  const { engine } = await fixture(t, (req, res) => {
    if (req.url.endsWith('/json')) return json(res, { Config: { Tty: false } })
    res.writeHead(200, { 'content-type': 'application/vnd.docker.raw-stream' })
    if (req.url.includes('tail=1&')) return res.end(Buffer.from('raw €\n'))
    const euro = Buffer.from('€')
    const content = Buffer.concat([frame(1, euro.subarray(0, 1)), frame(2, 'error\n'), frame(1, euro.subarray(1)), frame(1, 'ok\n')])
    for (let offset = 0; offset < content.length; offset += 3) res.write(content.subarray(offset, offset + 3))
    res.end()
  })
  const stream = await engine.logs(CID, { tail: 3 })
  assert.equal(stream.readableEncoding, 'utf8')
  assert.equal(await text(stream), 'error\n€ok\n')
  assert.equal(await text(await engine.logs(CID, { tail: 1, tty: true })), 'raw €\n')
})

test('logs reject oversized, invalid and truncated frames', async t => {
  const { engine } = await fixture(t, (req, res) => {
    if (req.url.includes('tail=1&')) { const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(129, 4); return res.end(header) }
    if (req.url.includes('tail=2&')) return res.end(Buffer.from([8, 0, 0, 0, 0, 0, 0, 0]))
    res.end(frame(1, 'abc').subarray(0, 10))
  }, { engine: { maxBytes: 128 } })
  for (const tail of [1, 2, 3]) await assert.rejects(text(await engine.logs(CID, { tail, tty: false })), { code: 'DOCKER_PROTOCOL' })
})

test('follow logs stay open beyond handshake timeout and cancellation destroys daemon connection', async t => {
  let response, started
  const ready = new Promise(resolve => { started = resolve })
  const { engine } = await fixture(t, (_req, res) => { response = res; res.write(frame(1, 'hello')); started() }, { engine: { timeout: 40 } })
  const controller = new AbortController(), output = await engine.logs(CID, { follow: true, tty: false, signal: controller.signal })
  output.on('error', () => {}); await ready
  const first = await once(output, 'data'); assert.equal(first[0], 'hello')
  await new Promise(resolve => setTimeout(resolve, 65))
  assert.equal(output.destroyed, false)
  const closed = once(response, 'close'); controller.abort(); await closed
  assert.equal(output.destroyed, true)
})

for (const status of [101, 200]) test(`execStart ${status} handshake preserves head bytes and exposes duplex stdin`, async t => {
  const { engine, server } = await fixture(t, (req, res) => json(res, { Id: EID }))
  server.on('upgrade', (_req, socket) => {
    const headers = status === 101 ? 'Connection: Upgrade\r\nUpgrade: tcp' : 'Content-Type: application/vnd.docker.raw-stream'
    socket.write(`HTTP/1.1 ${status} OK\r\n${headers}\r\n\r\ninitial€`)
    socket.on('data', data => socket.end('echo:' + data))
  })
  await engine.execCreate(CID, { Tty: true, Cmd: ['/bin/sh'] })
  const raw = await engine.execStart(EID)
  let output = ''
  raw.on('data', part => { output += part.toString(); if (output === 'initial€') raw.write('hello') })
  raw.resume(); await once(raw, 'end')
  assert.equal(output, 'initial€echo:hello')
})

test('exec captures framed stdout/stderr and inspects exit status', async t => {
  const { engine, server } = await fixture(t, (req, res) => {
    if (req.url.endsWith('/exec')) return json(res, { Id: EID })
    if (req.url.endsWith(`/exec/${EID}/json`)) return json(res, { Running: false, ExitCode: 7 })
    assert.fail(req.url)
  })
  server.on('upgrade', (_req, socket, head) => {
    assert.equal(JSON.parse(head.toString()).Tty, false)
    socket.write('HTTP/1.1 101 OK\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n')
    socket.end(Buffer.concat([frame(1, 'out €'), frame(2, 'failure')]))
  })
  assert.deepEqual(await engine.exec(CID, ['false']), { code: 7, stdout: 'out €', stderr: 'failure' })
})

test('exec deadlines cancel a hanging hijack and bounded capture rejects excess output', async t => {
  const { engine, server } = await fixture(t, (_req, res) => json(res, { Id: EID }), { engine: { maxBytes: 128 } })
  let huge = false
  server.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 OK\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n')
    if (huge) socket.end(Buffer.concat([frame(1, 'a'.repeat(80)), frame(2, 'b'.repeat(80))]))
  })
  // JSON command bodies exceed an unrealistically tiny maxBytes unless minimal.
  engine.maxBytes = 256
  await assert.rejects(engine.exec(CID, ['sh'], { timeout: 60 }), { code: 'DOCKER_TIMEOUT' })
  huge = true; engine.maxBytes = 150
  await assert.rejects(engine.exec(CID, ['x']), { code: 'DOCKER_LIMIT' })
})

test('cancellation while negotiating closes the last pending version request', { timeout: 3000 }, async t => {
  const { engine, server } = await fixture(t, () => assert.fail('versioned request should not run'))
  server.removeAllListeners('request')
  let entered, ended
  const started = new Promise(resolve => { entered = resolve }), stopped = new Promise(resolve => { ended = resolve })
  server.on('request', (_req, res) => { res.once('close', ended); entered() })
  const controller = new AbortController(), pending = engine.listContainers({ signal: controller.signal })
  await started; controller.abort(); await assert.rejects(pending, { code: 'ABORT_ERR' }); await stopped
  assert.equal(engine.pending.size, 0)
})

test('one cancelled negotiation waiter does not interrupt another caller', async t => {
  const { engine, server } = await fixture(t, (_req, res) => json(res, []))
  const handler = server.listeners('request')[0]
  server.removeAllListeners('request')
  let entered, respond
  const started = new Promise(resolve => { entered = resolve })
  server.on('request', (req, res) => {
    if (req.url !== '/version') return handler(req, res)
    respond = () => json(res, { ApiVersion: '1.47' }); entered()
  })
  const controller = new AbortController(), first = engine.listContainers({ signal: controller.signal }), second = engine.listContainers()
  await started; controller.abort(); await assert.rejects(first, { code: 'ABORT_ERR' }); respond()
  assert.deepEqual(await second, [])
})
