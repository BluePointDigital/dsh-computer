/** Real apply() wiring, isolated private servers, mocked CLI/Docker only. */
import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

let apps = [], actualId = 'a'.repeat(64), running = true, inspectTargets = []
childProcess.execFile = (bin, args, _opts, callback) => {
  if (bin === 'docker') inspectTargets.push(args.at(-1))
  const out = bin === 'docker'
    ? JSON.stringify({ Id: actualId, State: { Running: running }, NetworkSettings: { Networks: { bridge: { IPAddress: '127.0.0.1' } } } })
    : JSON.stringify({ ok: true, apps })
  queueMicrotask(() => callback(null, out, ''))
}
syncBuiltinESMExports()
const { apply } = await import('../lib/index.js')
const config = { computerBin: 'fixture-cli', appDomain: 'control.example.org', controlOrigin: 'https://control.example.org', appListenHost: '127.0.0.1', appListenPort: 0 }
function context() {
  const routes = new Map(), upgrades = new Map(), disposers = [], logs = []
  let announce
  const ready = new Promise(resolve => { announce = resolve })
  const ctx = {
    logger: { info(...parts) { const line = parts.join(' '); logs.push(line); const match = /isolated gateway listening on 127\.0\.0\.1:(\d+)/.exec(line); if (match) announce(Number(match[1])) } },
    connection: { requestRejection: req => req.headers['x-auth'] === 'yes' ? undefined : 401 },
    effect(fn) { const d = fn(); if (d) disposers.push(d) },
    webServer: {
      register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
      registerUpgrade(route) { upgrades.set(route.path, route); return () => upgrades.delete(route.path) },
    },
  }
  return { ctx, routes, upgrades, ready, logs, async dispose() { while (disposers.length) await disposers.pop()() } }
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
function request(port, url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, res => {
      let text = ''; res.on('data', b => { text += b }); res.on('end', () => {
        let json; try { json = JSON.parse(text) } catch {}
        resolve({ status: res.statusCode, text, json, headers: res.headers })
      })
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
async function setup(t, options = config) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gateway-apply-'))
  const old = process.env.COMPUTER_APPS_STATE
  process.env.COMPUTER_APPS_STATE = root
  const instance = context()
  const front = http.createServer((req, res) => {
    const route = instance.routes.get(req.url.startsWith('/apps/api') ? '/apps/api' : '/apps/web')
    if (!route) return res.writeHead(404).end()
    Promise.resolve(route.handler(req, res)).catch(() => res.destroy())
  })
  t.after(async () => {
    await instance.dispose(); await close(front)
    if (old === undefined) delete process.env.COMPUTER_APPS_STATE; else process.env.COMPUTER_APPS_STATE = old
    assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), 'dsh-gateway-apply-')))
    await fs.rm(root, { recursive: true, force: true })
  })
  await apply(instance.ctx, options)
  const port = await listen(front)
  return { ...instance, port }
}
const auth = { 'x-auth': 'yes' }
const launch = { ...auth, origin: config.controlOrigin, 'content-type': 'application/json' }

test('apply owns authenticated isolated gateway and disables BOTH legacy transports', { timeout: 10000 }, async t => {
  const upstream = http.createServer((req, res) => res.end(JSON.stringify({ url: req.url, host: req.headers.host })))
  const upstreamPort = await listen(upstream)
  t.after(() => close(upstream))
  actualId = 'a'.repeat(64); inspectTargets = []
  apps = [{ id: 'files', containerId: actualId, web: { webHost: 'obsolete.example.test', containerPort: upstreamPort, path: '/apps/web/files/' }, webSockets: ['/ws'] }]
  const instance = await setup(t)
  const gatewayPort = await instance.ready
  const req = (url, options) => request(instance.port, '/apps/api/' + url, options)
  assert.equal((await req('list')).status, 401)
  const listed = await req('list', { headers: auth })
  const descriptor = listed.json.apps[0].launch
  assert.equal(descriptor.mode, 'isolated')
  assert.equal(descriptor.host.split('.').slice(1).join('.'), new URL(config.controlOrigin).hostname)
  assert.deepEqual([...instance.upgrades.keys()], ['/apps/terminal'], 'only authenticated management terminal, no app WS bypass')
  assert.equal((await request(instance.port, '/apps/web/files/', { headers: auth })).status, 410)
  assert.equal((await request(gatewayPort, '/', { headers: { host: descriptor.host } })).status, 401)
  assert.equal((await request(gatewayPort, '/', { headers: { host: 'obsolete.example.test' } })).status, 404)
  for (const origin of [undefined, 'null', 'http://control.example.org', 'https://evil.example.org', descriptor.origin]) {
    const headers = { ...launch }; if (origin === undefined) delete headers.origin; else headers.origin = origin
    assert.equal((await req('launch', { method: 'POST', headers, body: { id: 'files' } })).status, 403)
  }
  assert.equal((await req('launch', { method: 'POST', headers: { ...launch, 'x-auth': 'no' }, body: { id: 'files' } })).status, 401)
  const issued = await req('launch', { method: 'POST', headers: launch, body: { id: 'files' } })
  assert.equal(issued.status, 200)
  const ticket = new URL(issued.json.url).hash.slice(1)
  assert.equal((await request(gatewayPort, '/__dsh_apps/launch', { headers: { host: descriptor.host } })).status, 200)
  const session = await request(gatewayPort, '/__dsh_apps/session', { method: 'POST', headers: { host: descriptor.host, origin: descriptor.origin, 'content-type': 'application/json' }, body: { ticket } })
  assert.equal(session.status, 200)
  const cookie = session.headers['set-cookie'][0].split(';')[0]
  const app = await request(gatewayPort, '/api/root?path=%2Fa', { headers: { host: descriptor.host, cookie } })
  assert.equal(app.status, 200); assert.equal(app.json.url, '/api/root?path=%2Fa'); assert.equal(app.json.host, descriptor.host)
  assert.ok(inspectTargets.length > 0 && inspectTargets.every(target => target === actualId), 'only immutable IDs may be inspected')
  assert.equal((await req('open?id=files', { headers: { ...auth, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'iframe' } })).status, 403)
  for (const site of ['cross-site', 'same-site']) {
    assert.equal((await req('open?id=files', { headers: { ...auth, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': site } })).status, 403)
  }
  const top = await req('open?id=files', { headers: { ...auth, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' } })
  assert.equal(top.status, 303); assert.equal(new URL(top.headers.location).origin, descriptor.origin)
  assert.equal(top.headers['cache-control'], 'no-store')
  // A stale network address must not make a stopped container launchable.
  running = false
  assert.equal((await req('launch', { method: 'POST', headers: launch, body: { id: 'files' } })).status, 503)
  assert.equal((await request(gatewayPort, '/', { headers: { host: descriptor.host, cookie } })).status, 502)
  running = true
  // The catalog still describes the original identity; the daemon is authoritative.
  actualId = 'b'.repeat(64)
  assert.equal((await request(gatewayPort, '/api/root', { headers: { host: descriptor.host, cookie } })).status, 502)
  assert.equal((await req('launch', { method: 'POST', headers: launch, body: { id: 'files' } })).status, 503)
  apps = [{ ...apps[0], containerId: actualId }]
  const replaced = await req('list', { headers: auth })
  assert.notEqual(replaced.json.apps[0].launch.origin, descriptor.origin)
  assert.equal((await request(gatewayPort, '/', { headers: { host: descriptor.host, cookie } })).status, 404)
  await instance.dispose()
  const rebound = http.createServer()
  await new Promise((resolve, reject) => { rebound.once('error', reject); rebound.listen(gatewayPort, '127.0.0.1', resolve) })
  await close(rebound)
})

test('legacy has no unauthenticated hostname listener; invalid opt-in config fails closed', async t => {
  apps = []
  const instance = await setup(t, { computerBin: 'fixture-cli' })
  assert.equal((await request(instance.port, '/apps/api/launch', { method: 'POST', headers: launch, body: { id: 'files' } })).status, 503)
  assert.ok(!instance.logs.some(line => /gateway listening|host mount listening/.test(line)))
  const bad = context()
  await assert.rejects(apply(bad.ctx, { ...config, appListenPort: 'invalid' }), /must be a port/)
  assert.equal(bad.routes.size, 0)
})

test('apply launches trusted apps on durable harness ports, persists CLI policy and owns disposal', async t => {
  const upstream = http.createServer((req, res) => res.end(JSON.stringify({ url: req.url, host: req.headers.host })))
  const upstreamPort = await listen(upstream)
  t.after(() => close(upstream))
  const probe = http.createServer(), chosen = await listen(probe); await close(probe)
  actualId = 'a'.repeat(64); running = true
  apps = [{ id: 'files', containerId: actualId, web: { containerPort: upstreamPort, path: '/apps/web/files/' }, webSockets: ['/ws'] }]
  const options = { computerBin: 'fixture-cli', appAccess: 'ports', controlOrigin: 'http://127.0.0.1:3080', appListenHost: '127.0.0.1', appPortStart: chosen, appPortEnd: chosen }
  const instance = await setup(t, options)
  const listed = await request(instance.port, '/apps/api/list', { headers: auth })
  assert.equal(listed.status, 200)
  const descriptor = listed.json.apps[0].launch
  assert.equal(descriptor.mode, 'ports'); assert.equal(descriptor.origin, `http://127.0.0.1:${chosen}`)
  const saved = JSON.parse(await fs.readFile(path.join(process.env.COMPUTER_APPS_STATE, 'launch-config.json')))
  assert.equal(saved.appAccess, 'ports'); assert.equal(saved.appPortStart, chosen)
  assert.deepEqual([...instance.upgrades.keys()], ['/apps/terminal'])
  assert.equal((await request(instance.port, '/apps/web/files/', { headers: auth })).status, 410)
  const issued = await request(instance.port, '/apps/api/launch', { method: 'POST', headers: { ...auth, origin: options.controlOrigin, 'content-type': 'application/json' }, body: { id: 'files' } })
  assert.equal(issued.status, 200); assert.equal(issued.json.url, descriptor.origin + '/')
  const app = await request(chosen, '/root/asset?x=%2Fa')
  assert.equal(app.status, 200); assert.equal(app.json.url, '/root/asset?x=%2Fa'); assert.equal(app.json.host, `127.0.0.1:${chosen}`)
  assert.equal(app.headers['set-cookie'], undefined, 'no gateway session cookie')
  assert.equal((await request(instance.port, '/apps/api/open?id=files', { headers: auth })).headers.location, descriptor.origin + '/')
  running = false
  assert.equal((await request(chosen, '/')).status, 502)
  running = true
  await instance.dispose()
  const rebound = http.createServer()
  await new Promise((resolve, reject) => { rebound.once('error', reject); rebound.listen(chosen, '127.0.0.1', resolve) }); await close(rebound)
})

test('disposal awaits a listener still starting and releases its port', async t => {
  apps = []
  const probe = http.createServer(), chosen = await listen(probe); await close(probe)
  const instance = await setup(t, { ...config, appListenPort: chosen })
  await instance.dispose()
  const rebound = http.createServer()
  await new Promise((resolve, reject) => { rebound.once('error', reject); rebound.listen(chosen, '127.0.0.1', resolve) })
  await close(rebound)
})
