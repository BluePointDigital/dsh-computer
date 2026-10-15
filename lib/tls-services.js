/** External adapters: ACME is delegated to Certbot, DNS updates to acme-dns. */
import dns from 'node:dns/promises'
import tls from 'node:tls'
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { check, dnsName } from './tls-config.js'

export async function jsonRequest(base, pathname, { method = 'GET', body, headers = {}, fetcher = fetch } = {}) {
  let response
  try {
    response = await fetcher(base + pathname, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { ...headers, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) })
  } catch { throw Object.assign(Error('Remote API unavailable (connection, TLS or timeout); credentials and response body suppressed'), { tlsCode: 'REMOTE_UNAVAILABLE' }) }
  if (!response.ok) throw Object.assign(Error(`Remote API request failed (HTTP ${response.status}); response body suppressed`), { tlsCode: `REMOTE_HTTP_${response.status}` })
  const text = await response.text()
  check(text.length <= 1024 * 1024, 'Remote API response too large')
  try { return JSON.parse(text) } catch { throw Error('Remote API returned invalid JSON') }
}
export class AcmeDns {
  constructor(config, request = jsonRequest) { this.config = config; this.request = request }
  async register() {
    const a = await this.request(this.config.url, '/register', { method: 'POST', body: {} })
    check(typeof a.username === 'string' && /^[a-f0-9-]{36}$/.test(a.username) && typeof a.password === 'string' && /^[A-Za-z0-9_-]{20,256}$/.test(a.password) && typeof a.subdomain === 'string' && /^[a-f0-9-]{36}$/.test(a.subdomain), 'Invalid acme-dns registration')
    check(dnsName(a.fulldomain) && a.fulldomain === `${a.subdomain}.${this.config.zone}`, 'acme-dns returned a record outside the configured validation zone')
    return { username: a.username, password: a.password, subdomain: a.subdomain, fulldomain: a.fulldomain }
  }
  async update(a, txt) {
    check(/^[A-Za-z0-9_-]{43}$/.test(txt), 'Invalid DNS challenge value')
    await this.request(this.config.url, '/update', { method: 'POST', headers: { 'X-Api-User': a.username, 'X-Api-Key': a.password }, body: { subdomain: a.subdomain, txt } })
  }
}
const canonical = name => name.toLowerCase().replace(/\.$/, '')
export async function checkDns(config, account, resolver = dns) {
  const name = `_acme-challenge.${config.domain}`
  let cnames = [], addresses = [], ipv6 = [], error = false
  try { cnames = await resolver.resolveCname(name) } catch { error = true }
  // Random-looking hostname avoids accidentally accepting only an explicit app A record.
  const probe = `dsh-dns-check-${Date.now().toString(36)}.${config.domain}`
  try { addresses = await resolver.resolve4(probe) } catch { error = true }
  try { ipv6 = await resolver.resolve6(probe) } catch (e) { if (!['ENODATA','ENOTFOUND'].includes(e.code)) error = true }
  const delegation = cnames.length === 1 && canonical(cnames[0]) === account.fulldomain
  const routing = addresses.length === 1 && addresses[0] === config.ingressAddress && ipv6.length === 0
  return { ok: delegation && routing && !error, delegation, routing, observed: { cnames, addresses, ipv6 },
    note: 'Resolver observation only; CAA, DNSSEC, global propagation, private ingress and CDN cache policy are not certified by this check.' }
}
export async function waitForTxt(config, account, txt, { resolver = dns, timeout = 180000, pause = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const until = Date.now() + timeout
  do {
    try {
      const aliases = await resolver.resolveCname(`_acme-challenge.${config.domain}`)
      check(aliases.length === 1 && canonical(aliases[0]) === account.fulldomain, 'DNS delegation changed')
      const values = await resolver.resolveTxt(`_acme-challenge.${config.domain}`)
      if (values.some(parts => parts.join('') === txt)) return
    } catch (error) { if (error.message === 'DNS delegation changed') throw error }
    await pause(2000)
  } while (Date.now() < until)
  throw Error('DNS challenge propagation timed out')
}
export function certificateInfo(fullchain, privateKey, domain, now = Date.now(), staging = false, roots = tls.rootCertificates) {
  const blocks = fullchain.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)
  check(blocks?.length >= 2 && blocks.length <= 8, 'Leaf and intermediate chain required')
  const chain = blocks.map(pem => new X509Certificate(pem)), cert = chain[0]
  check(!cert.ca && cert.checkPrivateKey(createPrivateKey(privateKey)), 'Invalid leaf certificate/private key mismatch')
  check(cert.subjectAltName === `DNS:*.${domain}`, 'Certificate must cover only this deployment wildcard')
  const expires = Date.parse(cert.validTo), starts = Date.parse(cert.validFrom)
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i]
    check(Date.parse(c.validFrom) <= now && Date.parse(c.validTo) > now, 'Certificate chain is not currently valid')
    if (i > 0) check(c.ca && chain[i - 1].checkIssued(c) && chain[i - 1].verify(c.publicKey), 'Invalid intermediate certificate signature')
  }
  const last = chain.at(-1)
  check(staging || roots.some(pem => { const r = new X509Certificate(pem); return last.checkIssued(r) && last.verify(r.publicKey) }), 'Certificate chain does not terminate at a public trust root')
  return { fingerprint: cert.fingerprint256, expires, starts }
}
export async function verifyServed(config, fingerprint, { timeout = 10000, attempts = 5, pause = ms => new Promise(r => setTimeout(r, ms)), connect = tls.connect } = {}) {
  // nginx reload is asynchronous; tolerate old workers briefly, not a stale
  // certificate forever. Each attempt establishes a fresh TLS connection.
  for (let n = 0; n < attempts; n++) {
    try { return await verifyServedOnce(config, fingerprint, timeout, connect) }
    catch (error) { if (n === attempts - 1) throw error; await pause(1000) }
  }
}
function verifyServedOnce(config, fingerprint, timeout, connect) {
  return new Promise((resolve, reject) => {
    // Probe a representative child via public DNS, not the control/apex route.
    const host = `dsh-tls-check.${config.domain}`
    const socket = connect({ host, port: 443, servername: host, rejectUnauthorized: !config.staging }, () => {
      const cert = socket.getPeerCertificate()
      const ok = cert.fingerprint256 === fingerprint && new X509Certificate(cert.raw).checkHost(host)
      socket.end(); if (ok) resolve(); else reject(Error('Public ingress is not serving the expected wildcard certificate'))
    })
    socket.setTimeout(timeout, () => socket.destroy(Error('Public TLS verification timed out')))
    socket.on('error', () => reject(Error('Public TLS verification failed (DNS, trust, routing or timeout)')))
  })
}

export class NpmTls {
  constructor(config, request = jsonRequest) { this.config = config; this.request = request }
  async login() {
    const result = await this.request(this.config.url, '/api/tokens', { method: 'POST', body: { identity: this.config.identity, secret: this.config.secret } })
    check(typeof result.token === 'string' && result.token.length > 10, 'Invalid NPM authentication response')
    this.token = result.token
  }
  call(path, method = 'GET', body) { return this.request(this.config.url, '/api/nginx/' + path, { method, body, headers: { authorization: `Bearer ${this.token}` } }) }
  async certificate(deployment, id, saveId) {
    const name = `dsh-apps-${deployment}`
    const certs = await this.call('certificates')
    check(Array.isArray(certs), 'Invalid NPM certificate listing')
    let found = id ? certs.find(c => c.id === id) : certs.find(c => c.nice_name === name)
    if (id) check(found, 'Managed NPM certificate disappeared; operator recovery required')
    if (found) check(found.provider === 'other' && found.nice_name === name, 'NPM certificate ownership mismatch')
    else found = await this.call('certificates', 'POST', { provider: 'other', nice_name: name, domain_names: [], meta: {} })
    check(Number.isInteger(found.id) && found.id > 0, 'Invalid NPM certificate id')
    await saveId(found.id)
    return found.id
  }
  async upload(id, fullchain, privateKey) {
    const form = new FormData()
    const chain = fullchain.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)
    check(chain?.length >= 2, 'A leaf and intermediate certificate chain are required')
    form.set('certificate', new Blob([chain[0] + '\n'], { type: 'application/x-pem-file' }), 'cert.pem')
    form.set('intermediate_certificate', new Blob([chain.slice(1).join('\n') + '\n'], { type: 'application/x-pem-file' }), 'chain.pem')
    form.set('certificate_key', new Blob([privateKey], { type: 'application/x-pem-file' }), 'privkey.pem')
    await this.call(`certificates/${id}/upload`, 'POST', form)
  }
  async planRoute(domain, deployment, certId, id) {
    const hosts = await this.call('proxy-hosts')
    check(Array.isArray(hosts), 'Invalid NPM proxy listing')
    const wildcard = `*.${domain}`
    // Refuse other wildcard, explicit-child or location routes in our namespace;
    // never overwrite control-host routes or silently take over operator routes.
    const collisions = hosts.filter(h => h.domain_names?.some(n => n === wildcard || n.endsWith('.' + domain)))
    let found = id ? hosts.find(h => h.id === id) : collisions.find(h => h.meta?.dsh_apps_tls === deployment)
    if (id) check(found, 'Managed NPM route disappeared; operator recovery required')
    if (found) check(found.meta?.dsh_apps_tls === deployment && found.domain_names?.length === 1 && found.domain_names[0] === wildcard && (!found.locations || found.locations.length === 0), 'NPM route ownership/configuration mismatch')
    check(collisions.every(h => h.id === found?.id), 'Conflicting NPM app hostname route; operator must resolve it')
    // A same-ID upload affects every consumer. Never rotate a certificate that
    // another proxy/redirect/dead host has attached, even outside our namespace.
    if (certId) check(hosts.every(h => h.certificate_id !== certId || h.id === found?.id), 'Managed certificate is referenced by a foreign proxy host')
    const desired = { domain_names: [wildcard], enabled: true, forward_scheme: 'http', forward_host: this.config.forwardHost, forward_port: this.config.forwardPort,
      access_list_id: 0, certificate_id: certId, ssl_forced: true, caching_enabled: false, block_exploits: false, allow_websocket_upgrade: true,
      http2_support: true, hsts_enabled: false, hsts_subdomains: false, advanced_config: 'proxy_buffering off;\nproxy_request_buffering off;\n', locations: [],
      meta: { dsh_apps_tls: deployment } }
    // Redirection/dead-host records also own hostnames; do not issue uploads
    // before detecting collisions in these other NPM namespaces.
    for (const kind of ['redirection-hosts', 'dead-hosts']) {
      const others = await this.call(kind)
      check(Array.isArray(others) && !others.some(h => h.domain_names?.some(n => n === wildcard || n.endsWith('.' + domain))), 'Conflicting NPM redirect/dead hostname route')
      if (certId) check(others.every(h => h.certificate_id !== certId), 'Managed certificate is referenced by a foreign redirect/dead host')
    }
    if (certId) {
      const streams = await this.call('streams')
      check(Array.isArray(streams) && streams.every(s => s.certificate_id !== certId), 'Managed certificate is referenced by a foreign stream')
    }
    return { found, desired }
  }
  async audit(domain, deployment, certId, hostId, { recovering = false } = {}) {
    check(Number.isInteger(certId) && Number.isInteger(hostId), 'Missing managed NPM identity')
    const cert = await this.call(`certificates/${certId}`)
    check(cert.provider === 'other' && cert.nice_name === `dsh-apps-${deployment}`, 'NPM certificate ownership drift')
    const { found, desired } = await this.planRoute(domain, deployment, certId, hostId)
    check(found && (recovering || found.meta?.nginx_online === true) && (found.enabled === true || found.enabled === 1), 'Managed NPM route is offline')
    for (const field of ['forward_scheme','forward_host','forward_port','access_list_id','certificate_id','advanced_config']) check(found[field] === desired[field], 'Managed NPM route configuration drift')
    for (const field of ['ssl_forced','caching_enabled','allow_websocket_upgrade','block_exploits','hsts_enabled','hsts_subdomains','http2_support']) check(Boolean(found[field]) === desired[field], 'Managed NPM security configuration drift')
  }
  async route(domain, deployment, certId, id, saveId) {
    const { found, desired } = await this.planRoute(domain, deployment, certId, id)
    // PUT also triggers nginx configuration/reload after same-id custom cert upload.
    const result = await this.call(found ? `proxy-hosts/${found.id}` : 'proxy-hosts', found ? 'PUT' : 'POST', desired)
    check(Number.isInteger(result.id) && result.id > 0, 'Invalid NPM route id')
    await saveId(result.id)
    const actual = await this.call(`proxy-hosts/${result.id}`)
    check(actual.meta?.nginx_online === true && actual.enabled !== false && actual.enabled !== 0, 'NPM rejected gateway route/reload')
    return result.id
  }
}
