/** Deterministic integration: real HTTP/WS, mocked CLI/daemon, no container deletion. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import crypto from 'node:crypto'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

let apps = []
let inspectCalls = 0
let delayed = null
const originalExec = childProcess.execFile
childProcess.execFile = (bin, args, _opts, callback) => {
  if (bin === 'docker') {
    inspectCalls++
    queueMicrotask(() => callback(null, JSON.stringify({ bridge: { IPAddress: '127.0.0.1' } }), ''))
  } else if (delayed) delayed.push(callback)
  else queueMicrotask(() => callback(null, JSON.stringify({ ok: true, apps }), ''))
}
syncBuiltinESMExports()
const { apply } = await import('../lib/index.js')

function context() {
  const routes = new Map(), upgrades = new Map(), disposers = []
  const ctx = {
    logger: { info() {} },
    connection: { requestRejection: (req) => req.headers.origin === 'https://evil.example' ? 403 : req.headers['x-auth'] === 'yes' ? undefined : 401 },
    effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose) },
    webServer: {
      register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
      registerUpgrade(route) {
        if (upgrades.has(route.path)) throw new Error('duplicate route')
        upgrades.set(route.path, route); return () => upgrades.delete(route.path)
      },
    },
  }
  return { ctx, routes, upgrades, dispose: () => disposers.reverse().forEach((fn) => fn()) }
}
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
function request(port, path, auth = true, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: auth ? { 'x-auth': 'yes' } : {} }, (res) => {
      const chunks = []; res.on('data', (b) => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    }); req.on('error', reject); req.end()
  })
}
function upgrade(port, path, auth = true, origin) {
  return new Promise((resolve, reject) => {
    let socket
    const timer = setTimeout(() => { socket?.destroy(); req.destroy(); reject(new Error('upgrade/echo timeout')) }, 3000)
    const req = http.request({ host: '127.0.0.1', port, path, headers: {
      ...(auth ? { 'x-auth': 'yes' } : {}), ...(origin ? { Origin: origin } : {}), Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13',
      Cookie: 'dsh-auth-test=secret; app=keep', Authorization: 'Basic frontdoor',
    } })
    req.on('response', (res) => { res.resume(); clearTimeout(timer); resolve({ status: res.statusCode }) })
    req.on('error', (error) => { clearTimeout(timer); reject(error) })
    req.on('upgrade', (res, s) => {
      socket = s
      const mask = Buffer.from([1,2,3,4]), body = Buffer.from('ping')
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4]
      socket.write(Buffer.concat([Buffer.from([0x81, 0x84]), mask, body]))
      const chunks = []
      socket.on('data', (data) => {
        chunks.push(data); const reply = Buffer.concat(chunks)
        if (reply.length < 6) return
        clearTimeout(timer); socket.destroy(); resolve({ status: res.statusCode, text: reply.subarray(2,6).toString() })
      })
    }); req.end()
  })
}

test('registered upgrades: gate, catalog refresh, collision, disposal and real bytes', async (t) => {
  const seen = []
  const backend = http.createServer((req, res) => {
    if (req.url === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: active\n\n'); return }
    if (req.url === '/slow') return
    res.writeHead(200, { 'content-type': 'text/html' }).end('<p>app</p>')
  })
  backend.on('upgrade', (req, socket) => {
    seen.push({ path: req.url, headers: req.headers })
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('data', () => socket.write(Buffer.from([0x81,4,112,105,110,103])))
    socket.on('error', () => {})
  })
  const bp = await listen(backend)
  apps = [{ id: 'demo', web: { containerPort: bp }, webSockets: ['/websockify'] }]
  const c = context()
  apply(c.ctx, { computerBin: 'fixture-cli' })
  const front = http.createServer((req, res) => {
    const route = c.routes.get(req.url.startsWith('/apps/api') ? '/apps/api' : '/apps/web')
    Promise.resolve(route.handler(req, res)).catch((error) => res.destroy(error))
  })
  front.on('upgrade', (req, socket, head) => {
    const route = c.upgrades.get(new URL(req.url, 'http://x').pathname)
    if (!route) { socket.destroy(); return }
    Promise.resolve(route.handler(req, socket, head)).catch(() => socket.destroy())
  })
  const fp = await listen(front)
  t.after(() => { c.dispose(); front.closeAllConnections(); front.close(); backend.closeAllConnections(); backend.close(); childProcess.execFile = originalExec; syncBuiltinESMExports() })

  await t.test('first request awaits activation and advertises owned sockets', async () => {
    const res = await request(fp, '/apps/web/demo/', true, 'HEAD')
    assert.equal(res.status, 200); assert.equal(res.headers['x-dsh-app-proxy-features'], 'ws')
    assert.ok(c.upgrades.has('/apps/web/demo/websockify'))
  })
  await t.test('unauthenticated upgrade is rejected before any daemon lookup', async () => {
    const before = inspectCalls
    assert.equal((await upgrade(fp, '/apps/web/demo/websockify', false)).status, 401)
    assert.equal(inspectCalls, before)
  })
  await t.test('cross-origin upgrade uses gate and is denied before daemon lookup', async () => {
    const before = inspectCalls
    assert.equal((await upgrade(fp, '/apps/web/demo/websockify', true, 'https://evil.example')).status, 403)
    assert.equal(inspectCalls, before)
  })
  await t.test('authenticated upgrade preserves query and echoes real frames', async () => {
    assert.deepEqual(await upgrade(fp, '/apps/web/demo/websockify?token=abc'), { status: 101, text: 'ping' })
    assert.equal(seen[0].path, '/websockify?token=abc')
    assert.equal(seen[0].headers.authorization, undefined)
    assert.equal(seen[0].headers.cookie.trim(), 'app=keep')
  })
  await t.test('list refresh adds and removes socket routes without restart', async () => {
    apps[0].webSockets = ['/changed']
    assert.equal((await request(fp, '/apps/api/list')).status, 200)
    assert.ok(c.upgrades.has('/apps/web/demo/changed')); assert.ok(!c.upgrades.has('/apps/web/demo/websockify'))
    assert.equal((await upgrade(fp, '/apps/web/demo/changed')).text, 'ping')
  })
  await t.test('registration collision does not advertise ws', async () => {
    c.upgrades.set('/apps/web/demo/collision', { handler() {} })
    apps[0].webSockets = ['/collision']
    await request(fp, '/apps/api/list')
    const res = await request(fp, '/apps/web/demo/', true, 'HEAD')
    assert.ok(!res.headers['x-dsh-app-proxy-features'].includes('ws'))
  })
  await t.test('mount without trailing slash redirects before relative assets resolve', async () => {
    const res = await request(fp, '/apps/web/demo?q=1')
    assert.equal(res.headers.location, '/apps/web/demo/?q=1')
  })
  await t.test('disposal closes open SSE and upstream requests still awaiting headers', async () => {
    const streams = context(); apply(streams.ctx, { computerBin: 'fixture-cli' })
    const sf = http.createServer((req, res) => streams.routes.get('/apps/web').handler(req, res))
    const sp = await listen(sf)
    const started = () => new Promise((resolve) => backend.once('request', resolve))
    const slowSeen = started()
    const slow = http.get({ host: '127.0.0.1', port: sp, path: '/apps/web/demo/slow', headers: { 'x-auth': 'yes' } })
    slow.on('error', () => {})
    const slowClosed = new Promise((resolve) => slow.once('close', resolve))
    await slowSeen
    let sseReq
    const { closed: sseClosed } = await new Promise((resolve) => {
      sseReq = http.get({ host: '127.0.0.1', port: sp, path: '/apps/web/demo/events', headers: { 'x-auth': 'yes' } }, (res) => {
        const closed = new Promise((done) => res.once('close', done))
        res.once('data', () => resolve({ closed }))
      })
      sseReq.on('error', () => {})
      // Resolve with an object to avoid promise assimilation while SSE is open.
    })
    streams.dispose()
    await Promise.race([Promise.all([slowClosed, sseClosed]), new Promise((_, reject) => setTimeout(() => reject(new Error('streams survived disposal')), 1500))])
    slow.destroy(); sseReq.destroy(); sf.closeAllConnections(); sf.close()
  })
  await t.test('disposal prevents pending catalog reads from installing orphan routes', async () => {
    delayed = []
    const other = context(); apply(other.ctx, { computerBin: 'fixture-cli' })
    other.dispose()
    for (const callback of delayed) callback(null, JSON.stringify({ ok: true, apps }), '')
    delayed = null
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(other.upgrades.size, 0)
  })
})
