/** Applications host plugin. Routes use DSH's public HTTP/upgrade APIs only. */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { proxyHttp, proxyUpgrade, mountFor, featuresFor, embedToken, appSearch } from './proxy.js'
import { startHostListener, DEFAULT_HOST_PORT } from './host-listen.js'
import { indexHostApps } from './host-router.js'
import { AppManager, recipes } from './app-manager.js'
import { ExistingApps } from './existing-apps.js'
import { deriveProposal, describeProposal } from './plan-derivation.js'

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
  const legacy = async () => {
    const out = await runCli(['apps', 'list', '--json'])
    if (out.code !== 0) throw new Error(out.stderr.trim() || 'Could not load application catalog')
    return JSON.parse(out.stdout).apps
  }
  const manager = new AppManager({ legacy })
  const existingApps = new ExistingApps(manager)
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

  // Host-mounted apps. An app that declares `webHost` is served at the ROOT of
  // that hostname (see lib/host-router.js for why the path mount cannot serve
  // apps that compute their own URLs). DSH's webServer matches routes by
  // pathname only and its arbitrary-path seat is taken, so this is its own
  // listener on its own port; `DSH_APPS_HOST_BIND` decides who can reach it.
  ctx.effect(() => {
    const port = Number(process.env.DSH_APPS_HOST_PORT ?? DEFAULT_HOST_PORT)
    // Zero is valid and means "let the OS pick a free port", exactly as DSH's own
    // webserver config documents. Only nonsense is refused.
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      log('host mount disabled: DSH_APPS_HOST_PORT is not a port', String(process.env.DSH_APPS_HOST_PORT))
      return
    }
    const bind = process.env.DSH_APPS_HOST_BIND ?? '127.0.0.1'
    // The harness has no login of its own, so a wider bind is reachable without
    // passing whatever fronts it. Allowed, but never quiet.
    if (bind !== '127.0.0.1' && bind !== 'localhost') log('warning: host-mounted apps are reachable beyond loopback on', bind)

    // Which hostname maps to which app is cached with the catalog. The container
    // ADDRESS is resolved per request instead: a mapping cached at startup goes
    // stale the moment the app restarts on a different IP.
    let cached = new Map()
    let cachedAt = -1
    let loading = null
    const hosts = async () => {
      await appsJson()
      if (catalog.at === cachedAt) return cached
      if (loading) return loading
      loading = (async () => {
        const { byHost, problems } = indexHostApps(catalog.apps)
        for (const problem of problems) log('host mount:', problem)
        cached = byHost
        cachedAt = catalog.at
        return byHost
      })().finally(() => { loading = null })
      return loading
    }
    const endpointFor = async (id) => {
      const app = catalog.apps.find((candidate) => candidate.id === id)
      if (!app) return null
      const containerPort = Number(app.web?.containerPort)
      if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) return null
      const ip = await containerIp(app.id, app.owner, app.containerId)
      return ip === '' ? null : { hostAddress: ip, port: containerPort }
    }

    let listener = null
    let closed = false
    startHostListener({ host: bind, port, hosts, endpointFor, log })
      .then(async (started) => {
        if (closed) { await started.close(); return }
        listener = started
        // Bind even with nothing declared: the port then explains itself to an
        // operator who pointed a hostname at it, instead of refusing to start.
        const known = [...(await hosts()).keys()]
        log('host mount listening on', `${bind}:${started.address.port}`,
          known.length > 0 ? `apps: ${known.join(', ')}` : '(no app declares webHost)')
      })
      .catch((error) => log('host mount unavailable', String(error.message ?? error)))
    return () => { closed = true; return listener?.close() }
  }, 'dsh-applications: host-mounted apps')
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
