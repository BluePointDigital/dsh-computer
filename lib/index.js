/**
 * dsh-applications — server half.
 *
 * Serves the Web GUI's Applications panel over a fenced `/apps/api` route. The
 * whole point of this file is that it is a THIN wrapper over `computer apps`:
 * it does not know what an application is, and it cannot invent one.
 *
 * Safety design, mirrored from the CLI's catalog:
 *
 *   - The only caller-supplied value that reaches a subprocess is an app id.
 *     It is shape-checked here and then validated again by the CLI against
 *     apps.yaml, which is an allowlist. There is no path from a request to an
 *     image name or a docker flag.
 *   - `execFile` with an argv array — never a shell string — so an id can never
 *     be interpreted as syntax even if the checks were bypassed.
 *   - Only three actions exist (up/down/rm), matched against a closed set.
 *   - Every request passes a browser-trust fence before any of that runs.
 *
 * The fence is a DNS-rebinding / cross-site defence, not authentication: the
 * GUI is expected to be private (loopback or the tailnet). It refuses
 * cross-site browser requests and any Host header that is neither loopback nor
 * a configured trusted authority.
 */
import { execFile } from 'node:child_process'
import { proxyHttp, mountFor } from './proxy.js'

export const name = 'dsh-applications'
export const inject = ['webServer', 'webRuntime', 'connection']

const DEFAULT_BIN = '/data/skills/docker-computer/bin/computer'
const ROUTE = '/apps/api'
/** Mount for the same-origin dashboard proxy; see lib/proxy.js. */
const WEB_ROUTE = '/apps/web'

/** The closed action set. Anything else is refused before a process is spawned. */
const ACTIONS = new Set(['up', 'down', 'rm'])

/** App ids are lowercase slugs; the catalog is the real validator. */
const APP_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

/** Loopback authority check (matches DSH's own /api fence). */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  )
}

function authority(hostHeader) {
  try {
    return new URL(`http://${hostHeader}`)
  } catch {
    return undefined
  }
}

/** Whether a request may reach this route at all. */
function isTrusted(req, trustedHosts) {
  const headers = req?.headers ?? {}
  // Cross-site browser markers never pass, whatever the Host says.
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const host = headers.host
  if (typeof host !== 'string' || host === '') return false
  const url = authority(host)
  if (url === undefined) return false
  if (isLoopbackHostname(url.hostname)) return true
  const withPort = url.port === '' ? url.hostname : `${url.hostname}:${url.port}`
  const list = Array.isArray(trustedHosts) ? trustedHosts : []
  return list.some((entry) => entry === url.hostname || entry === withPort)
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

export function apply(ctx, config = {}) {
  const bin = typeof config.computerBin === 'string' ? config.computerBin : DEFAULT_BIN
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 180_000
  const log = (...args) => ctx.logger?.info?.('[dsh-applications]', ...args)

  /** Run the CLI with an argv array. Never a shell. */
  const runCli = (args) =>
    new Promise((resolve) => {
      execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        })
      })
    })

  /**
   * The host's own gate: Host/Origin fence plus browser authentication. Using it
   * rather than a local fence keeps this route exactly as reachable as every
   * sibling route — a hand-rolled fence left it the one route in the app that
   * answered without a session.
   */
  const gate = (req) =>
    typeof ctx.connection?.requestRejection === 'function'
      ? ctx.connection.requestRejection(req)
      : isTrusted(req, ctx.webRuntime?.trustedHosts)
        ? undefined
        : 403

  const deny = (res, rejection) =>
    sendJson(res, rejection, {
      ok: false,
      error: rejection === 401 ? 'authentication required' : 'forbidden',
    })

  /** The container's address on the internal bridge, which the server can reach. */
  const containerIp = (name) =>
    new Promise((resolve) => {
      execFile(
        'docker',
        ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name],
        { timeout: 10_000 },
        (error, stdout) => resolve(error ? '' : String(stdout ?? '').trim()),
      )
    })

  // The catalog, briefly cached: the proxy needs each app's container port, and
  // shelling out once per asset request would be absurd.
  let catalog = { at: 0, apps: [] }
  const appsJson = async () => {
    if (Date.now() - catalog.at < 3000) return catalog.apps
    const out = await runCli(['apps', 'list', '--json'])
    if (out.code === 0) {
      try {
        const parsed = JSON.parse(out.stdout)
        catalog = { at: Date.now(), apps: Array.isArray(parsed.apps) ? parsed.apps : [] }
      } catch {
        // Keep the previous snapshot rather than dropping the panel.
      }
    }
    return catalog.apps
  }

  const webEntry = async (id) => {
    const apps = await appsJson()
    const app = apps.find((candidate) => candidate.id === id)
    if (app === undefined || app.web === undefined) return undefined
    const port = Number(app.web.containerPort)
    return Number.isInteger(port) && port > 0 ? { port } : undefined
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          // Delegate to the host's own gate rather than a hand-rolled fence: it
          // applies the Host/Origin fence AND browser authentication, so this
          // route is exactly as reachable as every sibling route. Rolling our own
          // left it the one route in the app that answered without a session —
          // verified by curl: `/` returned 401 while `/apps/api/list` returned 200.
          const rejection = gate(req)
          if (rejection !== undefined) {
            deny(res, rejection)
            return
          }

          const url = new URL(req.url ?? '/', 'http://dsh.internal')
          const method = url.pathname.startsWith(`${ROUTE}/`)
            ? url.pathname.slice(ROUTE.length + 1)
            : ''
          if (method === '' || method.includes('/')) {
            sendJson(res, 404, { ok: false, error: 'unknown method' })
            return
          }

          // READ — the catalog plus live state, straight from the CLI's JSON.
          if (method === 'list') {
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const out = await runCli(['apps', 'list', '--json'])
            if (out.code !== 0) {
              sendJson(res, 500, {
                ok: false,
                error: out.stderr.trim() || `computer apps list exited ${out.code}`,
              })
              return
            }
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(out.stdout)
            return
          }

          // WRITE — the only two caller-supplied values are action and id.
          if (method === 'action') {
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const body = await readJsonBody(req)
            if (body === null) {
              sendJson(res, 400, { ok: false, error: 'malformed JSON body' })
              return
            }
            const action = typeof body.action === 'string' ? body.action : ''
            const id = typeof body.id === 'string' ? body.id : ''
            if (!ACTIONS.has(action)) {
              sendJson(res, 400, {
                ok: false,
                error: `action must be one of: ${[...ACTIONS].join(', ')}`,
              })
              return
            }
            if (!APP_ID.test(id)) {
              sendJson(res, 400, { ok: false, error: 'malformed app id' })
              return
            }
            log('action', action, id)
            const out = await runCli(['apps', action, id])
            const ok = out.code === 0
            sendJson(res, ok ? 200 : 500, {
              ok,
              action,
              id,
              code: out.code,
              output: `${out.stdout}${out.stderr}`.trim(),
            })
            return
          }

          sendJson(res, 404, { ok: false, error: 'unknown method' })
        },
      }),
    'dsh-applications: /apps/api routes',
  )

  // ---- same-origin dashboard proxy: /apps/web/<id>/... ---------------------
  // A dashboard with its own UI is the normal case; the VNC desktop is the
  // extreme one. Proxying it keeps the app same-origin with the GUI, so it
  // inherits this session, needs no extra published port, and cannot refuse to
  // be framed — at the cost of re-pointing root-absolute URLs, redirects and
  // cookies. Those rules live in lib/proxy.js and are tested in isolation.
  //
  // WebSocket note: the host webserver matches upgrade routes by EXACT pathname
  // only (`this.upgrades.get(pathname)`), and its single fallback seat is
  // already owned by the SPA server — so no generic prefix upgrade proxy is
  // possible here. A dashboard that needs WebSockets should set
  // `webMode: direct` in the catalog and be embedded from its published origin.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: WEB_ROUTE,
        handler: async (req, res) => {
          const rejection = gate(req)
          if (rejection !== undefined) {
            deny(res, rejection)
            return
          }

          const url = new URL(req.url ?? '/', 'http://dsh.internal')
          const rest = url.pathname.slice(WEB_ROUTE.length + 1)
          const slash = rest.indexOf('/')
          const id = slash === -1 ? rest : rest.slice(0, slash)

          if (!APP_ID.test(id)) {
            sendJson(res, 404, { ok: false, error: 'unknown app' })
            return
          }
          const entry = await webEntry(id)
          if (entry === undefined) {
            sendJson(res, 404, { ok: false, error: `'${id}' is not a web app` })
            return
          }
          const ip = await containerIp(`dsh-app-${id}`)
          if (ip === '') {
            sendJson(res, 502, { ok: false, error: `app '${id}' is not running` })
            return
          }

          const targetPath = (slash === -1 ? '/' : rest.slice(slash)) + (url.search ?? '')
          proxyHttp(req, res, {
            target: {
              hostname: ip,
              port: entry.port,
              path: targetPath,
              host: `${ip}:${entry.port}`,
            },
            mount: mountFor(id),
            marker: id,
            log,
          })
        },
      }),
    'dsh-applications: /apps/web dashboard proxy',
  )
}
