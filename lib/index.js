/** Applications host plugin. Routes use DSH's public HTTP/upgrade APIs only. */
import { execFile } from 'node:child_process'
import { proxyHttp, proxyUpgrade, mountFor, featuresFor } from './proxy.js'

export const name = 'dsh-applications'
export const inject = ['webServer', 'webRuntime', 'connection']
const DEFAULT_BIN = '/data/skills/docker-computer/bin/computer'
const ROUTE = '/apps/api'
const WEB_ROUTE = '/apps/web'
const ACTIONS = new Set(['up', 'down', 'rm'])
const APP_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const SOCKET_PATH = /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/
const REWRITE_PREFIX = /^\/(?:[A-Za-z0-9_-]+\/)+$/

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { resolve(null); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }
      catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

export function apply(ctx, config = {}) {
  const bin = typeof config.computerBin === 'string' ? config.computerBin : DEFAULT_BIN
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 180_000
  const log = (...args) => ctx.logger?.info?.('[dsh-applications]', ...args)
  const runCli = (args) => new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
      code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
      stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }))
  })
  const gate = (req) => typeof ctx.connection?.requestRejection === 'function'
    ? ctx.connection.requestRejection(req)
    : 503 // Never silently downgrade authentication to a Host-only fence.
  const deny = (res, code) => sendJson(res, code, { ok: false, error: code === 401 ? 'authentication required' : code === 503 ? 'authentication gate unavailable' : 'forbidden' })
  const rejectUpgrade = (socket, code) => socket.end(
    `HTTP/1.1 ${code} ${code === 401 ? 'Unauthorized' : code === 503 ? 'Service Unavailable' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  )
  const containerIp = (id) => new Promise((resolve) => {
    // Select one usable bridge address rather than concatenating multiple networks.
    execFile('docker', ['inspect', '-f', '{{json .NetworkSettings.Networks}}', `dsh-app-${id}`],
      { timeout: 10_000 }, (error, stdout) => {
        try {
          const networks = error ? {} : JSON.parse(String(stdout))
          resolve(Object.values(networks).find((network) => network.IPAddress)?.IPAddress ?? '')
        } catch { resolve('') }
      })
  })
  const socketPaths = (app) => Array.isArray(app.webSockets)
    ? [...new Set(app.webSockets.filter((path) => typeof path === 'string' && SOCKET_PATH.test(path)))] : []
  const rewritePrefixes = (app) => Array.isArray(app.webRewrite)
    ? [...new Set(app.webRewrite.filter((path) => typeof path === 'string' && REWRITE_PREFIX.test(path)))] : []

  let disposed = false
  const upgrades = new Map()
  const tunnels = new Set()
  const closeUpgrade = (pathname) => {
    const entry = upgrades.get(pathname)
    if (entry) { entry.dispose(); upgrades.delete(pathname) }
  }
  const reconcile = (apps) => {
    if (disposed) return
    const want = new Map()
    for (const app of apps) {
      const port = Number(app.web?.containerPort)
      if (!APP_ID.test(app.id) || !Number.isInteger(port) || port < 1 || port > 65535) continue
      for (const path of socketPaths(app)) want.set(`${mountFor(app.id)}${path}`, { id: app.id, port, path })
    }
    for (const pathname of [...upgrades.keys()]) if (!want.has(pathname)) closeUpgrade(pathname)
    for (const [pathname, policy] of want) {
      const existing = upgrades.get(pathname)
      if (existing) { existing.policy = policy; continue }
      const entry = { policy, dispose: () => {} }
      try {
        entry.dispose = ctx.webServer.registerUpgrade({ path: pathname, handler: async (req, socket, head) => {
          const rejection = gate(req)
          if (rejection !== undefined) { rejectUpgrade(socket, rejection); return }
          if (disposed || upgrades.get(pathname) !== entry) { socket.destroy(); return }
          // Revalidate against a fresh-enough catalog before dialing, even when
          // the browser retains a socket URL from a previous configuration.
          const apps = await appsJson()
          const app = apps.find((candidate) => candidate.id === entry.policy.id)
          if (disposed || upgrades.get(pathname) !== entry || !app || !socketPaths(app).includes(entry.policy.path)) {
            socket.destroy(); return
          }
          const ip = await containerIp(entry.policy.id)
          if (!ip || disposed || socket.destroyed || upgrades.get(pathname) !== entry) { socket.destroy(); return }
          const tunnel = proxyUpgrade(req, socket, head, {
            target: { hostname: ip, port: entry.policy.port, path: entry.policy.path, host: `${ip}:${entry.policy.port}` },
            mount: mountFor(entry.policy.id), log,
          })
          tunnels.add(tunnel)
          tunnel.once('close', () => tunnels.delete(tunnel))
        } })
        upgrades.set(pathname, entry)
      } catch (error) { log('cannot register upgrade route', pathname, String(error.message ?? error)) }
    }
  }

  let catalog = { at: 0, apps: [] }
  let loading = null
  const appsJson = (force = false) => {
    if (loading) return loading
    if (!force && Date.now() - catalog.at < 3000) return Promise.resolve(catalog.apps)
    loading = (async () => {
      const out = await runCli(['apps', 'list', '--json'])
      if (out.code !== 0) throw new Error(out.stderr.trim() || `catalog exited ${out.code}`)
      const parsed = JSON.parse(out.stdout)
      if (parsed.ok === false || !Array.isArray(parsed.apps)) throw new Error('invalid application catalog')
      if (!disposed) { catalog = { at: Date.now(), apps: parsed.apps }; reconcile(catalog.apps) }
      return parsed.apps
    })().finally(() => { loading = null })
    return loading
  }
  ctx.effect(() => () => {
    disposed = true
    for (const pathname of [...upgrades.keys()]) closeUpgrade(pathname)
    for (const tunnel of tunnels) tunnel.destroy()
    tunnels.clear()
  }, 'dsh-applications: socket route lifetime')

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: async (req, res) => {
    const rejection = gate(req)
    if (rejection !== undefined) { deny(res, rejection); return }
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const method = url.pathname.startsWith(`${ROUTE}/`) ? url.pathname.slice(ROUTE.length + 1) : ''
    try {
      if (method === 'list') {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        sendJson(res, 200, { ok: true, apps: await appsJson(true) })
        return
      }
      if (method === 'action') {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        const body = await readJsonBody(req)
        if (!body || typeof body !== 'object') { sendJson(res, 400, { ok: false, error: 'malformed JSON body' }); return }
        const action = typeof body.action === 'string' ? body.action : ''
        const id = typeof body.id === 'string' ? body.id : ''
        if (!ACTIONS.has(action)) { sendJson(res, 400, { ok: false, error: `action must be one of: ${[...ACTIONS].join(', ')}` }); return }
        if (!APP_ID.test(id)) { sendJson(res, 400, { ok: false, error: 'malformed app id' }); return }
        log('action', action, id)
        const out = await runCli(['apps', action, id])
        catalog.at = 0
        await appsJson(true)
        sendJson(res, out.code === 0 ? 200 : 500, { ok: out.code === 0, action, id, code: out.code, output: `${out.stdout}${out.stderr}`.trim() })
        return
      }
      sendJson(res, 404, { ok: false, error: 'unknown method' })
    } catch (error) { sendJson(res, 500, { ok: false, error: String(error.message ?? error) }) }
  } }), 'dsh-applications: /apps/api routes')

  ctx.effect(() => {
    void appsJson().catch((error) => log('initial catalog load failed', String(error.message ?? error)))
    return ctx.webServer.register({ kind: 'prefix', path: WEB_ROUTE, handler: async (req, res) => {
      const rejection = gate(req)
      if (rejection !== undefined) { deny(res, rejection); return }
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const rest = url.pathname.slice(WEB_ROUTE.length + 1)
      const slash = rest.indexOf('/')
      const id = slash === -1 ? rest : rest.slice(0, slash)
      if (!APP_ID.test(id)) { sendJson(res, 404, { ok: false, error: 'unknown app' }); return }
      try {
        const apps = await appsJson()
        const app = apps.find((candidate) => candidate.id === id)
        const port = Number(app?.web?.containerPort)
        if (!Number.isInteger(port) || port < 1 || port > 65535) { sendJson(res, 404, { ok: false, error: `'${id}' is not a web app` }); return }
        if (slash === -1) {
          res.writeHead(302, { location: `${mountFor(id)}/${url.search}`, 'cache-control': 'no-store' }); res.end(); return
        }
        const ip = await containerIp(id)
        if (!ip || disposed) { sendJson(res, 502, { ok: false, error: `app '${id}' is not running` }); return }
        const prefixes = rewritePrefixes(app)
        const paths = socketPaths(app)
        const ws = paths.length > 0 && paths.every((path) => upgrades.has(`${mountFor(id)}${path}`))
        const upstream = proxyHttp(req, res, {
          target: { hostname: ip, port, path: rest.slice(slash) + url.search, host: `${ip}:${port}` },
          mount: mountFor(id), marker: id, features: featuresFor({ js: prefixes.length > 0, ws }),
          rewritePrefixes: prefixes, log,
        })
        tunnels.add(upstream)
        upstream.once('close', () => tunnels.delete(upstream))
      } catch (error) { sendJson(res, 502, { ok: false, error: String(error.message ?? error) }) }
    } })
  }, 'dsh-applications: /apps/web proxy')
}
