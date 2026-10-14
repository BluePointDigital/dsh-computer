/** Isolated gateway contract: test upstream bytes and credentials, not a 200 alone. */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { gatewayConfig, describeApps, launchDescriptor } from '../lib/app-launch.js'
import { AppSessions, SESSION_COOKIE } from '../lib/app-sessions.js'
import { startHostListener } from '../lib/host-listen.js'

const config = gatewayConfig({ appDomain: 'control.example.org', controlOrigin: 'https://control.example.org' }, {})
const raw = { id: 'files', containerId: 'a'.repeat(64), web: { containerPort: 80, path: '/apps/web/files/' } }
const app = describeApps([raw], config)[0]
const cookieFor = (sessions, item = app) => sessions.exchange(new URL(sessions.issue(item)).hash.slice(1), item).cookie.split(';')[0]
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
function request(port, path = '/', { method = 'GET', headers = {}, body = '', host = app.launch.host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { host, ...headers } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject); req.end(body)
  })
}
async function fixture(t, handler = (req, res) => res.end(req.url), options = {}) {
  const upstream = http.createServer(handler)
  const upstreamSockets = new Set()
  upstream.on('connection', socket => { upstreamSockets.add(socket); socket.on('close', () => upstreamSockets.delete(socket)) })
  const upstreamPort = await listen(upstream)
  const sessions = options.sessions ?? new AppSessions()
  const hosts = new Map([[app.launch.host, app]])
  let calls = 0
  const gateway = await startHostListener({ host: '127.0.0.1', port: 0, hosts: async () => hosts, sessions, controlOrigin: config.controlOrigin,
    endpointFor: async () => { calls++; return { hostAddress: '127.0.0.1', port: upstreamPort } }, ...options })
  t.after(async () => { await gateway.close(); for (const socket of upstreamSockets) socket.destroy(); await new Promise(resolve => upstream.close(resolve)) })
  return { upstream, gateway, sessions, hosts, port: gateway.address.port, cookie: cookieFor(sessions), calls: () => calls }
}

test('opt-in config is strict; descriptors are uniform and never reuse replacement origins', () => {
  assert.equal(gatewayConfig({}, {}), null)
  for (const values of [
    { appDomain: 'https://apps.test' }, { appDomain: 'Apps.test' }, { appDomain: 'apps.test.' },
    { appDomain: 'x'.repeat(64) + '.test' }, { controlOrigin: 'http://control.example.org' },
    { controlOrigin: 'https://control.example.org/' }, { appDomain: '*.control.example.org' },
    { appDomain: 'example.org' }, { controlOrigin: app.launch.origin },
    { appIngressPeers: ['10.0.0.0/8'] }, { appPublicPort: 0 },
  ]) assert.throws(() => gatewayConfig({ appDomain: config.domain, controlOrigin: config.controlOrigin, ...values }, {}))
  const replacement = launchDescriptor({ ...raw, containerId: 'b'.repeat(64) }, config)
  assert.notEqual(app.launch.origin, replacement.origin, 'replacement must not inherit a service worker/storage origin')
  assert.equal(launchDescriptor({ ...raw, containerId: undefined }, config).mode, 'unavailable')
  for (const path of ['//evil.test/', '/\\evil.test/', '/bad\npath', '/__dsh_apps/session', '/a/../__dsh_apps/launch']) assert.throws(() => launchDescriptor({ ...raw, webPath: path }, config))
  assert.throws(() => describeApps([raw, raw], config), /Duplicate/)
  const viewer = launchDescriptor({ ...raw, viewer: { password: 'secret' } }, config)
  assert.match(viewer.entryPath, /^\/vnc.html\?/)
  assert.ok(!viewer.entryPath.includes('secret'))
  assert.equal(new URL(viewer.entryPath, viewer.origin).searchParams.get('path'), 'websockify')
})

test('standard wildcard follows the full harness hostname without sharing its origin', () => {
  for (const domain of ['thisharnessdomain.com', 'dev.bluepointdigital.com', 'otherdsh.bluepointdigital.com']) {
    const controlOrigin = `https://${domain}`
    const configured = gatewayConfig({ appDomain: domain, controlOrigin }, {})
    assert.deepEqual(gatewayConfig({}, { DSH_APPS_DOMAIN: domain, DSH_APPS_CONTROL_ORIGIN: controlOrigin }), configured)
    const descriptor = launchDescriptor(raw, configured)
    assert.equal(descriptor.host.split('.').slice(1).join('.'), domain)
    assert.match(descriptor.host.split('.')[0], /^files-[a-f0-9]{20}$/)
    assert.notEqual(descriptor.origin, controlOrigin)
    // A parent suffix could route an app to the control hostname; reject it.
    assert.throws(() => gatewayConfig({ appDomain: domain, controlOrigin: descriptor.origin }, {}), /must not be beneath/)
  }
  // Explicit alternative suffixes remain compatible, but are not the setup default.
  assert.equal(gatewayConfig({ appDomain: 'apps.example.net', controlOrigin: config.controlOrigin }, {}).domain, 'apps.example.net')
})

test('tickets are atomic, app-bound, expiring, capacity-limited and invalidated on disposal', () => {
  let now = 100
  const sessions = new AppSessions({ now: () => now, maxTickets: 2, maxSessions: 2, ticketMs: 100, sessionMs: 200 })
  const ticket = new URL(sessions.issue(app)).hash.slice(1)
  assert.equal(sessions.exchange(ticket, { ...app, launch: { ...app.launch, identity: 'wrong' } }), null)
  const result = sessions.exchange(ticket, app)
  assert.match(result.cookie, /; Path=\/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=0$/)
  assert.equal(sessions.exchange(ticket, app), null)
  const req = { headers: { cookie: result.cookie.split(';')[0] } }
  assert.equal(sessions.authorize(req, app), true)
  assert.equal(sessions.authorize({ headers: { cookie: req.headers.cookie + '; ' + req.headers.cookie } }, app), false)
  const expires = new URL(sessions.issue(app)).hash.slice(1)
  now += 100
  assert.equal(sessions.exchange(expires, app), null)
  now += 100
  assert.equal(sessions.authorize(req, app), false)
  sessions.issue(app); sessions.issue(app)
  assert.throws(() => sessions.issue(app), /Too many/)
  sessions.close(); assert.throws(() => sessions.issue(app), /unavailable/)
})

test('anonymous/wrong-host/wrong-peer/foreign-Origin requests never reach the app', async t => {
  const f = await fixture(t)
  assert.equal((await request(f.port)).status, 401)
  assert.equal((await request(f.port, '/', { host: 'unknown.' + config.domain })).status, 404)
  assert.equal((await request(f.port, '/', { host: new URL(config.controlOrigin).hostname })).status, 404)
  assert.equal((await request(f.port, '/', { host: app.launch.host + ':444' })).status, 400)
  assert.equal((await request(f.port, '/', { host: app.launch.host + '.' })).status, 404)
  for (const method of ['GET', 'POST', 'OPTIONS']) for (const origin of ['null', config.controlOrigin, 'http://' + app.launch.host]) {
    assert.equal((await request(f.port, '/', { method, headers: { cookie: f.cookie, origin } })).status, 403)
  }
  assert.equal((await request(f.port, '/', { method: 'POST', headers: { cookie: f.cookie } })).status, 403)
  assert.equal(f.calls(), 0)
  const untrusted = await fixture(t, undefined, { ingressPeers: ['192.0.2.1'] })
  assert.equal((await request(untrusted.port)).status, 403)
  assert.equal(untrusted.calls(), 0)
  const socket = net.connect(f.port, '127.0.0.1')
  let response = ''
  socket.on('data', b => { response += b })
  await new Promise(resolve => { socket.on('close', resolve); socket.end(`GET / HTTP/1.1\r\nHost: ${app.launch.host}\r\nHost: evil.test\r\nConnection: close\r\n\r\n`) })
  assert.ok(!response.startsWith('HTTP/1.1 200'))
  assert.equal(f.calls(), 0)
})

test('bootstrap and exchange enforce exact origin, single use and bounded JSON', async t => {
  const f = await fixture(t)
  const ticket = new URL(f.sessions.issue(app)).hash.slice(1)
  const page = await request(f.port, '/__dsh_apps/launch')
  assert.equal(page.status, 200)
  assert.ok(!page.body.includes(ticket))
  assert.equal(page.headers['referrer-policy'], 'no-referrer')
  assert.match(page.headers['content-security-policy'], /frame-ancestors https:\/\/control.example.org/)
  const exchange = headers => request(f.port, '/__dsh_apps/session', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ ticket }) })
  assert.equal((await exchange({})).status, 403)
  assert.equal((await exchange({ origin: 'null' })).status, 403)
  assert.equal((await exchange({ origin: app.launch.origin, 'content-type': 'text/plain' })).status, 401)
  const results = await Promise.all([exchange({ origin: app.launch.origin }), exchange({ origin: app.launch.origin })])
  assert.deepEqual(results.map(r => r.status).sort(), [200, 401])
  assert.equal(f.calls(), 0)
  assert.equal((await request(f.port, '/__dsh_apps/not-an-app', { headers: { cookie: f.cookie } })).status, 404)
})

test('transport preserves bytes, compression, app auth, queries, cookies, redirects and cache/security headers', async t => {
  let seen
  const compressed = gzipSync('<script src="/a.js"></script>\0literal')
  const f = await fixture(t, (req, res) => {
    seen = { url: req.url, headers: req.headers }
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': compressed.length,
      etag: '"unchanged"', 'cache-control': 'public, max-age=3600', 'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'", location: '/login?return=%2Fa',
      'set-cookie': ['app=ok; Path=/; HttpOnly', `${SESSION_COOKIE}=evil; Path=/; Secure`, 'dsh-auth-test=evil; Path=/'] })
    res.end(compressed)
  })
  const response = await request(f.port, '/api//login?path=%2Fa%2Fb&x=1&x=2', { headers: {
    cookie: `${f.cookie}; app=original; dsh-auth-login=control`, authorization: 'Bearer app-credential', range: 'bytes=0-5',
    'if-none-match': '"prior"', 'accept-encoding': 'gzip', 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'http', 'x-forwarded-for': '1.2.3.4', forwarded: 'host=evil.test', 'x-dsh-session': 'hidden', 'proxy-authorization': 'Basic hidden' } })
  assert.equal(response.status, 200); assert.deepEqual(response.body, compressed)
  assert.equal(seen.url, '/api//login?path=%2Fa%2Fb&x=1&x=2')
  assert.equal(seen.headers.host, app.launch.host)
  assert.equal(seen.headers.authorization, 'Bearer app-credential')
  assert.equal(seen.headers.cookie, 'app=original')
  assert.equal(seen.headers.range, 'bytes=0-5'); assert.equal(seen.headers['if-none-match'], '"prior"')
  assert.equal(seen.headers['accept-encoding'], 'gzip'); assert.equal(seen.headers['x-forwarded-proto'], 'https')
  for (const key of ['x-forwarded-for', 'forwarded', 'x-dsh-session', 'proxy-authorization']) assert.equal(seen.headers[key], undefined)
  assert.equal(response.headers.etag, '"unchanged"'); assert.equal(response.headers['cache-control'], 'public, max-age=3600')
  assert.equal(response.headers['x-frame-options'], 'DENY')
  assert.equal(response.headers['content-security-policy'], "default-src 'self'; frame-ancestors 'none'")
  assert.equal(response.headers.location, '/login?return=%2Fa')
  assert.deepEqual(response.headers['set-cookie'], ['app=ok; Path=/; HttpOnly'])
  // A warm browser/public cache policy does not make the gateway itself public.
  assert.equal((await request(f.port, seen.url)).status, 401)
})

test('POST upload, range download and 304 remain streaming protocol operations', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.method === 'POST') { res.writeHead(201, { 'content-type': 'application/octet-stream' }); req.pipe(res); return }
    if (req.headers['if-none-match']) { res.writeHead(304, { etag: '"v1"' }).end(); return }
    res.writeHead(206, { 'content-range': 'bytes 2-5/10', 'accept-ranges': 'bytes', 'content-disposition': 'attachment; filename="download.bin"' }).end('2345')
  })
  const body = Buffer.alloc(128 * 1024, 42)
  const upload = await request(f.port, '/upload?exact=%2F', { method: 'POST', headers: { cookie: f.cookie, origin: app.launch.origin }, body })
  assert.equal(upload.status, 201); assert.deepEqual(upload.body, body)
  const download = await request(f.port, '/download', { headers: { cookie: f.cookie, range: 'bytes=2-5' } })
  assert.equal(download.status, 206); assert.equal(download.body.toString(), '2345')
  assert.equal(download.headers['content-range'], 'bytes 2-5/10')
  assert.match(download.headers['content-disposition'], /attachment/)
  assert.equal((await request(f.port, '/download', { headers: { cookie: f.cookie, 'if-none-match': '"v1"' } })).status, 304)
})

test('arbitrary WS paths preserve app auth/subprotocol/query and relay frames; disposal closes both ends', { timeout: 5000 }, async t => {
  const f = await fixture(t)
  let received, upstreamSocket
  f.upstream.on('upgrade', (req, socket) => {
    received = req; upstreamSocket = socket
    socket.on('end', () => socket.end())
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: fixture\r\nSet-Cookie: ${SESSION_COOKIE}=evil; Path=/; Secure\r\n\r\n`)
    socket.once('data', bytes => { assert.equal(bytes[0], 0x81); socket.write(Buffer.from([0x81, 2, 111, 107])) })
  })
  const socket = net.connect(f.port, '127.0.0.1')
  t.after(() => socket.destroy())
  let handshake = '', buffer = Buffer.alloc(0), upgraded = false
  const frame = new Promise((resolve, reject) => {
    socket.on('error', reject)
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n'); if (end === -1) return
        handshake = buffer.subarray(0, end).toString(); buffer = buffer.subarray(end + 4); upgraded = true
        socket.write(Buffer.from([0x81, 0x82, 0, 0, 0, 0, 104, 105]))
      }
      if (buffer.length >= 4) resolve(buffer)
    })
  })
  socket.write(`GET /undeclared/ws?token=%2F&token=x HTTP/1.1\r\nHost: ${app.launch.host}\r\nOrigin: ${app.launch.origin}\r\nCookie: ${f.cookie}; app=ok\r\nAuthorization: Bearer app\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: fixture\r\n\r\n`)
  assert.deepEqual(await frame, Buffer.from([0x81, 2, 111, 107]))
  assert.match(handshake, /101/); assert.ok(!handshake.includes(SESSION_COOKIE))
  assert.equal(received.url, '/undeclared/ws?token=%2F&token=x')
  assert.equal(received.headers.cookie, 'app=ok'); assert.equal(received.headers.authorization, 'Bearer app')
  assert.equal(received.headers['sec-websocket-protocol'], 'fixture')
  const ended = new Promise(resolve => upstreamSocket.once('close', resolve))
  const clientEnded = new Promise(resolve => socket.once('close', resolve))
  await f.gateway.close(); await clientEnded; await ended
})

test('SSE streams promptly and is terminated on session expiry', { timeout: 5000 }, async t => {
  const sessions = new AppSessions({ sessionMs: 150 })
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n') }, { sessions })
  const response = await new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: f.port, headers: { host: app.launch.host, cookie: f.cookie } }, resolve)
    req.on('error', reject)
  })
  const first = await new Promise(resolve => response.once('data', resolve))
  assert.equal(first.toString(), 'data: first\n\n')
  await new Promise(resolve => response.once('close', resolve))
  assert.equal(sessions.authorize({ headers: { cookie: f.cookie } }, app), false)
})

for (const mode of ['revocation', 'expiry']) test(`pipelined streams keep every grant until completion: ${mode}`, { timeout: 5000 }, async t => {
  const other = describeApps([{ ...raw, id: 'other', containerId: 'b'.repeat(64) }], config)[0]
  let received = 0, ready
  const bothReceived = new Promise(resolve => { ready = resolve })
  const sessions = new AppSessions({ sessionMs: mode === 'expiry' ? 1000 : 60_000 })
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: active\n\n')
    if (++received === 2) ready()
  }, { sessions })
  f.hosts.set(other.launch.host, other)
  sessions.sessionMs = 60_000
  const laterCookie = cookieFor(sessions, other)
  const socket = net.connect(f.port, '127.0.0.1')
  t.after(() => socket.destroy())
  socket.on('error', () => {})
  socket.resume()
  const closed = new Promise(resolve => socket.once('close', resolve))
  socket.write([ [app, f.cookie], [other, laterCookie] ].map(([item, cookie]) =>
    `GET /events HTTP/1.1\r\nHost: ${item.launch.host}\r\nCookie: ${cookie}\r\nConnection: keep-alive\r\n\r\n`).join(''))
  await bothReceived
  if (mode === 'revocation') f.gateway.reconcile([other])
  await closed
  assert.equal(sessions.authorize({ headers: { cookie: f.cookie } }, app), false)
  assert.equal(sessions.authorize({ headers: { cookie: laterCookie } }, other), true, 'later grant must not hide revoked/expired stream')
})

test('completed HTTP grants do not revoke later requests on a reused connection', { timeout: 5000 }, async t => {
  const other = describeApps([{ ...raw, id: 'other', containerId: 'b'.repeat(64) }], config)[0]
  const f = await fixture(t, (req, res) => { res.setHeader('connection', 'keep-alive'); res.end(req.url) })
  f.hosts.set(other.launch.host, other)
  const socket = net.connect(f.port, '127.0.0.1')
  t.after(() => socket.destroy())
  socket.on('error', () => {})
  const next = () => new Promise(resolve => socket.once('data', resolve))
  const send = (item, cookie, path) => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${item.launch.host}\r\nCookie: ${cookie}\r\nConnection: keep-alive\r\n\r\n`)
  const first = next(); send(app, f.cookie, '/first')
  assert.match((await first).toString(), /\/first$/)
  f.gateway.reconcile([other])
  const second = next(); send(other, cookieFor(f.sessions, other), '/second')
  assert.match((await second).toString(), /\/second$/)
})

test('early upstream response does not release a still-uploading request grant', { timeout: 5000 }, async t => {
  const f = await fixture(t, (req, res) => { req.resume(); res.setHeader('connection', 'keep-alive'); res.end('early') })
  const socket = net.connect(f.port, '127.0.0.1')
  t.after(() => socket.destroy())
  socket.on('error', () => {})
  const response = new Promise(resolve => socket.once('data', resolve))
  const closed = new Promise(resolve => socket.once('close', resolve))
  socket.write(`POST /upload HTTP/1.1\r\nHost: ${app.launch.host}\r\nOrigin: ${app.launch.origin}\r\nCookie: ${f.cookie}\r\nContent-Length: 1000000\r\nConnection: keep-alive\r\n\r\npartial`)
  assert.match((await response).toString(), /early$/)
  f.gateway.reconcile([])
  await closed
})

test('streaming uploads can progress beyond thirty seconds without a whole-body deadline', { timeout: 40_000 }, async t => {
  const f = await fixture(t, (req, res) => req.pipe(res))
  assert.equal(f.gateway.server.requestTimeout, 0)
  assert.equal(f.gateway.server.headersTimeout, 30_000)
  let heartbeat, finish
  t.after(() => { clearInterval(heartbeat); clearTimeout(finish) })
  const sent = ['first\n'], received = []
  const response = new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: f.port, path: '/slow-upload', method: 'POST', headers: { host: app.launch.host, origin: app.launch.origin, cookie: f.cookie } }, res => {
      assert.equal(res.statusCode, 200)
      res.on('data', chunk => received.push(chunk))
      res.on('error', reject)
      res.on('end', resolve)
    })
    t.after(() => req.destroy())
    req.on('error', reject)
    req.write(sent[0])
    heartbeat = setInterval(() => { sent.push('progress\n'); req.write(sent.at(-1)) }, 5000)
    finish = setTimeout(() => { clearInterval(heartbeat); sent.push('last\n'); req.end(sent.at(-1)) }, 31_000)
  })
  await response
  assert.equal(Buffer.concat(received).toString(), sent.join(''))
})

test('catalog revocation invalidates tickets, sessions and active streams', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n') })
  const response = await new Promise(resolve => http.get({ hostname: '127.0.0.1', port: f.port, headers: { host: app.launch.host, cookie: f.cookie } }, resolve))
  response.resume()
  const ended = new Promise(resolve => response.once('close', resolve))
  f.gateway.reconcile([]); await ended
  assert.equal(f.sessions.authorize({ headers: { cookie: f.cookie } }, app), false)
})
