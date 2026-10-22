/** Applications host plugin. Routes use DSH's public HTTP/upgrade APIs only. */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { ApplicationRuntime } from './application-runtime.js'
import { Catalog } from './catalog.js'
import { Deployments } from './deployments.js'
import { RuntimeConsole } from './runtime-console.js'
import { randomBytes } from 'node:crypto'
import { proxyHttp, proxyUpgrade, mountFor, featuresFor, embedToken, appSearch } from './proxy.js'
import { startHostListener } from './host-listen.js'
import { gatewayConfig } from './app-launch.js'
import { AppSessions } from './app-sessions.js'
import { PortListeners, portTls } from './port-listen.js'
import { AppManager, recipes } from './app-manager.js'
import { ExistingApps } from './existing-apps.js'
import { deriveProposal, describeProposal } from './plan-derivation.js'
import { PublicTls } from './tls-public.js'

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

export async function apply(ctx, config = {}) {
  const bin = typeof config.computerBin === 'string' ? config.computerBin : DEFAULT_BIN
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 180_000
  const log = (...args) => ctx.logger?.info?.('[dsh-applications]', ...args)
  const runCli = (args) => new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, COMPUTER_APPS_LEGACY: '1' } }, (error, stdout, stderr) => resolve({
      code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
      stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
    }))
  })
  const metadataCatalog = new Catalog()
  const manager = new AppManager({ legacy: () => metadataCatalog.list() })
  const existingApps = new ExistingApps(manager)
  const deployments = new Deployments({ manager })
  const deploymentWorkers = new Map()
  let deploymentRecovery
  const recoverDeployments = () => deploymentRecovery ??= deployments.recover().then(async () => {
    for (const job of await deployments.list()) if (job.state === 'queued') startDeployment(job)
  }).catch(error => { deploymentRecovery = undefined; log('deployment recovery failed', error.message); throw error })
  const startDeployment = job => {
    if (disposed || deploymentWorkers.has(job.id)) return
    const previous = [...deploymentWorkers.values()].at(-1) ?? Promise.resolve()
    const work = previous.then(() => disposed ? undefined : deployments.run(job.id)).catch(error => log('deployment worker failed', job.id, error.message))
      .finally(() => { deploymentWorkers.delete(job.id); invalidate() })
    deploymentWorkers.set(job.id, work)
  }
  const gateway = gatewayConfig(config) // Invalid opt-in configuration fails closed.
  const runtime = new ApplicationRuntime({ manager, catalog: metadataCatalog, deployments, config: gateway })
  const inventory = { resolve: (id, container) => runtime.resolve(id, Array.isArray(container) ? undefined : container) }
  let portCertificates
  if (gateway?.mode === 'ports') portCertificates = await portTls({ ...config, controlOrigin: gateway.controlOrigin })
  const tlsManager = new PublicTls() // Read-only sanitized snapshot; worker secrets are not mounted into DSH.
  const sessions = new AppSessions()
  let hostListener = null
  let portListeners = null
  const endpointFor = async (_id, app) => disposed ? null : runtime.endpoint(app)
  // Agent affordance, not a second implementation: it shells through the same
  // AppManager the CLI and GUI use, and it can only PREPARE. It never approves
  // and never runs, so the review card stays the owner's decision.
  registerProposalTool(ctx, manager, log)
  const workers = new Map()
  const startWorker = (id) => {
    if (disposed || workers.has(id)) return
    // Work is detached from the HTTP response, but not from the owning process.
    // Persisted journals allow explicit recovery if the process is interrupted.
    const work = manager.run(id).catch((error) => log('installer worker', id, error.message))
      .finally(() => { workers.delete(id); invalidate() })
    workers.set(id, work)
  }
  const gate = (req) => typeof ctx.connection?.requestRejection === 'function'
    ? ctx.connection.requestRejection(req)
    : 503 // Never silently downgrade authentication to a Host-only fence.
  const deny = (res, code) => sendJson(res, code, { ok: false, error: code === 401 ? 'authentication required' : code === 503 ? 'authentication gate unavailable' : 'forbidden' })
  const rejectUpgrade = (socket, code) => socket.end(
    `HTTP/1.1 ${code} ${code === 401 ? 'Unauthorized' : code === 503 ? 'Service Unavailable' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  )
  const containerIp = async (id, owner, containerId) => {
    if (!containerId) return ''
    const app = catalog.apps.find(candidate => candidate.id === id && candidate.containerId === containerId)
    if (!app || app.owner !== owner) return ''
    return (await runtime.endpoint(app))?.hostAddress ?? ''
  }
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
    for (const app of gateway ? [] : apps) {
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
  const appsJson = async (force = false) => {
    const snapshot = await runtime.current({ fresh: force })
    return reconcileSnapshot(snapshot)
  }
  const reconcileSnapshot = async snapshot => {
    let apps = snapshot.apps
    if (portListeners) apps = await portListeners.reconcile(apps)
    if (!disposed) { catalog = { at: snapshot.at, apps }; reconcile(apps); hostListener?.reconcile(apps) }
    return apps
  }
  const invalidate = () => { catalog.at = 0; runtime.invalidate() }
  const runtimeConsole = new RuntimeConsole({ inventory, engine: runtime.engine, known: async () => [] })
  ctx.effect(() => () => {
    runtimeConsole.close()
    void runtime.close()
    disposed = true
    sessions.close()
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
      if (method.startsWith('runtime/')) {
        const operation = method.slice('runtime/'.length)
        if (req.method !== 'GET') {
          const origin = req.headers.origin
          const host = req.headers.host
          const validOrigin = typeof origin === 'string' && (() => { try { const parsed = new URL(origin); return parsed.host === host && ['http:', 'https:'].includes(parsed.protocol) } catch { return false } })()
          if (!validOrigin) { deny(res, 403); return }
          if (req.headers['content-type']?.split(';')[0] !== 'application/json') { sendJson(res, 415, { ok: false, error: 'JSON required' }); return }
        }
        if (operation === 'inventory' && req.method === 'GET') {
          await recoverDeployments()
          const data = await runtime.inventory({ fresh: url.searchParams.get('refresh') === '1' })
          if (data.inventory.dockerAvailable && runtime.snapshot) data.apps = await reconcileSnapshot(runtime.snapshot)
          else { reconcile([]); hostListener?.reconcile([]) }
          sendJson(res, 200, { ok: true, ...data }); return
        }
        if (operation === 'details' && req.method === 'GET') {
          const id = url.searchParams.get('id')
          sendJson(res, 200, { ok: true, app: await runtime.details(id), stats: runtime.cachedStats(id) }); return
        }
        if (operation === 'stats' && req.method === 'GET') {
          sendJson(res, 200, { ok: true, stats: await runtime.stats(url.searchParams.get('id')) }); return
        }
        if (operation === 'definition' && req.method === 'GET') {
          sendJson(res, 200, { ok: true, definition: await deployments.definition(url.searchParams.get('id')) }); return
        }
        if (operation === 'logs' && req.method === 'GET') { await runtimeConsole.logs(req, res, url); return }
        if (operation === 'deploy' && req.method === 'POST') {
          await recoverDeployments()
          const input = await readJsonBody(req, 512 * 1024)
          const job = await deployments.submit(input)
          startDeployment(job)
          invalidate()
          sendJson(res, 202, { ok: true, job }); return
        }
        if (operation === 'action' && req.method === 'POST') {
          const body = await readJsonBody(req)
          if (!body || !APP_ID.test(body.id ?? '')) throw Error('Invalid application')
          if (['redeploy', 'update', 'rollback'].includes(body.action)) {
            const job = await deployments.action(body.id, body.action, body)
            startDeployment(job); sendJson(res, 202, { ok: true, job }); return
          }
          const result = await runtime.action(body.id, body.action, { container: body.container, deleteData: body.deleteData === true })
          invalidate(); sendJson(res, 200, result); return
        }
        if (operation === 'endpoint' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const app = (await appsJson()).find(item => item.id === body?.id)
          const port = Number(body?.webPort)
          if (!app || !Number.isInteger(port) || port < 1 || port > 65535 || typeof body.webPath !== 'string' || !body.webPath.startsWith('/') || body.webPath.startsWith('//') || /[\\\u0000-\u0020]/.test(body.webPath)) throw Error('Invalid application endpoint')
          const entry = new URL(body.webPath, 'http://app.internal')
          if (entry.pathname.startsWith('/__dsh_apps/')) throw Error('Reserved application endpoint')
          const service = app.services?.find(service => service.containerId === body.container)
          if (!service) throw Error('Choose an application service')
          await manager.locked(async () => {
            const settings = await manager.read('runtime-settings.json', { apps: {} })
            settings.apps[app.id] = { service: service.service || service.name, webPort: port, webPath: body.webPath }
            await manager.save('runtime-settings.json', settings)
          }, 'ports.lock')
          invalidate(); sendJson(res, 200, { ok: true }); return
        }
        sendJson(res, 405, { ok: false, error: 'Unsupported application operation' }); return
      }
      if (method === 'tls-status' || method === 'tls-check') {
        if (req.method !== (method === 'tls-status' ? 'GET' : 'POST')) { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        if (method === 'tls-check' && (!gateway || req.headers.origin !== gateway.controlOrigin || req.headers['content-type']?.split(';')[0] !== 'application/json')) { deny(res, 403); return }
        if (gateway?.mode === 'ports') {
          sendJson(res, 200, { ok: true, tls: { configured: false, mode: 'ports' } }); return
        }
        const status = await tlsManager.status()
        if (status.configured && (!gateway || status.domain !== gateway.domain)) { sendJson(res, 409, { ok: false, error: 'TLS deployment and active gateway domain differ' }); return }
        sendJson(res, 200, { ok: true, tls: method === 'tls-check' ? await tlsManager.check() : status }); return
      }
      if (method === 'launch' || method === 'open') {
        if (!gateway || !(hostListener || portListeners) || disposed) { sendJson(res, 503, { ok: false, error: 'Application gateway unavailable' }); return }
        const isOpen = method === 'open'
        if (req.method !== (isOpen ? 'GET' : 'POST')) { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        const origin = req.headers.origin
        if ((!isOpen && origin !== gateway.controlOrigin) || (origin !== undefined && origin !== gateway.controlOrigin)) { deny(res, 403); return }
        if (isOpen && ((req.headers['sec-fetch-mode'] && req.headers['sec-fetch-mode'] !== 'navigate') || (req.headers['sec-fetch-dest'] && req.headers['sec-fetch-dest'] !== 'document') || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])))) { deny(res, 403); return }
        if (!isOpen && req.headers['content-type']?.split(';')[0] !== 'application/json') { sendJson(res, 400, { ok: false, error: 'JSON required' }); return }
        const id = isOpen ? url.searchParams.get('id') : (await readJsonBody(req, 1024))?.id
        if (!APP_ID.test(id ?? '')) { sendJson(res, 400, { ok: false, error: 'invalid app id' }); return }
        const app = (await appsJson(true)).find(candidate => candidate.id === id)
        if (!app || !['isolated', 'ports'].includes(app.launch?.mode)) { sendJson(res, 404, { ok: false, error: 'Application unavailable' }); return }
        if (!await containerIp(app.id, app.owner, app.containerId) || disposed) { sendJson(res, 503, { ok: false, error: 'Application is not running' }); return }
        const launchUrl = app.launch.mode === 'ports' ? new URL(app.launch.entryPath, app.launch.origin).href : sessions.issue(app)
        res.setHeader('referrer-policy', 'no-referrer')
        if (isOpen) { res.writeHead(303, { location: launchUrl, 'cache-control': 'no-store' }).end(); return }
        sendJson(res, 200, { ok: true, url: launchUrl, launch: app.launch }); return
      }
      if (method === 'discovery') {
        if (req.method !== 'GET') { sendJson(res, 405, {ok:false,error:'GET required'}); return }
        const snapshot = await runtime.current({ fresh: true })
        const registered = new Set(Object.values((await existingApps.registry()).apps).map(app => app.containerId))
        sendJson(res,200,{ok:true,containers:snapshot.infos.filter(info => !registered.has(info.Id)).map(info => existingApps.summary(info))});return
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
        else if (registry.apps[id] && ['uninstall'].includes(action)) result = await manager.action(action, id)
        else if (['up', 'down', 'rm', 'logs'].includes(action) && (await runtime.current({ fresh: true })).apps.find(app => app.id === id)?.services.length) {
          result = await runtime.action(id, ({ up: 'start', down: 'stop', rm: 'remove', logs: 'logs' })[action])
        }
        else if (registry.apps[id]) result = await manager.action(action, id)
        else {
          if (action === 'uninstall' || action === 'logs' || action === 'forget') throw new Error('This legacy catalog app is not managed by the installer')
          const out = await runCli(['apps', action, id])
          result = { ok: out.code === 0, code: out.code, output: `${out.stdout}${out.stderr}`.trim() }
        }
        invalidate()
        await appsJson(true)
        sendJson(res, result.ok ? 200 : 500, { ...result, action, id })
        return
      }
      sendJson(res, 404, { ok: false, error: 'unknown method' })
    } catch (error) { sendJson(res, error.status || 500, { ok: false, error: String(error.message ?? error) }) }
  } }), 'dsh-applications: /apps/api routes')

  ctx.effect(() => {
    void appsJson().catch((error) => log('initial catalog load failed', String(error.message ?? error)))
    return ctx.webServer.register({ kind: 'prefix', path: WEB_ROUTE, handler: async (req, res) => {
      const rejection = gate(req)
      if (rejection !== undefined) { deny(res, rejection); return }
      if (gateway) { sendJson(res, 410, { ok: false, error: 'Same-origin app access is disabled. Open this app from Applications.' }); return }
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
        // Every proxied document load is stamped with a fresh salt, so the app
        // always comes from current files even if the browser holds an older
        // bundle, and even if the panel client that asked is itself outdated.
        // A salt supplied by the client is used as-is; it is consumed here, so
        // the app itself keeps seeing an unmodified query string.
        const raw = url.searchParams.get('dsha') ?? ''
        const salt = RELOAD_SALT.test(raw) ? raw : randomBytes(6).toString('hex')
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

  const require = createRequire(import.meta.url)
  const terminalAssets = new Map([
    ['/apps/assets/runtime-ui.js', [new URL('./runtime-ui.js', import.meta.url), 'text/javascript']],
    ['/apps/assets/xterm.js', [require.resolve('@xterm/xterm'), 'text/javascript']],
    ['/apps/assets/fit.js', [require.resolve('@xterm/addon-fit'), 'text/javascript']],
    ['/apps/assets/xterm.css', [require.resolve('@xterm/xterm/css/xterm.css'), 'text/css']],
  ])
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/apps/assets', handler: async (req, res) => {
    const rejection = gate(req)
    if (rejection !== undefined) return deny(res, rejection)
    const asset = terminalAssets.get(new URL(req.url, 'http://dsh.internal').pathname)
    if (!asset || req.method !== 'GET') return sendJson(res, 404, { ok: false, error: 'Asset not found' })
    res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'private, max-age=3600' }).end(await fs.readFile(asset[0]))
  } }), 'dsh-applications: terminal assets')
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/apps/terminal', handler: async (req, socket, head) => {
    const rejection = gate(req)
    if (rejection !== undefined) { rejectUpgrade(socket, rejection); return }
    try {
      const origin = new URL(req.headers.origin)
      if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) { rejectUpgrade(socket, 403); return }
      await runtimeConsole.upgrade(req, socket, head, new URL(req.url, origin))
    } catch { rejectUpgrade(socket, 400) }
  } }), 'dsh-applications: terminal websocket')

  // rc.2's webServer owns pathname routes, not virtual hosts. Keep this separate
  // data-plane listener inside a Cordis effect; never patch the harness router.
  if (gateway?.mode === 'ports') {
    portListeners = new PortListeners({ config: gateway, endpointFor, log, tls: portCertificates })
    // The operator CLI does not inherit Cordis config. Persist only the public
    // routing policy, never private TLS keys or credentials, in app state.
    await manager.locked(() => manager.save('launch-config.json', {
      appAccess: 'ports', controlOrigin: gateway.controlOrigin,
      appPortStart: gateway.portStart, appPortEnd: gateway.portEnd, appListenHost: gateway.bind,
    }), 'ports.lock')
    ctx.effect(() => {
      const refresh = setInterval(() => { if (!disposed) void appsJson(true).catch(error => log('app port refresh failed', error.message)) }, 3000).unref()
      void appsJson(true).catch(error => log('app port startup failed', error.message))
      return async () => {
        disposed = true
        clearInterval(refresh)
        await portListeners.close()
        await runtime.loading?.catch(() => {})
      }
    }, 'dsh-applications: application ports')
  } else if (gateway) ctx.effect(() => {
    let closed = false
    // Also revoke idle streams after external uninstall/container replacement.
    // Request dispatch separately checks immutable identity; this bounds idle revocation.
    const refresh = setInterval(() => {
      if (!closed) void appsJson(true).catch(() => hostListener?.reconcile([]))
    }, 3000).unref()
    const started = startHostListener({
      host: gateway.bind, port: gateway.port, sessions, controlOrigin: gateway.controlOrigin,
      ingressPeers: gateway.peers,
      hosts: async () => new Map((await appsJson()).filter(app => app.launch?.mode === 'isolated').map(app => [app.launch.host, app])),
      endpointFor: async (_id, app) => disposed ? null : runtime.endpoint(app), log,
    }).then(async listener => {
      if (closed) { await listener.close(); return }
      hostListener = listener
      log('isolated gateway listening on', `${gateway.bind}:${listener.address.port}`)
      return listener
    }).catch(error => { log('isolated gateway unavailable', error.code ?? error.message) })
    return async () => {
      closed = true
      clearInterval(refresh)
      sessions.close()
      const listener = await started
      hostListener = null
      await listener?.close()
    }
  }, 'dsh-applications: isolated gateway')
}

/**
 * Register `propose_program` once a tools runtime exists.
 *
 * `tools` is requested through `ctx.inject` rather than declared in the static
 * inject list on purpose. Cordis has no optional-inject form — a hard `tools`
 * requirement would unmount this whole plugin, Applications panel included, on
 * any context without a tools runtime. Deferred injection waits instead, so the
 * failure mode is "the tool is not offered", never "the menu disappeared".
 *
 * Returns the cancel function when it could inject, otherwise undefined. Never
 * throws: registration must not be able to take the plugin down.
 */
export function registerProposalTool(ctx, manager, log = () => {}) {
  if (typeof ctx?.inject !== 'function') {
    log('propose_program unavailable: this Cordis has no deferred injection')
    return undefined
  }
  return ctx.inject(['tools'], (toolsCtx) => {
    let cancelled = false
    import('@deepseek-ai/dsh-tools')
      .then(({ defineTool }) => {
        if (cancelled || typeof defineTool !== 'function' || !toolsCtx.tools?.register) return
        // Same ownership shape as the route registrations: the returned disposer
        // unregisters the tool when this fiber goes away.
        toolsCtx.effect(() => toolsCtx.tools.register(buildProposalTool(defineTool, manager, log)))
        log('propose_program registered')
      })
      .catch((error) => log('propose_program unavailable: cannot resolve @deepseek-ai/dsh-tools —', String(error.message ?? error)))
    return () => { cancelled = true }
  })
}

/**
 * Build the definitions outside `apply` so the real installed `defineTool` can
 * validate the schema in tests. `manager` is the same installer the CLI and GUI
 * use — this is a shim, and it can only ever prepare.
 */
export function buildProposalTool(defineTool, manager, log = () => {}) {
  return defineTool({
    name: 'propose_program',
    description: 'Propose installing a containerised program as a first-class app. Use when real work hits a missing program. This only prepares a review; the owner approves it in Applications, and nothing is installed here. If the result reports unknowns, ask the owner for them instead of choosing values.',
    parameters: {
      id: { type: 'string', required: true, description: 'Lowercase slug for the app, at most 32 characters' },
      image: { type: 'string', required: true, description: 'Image reference with an explicit tag or sha256 digest' },
      task: { type: 'string', required: true, description: 'The failing command or job that required this, quoted verbatim — not a summary' },
      name: { type: 'string', description: 'Display name; defaults to the id' },
      description: { type: 'string', description: 'What the program is for' },
      webPort: { type: 'integer', description: 'Container port serving HTTP. Omit if unknown — never guess it' },
      webPath: { type: 'string', description: 'Entry path, default /' },
      webSockets: { type: 'array', items: { type: 'string' }, description: 'Absolute socket paths the app opens' },
      webRewrite: { type: 'array', items: { type: 'string' }, description: 'Literal JS URL prefixes ending in /' },
      volumes: { type: 'array', items: { type: 'string' }, description: 'Absolute container data directories needing persistent storage' },
      cpus: { type: 'integer', description: 'CPU cap' },
      memoryMb: { type: 'integer', description: 'Memory cap in MiB' },
      shmMb: { type: 'integer', description: 'Shared-memory size in MiB' },
      autostart: { type: 'boolean', description: 'Return after a harness restart; default false' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          ready: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          jobId: { type: 'string' },
          approvalHash: { type: 'string' },
          state: { type: 'string' },
          failure: { type: 'string' },
          evidence: { type: 'string', required: true },
          unknowns: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                field: { type: 'string', required: true },
                reason: { type: 'string', required: true },
                required: { type: 'boolean', required: true },
              },
            },
          },
          next: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const lines = [`Proposed ${value.id} for owner review.`, `Evidence: ${value.evidence}`]
        const blocking = (value.unknowns ?? []).filter((entry) => entry.required)
        if (blocking.length) {
          lines.push('', 'Not submittable yet — ask the owner:',
            ...blocking.map((entry) => `  ${entry.field}: ${entry.reason}`))
        }
        if (value.jobId) lines.push('', `Review "${value.id}" in Applications → Add app, then approve.`)
        lines.push('', value.next)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const proposal = deriveProposal(args)
      const unknowns = proposal.unknowns.map(({ field, reason, required }) => ({ field, reason, required }))
      const evidence = proposal.provenance.task
      if (!proposal.ready) {
        return { ok: false, ready: false, id: proposal.plan.id, evidence, unknowns, next: describeProposal(proposal) }
      }
      const job = await manager.prepare(proposal.plan)
      log('proposed', proposal.plan.id, 'job', job.id, job.state, exec?.agent?.id ? `by ${exec.agent.id}` : '')
      // `prepare` also returns FAILED jobs — the image could not be downloaded or
      // inspected, and then `job.approval` is absent. Measured on the live
      // instance 2026-10-14: returning it directly failed output validation with
      // "value is not lossless JSON" (undefined is not JSON), *after* the tool
      // had already created the failed job. So optional fields are added only
      // when they exist, and a failed prepare is never reported as a review
      // waiting for approval.
      const failure = job.state === 'failed'
        ? (job.events ?? []).at(-1) ?? 'Preparation failed before review.'
        : undefined
      return {
        ok: job.state !== 'failed',
        ready: true,
        id: proposal.plan.id,
        evidence,
        unknowns,
        jobId: job.id,
        ...(job.approval !== undefined ? { approvalHash: job.approval } : {}),
        state: job.state,
        ...(failure !== undefined ? { failure } : {}),
        next: failure !== undefined
          ? `Preparation failed: ${failure} No approval is possible — fix the image or the network and propose again.`
          : 'Prepared for review. The owner approves in Applications; secrets are entered there, never in this call.',
      }
    },
  })
}
