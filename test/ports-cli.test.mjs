import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gatewayConfig, describeApps } from '../lib/app-launch.js'
const exec = promisify(execFile)
const cli = new URL('../bin/app-cli.mjs', import.meta.url).pathname
const computer = new URL('../bin/computer', import.meta.url).pathname
const CID = 'a'.repeat(64), VIEWER = 'b'.repeat(64), OTHER = 'c'.repeat(64)
const container = (id, name, port = 80, labels = {}) => ({
  Id: id, Name: '/' + name, Image: 'sha256:' + 'f'.repeat(64),
  Config: { Image: 'fixture:latest', Labels: labels, ExposedPorts: { [`${port}/tcp`]: {} }, Env: ['PASSWORD=never-public'], Tty: true },
  HostConfig: { AutoRemove: false, PortBindings: {} }, State: { Status: 'running', Running: true }, Mounts: [],
  NetworkSettings: { Ports: {}, Networks: { bridge: { IPAddress: '127.0.0.1' } } },
})
async function fixture(t, infos = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ports-cli-'))
  const state = path.join(root, 'state'); await fs.mkdir(state, { mode: 0o700 })
  const catalog = path.join(root, 'apps.yaml')
  await fs.writeFile(catalog, 'apps:\n  - id: web\n    image: fixture\n    web: 8090:80\n  - id: viewer\n    image: fixture\n    viewer: 6081:6080\n')
  await fs.writeFile(path.join(state, 'launch-config.json'), JSON.stringify({ appAccess: 'ports', controlOrigin: 'https://harness.example', appPortStart: 21000, appPortEnd: 21009 }))
  // A tripwire, not a mock: all successful runtime operations must use HTTP.
  const tripwire = path.join(root, 'subprocess-used')
  await fs.writeFile(path.join(root, 'docker'), `#!/bin/sh\nprintf unexpected >> '${tripwire}'\nexit 97\n`, { mode: 0o755 })
  const socket = path.join(root, 'docker.sock'), calls = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://daemon'), pathname = url.pathname.replace(/^\/v1\.\d+/, '')
    calls.push({ method: req.method, pathname, search: url.search })
    const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (pathname === '/version') return json({ ApiVersion: '1.47', MinAPIVersion: '1.41' })
    if (pathname === '/containers/json') return json(infos.map(info => ({ Id: info.Id, Names: [info.Name], Labels: info.Config.Labels, Image: info.Config.Image, State: info.State.Status })))
    const match = pathname.match(/^\/containers\/([^/]+)(?:\/(json|stats|logs|start|stop|restart))?$/)
    const info = match && infos.find(info => info.Id === decodeURIComponent(match[1]) || info.Name === '/' + decodeURIComponent(match[1]))
    if (info) {
      if (match[2] === 'json') return json(info)
      if (match[2] === 'stats') return json({ id: info.Id, name: info.Name, cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 1000, online_cpus: 2 }, precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500 }, memory_stats: { usage: 1048576, limit: 536870912 } })
      if (match[2] === 'logs') { res.writeHead(200, { 'content-type': 'application/vnd.docker.raw-stream' }); return res.end('fixture log line\n') }
      if (req.method === 'DELETE' || ['start', 'stop', 'restart'].includes(match[2])) { res.writeHead(204); return res.end() }
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'No such container' }))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('dsh-ports-cli-'))
    await fs.rm(root, { recursive: true, force: true })
  })
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, DOCKER_HOST: `unix://${socket}`, COMPUTER_APPS_FILE: catalog, COMPUTER_APPS_STATE: state, COMPUTER_BIND_IP: '127.0.0.1', DSH_HOME: root, DSH_PUBLIC_URL: 'https://harness.example' }
  for (const key of ['DSH_APPS_ACCESS', 'DSH_APPS_DOMAIN', 'DSH_APPS_CONTROL_ORIGIN', 'DSH_APPS_ORIGIN', 'COMPUTER_APPS_LEGACY', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_API_VERSION']) delete env[key]
  const run = async args => (await exec(process.execPath, [cli, ...args], { env })).stdout.trim()
  const noSubprocess = async () => assert.equal(await fs.stat(tripwire).then(() => true, () => false), false, 'Runtime spawned Docker CLI')
  return { root, state, catalog, env, run, calls, noSubprocess }
}

test('CLI shares saved range and assigned URLs for catalog web and viewer apps through Unix daemon', async t => {
  const f = await fixture(t, [container(CID, 'dsh-app-web'), container(VIEWER, 'dsh-app-viewer', 6080)])
  const listed = JSON.parse(await f.run(['list', '--json'])).apps
  const web = listed.find(app => app.id === 'web'), viewer = listed.find(app => app.id === 'viewer')
  assert.match(web.launch.origin, /^https:\/\/harness\.example:2100[0-9]$/)
  assert.notEqual(web.launch.origin, viewer.launch.origin)
  assert.equal(await f.run(['url', 'web']), web.launch.origin + '/')
  assert.match(await f.run(['url', 'viewer']), new RegExp('^' + viewer.launch.origin.replaceAll('.', '\\.') + '/vnc.html\\?'))
  const status = JSON.parse(await f.run(['status', 'web']))
  assert.equal(status.app.launch.origin, web.launch.origin)
  assert.ok(f.calls.some(call => call.pathname === '/containers/json'))
  await f.noSubprocess()
})

test('CLI honors saved server app origin with exact launch and viewer URL parity', async t => {
  const f = await fixture(t, [container(CID, 'dsh-app-web'), container(VIEWER, 'dsh-app-viewer', 6080)])
  const saved = { appAccess: 'ports', controlOrigin: 'https://dev.bluepointdigital.com', appOrigin: 'https://apps.dev.bluepointdigital.com', appPortStart: 21000, appPortEnd: 21009 }
  await fs.writeFile(path.join(f.state, 'launch-config.json'), JSON.stringify(saved))
  const apps = JSON.parse(await f.run(['list', '--json'])).apps
  const config = gatewayConfig(saved, {})
  assert.equal(config.controlOrigin, saved.controlOrigin)
  for (const app of apps) {
    const expected = describeApps([app], config)[0].launch
    assert.deepEqual(app.launch, expected)
    const url = new URL(await f.run(['url', app.id]))
    assert.equal(url.origin, app.launch.origin)
    assert.equal(url.hostname, 'apps.dev.bluepointdigital.com')
    assert.equal(url.href, new URL(expected.entryPath, expected.origin).href)
    assert.equal(JSON.parse(await f.run(['status', app.id])).app.launch.origin, expected.origin)
    if (app.viewer) {
      assert.equal(url.pathname, '/vnc.html')
      assert.equal(url.searchParams.get('host'), 'apps.dev.bluepointdigital.com')
      assert.equal(url.searchParams.get('port'), String(app.appPort))
      assert.equal(url.searchParams.get('encrypt'), '1')
    }
  }
  assert.equal(JSON.parse(await fs.readFile(path.join(f.state, 'launch-config.json'), 'utf8')).controlOrigin, saved.controlOrigin)
  await f.noSubprocess()
})

test('CLI discovers uncatalogued containers and runs lifecycle aliases/logs on immutable IDs via HTTP', async t => {
  const f = await fixture(t, [container(OTHER, 'ordinary-container')])
  const discovery = JSON.parse(await f.run(['discover']))
  const app = discovery.apps.find(app => app.services?.some(service => service.containerId === OTHER))
  assert.ok(app); assert.equal(app.name, 'ordinary-container')
  const status = JSON.parse(await f.run(['status', app.id]))
  assert.equal(status.app.containerId, OTHER)
  for (const [command, method, suffix] of [['up', 'POST', '/start'], ['start', 'POST', '/start'], ['down', 'POST', '/stop'], ['restart', 'POST', '/restart'], ['rm', 'DELETE', '']]) {
    const result = JSON.parse(await f.run([command, app.id]))
    assert.equal(result.ok, true, command)
    assert.ok(f.calls.some(call => call.method === method && call.pathname === `/containers/${OTHER}${suffix}`), command)
  }
  const logs = JSON.parse(await f.run(['logs', app.id, '--tail', '12']))
  assert.equal(logs.ok, true); assert.match(JSON.stringify(logs), /fixture log line/)
  assert.ok(f.calls.some(call => call.pathname.endsWith('/logs') && call.search.includes('tail=12')))
  await f.noSubprocess()
})

test('broken catalog yields warning while valid daemon containers remain discoverable', async t => {
  const f = await fixture(t, [container(OTHER, 'ordinary-container')])
  await fs.writeFile(f.catalog, 'apps:\nmalformed')
  const result = JSON.parse(await f.run(['list', '--json']))
  assert.equal(result.ok, true); assert.equal(result.apps.length, 1)
  assert.equal(result.apps[0].services[0].containerId, OTHER)
  assert.ok(result.warnings.length)
  assert.ok(!JSON.stringify(result).includes('never-public'))
  await f.noSubprocess()
})

test('initial daemon failure reports an error rather than claiming container absence or spawning legacy list', async t => {
  const f = await fixture(t)
  f.env.DOCKER_HOST = `unix://${path.join(f.root, 'missing.sock')}`
  await assert.rejects(f.run(['list', '--json']), error => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /Docker|daemon|connection/i)
    assert.equal(error.stdout, '')
    return true
  })
  await assert.rejects(f.run(['up', 'web']))
  await f.noSubprocess()
})

test('computer apps dispatch resolves direct, absolute, relative, chained and PATH symlinks with daemon metadata', async t => {
  const f = await fixture(t, [container(CID, 'dsh-app-fixture')])
  const links = path.join(f.root, 'links with spaces'); await fs.mkdir(links)
  await fs.writeFile(f.catalog, 'apps:\n  - id: fixture\n    name: Symlink Fixture\n    image: fixture\n')
  const absolute = path.join(links, 'absolute'), relative = path.join(links, 'relative'), chained = path.join(links, 'computer')
  await fs.symlink(computer, absolute)
  await fs.symlink(path.relative(links, computer), relative)
  await fs.symlink('relative', chained)
  f.env.PATH = `${links}:${f.env.PATH}`
  for (const executable of [computer, absolute, relative, chained, 'computer', './links with spaces/computer']) {
    const { stdout } = await exec(executable, ['apps', 'list', '--json'], { env: f.env, cwd: f.root })
    const result = JSON.parse(stdout)
    assert.equal(result.ok, true, executable)
    assert.equal(result.apps[0].name, 'Symlink Fixture', executable)
    assert.equal(result.apps[0].services[0].containerId, CID, executable)
  }
  await f.noSubprocess()
})
