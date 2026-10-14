/**
 * The listener that serves host-mounted apps.
 *
 * DSH's `webServer` matches routes by pathname only and its one arbitrary-path
 * seat (`registerFallback`) is already owned by the SPA server, so an app that
 * must appear at the ROOT of a name needs its own listener. This is that
 * listener: it resolves `Host` to an app, forwards the path unchanged at
 * `mount = ''`, and lets the response through unrewritten.
 *
 * Rewriting nothing is the point. `proxyHttp` at an empty mount already does the
 * right thing for redirects, cookies and CSP (each was checked, not assumed:
 * `rewriteLocation` returns the location unchanged because nothing needs
 * prepending, `scopeCookie` writes `Path=/`, which is correct for an app that
 * owns the name, and `rewriteCsp` only drops `frame-ancestors`).
 *
 * The container ADDRESS is resolved per request through `endpointFor`, so a
 * restarted app is followed. Only the hostname -> app mapping is cached, and it
 * is keyed to the catalog's own cache stamp.
 */
import http from 'node:http'
import { proxyHttp, proxyUpgrade } from './proxy.js'
import { indexHostApps, matchHostApp, unroutedResponse } from './host-router.js'

/** Default port for the shared listener. One listener serves every app. */
export const DEFAULT_HOST_PORT = 3099

/**
 * Build the request handler.
 *
 * Exported for tests: routing, forwarding and the unrouted response are the
 * behaviour worth asserting, and none of it needs a socket. `hosts` is a
 * function so the mapping can be refreshed without re-registering anything;
 * `endpointFor` returns `{ hostAddress, port }` or null when an app is not
 * running, which is a 502 rather than a 404 — the name IS routed, the app just
 * is not up, and those are different problems for whoever is looking at it.
 */
export function createHostHandler({ hosts, endpointFor = null, log = () => {}, forwardHttp = proxyHttp, forwardUpgrade = proxyUpgrade }) {
  const resolve = async (rawHost) => {
    const byHost = await hosts()
    const { app, host } = matchHostApp(rawHost, byHost)
    if (!app) return { host, byHost }
    const endpoint = endpointFor ? await endpointFor(app.id) : { hostAddress: app.hostAddress, port: Number(app.web.containerPort) }
    return { app, host, byHost, endpoint }
  }

  return {
    async request(req, res) {
      let resolved
      try {
        resolved = await resolve(req.headers?.host)
      } catch (error) {
        log('host mount: catalog unavailable', String(error?.message ?? error))
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end('app catalog unavailable\n')
        return
      }
      const { app, host, byHost, endpoint } = resolved
      if (!app) {
        const body = unroutedResponse(host, byHost)
        res.writeHead(404, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
        })
        res.end(req.method === 'HEAD' ? undefined : body)
        return
      }
      if (!endpoint) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(`app '${app.id}' is not running\n`)
        return
      }
      try {
        // The path is the request's own path. The app is at the root of this
        // name, so there is nothing to strip and nothing to add — which is the
        // whole reason no rewrite machinery is configured here.
        forwardHttp(req, res, {
          target: { hostname: endpoint.hostAddress, port: endpoint.port, path: req.url ?? '/', host: endpoint.hostAddress },
          mount: '',
          marker: undefined,
          log,
        })
      } catch (error) {
        const message = String(error?.message ?? error)
        log('host route failed', app.id, message)
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(`app upstream unavailable: ${message}`)
      }
    },

    async upgrade(req, socket, head) {
      let resolved
      try {
        resolved = await resolve(req.headers?.host)
      } catch {
        socket.destroy()
        return
      }
      const { app, endpoint } = resolved
      if (!app || !endpoint) {
        socket.destroy()
        return
      }
      try {
        // Path only: `proxyUpgrade` appends the query string itself, because the
        // handshake carries it for some apps (`/websockify?token=…`). Passing
        // `req.url` whole here would send the query twice.
        const raw = req.url ?? '/'
        const path = raw.includes('?') ? raw.slice(0, raw.indexOf('?')) : raw
        forwardUpgrade(req, socket, head, {
          target: { hostname: endpoint.hostAddress, port: endpoint.port, path, host: endpoint.hostAddress },
          mount: '',
          log,
        })
      } catch (error) {
        log('host upgrade failed', app.id, String(error?.message ?? error))
        socket.destroy()
      }
    },
  }
}

/**
 * Listen on `host:port` for host-routed apps.
 *
 * `host` defaults to loopback: mounting an app at a name is only half the
 * change, and the other half — making the name resolve and terminating TLS —
 * belongs to whatever already fronts this instance. Binding wider is an
 * explicit choice because the harness itself has no login, so widening this
 * listener widens what is reachable without passing the front door's auth.
 */
export function startHostListener({ hosts, host = '127.0.0.1', port = DEFAULT_HOST_PORT, endpointFor = null, log = () => {} }) {
  if (typeof hosts !== 'function') throw new Error('startHostListener requires a hosts() resolver')
  const handler = createHostHandler({ hosts, endpointFor, log })
  const server = http.createServer((req, res) => { void handler.request(req, res) })
  // An upgrade handler that throws must not take the process with it: the socket
  // is the only thing that should die.
  server.on('upgrade', (req, socket, head) => { void handler.upgrade(req, socket, head) })
  server.on('clientError', (_error, socket) => socket.destroy())
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.removeListener('listening', onListening); reject(error) }
    const onListening = () => {
      server.removeListener('error', onError)
      // After startup, a listen error must be reported, not thrown unhandled.
      server.on('error', (error) => log('host mount server error', String(error?.message ?? error)))
      resolve({
        server,
        address: server.address(),
        close: () => new Promise((done) => server.close(() => done())),
      })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}
