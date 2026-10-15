/** Trusted shared-host ports: durable allocation and real HTTP/WS transport. */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { AppManager } from '../lib/app-manager.js'
import { AppPorts } from '../lib/app-ports.js'
import { gatewayConfig, describeApps } from '../lib/app-launch.js'
import { PortListeners, portTls } from '../lib/port-listen.js'
import { portIngress } from '../deploy/port-ingress.mjs'

const raw = id => ({ id, containerId: id.repeat(64), web: { containerPort: 80, path: `/apps/web/${id}/` } })
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)) })
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-app-ports-'))
  t.after(async () => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'dsh-app-ports-'))); await fs.rm(root, { recursive: true, force: true }) })
  return root
}
async function freePort() { const server = http.createServer(); const port = await listen(server); await close(server); return port }
function request(port, authority, pathname = '/', options = {}) {
  const transport = options.https ? https : http
  return new Promise((resolve, reject) => {
    const req = transport.request({ hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET', rejectUnauthorized: false, headers: { host: authority, ...options.headers } }, res => {
      let body = ''; res.on('data', data => { body += data }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    }); req.on('error', reject); req.end(options.body)
  })
}

test('port config defaults to the harness origin, supports DNS/IPv4/IPv6 and explicit legacy/wildcard', () => {
  for (const controlOrigin of ['https://dev.example.com', 'http://192.0.2.5:3080', 'http://[::1]:3080']) {
    const config = gatewayConfig({ controlOrigin }, {})
    assert.equal(config.mode, 'ports'); assert.equal(config.bind, controlOrigin.includes('[::1]') ? '::' : '0.0.0.0')
    assert.equal(config.portStart, 20000); assert.equal(config.portEnd, 20099)
    assert.deepEqual(gatewayConfig({}, { DSH_PUBLIC_URL: controlOrigin }), config)
    const [app] = describeApps([{ ...raw('a'), appPort: 20000, viewer: { password: 'pw' } }], config)
    const url = new URL(app.launch.entryPath, app.launch.origin)
    assert.equal(url.hostname, new URL(controlOrigin).hostname)
    assert.equal(url.port, '20000'); assert.equal(url.pathname, '/vnc.html')
    assert.equal(url.searchParams.get('port'), '20000')
    assert.equal(url.searchParams.get('encrypt'), url.protocol === 'https:' ? '1' : '0')
    assert.equal(url.searchParams.get('password'), 'pw')
    assert.equal(url.searchParams.get('path'), 'websockify')
  }
  assert.equal(gatewayConfig({ appAccess: 'legacy', controlOrigin: 'http://127.0.0.1:3080' }, {}), null)
  assert.equal(gatewayConfig({ appDomain: 'apps.test', controlOrigin: 'https://control.test' }, {}).domain, 'apps.test')
  assert.equal(gatewayConfig({ appAccess: 'ports', appDomain: 'obsolete.test', controlOrigin: 'http://127.0.0.1:3080' }, {}).mode, 'ports')
  for (const bad of [{ appPortStart: 80 }, { appPortStart: 22000, appPortEnd: 21000 }, { appPortEnd: 65536 }, { controlOrigin: 'https://user:pw@control.test' }, { controlOrigin: 'http://control.test/path' }]) {
    assert.throws(() => gatewayConfig({ controlOrigin: 'http://127.0.0.1:3080', ...bad }, {}))
  }
})

test('allocation survives ordering, stop/remove, container replacement and process instances without recycling', async t => {
  const root = await temporary(t), manager = new AppManager({ root })
  const allocator = new AppPorts(manager)
  const config = gatewayConfig({ controlOrigin: 'http://127.0.0.1:20000', appPortEnd: 20003 }, {})
  let apps = await allocator.assign([raw('a'), raw('b')], config)
  assert.deepEqual(apps.map(a => a.appPort), [20001, 20002], 'skip harness port')
  const restarted = new AppPorts(new AppManager({ root }))
  apps = await restarted.assign([{ ...raw('b'), containerId: 'replacement', status: 'stopped' }, raw('a')], config)
  assert.deepEqual(apps.map(a => a.appPort), [20002, 20001])
  assert.equal((await restarted.assign([raw('c')], config))[0].appPort, 20003)
  const full = describeApps(await restarted.assign([raw('a'), raw('d')], config), config)
  assert.equal(full[0].launch.mode, 'ports')
  assert.match(full[1].launch.reason, /exhausted/)
  const before = await fs.readFile(path.join(root, 'ports.json'), 'utf8')
  // Existing assignments need no mutation lock while another install is running.
  await manager.locked(async () => assert.equal((await restarted.assign([raw('a')], config))[0].appPort, 20001))
  assert.equal(await fs.readFile(path.join(root, 'ports.json'), 'utf8'), before)
  await assert.rejects(restarted.assign([raw('a')], { ...config, portStart: 20002 }), /outside/)
  assert.equal((await fs.stat(path.join(root, 'ports.json'))).mode & 0o777, 0o600)
  await manager.locked(async () => {
    const more = await restarted.assign([raw('e')], { ...config, portEnd: 20004 })
    assert.equal(more[0].appPort, 20004, 'new allocation must not block on an install transaction')
  })
})

test('corrupt registry and duplicate assignments fail without overwriting', async t => {
  const root = await temporary(t), manager = new AppManager({ root })
  await manager.init(); await manager.save('ports.json', { version: 1, assignments: { a: 20000, b: 20000 } })
  await assert.rejects(new AppPorts(manager).assign([raw('a')], gatewayConfig({ controlOrigin: 'http://127.0.0.1:3080' }, {})), /duplicate/)
})

async function fixture(t, { tls, origin = 'http://127.0.0.1:3080' } = {}) {
  const seen = [], upstreamSockets = new Set()
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers })
    let body = ''; req.on('data', b => { body += b }); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['connect.sid=app-session; Path=/; HttpOnly'], 'content-security-policy': "default-src 'self'", 'x-frame-options': 'SAMEORIGIN', location: '/login' })
      res.end(JSON.stringify({ url: req.url, body, headers: req.headers }))
    })
  })
  upstream.on('connection', socket => { upstreamSockets.add(socket); socket.on('close', () => upstreamSockets.delete(socket)) })
  upstream.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, headers: req.headers })
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('data', () => socket.write(Buffer.from([0x81, 4, 112, 111, 110, 103])))
  })
  const upstreamPort = await listen(upstream), publicPort = await freePort()
  const config = gatewayConfig({ controlOrigin: origin, appListenHost: '127.0.0.1', appPortStart: publicPort, appPortEnd: publicPort }, {})
  let available = true
  const pool = new PortListeners({ config, tls, endpointFor: async () => available ? { hostAddress: '127.0.0.1', port: upstreamPort } : null })
  const [app] = describeApps([{ ...raw('a'), appPort: publicPort }], config)
  const result = await pool.reconcile([app]); assert.equal(result[0].launch.mode, 'ports')
  t.after(async () => { await pool.close(); for (const socket of upstreamSockets) socket.destroy(); await close(upstream) })
  return { pool, app, port: publicPort, authority: new URL(app.launch.origin).host, seen, unavailable() { available = false } }
}

test('real root HTTP preserves app cookies/auth, paths, callbacks and response protections without gateway login', async t => {
  const f = await fixture(t)
  const response = await request(f.port, f.authority, '/api//login?x=%2Fa&x=2', {
    method: 'POST', body: 'payload', headers: { origin: 'https://oauth-provider.test', cookie: 'connect.sid=value; dsh-auth-control=secret', authorization: 'Bearer app', 'x-forwarded-proto': 'garbage' },
  })
  assert.equal(response.status, 200)
  const result = JSON.parse(response.body)
  assert.equal(result.url, '/api//login?x=%2Fa&x=2'); assert.equal(result.body, 'payload')
  assert.equal(result.headers.host, f.authority); assert.equal(result.headers['x-forwarded-port'], String(f.port))
  assert.equal(result.headers['x-forwarded-proto'], 'http')
  assert.equal(result.headers.cookie, 'connect.sid=value'); assert.equal(result.headers.authorization, 'Bearer app')
  assert.deepEqual(response.headers['set-cookie'], ['connect.sid=app-session; Path=/; HttpOnly'])
  assert.equal(response.headers.location, '/login'); assert.equal(response.headers['x-frame-options'], 'SAMEORIGIN')
  assert.equal(response.headers['content-security-policy'], "default-src 'self'")
  assert.equal((await request(f.port, 'evil.test:' + f.port)).status, 404)
  assert.equal((await request(f.port, '127.0.0.1:' + (f.port + 1))).status, 404)
  assert.equal((await request(f.port, f.authority, '/__dsh_apps/session')).status, 404)
  f.unavailable(); assert.equal((await request(f.port, f.authority)).status, 502)
})

test('generic WebSockets relay real masked frames; removal closes active sockets and releases port', async t => {
  const f = await fixture(t)
  const socket = net.connect(f.port, '127.0.0.1')
  t.after(() => socket.destroy())
  await new Promise((resolve, reject) => {
    socket.on('error', reject)
    socket.write(`GET /arbitrary/ws?x=1 HTTP/1.1\r\nHost: ${f.authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer app\r\n\r\n`)
    let upgraded = false, bytes = Buffer.alloc(0)
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk])
      if (!upgraded) {
        const end = bytes.indexOf('\r\n\r\n'); if (end < 0) return
        assert.match(bytes.toString(), /^HTTP\/1.1 101/); upgraded = true; bytes = bytes.subarray(end + 4)
        const mask = Buffer.from([1, 2, 3, 4]), body = Buffer.from('ping')
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4]
        socket.write(Buffer.concat([Buffer.from([0x81, 0x84]), mask, body]))
      }
      if (bytes.length >= 6) { assert.equal(bytes.subarray(2, 6).toString(), 'pong'); resolve() }
    })
  })
  assert.equal(f.seen[0].url, '/arbitrary/ws?x=1')
  const ended = new Promise(resolve => socket.once('close', resolve))
  await f.pool.reconcile([]); await ended
  const rebound = http.createServer(); await new Promise((resolve, reject) => { rebound.once('error', reject); rebound.listen(f.port, '127.0.0.1', resolve) }); await close(rebound)
})

test('IPv6 harness defaults bind an actual IPv6 app listener', async t => {
  const port = await freePort()
  const upstream = http.createServer((_req, res) => res.end('ipv6-app'))
  const backend = await listen(upstream)
  const config = gatewayConfig({ controlOrigin: 'http://[::1]:3080', appPortStart: port, appPortEnd: port }, {})
  const pool = new PortListeners({ config, endpointFor: async () => ({ hostAddress: '127.0.0.1', port: backend }) })
  t.after(async () => { await pool.close(); await close(upstream) })
  const [app] = describeApps([{ ...raw('a'), appPort: port }], config)
  assert.equal((await pool.reconcile([app]))[0].launch.mode, 'ports')
  const result = await new Promise((resolve, reject) => {
    http.get({ hostname: '::1', port, path: '/', headers: { host: `[::1]:${port}` } }, res => {
      let body = ''; res.on('data', b => { body += b }); res.on('end', () => resolve({ status: res.statusCode, body }))
    }).on('error', reject)
  })
  assert.deepEqual(result, { status: 200, body: 'ipv6-app' })
})

test('occupied durable port is unavailable, never silently reassigned, and retry recovers', async t => {
  const server = http.createServer(), port = await listen(server)
  const config = gatewayConfig({ controlOrigin: 'http://127.0.0.1:3080', appListenHost: '127.0.0.1', appPortStart: port, appPortEnd: port }, {})
  const pool = new PortListeners({ config, endpointFor: async () => null })
  t.after(() => pool.close())
  const apps = describeApps([{ ...raw('a'), appPort: port }], config)
  assert.equal((await pool.reconcile(apps))[0].launch.mode, 'unavailable')
  await close(server)
  assert.equal((await pool.reconcile(apps))[0].launch.port, port)
})

test('replacement drains old streams at the same port; concurrent reconcile/dispose leaves no listener', async t => {
  const f = await fixture(t)
  const replacement = { ...f.app, launch: { ...f.app.launch, identity: 'replacement' } }
  await Promise.all([f.pool.reconcile([f.app]), f.pool.reconcile([replacement])])
  assert.equal(f.pool.listeners.size, 1)
  assert.equal(f.pool.listeners.get(f.port).identity, 'replacement')
  const starting = f.pool.reconcile([replacement])
  await f.pool.close(); await starting
  const rebound = http.createServer()
  await new Promise((resolve, reject) => { rebound.once('error', reject); rebound.listen(f.port, '127.0.0.1', resolve) }); await close(rebound)
})

test('HTTPS requires TLS or explicit ingress termination; range generator preserves app authority', async () => {
  await assert.rejects(portTls({ controlOrigin: 'https://harness.test' }, {}), /HTTPS app ports require/)
  assert.equal(await portTls({ controlOrigin: 'https://harness.test', appTlsTermination: 'ingress' }, {}), undefined)
  const conf = portIngress({ controlOrigin: 'https://harness.test', upstream: '172.18.0.4', cert: '/cert/fullchain.pem', key: '/cert/privkey.pem', start: 20000, end: 20002 })
  assert.equal((conf.match(/listen \d+ ssl;/g) || []).length, 3)
  assert.ok(conf.includes('proxy_pass http://172.18.0.4:$server_port;'))
  assert.ok(conf.includes('proxy_set_header Host $http_host;'))
  assert.ok(!conf.includes('Authorization'))
  assert.throws(() => portIngress({ controlOrigin: 'https://harness.test', upstream: '172.18.0.4;bad', cert: '/cert', key: '/key' }), /private DSH IP/)
})

test('direct HTTPS listener reuses a host certificate across assigned ports', async t => {
  const root = await temporary(t)
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'key'), '-out', path.join(root, 'cert'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' })
  const tls = { key: await fs.readFile(path.join(root, 'key')), cert: await fs.readFile(path.join(root, 'cert')) }
  const f = await fixture(t, { tls, origin: 'https://127.0.0.1:3080' })
  const response = await request(f.port, f.authority, '/asset.js', { https: true })
  assert.equal(response.status, 200)
  assert.equal(JSON.parse(response.body).headers['x-forwarded-proto'], 'https')
})
