/** Applications host plugin. Routes use DSH's public HTTP/upgrade APIs only. */
import { execFile } from 'node:child_process'
import { proxyHttp, proxyUpgrade, mountFor, featuresFor, embedToken, appSearch } from './proxy.js'
import { AppManager, recipes } from './app-manager.js'
import { ExistingApps } from './existing-apps.js'

export const name = 'dsh-applications'
export const inject = ['webServer', 'webRuntime', 'connection']
const DEFAULT_BIN = '/data/skills/docker-computer/bin/computer'
const ROUTE = '/apps/api'
const WEB_ROUTE = '/apps/web'
const ACTIONS = new Set(['up', 'down', 'rm', 'uninstall', 'logs', 'forget'])
const APP_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const SOCKET_PATH = /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/
const REWRITE_PREFIX = /^\/(?:[A-Za-z0-9_-]+\/)+$/
const RELOAD_SALT = /^[a-z0-9]{1,16}$/

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
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, COMPUTER_APPS_LEGACY: '1' } }, (error, stdout, stderr) => resolve({
      code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
      stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }))
  })
  const legacy = async () => {
    const out = await runCli(['apps', 'list', '--json'])
    if (out.code !== 0) throw new Error(out.stderr.trim() || 'Could not load application catalog')
    return JSON.parse(out.stdout).apps
  }
  const manager = new AppManager({ legacy })
  const existingApps = new ExistingApps(manager)
  const workers = new Map()
  const startWorker = (id) => {
    if (disposed || workers.has(id)) return
    // Work is detached from the HTTP response, but not from the owning process.
    // Persisted journals allow explicit recovery if the process is interrupted.
    const work = manager.run(id).catch((error) => log('installer worker', id, error.message))
      .finally(() => { workers.delete(id); catalog.at = 0 })
    workers.set(id, work)
  }
  const gate = (req) => typeof ctx.connection?.requestRejection === 'function'
    ? ctx.connection.requestRejection(req)
    : 503 // Never silently downgrade authentication to a Host-only fence.
  const deny = (res, code) => sendJson(res, code, { ok: false, error: code === 401 ? 'authentication required' : code === 503 ? 'authentication gate unavailable' : 'forbidden' })
  const rejectUpgrade = (socket, code) => socket.end(
    `HTTP/1.1 ${code} ${code === 401 ? 'Unauthorized' : code === 503 ? 'Service Unavailable' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  )
  const containerIp = (id, owner, containerId) => new Promise((resolve) => {
    // Select one usable bridge address rather than concatenating multiple networks.
    execFile('docker', ['inspect', '-f', '{{json .}}', containerId || `dsh-app-${id}`],
      { timeout: 10_000 }, (error, stdout) => {
        try {
          const info = error ? {} : JSON.parse(String(stdout))
          if (containerId && info.Id !== containerId) { resolve(''); return }
          if (owner && (info.Config?.Labels?.['dsh.apps.install'] !== owner || info.Config?.Labels?.['dsh.apps.id'] !== id)) { resolve(''); return }
          const networks = info.NetworkSettings?.Networks ?? {}
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
          const ip = await containerIp(entry.policy.id, app.owner, app.containerId)
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
      const apps = [...parsed.apps, ...await manager.list(), ...await existingApps.list()]
      const ids = new Set()
      for (const app of apps) {
        if (ids.has(app.id)) throw new Error(`Duplicate catalog/managed application id: ${app.id}`)
        ids.add(app.id)
      }
      if (!disposed) { catalog = { at: Date.now(), apps }; reconcile(catalog.apps) }
      return apps
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
      if (method === 'discovery') {
        if (req.method !== 'GET') { sendJson(res, 405, {ok:false,error:'GET required'}); return }
        sendJson(res,200,{ok:true,containers:await existingApps.discover(await appsJson())});return
      }
      if (['review-existing','add-existing'].includes(method)) {
        if (req.method !== 'POST' || req.headers['content-type']?.split(';')[0] !== 'application/json') { sendJson(res,405,{ok:false,error:'JSON POST required'});return }
        const body=await readJsonBody(req)
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Invalid registration')
        const result=method==='review-existing'?await existingApps.review(body):await existingApps.add(body)
        catalog.at=0;sendJson(res,200,{ok:true,...(method==='review-existing'?{review:result}:{app:result})});return
      }
      if (method === 'recipes') {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        sendJson(res, 200, { ok: true, recipes }); return
      }
      if (method === 'jobs') {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        sendJson(res, 200, { ok: true, jobs: await manager.jobs() }); return
      }
      if (['prepare', 'approve', 'cancel', 'recover', 'retry', 'credentials'].includes(method)) {
        if (req.method !== 'POST' || req.headers['content-type']?.split(';')[0] !== 'application/json') { sendJson(res, 405, { ok: false, error: 'JSON POST required' }); return }
        const body = await readJsonBody(req)
        if (!body || typeof body !== 'object' || Array.isArray(body)) { sendJson(res, 400, { ok: false, error: 'invalid request body' }); return }
        if (method === 'credentials') { sendJson(res, 200, { ok: true, job: await manager.credentials(body.id, body.env) }); return }
        if (method === 'prepare') { sendJson(res, 200, { ok: true, job: await manager.prepare(body) }); return }
        if (method === 'approve') {
          const job = await manager.approve(body.id, body.approval, body.trusted)
          sendJson(res, 202, { ok: true, job }); startWorker(job.id); return
        }
        if (method === 'retry') {
          const job = await manager.job(body.id)
          if (job.state !== 'queued') throw new Error('Only a queued approved operation can be retried')
          startWorker(job.id); sendJson(res, 202, { ok: true, job: manager.publicJob(job) }); return
        }
        if (method === 'cancel') { sendJson(res, 200, { ok: true, job: await manager.cancel(body.id) }); return }
        sendJson(res, 200, { ok: true, recovered: await manager.recover() }); return
      }
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
        const registry = await manager.registry()
        let result
        if ((await existingApps.registry()).apps[id]) result = await existingApps.action(action,id)
        else if (registry.apps[id]) result = await manager.action(action, id)
        else {
          if (action === 'uninstall' || action === 'logs' || action === 'forget') throw new Error('This legacy catalog app is not managed by the installer')
          const out = await runCli(['apps', action, id])
          result = { ok: out.code === 0, code: out.code, output: `${out.stdout}${out.stderr}`.trim() }
        }
        catalog.at = 0
        await appsJson(true)
        sendJson(res, result.ok ? 200 : 500, { ...result, action, id })
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
        const ip = await containerIp(id, app.owner, app.containerId)
        if (!ip || disposed) { sendJson(res, 502, { ok: false, error: `app '${id}' is not running` }); return }
        const prefixes = rewritePrefixes(app)
        const paths = socketPaths(app)
        const ws = paths.length > 0 && paths.every((path) => upgrades.has(`${mountFor(id)}${path}`))
        // A reload salt makes the app load under fresh URLs; it is consumed
        // here so the app itself keeps seeing an unmodified query string.
        const raw = url.searchParams.get('dsha') ?? ''
        const salt = RELOAD_SALT.test(raw) ? raw : ''
        const upstream = proxyHttp(req, res, {
          target: { hostname: ip, port, path: rest.slice(slash) + appSearch(url.search), host: `${ip}:${port}` },
          mount: mountFor(id), marker: id, features: featuresFor({ js: prefixes.length > 0, ws }),
          rewritePrefixes: prefixes, log,
          cacheToken: embedToken({ containerId: app.containerId, port: app.web?.containerPort ?? '', path: app.web?.path ?? '', sockets: paths, prefixes, salt }),
        })
        tunnels.add(upstream)
        upstream.once('close', () => tunnels.delete(upstream))
      } catch (error) { sendJson(res, 502, { ok: false, error: String(error.message ?? error) }) }
    } })
  }, 'dsh-applications: /apps/web proxy')
}
