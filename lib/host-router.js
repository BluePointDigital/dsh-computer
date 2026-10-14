/**
 * Host-scoped routing for web apps.
 *
 * WHY THIS EXISTS
 *
 * The `/apps/web/<id>/` mount publishes an app under a path. Most apps assume
 * they own the origin root and emit root-absolute URLs (`/api/login`,
 * `/static/x.js`). Under a path mount those URLs address the HARNESS, not the
 * app, so the proxy has to rewrite HTML, rewrite selected JS literals, and
 * re-scope redirects and cookies. That works only where the app happens to
 * write its URLs as literals we can see: an app that builds them at runtime
 * from server config cannot be fixed this way, and each such app needs its own
 * bespoke rule.
 *
 * Serving the same app on its own hostname removes the mismatch instead of
 * patching it. On `filebrowser.example.com` the app really is at `/api/login`,
 * so no rewrite is needed at all and the app needs no configuration.
 *
 * The plugin's job is therefore small: resolve a request's `Host` header to an
 * app, forward the path UNCHANGED, and let the response through untouched.
 * `proxyHttp` already behaves correctly at `mount = ''` (verified: redirects,
 * cookies and CSP all become no-ops or the correct root form), so this module
 * supplies the routing decision and the listener that owns it — nothing else.
 *
 * DSH's `webServer` cannot express this. `WebRoute` has no host field, and the
 * one seat that sees arbitrary paths (`registerFallback`) is single-owner and
 * already held by the SPA server. Hence a separate listener.
 */

/**
 * Normalize a `Host` header to a bare lowercase hostname.
 *
 * `Host` may carry a port (`app.example.com:8443`), IPv6 brackets
 * (`[::1]:3080`) or a trailing dot (`app.example.com.`), and the value is
 * attacker-controlled. Returns `''` for anything that cannot be a hostname, so
 * a malformed header falls through to "no app" rather than matching something.
 */
export function normalizeHost(raw) {
  if (typeof raw !== 'string') return ''
  let value = raw.trim().toLowerCase()
  if (value === '') return ''
  // A comma would mean multiple values, which is not valid for Host. Refuse it
  // rather than pick one: guessing here would be a routing decision made from
  // ambiguous input.
  if (value.includes(',') || /[\s/\\@?#]/.test(value)) return ''

  if (value.startsWith('[')) {
    // Bracketed IPv6. A literal address is never one of our app hostnames, but
    // normalize it anyway so callers see a consistent shape.
    const close = value.indexOf(']')
    if (close === -1) return ''
    const rest = value.slice(close + 1)
    if (rest !== '' && !/^:\d+$/.test(rest)) return ''
    return value.slice(1, close)
  }

  const colon = value.lastIndexOf(':')
  if (colon !== -1) {
    const port = value.slice(colon + 1)
    if (!/^\d+$/.test(port)) return ''
    // A bare hostname has no colon; a colon here is a port separator.
    value = value.slice(0, colon)
  }
  // Trailing-dot (fully qualified) form is the same host to DNS.
  value = value.replace(/\.+$/, '')
  if (value === '') return ''
  // Labels: alphanumerics and hyphens, dot-separated. Underscores and other
  // characters are not valid in a hostname we would route on.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(value)) return ''
  return value
}

/**
 * Index the apps that declare a `webHost` by normalized hostname.
 *
 * A hostname claimed by two apps is a catalog error, not a preference: routing
 * would silently pick whichever came first. `problems` reports it so the caller
 * can refuse to serve that host, and `byHost` omits it entirely.
 *
 * @param {Array<{id?: string, web?: {webHost?: string, containerPort?: unknown}}>} apps
 * @returns {{byHost: Map<string, object>, problems: string[]}}
 */
export function indexHostApps(apps) {
  const byHost = new Map()
  const problems = []
  const seen = new Map()
  for (const app of Array.isArray(apps) ? apps : []) {
    const declared = app?.web?.webHost
    if (typeof declared !== 'string' || declared.trim() === '') continue
    const host = normalizeHost(declared)
    if (host === '') {
      problems.push(`app '${app?.id ?? '?'}': webHost '${declared}' is not a valid hostname`)
      continue
    }
    const port = Number(app?.web?.containerPort)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      problems.push(`app '${app.id}': webHost set but containerPort '${app?.web?.containerPort}' is not a port`)
      continue
    }
    const prior = seen.get(host)
    if (prior !== undefined) {
      problems.push(`webHost '${host}' is claimed by both '${prior}' and '${app.id}'`)
      // Drop the host entirely. Leaving the first claim in place would serve a
      // hostname the catalog says is ambiguous — the exact silent preference
      // this check exists to prevent.
      byHost.delete(host)
      continue
    }
    seen.set(host, app.id)
    byHost.set(host, app)
  }
  return { byHost, problems }
}

/**
 * Resolve a request's `Host` to an app.
 *
 * Matching is EXACT, deliberately. A suffix rule (`*.example.com`) would make
 * every name under the domain route somewhere, and with wildcard DNS and a
 * wildcard certificate that turns any typo — or any attacker-chosen name — into
 * a request forwarded to a container. Exact names keep the reachable set equal
 * to the declared set.
 *
 * @returns {{app: object, host: string} | {app: null, host: string}}
 */
export function matchHostApp(rawHost, byHost) {
  const host = normalizeHost(rawHost)
  if (host === '') return { app: null, host: '' }
  const app = byHost instanceof Map ? byHost.get(host) : undefined
  return { app: app ?? null, host }
}

/**
 * A body an operator can act on when a hostname is not routed.
 *
 * Reached in practice by a hostname pointed at this port that no app declares,
 * or by a health probe. It is deliberately plain text: whoever sees it is
 * looking at a proxy misconfiguration, and the useful information is which
 * names WOULD have worked. Reported hostnames are safe to show — they are the
 * ones the catalog declares, not the ones the request claimed.
 */
export function unroutedResponse(host, byHost) {
  const known = byHost instanceof Map ? [...byHost.keys()].sort() : []
  const lines = [
    'dsh-applications: no app is routed to this hostname.',
    '',
    `received Host: ${host === '' ? '(absent or malformed)' : host}`,
    known.length === 0
      ? 'no app declares a webHost'
      : `hostnames that would work: ${known.join(', ')}`,
    '',
    'Declare a hostname by adding "webHost" to the app in apps.yaml, then',
    'reload the catalog. See the host mounting notes in SKILL.md.',
  ]
  return `${lines.join('\n')}\n`
}
