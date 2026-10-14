/** Opt-in app data plane. Never uses the legacy content-rewriting proxy. */
import http from 'node:http'
import { isIP } from 'node:net'
import { createProxyServer } from 'httpxy'
import { LAUNCH_PATH, SESSION_PATH } from './app-launch.js'
import { bootstrapPage, privateCookie } from './app-sessions.js'

export const DEFAULT_HOST_PORT = 3099
const peerIP = raw => raw?.startsWith('::ffff:') ? raw.slice(7) : raw
const errorBody = code => ({ 400: 'invalid request', 401: 'Open this application from DSH Applications to authenticate.', 403: 'forbidden', 404: 'no app is routed to this hostname', 502: 'application upstream unavailable', 503: 'application gateway unavailable' }[code])
const deny = (res, code) => {
  if (res.destroyed) return
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(errorBody(code) + '\n')
}
const denySocket = (socket, code) => {
  socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.setTimeout(1000, () => socket.destroy())
}

async function ticketBody(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') return null
  let bytes = 0, body = ''
  const timer = setTimeout(() => req.destroy(), 5000).unref()
  try {
    for await (const chunk of req) {
      bytes += chunk.length
      if (bytes > 1024) { req.destroy(); return null }
      body += chunk
    }
    return JSON.parse(body)?.ticket
  } catch { return null } finally { clearTimeout(timer) }
}

/** Require exactly the configured HTTPS authority; never trust X-Forwarded-Host. */
export function requestMatches(req, app) {
  let count = 0
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'host') count++
  const authority = new URL(app.launch.origin).host
  const host = req.headers.host?.toLowerCase()
  return count === 1 && (host === authority || (authority === app.launch.host && host === authority + ':443'))
}

function cleanRequest(req, app) {
  // Forward only verified public authority/protocol. Ignore all client-supplied
  // proxy identity assertions, including ones passed through an ingress.
  const connection = String(req.headers.connection ?? '').toLowerCase().split(',').map(s => s.trim())
  for (const key of Object.keys(req.headers)) {
    if (key === 'forwarded' || key.startsWith('x-forwarded-') || key.startsWith('x-dsh-') || key === 'proxy-authorization' || key === 'proxy-connection' || (connection.includes(key) && !['upgrade', 'connection'].includes(key))) delete req.headers[key]
  }
  const cookies = (req.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s && !privateCookie(s.split('=')[0]))
  if (cookies.length) req.headers.cookie = cookies.join('; ')
  else delete req.headers.cookie
  const publicURL = new URL(app.launch.origin)
  req.headers.host = publicURL.host
  req.headers['x-forwarded-host'] = publicURL.host
  req.headers['x-forwarded-proto'] = 'https'
  req.headers['x-forwarded-port'] = publicURL.port || '443'
  // XFF intentionally omitted: the socket peer is the edge, not the user.
}

export async function startHostListener({ hosts, sessions, controlOrigin, ingressPeers = ['127.0.0.1', '::1'], host = '127.0.0.1', port = DEFAULT_HOST_PORT, endpointFor, log = () => {} }) {
  if (typeof hosts !== 'function' || typeof endpointFor !== 'function' || !sessions || !controlOrigin) throw Error('Gateway requires catalog, endpoint, launch sessions and control origin')
  if (!ingressPeers.length || !ingressPeers.every(p => isIP(p))) throw Error('Gateway requires exact ingress peer IPs')
  const peers = new Set(ingressPeers.map(peerIP))
  const sockets = new Set(), outgoing = new Set(), grants = new Map()
  const bindGrant = (req, app, response) => {
    const grant = sessions.grant(req, app)
    if (!grant) return false
    const socket = req.socket
    let active = grants.get(socket)
    if (!active) {
      active = new Set()
      grants.set(socket, active)
      socket.once('close', () => { for (const item of active) clearTimeout(item.timer); grants.delete(socket) })
    }
    // HTTP/1 pipelining can overlap different app identities or session expiries
    // on one ingress connection. Never let a later request replace a live grant.
    const item = { identity: app.launch.identity, timer: setTimeout(() => socket.destroy(), Math.max(1, grant.expires - sessions.now())).unref() }
    active.add(item)
    if (response) {
      const release = () => {
        // An upstream may finish its response before an upload completes. Keep
        // the grant until BOTH directions finish, or the transport aborts.
        if (!(req.complete && response.writableFinished) && !req.aborted && !socket.destroyed && !(response.destroyed && !response.writableFinished)) return
        clearTimeout(item.timer); active.delete(item)
        req.removeListener('end', release); req.removeListener('aborted', release)
        response.removeListener('finish', release); response.removeListener('close', release)
      }
      req.once('end', release); req.once('aborted', release)
      response.once('finish', release); response.once('close', release)
    }
    // WebSocket grants remain active until their socket closes.
    return true
  }
  let closed = false
  const track = (set, item) => { set.add(item); item.once('close', () => set.delete(item)); if (closed) item.destroy() }
  const proxy = createProxyServer({ prependPath: false, changeOrigin: false, xfwd: false, agent: false, proxyTimeout: 0, followRedirects: false })
  proxy.on('proxyReq', request => track(outgoing, request))
  const filterCookies = response => {
    if (response.headers['set-cookie']) response.headers['set-cookie'] = response.headers['set-cookie'].filter(c => !privateCookie(c.split('=')[0].trim()))
  }
  proxy.on('proxyReqWs', (request, _req, client) => {
    track(outgoing, request)
    // Couple cancellation before 101 as well as after it. httpxy only handles
    // client errors during the pending handshake, not a normal FIN/close.
    const abortPending = () => request.destroy()
    client.once('close', abortPending)
    request.once('close', () => client.removeListener('close', abortPending))
    if (client.destroyed || client.readableEnded) { request.destroy(); return }
    request.setTimeout(10_000, () => request.destroy())
    request.prependListener('upgrade', (response, upstream) => {
      filterCookies(response)
      client.once('close', () => upstream.destroy())
      upstream.once('close', () => client.destroy())
    })
    request.prependListener('response', filterCookies)
  })
  proxy.on('open', socket => { socket.setTimeout(0); track(sockets, socket) })
  proxy.on('proxyRes', response => {
    // Reserve our session cookie only. App cookies, CSP, framing, redirects,
    // compression, caching and validators otherwise pass through unchanged.
    filterCookies(response)
  })
  const resolve = async req => {
    if (closed) return { code: 503 }
    if (!peers.has(peerIP(req.socket.remoteAddress))) return { code: 403 }
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return { code: 400 }
    const authority = req.headers.host
    if (typeof authority !== 'string' || authority.length > 260 || !/^[a-z0-9.-]+(?::\d+)?$/i.test(authority)) return { code: 400 }
    const byHost = await hosts()
    const host = authority.toLowerCase().replace(/:\d+$/, '')
    const app = byHost.get(host)
    if (!app || app.launch?.mode !== 'isolated') return { code: 404 }
    if (!requestMatches(req, app)) return { code: 400 }
    return { app }
  }
  const originAllowed = (req, app, upgrade = false) => {
    const origin = req.headers.origin
    if (upgrade || !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return origin === app.launch.origin
    return origin === undefined || origin === app.launch.origin
  }
  const request = async (req, res) => {
    try {
      const { app, code } = await resolve(req)
      if (code) return deny(res, code)
      const pathname = new URL(req.url, app.launch.origin).pathname
      if (pathname === LAUNCH_PATH && req.method === 'GET') {
        const page = bootstrapPage(controlOrigin)
        res.writeHead(200, page.headers).end(page.body); return
      }
      if (pathname === SESSION_PATH && req.method === 'POST') {
        if (req.headers.origin !== app.launch.origin) return deny(res, 403)
        const result = sessions.exchange(await ticketBody(req), app)
        if (!result) return deny(res, 401)
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': result.cookie }).end(JSON.stringify({ entryPath: result.entryPath })); return
      }
      if (pathname.startsWith('/__dsh_apps/')) return deny(res, 404)
      if (!sessions.authorize(req, app)) return deny(res, 401)
      if (!originAllowed(req, app)) return deny(res, 403)
      const endpoint = await endpointFor(app.id, app)
      if (closed || res.destroyed) return deny(res, 503)
      if (!endpoint || !isIP(endpoint.hostAddress)) return deny(res, 502)
      if (!bindGrant(req, app, res)) return deny(res, 401)
      cleanRequest(req, app)
      await proxy.web(req, res, { target: { hostname: endpoint.hostAddress, port: endpoint.port, protocol: 'http:' } })
    } catch (error) {
      log('application gateway request failed', error.code ?? 'upstream error')
      deny(res, 502)
    }
  }
  const upgrade = async (req, socket, head) => {
    // Upgraded Node sockets allow half-open connections: FIN alone leaves
    // destroyed=false. Cancel immediately, including while lookups are pending.
    const cancel = () => socket.destroy()
    socket.once('end', cancel)
    socket.once('error', cancel)
    if (closed || socket.destroyed || socket.readableEnded) { cancel(); return }
    try {
      const { app, code } = await resolve(req)
      if (closed || socket.destroyed || socket.readableEnded) { cancel(); return }
      if (code) return denySocket(socket, code)
      if (!sessions.authorize(req, app)) return denySocket(socket, 401)
      if (!originAllowed(req, app, true)) return denySocket(socket, 403)
      if (req.url.startsWith('/__dsh_apps/')) return denySocket(socket, 404)
      const endpoint = await endpointFor(app.id, app)
      if (closed || socket.destroyed || socket.readableEnded) { cancel(); return }
      if (!endpoint || !isIP(endpoint.hostAddress)) return denySocket(socket, 502)
      if (!bindGrant(req, app)) return denySocket(socket, 401)
      cleanRequest(req, app)
      await proxy.ws(req, socket, { target: { hostname: endpoint.hostAddress, port: endpoint.port, protocol: 'http:' } }, head)
    } catch { socket.destroy() }
  }
  // A whole-body deadline breaks healthy large uploads. Header receipt remains
  // bounded; ticket JSON has its own five-second limit and authenticated streams
  // are bounded by their session. The trusted ingress must enforce idle limits.
  const server = http.createServer({ requestTimeout: 0, headersTimeout: 30_000 }, (req, res) => { void request(req, res) })
  server.on('connection', socket => track(sockets, socket))
  server.on('upgrade', (req, socket, head) => { void upgrade(req, socket, head) })
  server.on('clientError', (_error, socket) => socket.destroy())
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
  server.on('error', error => log('application gateway server error', error.code ?? 'listener error'))
  let closing
  return { server, address: server.address(), reconcile(apps) {
    sessions.retain(apps)
    const identities = new Set(apps.filter(app => app.launch?.mode === 'isolated').map(app => app.launch.identity))
    for (const [socket, active] of grants) if ([...active].some(grant => !identities.has(grant.identity))) socket.destroy()
  }, close() {
    if (closing) return closing
    closed = true
    sessions.close()
    closing = new Promise(resolve => {
      server.close(resolve)
      for (const item of outgoing) item.destroy()
      for (const socket of sockets) socket.destroy()
      proxy.close()
    })
    return closing
  } }
}
