/**
 * Path-scoped reverse proxy for HTTP app dashboards.
 *
 * Why this exists: an app with its own dashboard is the normal case, and a VNC
 * viewer is the extreme one. Pointing an iframe at the app's own published port
 * makes it a cross-origin frame that (a) needs its port reachable from wherever
 * the GUI is being viewed, and (b) is refused outright by any app that sends
 * `X-Frame-Options` or a CSP `frame-ancestors`. Proxying it under
 * `/apps/web/<id>/` keeps it same-origin with the GUI: it inherits the GUI's
 * session, needs no extra published port, and the dashboard cannot refuse to be
 * framed by its own console.
 *
 * The cost is the classic one of mounting an app under a sub-path: root-absolute
 * URLs, redirects, cookies and frame headers all have to be re-pointed. That is
 * what the pure functions below do, and they are exported separately so they can
 * be tested without a server.
 */
import http from 'node:http'
import net from 'node:net'

export const WEB_MOUNT = '/apps/web'

/** Hop-by-hop headers must not be forwarded (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** The mount path for one app; always without a trailing slash. */
export function mountFor(id) {
  return `${WEB_MOUNT}/${id}`
}

/**
 * Re-point root-absolute URLs at the app's mount.
 * `src="/x"` -> `src="/apps/web/<id>/x"`. Protocol-relative (`//cdn/x`) is left
 * alone, because that is a different host, not a path on this one.
 */
export function rewriteHtml(html, mount) {
  return String(html)
    .replace(
      /(\s(?:src|href|action|poster|data-src)\s*=\s*)(["'])\/(?!\/)/gi,
      (_m, attr, quote) => `${attr}${quote}${mount}/`,
    )
    .replace(/(url\(\s*)(["']?)\/(?!\/)/gi, (_m, pre, quote) => `${pre}${quote}${mount}/`)
}

/** Opt-in literal URL rewrite; not a JS parser or a universal SPA adapter. */
export function rewriteJs(js, mount, prefixes = []) {
  const ordered = [...new Set(prefixes)].sort((a, b) => b.length - a.length)
  return String(js).replace(/(["'`])(\/[^"'`\s]*)/g, (match, quote, path) => {
    if (path.startsWith(`${mount}/`)) return match
    return ordered.some((prefix) => path.startsWith(prefix)) ? `${quote}${mount}${path}` : match
  })
}

/**
 * Drop `frame-ancestors` so the dashboard can be embedded by its own console.
 * Only that directive is removed; the rest of the policy is preserved.
 */
export function rewriteCsp(value) {
  return String(value)
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !/^frame-ancestors\b/i.test(part))
    .join('; ')
}

/** Re-point redirects that target the app, so the browser stays inside the mount. */
export function rewriteLocation(location, mount, upstreamHost) {
  if (typeof location !== 'string' || location === '') return location
  if (location === mount || location.startsWith(`${mount}/`)) return location
  if (location.startsWith('/')) return `${mount}${location}`
  try {
    const url = new URL(location)
    if (upstreamHost !== undefined && url.host === upstreamHost) {
      return `${mount}${url.pathname}${url.search}${url.hash}`
    }
  } catch {
    // Not an absolute URL; leave it to the browser.
  }
  return location
}

/**
 * Scope a cookie to the app's mount. Without this a dashboard's `Path=/` cookie
 * is offered to every route on the GUI's origin, which is both a collision risk
 * with the harness's own cookies and a privacy leak between apps.
 */
export function scopeCookie(cookie, mount) {
  const base = `${mount}/`
  if (/;\s*path\s*=/i.test(cookie)) {
    return cookie.replace(/;\s*path\s*=\s*([^;]*)/i, (_m, existing) => {
      const sub = String(existing).trim().replace(/^\/+/, '')
      return `; Path=${base}${sub}`
    })
  }
  return `${cookie}; Path=${base}`
}

/** Consume front-door credentials at the harness gate, never at an app. */
function appRequestHeaders(raw) {
  const headers = { ...raw }
  delete headers.authorization
  delete headers['proxy-authorization']
  if (headers.cookie) {
    const cookies = String(headers.cookie).split(';').filter((part) => !part.trim().startsWith('dsh-auth-'))
    if (cookies.length) headers.cookie = cookies.join(';')
    else delete headers.cookie
  }
  return headers
}

function filteredResponseHeaders(raw) {
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out[key] = value
  }
  return out
}

/** Header name carrying the proxy's capability list. */
export const FEATURES_HEADER = 'x-dsh-app-proxy-features'

/** Capabilities this proxy advertises. */
export function featuresFor({ js = false, ws = false } = {}) {
  return [js ? 'js' : '', ws ? 'ws' : ''].filter((part) => part !== '').join(' ')
}

/**
 * Proxy one HTTP request to `target` ({ hostname, port, path, host }) and apply
 * the mount rewrites to the response.
 */
export function proxyHttp(req, res, { target, mount, log = () => {}, marker, features, rewritePrefixes = [] }) {
  const headers = appRequestHeaders(req.headers)
  // Ask for an uncompressed body: rewriting HTML through a decompressor is a lot
  // of machinery for a dashboard console, and identity costs nothing here.
  headers['accept-encoding'] = 'identity'
  headers.host = target.host ?? target.hostname
  // Conditional upstream responses would reuse an unrewritten representation.
  delete headers['if-none-match']
  delete headers['if-modified-since']
  delete headers.range
  delete headers['if-range']

  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: target.path,
      headers,
    },
    (upstreamRes) => {
      res.once('close', () => upstreamRes.destroy())
      const out = filteredResponseHeaders(upstreamRes.headers)

      // Mark the response as genuinely produced by this proxy. The client probes
      // for this before embedding the mount, because an UNMOUNTED route falls
      // through to the SPA server, which answers 200 with the app shell — so a
      // status-code probe alone would make the panel embed the GUI inside itself.
      if (marker !== undefined) out['x-dsh-app-proxy'] = marker
      // What this proxy can DO, not merely that it exists. The client needs this
      // before choosing the mount for an app that opens a socket: a proxy that
      // cannot carry the upgrade renders a page that never connects, which is a
      // worse failure than the honest fallback. Absent means "unknown/older
      // proxy" and the client must assume the conservative answer.
      if (features !== undefined) out[FEATURES_HEADER] = features

      // The app must not be able to refuse its own console.
      delete out['x-frame-options']
      if (out['content-security-policy'] !== undefined) {
        out['content-security-policy'] = rewriteCsp(out['content-security-policy'])
      }
      if (out.location !== undefined) {
        out.location = rewriteLocation(out.location, mount, target.host)
      }
      if (out['set-cookie'] !== undefined) {
        const cookies = Array.isArray(out['set-cookie']) ? out['set-cookie'] : [out['set-cookie']]
        out['set-cookie'] = cookies.map((cookie) => scopeCookie(cookie, mount))
      }

      const type = String(out['content-type'] ?? '')
      const encoding = String(out['content-encoding'] ?? '').toLowerCase()
      const identity = encoding === '' || encoding === 'identity'
      const isHtml = /text\/html/i.test(type)
      const isJs = /(?:text|application)\/(?:java|ecma)script/i.test(type) && rewritePrefixes.length > 0
      const rewritable = req.method !== 'HEAD' && identity && (isHtml || isJs)
      // HEAD must describe the transformed resource too; upstream validators and
      // immutable caching cannot safely identify a mount-specific rewritten body.
      if (identity && (isHtml || isJs)) {
        for (const key of ['etag', 'last-modified', 'content-md5', 'digest', 'content-length']) delete out[key]
        out['cache-control'] = 'no-store'
      }

      if (!rewritable) {
        res.writeHead(upstreamRes.statusCode ?? 502, out)
        upstreamRes.pipe(res)
        return
      }

      const chunks = []
      upstreamRes.on('data', (chunk) => chunks.push(chunk))
      upstreamRes.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const body = Buffer.from(isHtml ? rewriteHtml(text, mount) : rewriteJs(text, mount, rewritePrefixes), 'utf8')
        delete out['content-length']
        out['content-length'] = String(body.length)
        res.writeHead(upstreamRes.statusCode ?? 502, out)
        res.end(body)
      })
      upstreamRes.on('error', () => res.destroy())
    },
  )

  upstream.on('error', (error) => {
    const message = String((error && error.message) || error)
    log('proxy error', message)
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    }
    res.end(`app upstream unavailable: ${message}`)
  })

  // Bind before headers arrive too: an abandoned slow upstream must not linger.
  res.once('close', () => upstream.destroy())
  req.once('aborted', () => upstream.destroy())
  upstream.once('close', () => { if (!res.writableEnded) res.destroy() })
  req.pipe(upstream)
  return upstream
}

/**
 * Tunnel a WebSocket upgrade to the app. After the handshake a WebSocket is just
 * bytes, so replaying the request line with the mount stripped and then piping
 * both directions is enough — no protocol awareness required.
 *
 * This is how a socket app stays EMBEDDED. The host webserver matches upgrade
 * routes by exact pathname, so the caller registers one route per declared
 * socket path under the mount (`/apps/web/<id>/websockify`), and this strips the
 * mount before the app sees it. `mount` is passed so the strip is verifiable
 * rather than assumed; `target.path` is what the app receives.
 */
export function proxyUpgrade(req, socket, head, { target, mount, log = () => {} }) {
  // The query string is part of the handshake for some apps (noVNC passes its
  // token there), so it is forwarded rather than dropped.
  const query = (req.url ?? '').includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
  const upstreamPath = `${target.path}${query}`

  const upstream = net.connect(target.port, target.hostname, () => {
    const lines = [`GET ${upstreamPath} HTTP/1.1`]
    for (const [key, value] of Object.entries(appRequestHeaders(req.headers))) {
      if (key.toLowerCase() === 'host') continue
      if (Array.isArray(value)) {
        for (const one of value) lines.push(`${key}: ${one}`)
      } else if (value !== undefined) {
        lines.push(`${key}: ${value}`)
      }
    }
    lines.push(`host: ${target.host ?? target.hostname}`)
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head && head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })

  const bail = () => {
    try {
      socket.destroy()
    } catch {
      /* already gone */
    }
    try {
      upstream.destroy()
    } catch {
      /* already gone */
    }
  }

  upstream.on('error', (error) => {
    log('upgrade error', `mount=${mount}`, String((error && error.message) || error))
    bail()
  })
  socket.on('error', bail)
  socket.on('close', () => upstream.destroy())
  upstream.on('close', () => socket.destroy())
  upstream.setTimeout(10_000, bail)
  upstream.once('data', () => upstream.setTimeout(0))
  return upstream
}
