import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import { dockerFixture, containerInfo } from './helpers/docker-fixture.mjs'
const { apply } = await import('../lib/index.js')
const CID = 'a'.repeat(64), OTHER = 'b'.repeat(64)
const info = containerInfo(CID, 'ordinary-app', 80)
info.Config.Env = ['PASSWORD=private']

async function setup(t) {
  let containers = [info]
  const fixture = await dockerFixture(t, { containers: () => containers })
  // A malformed flat catalog must not suppress authoritative all-container discovery.
  await fs.writeFile(fixture.catalogPath, 'apps:\n  - id: invalid\n    malformed flat field\n')
  const routes = new Map(), upgrades = new Map(), disposers = []
  const ctx = { logger: { info() {} }, connection: { requestRejection: req => req.headers['x-auth'] === 'yes' ? undefined : 401 }, effect(fn) { const d = fn(); if (d) disposers.push(d) }, webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) }, registerUpgrade(route) { upgrades.set(route.path, route); return () => upgrades.delete(route.path) } } }
  const server = http.createServer((req, res) => {
    const route = routes.get(req.url.startsWith('/apps/assets') ? '/apps/assets' : '/apps/api')
    Promise.resolve(route.handler(req, res)).catch(error => res.writeHead(500).end(error.message))
  })
  fixture.disposers.push(async () => {
    while (disposers.length) await disposers.pop()()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  })
  await apply(ctx, { computerBin: 'must-not-execute' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const request = (pathname, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: body ? 'POST' : 'GET', headers: { 'x-auth': 'yes', ...(body ? { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''; res.on('data', b => { text += b }); res.on('end', () => { let json; try { json = JSON.parse(text) } catch {} resolve({ status: res.statusCode, json, text }) })
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined)
  })
  return { request, fixture, upgrades, setContainers: value => { containers = value } }
}

test('inventory refresh reconciles newly discovered legacy websocket routes and removes obsolete routes',async t=>{
 const {request,fixture,upgrades,setContainers}=await setup(t)
 await request('/apps/api/list')
 const desktop=containerInfo(OTHER,'dsh-app-desktop',6080)
 await fixture.writeCatalog([{id:'desktop',image:'desktop:1',viewer:'6081:6080'}])
 setContainers([info,desktop])
 const data=await request('/apps/api/runtime/inventory?refresh=1')
 assert.equal(data.status,200,data.text)
 assert.ok(upgrades.has('/apps/web/desktop/websockify'))
 setContainers([info]);await request('/apps/api/runtime/inventory?refresh=1')
 assert.ok(!upgrades.has('/apps/web/desktop/websockify'))
})

test('runtime inventory bypasses broken catalog, exposes every container, authenticates owner actions and assets', async t => {
  const { request, fixture, upgrades } = await setup(t)
  assert.equal((await request('/apps/api/runtime/inventory', undefined, { 'x-auth': 'no' })).status, 401)
  const listed = await request('/apps/api/list')
  assert.equal(listed.status, 200, listed.text)
  assert.equal(listed.json.apps.length, 1, 'ordinary list discovers all containers before any runtime route is requested')
  assert.equal(listed.json.apps[0].services[0].containerId, CID)
  const inventory = await request('/apps/api/runtime/inventory')
  assert.equal(inventory.status, 200, inventory.text)
  assert.equal(inventory.json.apps.length, 1)
  const app = inventory.json.apps[0]
  assert.equal(app.name, 'ordinary-app'); assert.equal(app.services[0].containerId, CID)
  assert.ok(inventory.json.warnings.some(warning => /catalog/i.test(warning)))
  assert.ok(!JSON.stringify(inventory.json).includes('private'))
  const before = fixture.calls.length
  const details = await request('/apps/api/runtime/details?id=' + app.id)
  assert.equal(details.status, 200, details.text)
  assert.ok(!JSON.stringify(details.json).includes('private'))
  assert.deepEqual(details.json.stats, [])
  assert.equal(fixture.calls.length, before, 'details reuse the inventory snapshot without Docker requests')
  const stats = await request('/apps/api/runtime/stats?id=' + app.id)
  assert.equal(stats.status, 200, stats.text)
  assert.equal(stats.json.stats[0].CPUPerc, '2.00%')
  assert.equal(stats.json.stats[0].MemUsage, '1.0 MiB / 512.0 MiB')
  assert.ok(fixture.calls.some(call => call.path === `/v1.41/containers/${CID}/stats`))
  const mutations = () => fixture.calls.filter(call => ['POST', 'DELETE'].includes(call.method))
  assert.equal((await request('/apps/api/runtime/action', { id: app.id, action: 'stop' }, { origin: 'https://evil.test' })).status, 403)
  assert.equal(mutations().length, 0)
  const action = await request('/apps/api/runtime/action', { id: app.id, action: 'restart' })
  assert.equal(action.status, 200, action.text)
  assert.deepEqual(mutations().map(({ method, path }) => ({ method, path })), [{ method: 'POST', path: `/v1.41/containers/${CID}/restart` }])
  assert.equal((await request('/apps/api/runtime/action', { id: app.id, action: 'stop', container: OTHER })).status, 500)
  assert.equal(mutations().length, 1, 'foreign container must not reach a mutation endpoint')
  const logs = await request('/apps/api/runtime/action', { id: app.id, action: 'logs' })
  assert.equal(logs.status, 200, logs.text)
  assert.equal(logs.json.output, 'fixture log\n')
  for (const action of ['start', 'stop', 'remove']) {
    const result = await request('/apps/api/runtime/action', { id: app.id, action })
    assert.equal(result.status, 200, result.text)
  }
  assert.deepEqual(mutations().map(({ method, path, query }) => ({ method, path, query })), [
    { method: 'POST', path: `/v1.41/containers/${CID}/restart`, query: {} },
    { method: 'POST', path: `/v1.41/containers/${CID}/start`, query: {} },
    { method: 'POST', path: `/v1.41/containers/${CID}/stop`, query: {} },
    { method: 'DELETE', path: `/v1.41/containers/${CID}`, query: { v: '0', force: '1' } },
  ], 'lifecycle uses immutable HTTP targets and retains volumes by default')
  assert.equal((await request('/apps/assets/xterm.js', undefined, { 'x-auth': 'no' })).status, 401)
  assert.equal((await request('/apps/assets/xterm.js')).status, 200)
  assert.ok(upgrades.has('/apps/terminal'))
  assert.ok(fixture.calls.some(call => call.path === '/version'))
  assert.ok(fixture.calls.some(call => call.path === '/v1.41/containers/json'))
  assert.ok(fixture.calls.filter(call => /\/containers\/[^/]+\/json$/.test(call.path)).every(call => call.path === `/v1.41/containers/${CID}/json`))
  assert.deepEqual(fixture.nativeCalls, [])
})
