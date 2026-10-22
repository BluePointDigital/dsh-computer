/** Private, local-only Engine daemon for route integration tests. Never contacts Docker. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

export async function dockerFixture(t, { containers = () => [], catalog = [], stats, logs = 'fixture log\n', inspect } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-engine-fixture-'))
  await fs.chmod(root, 0o700)
  const socketPath = path.join(root, 'docker.sock'), catalogPath = path.join(root, 'apps.yaml')
  const env = new Map(['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_API_VERSION', 'COMPUTER_APPS_STATE', 'COMPUTER_APPS_FILE'].map(key => [key, process.env[key]]))
  const calls = [], nativeCalls = [], errors = [], sockets = new Set(), disposers = []
  const originals = new Map(['execFile', 'exec', 'spawn', 'execFileSync', 'execSync', 'spawnSync'].map(key => [key, childProcess[key]]))
  const fixture = {
    root, socketPath, catalogPath, calls, nativeCalls, errors, disposers,
    beforeList: null,
    async writeCatalog(apps) {
      const lines = ['apps:']
      for (const app of apps) {
        lines.push(`  - id: ${app.id}`)
        for (const [key, value] of Object.entries(app)) {
          if (key === 'id' || value === undefined) continue
          const text = key === 'web' && typeof value === 'object' ? `${value.containerPort}:${value.containerPort}` : Array.isArray(value) ? value.join(' ') : String(value)
          lines.push(`    ${key}: ${text}`)
        }
      }
      await fs.writeFile(catalogPath, lines.join('\n') + '\n', { mode: 0o600 })
    },
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture.local')
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const text = Buffer.concat(chunks).toString(), body = text ? JSON.parse(text) : undefined
      calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body })
      const json = (value, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
      if (req.method === 'GET' && url.pathname === '/version') return json({ ApiVersion: '1.41', MinAPIVersion: '1.41' })
      assert.ok(url.pathname.startsWith('/v1.41/'), `Unexpected API version: ${req.url}`)
      if (req.method === 'GET' && url.pathname === '/v1.41/containers/json') {
        assert.ok(['1', 'true'].includes(url.searchParams.get('all')), 'inventory must always request all containers')
        await fixture.beforeList?.()
        return json(containers().map(info => ({ Id: info.Id, Names: [info.Name], State: info.State?.Status, Labels: info.Config?.Labels ?? {} })))
      }
      const match = /^\/v1\.41\/containers\/([a-f0-9]{64})(?:\/(json|stats|logs|start|stop|restart))?$/.exec(url.pathname)
      assert.ok(match, `Unexpected Engine endpoint: ${req.method} ${req.url}`)
      const [, id, operation] = match
      const info = inspect && operation === 'json' ? inspect(id) : containers().find(info => info.Id === id)
      if (!info) return json({ message: 'No such container' }, 404)
      if (req.method === 'GET' && operation === 'json') return json(info)
      if (req.method === 'GET' && operation === 'stats') {
        assert.ok(['false', '0'].includes(url.searchParams.get('stream')))
        return json(stats ?? { id, name: info.Name, cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 20000, online_cpus: 2 }, precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 10000 }, memory_stats: { usage: 1048576, limit: 536870912, stats: {} } })
      }
      if (req.method === 'GET' && operation === 'logs') {
        const bytes = Buffer.from(logs), header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(bytes.length, 4)
        return res.writeHead(200, { 'content-type': 'application/vnd.docker.raw-stream' }).end(info.Config?.Tty ? bytes : Buffer.concat([header, bytes]))
      }
      if (req.method === 'POST' && ['start', 'stop', 'restart'].includes(operation) || req.method === 'DELETE' && operation === undefined) return res.writeHead(204).end()
      assert.fail(`Unexpected Engine method: ${req.method} ${req.url}`)
    } catch (error) { errors.push(error); if (!res.headersSent) res.writeHead(500); res.end('fixture rejected request') }
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  // Registered first so test-specific servers/effects can be registered with defer().
  t.after(async () => {
    try {
      while (disposers.length) await disposers.pop()()
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
      for (const [key, value] of env) if (value === undefined) delete process.env[key]; else process.env[key] = value
      for (const [key, value] of originals) childProcess[key] = value
      syncBuiltinESMExports()
      assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('dsh-engine-fixture-'))
      await fs.rm(root, { recursive: true, force: true })
    }
    assert.deepEqual(errors, [], 'all Docker requests must match the fixture protocol')
    assert.deepEqual(nativeCalls, [], 'runtime routes must never invoke native subprocesses')
  })
  await fixture.writeCatalog(catalog)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  await fs.chmod(socketPath, 0o600)
  for (const key of env.keys()) delete process.env[key]
  Object.assign(process.env, { DOCKER_HOST: `unix://${socketPath}`, COMPUTER_APPS_STATE: root, COMPUTER_APPS_FILE: catalogPath })
  for (const key of originals.keys()) childProcess[key] = (...args) => {
    // AppManager's kernel lock carrier is not a Docker/runtime subprocess.
    if (key === 'spawn' && args[0] === 'flock') return originals.get(key)(...args)
    nativeCalls.push({ method: key, bin: args[0] })
    const error = new Error(`Unexpected native subprocess: ${key} ${args[0]}`), callback = args.at(-1)
    if (typeof callback === 'function') { queueMicrotask(() => callback(error, '', '')); return }
    throw error
  }
  syncBuiltinESMExports()
  return fixture
}

export function containerInfo(id, name, port, running = true) {
  return { Id: id, Name: `/${name}`, Config: { Image: 'fixture:1', ExposedPorts: port ? { [`${port}/tcp`]: {} } : {}, Labels: {}, Env: [] }, HostConfig: {}, State: { Running: running, Status: running ? 'running' : 'exited' }, Mounts: [], NetworkSettings: { Networks: { bridge: { IPAddress: '127.0.0.1' } } } }
}
