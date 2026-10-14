/**
 * Integration: the host-mounted app effect, through `apply()`. Run:
 *   node --test test/host-mount-apply.test.mjs
 *
 * This file exists because unit tests of `lib/host-router.js` and
 * `lib/host-listen.js` cannot catch a missing import or a mis-wired effect in
 * `lib/index.js` — the module still parses and every unit test still passes. The
 * first version of this feature had exactly that bug (`indexHostApps` used but
 * never imported), found only by running the plugin.
 *
 * It is deliberately NOT in `upgrade-route.test.mjs`: that file's tests share a
 * mutable `delayed` callback queue, and a concurrently-running test there
 * swallows every CLI callback, which makes this effect's catalog read fail for
 * reasons that have nothing to do with host mounting. The shared state is the
 * other file's design; this file keeps its own so a failure here means what it
 * says.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const UPSTREAM_PORT = 8080
let apps = [{ id: 'files', image: 'fixture-image', web: { webHost: 'files.example.test', containerPort: UPSTREAM_PORT } }]

childProcess.execFile = (bin, args, _opts, callback) => {
  const out = bin === 'docker'
    ? JSON.stringify({ NetworkSettings: { Networks: { bridge: { IPAddress: '127.0.0.1' } } } })
    : JSON.stringify({ ok: true, apps })
  queueMicrotask(() => callback(null, out, ''))
}
syncBuiltinESMExports()
const { apply } = await import('../lib/index.js')

function context(logs) {
  const routes = new Map()
  const disposers = []
  const ctx = {
    logger: { info: (...parts) => logs.push(parts.join(' ')) },
    connection: { requestRejection: () => undefined },
    effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose) },
    webServer: {
      register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
      registerUpgrade() { return () => {} },
    },
  }
  return { ctx, routes, dispose: () => disposers.reverse().forEach((fn) => fn()) }
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

function request(port, host, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host, 'content-length': '0' } }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('apply() starts the host listener and routes by Host with no rewriting', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url, host: req.headers.host }))
  })
  const upstreamPort = await listen(upstream)
  apps = [{ id: 'files', image: 'fixture-image', web: { webHost: 'files.example.test', containerPort: upstreamPort } }]

  const previousPort = process.env.DSH_APPS_HOST_PORT
  const previousBind = process.env.DSH_APPS_HOST_BIND
  // Port 0 = let the OS choose. The real default (3099) may be in use, and a
  // test colliding on a fixed port is what produced a phantom failure earlier.
  process.env.DSH_APPS_HOST_PORT = '0'
  process.env.DSH_APPS_HOST_BIND = '127.0.0.1'

  const logs = []
  const instance = context(logs)
  try {
    await apply(instance.ctx, { computerBin: 'fixture-cli' })

    // The listener binds asynchronously; wait for it to announce its port. Entries
    // carry the `[dsh-applications]` prefix, so search the whole line.
    let port = 0
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && port === 0) {
      const line = logs.find((entry) => entry.includes('host mount listening on'))
      const match = line && /host mount listening on 127\.0\.0\.1:(\d+)/.exec(line)
      if (match) port = Number(match[1])
      else await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.ok(port > 0, `listener never announced a port; logs: ${JSON.stringify(logs)}`)

    // A root-absolute path must arrive unchanged. Under the path mount this same
    // request is the bug being fixed, so this assertion IS the feature.
    const api = await request(port, 'files.example.test', '/api/login', 'POST')
    assert.equal(api.status, 200)
    const echoed = JSON.parse(api.body)
    assert.equal(echoed.url, '/api/login', 'no mount may be added to the path')
    assert.equal(echoed.host, '127.0.0.1', 'the public hostname must not be forwarded')

    // The query string must survive too.
    const query = await request(port, 'files.example.test', '/api/raw?path=/a/b&x=1')
    assert.equal(JSON.parse(query.body).url, '/api/raw?path=/a/b&x=1')

    // An undeclared name must not reach any app.
    const stray = await request(port, 'other.example.test', '/api/login', 'POST')
    assert.equal(stray.status, 404)
    assert.match(stray.body, /no app is routed/)

    // Disposal must release the port, or a reload would leak a listener.
    instance.dispose()
    await new Promise((resolve) => setTimeout(resolve, 100))
  } finally {
    instance.dispose()
    if (previousPort === undefined) delete process.env.DSH_APPS_HOST_PORT
    else process.env.DSH_APPS_HOST_PORT = previousPort
    if (previousBind === undefined) delete process.env.DSH_APPS_HOST_BIND
    else process.env.DSH_APPS_HOST_BIND = previousBind
    await new Promise((resolve) => upstream.close(resolve))
  }
})

test('an unusable DSH_APPS_HOST_PORT disables the listener instead of crashing the plugin', async () => {
  const previous = process.env.DSH_APPS_HOST_PORT
  process.env.DSH_APPS_HOST_PORT = 'not-a-port'
  const logs = []
  const instance = context(logs)
  try {
    await apply(instance.ctx, { computerBin: 'fixture-cli' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(
      logs.some((entry) => entry.includes('host mount disabled')),
      `expected a clear refusal; logs: ${JSON.stringify(logs)}`,
    )
    // The plugin must still be usable: the path mount is the default and must not
    // depend on the host listener being up.
    assert.equal(instance.routes.has('/apps/web'), true)
  } finally {
    instance.dispose()
    if (previous === undefined) delete process.env.DSH_APPS_HOST_PORT
    else process.env.DSH_APPS_HOST_PORT = previous
  }
})
