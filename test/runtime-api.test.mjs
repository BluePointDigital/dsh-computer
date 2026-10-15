import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { AppManager } from '../lib/app-manager.js'
const original = childProcess.execFile
childProcess.execFile = (_bin, _args, _opts, callback) => queueMicrotask(() => callback(Object.assign(Error('old catalog broken'), { code: 1 }), '', 'bad old catalog'))
syncBuiltinESMExports()
const { apply } = await import('../lib/index.js')
const CID = 'a'.repeat(64), OTHER = 'b'.repeat(64)
const info = { Id: CID, Name: '/ordinary-app', Config: { Image: 'nginx:alpine', ExposedPorts: { '80/tcp': {} }, Labels: {}, Env: ['PASSWORD=private'] }, HostConfig: {}, State: { Running: true, Status: 'running' }, Mounts: [], NetworkSettings: { Networks: { bridge: { IPAddress: '127.0.0.1' } } } }

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-api-')), old = process.env.COMPUTER_APPS_STATE
  process.env.COMPUTER_APPS_STATE = root
  // RuntimeInventory default uses module executor; provide a temporary docker CLI
  // shim instead of replacing its private implementation.
  const bin = path.join(root, 'docker')
  await fs.writeFile(bin, `#!/usr/bin/env node\nconst args=process.argv.slice(2);const fs=require('fs');fs.appendFileSync(${JSON.stringify(path.join(root, 'calls'))},JSON.stringify(args)+'\\n');if(args[0]==='ps')console.log(${JSON.stringify(CID)});else if(args[0]==='inspect')console.log(JSON.stringify([${JSON.stringify(info)}]));else if(args[0]==='stats')console.log(JSON.stringify({Name:'ordinary-app',CPUPerc:'1%',MemUsage:'1MiB / 512MiB'}));else if(['start','stop','restart','rm'].includes(args[0]))console.log('ok');else process.exit(1);`, { mode: 0o755 })
  const oldPath = process.env.PATH; process.env.PATH = `${root}:${oldPath}`
  const routes = new Map(), upgrades = new Map(), disposers = []
  const ctx = { logger: { info() {} }, connection: { requestRejection: req => req.headers['x-auth'] === 'yes' ? undefined : 401 }, effect(fn) { const d = fn(); if (d) disposers.push(d) }, webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) }, registerUpgrade(route) { upgrades.set(route.path, route); return () => upgrades.delete(route.path) } } }
  const server = http.createServer((req, res) => {
    const route = routes.get(req.url.startsWith('/apps/assets') ? '/apps/assets' : '/apps/api')
    Promise.resolve(route.handler(req, res)).catch(error => res.writeHead(500).end(error.message))
  })
  await apply(ctx, { computerBin: 'broken-catalog' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  t.after(async () => {
    while (disposers.length) await disposers.pop()()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    process.env.PATH = oldPath
    if (old === undefined) delete process.env.COMPUTER_APPS_STATE; else process.env.COMPUTER_APPS_STATE = old
    childProcess.execFile = original; syncBuiltinESMExports()
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'dsh-runtime-api-'))); await fs.rm(root, { recursive: true, force: true })
  })
  const request = (pathname, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: body ? 'POST' : 'GET', headers: { 'x-auth': 'yes', ...(body ? { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''; res.on('data', b => { text += b }); res.on('end', () => { let json; try { json = JSON.parse(text) } catch {} resolve({ status: res.statusCode, json, text }) })
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined)
  })
  return { request, root, upgrades }
}

test('runtime inventory bypasses broken catalog, exposes every container, authenticates owner actions and assets', async t => {
  const { request, root, upgrades } = await setup(t)
  assert.equal((await request('/apps/api/runtime/inventory', undefined, { 'x-auth': 'no' })).status, 401)
  const inventory = await request('/apps/api/runtime/inventory')
  assert.equal(inventory.status, 200, inventory.text)
  assert.equal(inventory.json.apps.length, 1)
  const app = inventory.json.apps[0]
  assert.equal(app.name, 'ordinary-app'); assert.equal(app.services[0].containerId, CID)
  assert.ok(inventory.json.warnings.length)
  assert.ok(!JSON.stringify(inventory.json).includes('private'))
  const details = await request('/apps/api/runtime/details?id=' + app.id)
  assert.equal(details.status, 200, details.text)
  assert.equal(details.json.stats[0].CPUPerc, '1%')
  assert.equal((await request('/apps/api/runtime/action', { id: app.id, action: 'stop' }, { origin: 'https://evil.test' })).status, 403)
  const action = await request('/apps/api/runtime/action', { id: app.id, action: 'restart' })
  assert.equal(action.status, 200, action.text)
  const executed = (await fs.readFile(path.join(root, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(executed.some(args => args[0] === 'restart' && args[1] === CID))
  assert.equal((await request('/apps/api/runtime/action', { id: app.id, action: 'stop', container: OTHER })).status, 500)
  assert.equal((await request('/apps/assets/xterm.js')).status, 200)
  assert.ok(upgrades.has('/apps/terminal'))
})
