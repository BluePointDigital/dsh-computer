/** Read-only, bounded DNS observations. Never reads worker credentials or changes DNS. */
import { Resolver } from 'node:dns/promises'
import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
const missing = new Set(['ENODATA', 'ENOTFOUND'])
export class AccessHealth {
  constructor({ gateway, tlsManager, listenerReady = () => false, resolver = new Resolver({ timeout: 2000, tries: 1 }), now = Date.now } = {}) {
    Object.assign(this, { gateway, tlsManager, listenerReady, resolver, now }); this.cached = null; this.flight = null
  }
  async status(force = false) {
    if (this.flight) return this.flight
    if (this.cached && this.now() - this.cached.at < (force ? 5000 : 30000)) return this.cached.value
    this.flight = this.inspect().then(value => { this.cached = { at: this.now(), value }; return value }).finally(() => { this.flight = null })
    return this.flight
  }
  async inspect() {
    const g = this.gateway, issues = [], records = []
    const result = { checkedAt: new Date(this.now()).toISOString(), mode: g?.mode || 'legacy', issues, records,
      note: 'Server resolver observation only—not proof of global propagation, browser DNS, ingress authentication or CDN cache policy.' }
    const issue = (kind, title, instruction) => issues.push({ kind, title, instruction })
    if (g?.mode !== 'isolated') {
      issue('configuration', 'Authenticated app gateway is not configured', 'Ask the operator to enable isolated app access, configure an appDomain, and provision wildcard DNS, HTTPS and a private gateway. Public app ports are not protected by Harness login.')
      return result
    }
    result.domain = g.domain
    let snapshot
    try { snapshot = await this.tlsManager.status() } catch { issue('unknown', 'Certificate status could not be read', 'Ask the operator to check the sanitized TLS status snapshot; no private certificate credentials are needed by this page.') }
    if (snapshot?.configured && snapshot.domain !== g.domain) {
      issue('configuration', 'Certificate setup is for another domain', `Ask the operator to align the TLS deployment with ${g.domain}. Records from the other deployment are not shown.`)
      snapshot = null
    }
    const configured = snapshot?.configured
    if (configured) records.push(...snapshot.records)
    const expected = records.find(r => r.type === 'A' && r.name === `*.${g.domain}`)?.value
    if (!expected) records.push({ type: 'A', name: `*.${g.domain}`, value: null, proxy: 'DNS only' })
    const query = async (method, name) => {
      try { return { values: await this.resolver[method](name), state: 'observed' } }
      catch (e) { return { values: [], state: missing.has(e.code) ? 'missing' : 'unknown' } }
    }
    const probe = `dsh-check-${randomBytes(8).toString('hex')}.${g.domain}`
    const [a, aaaa] = await Promise.all([query('resolve4', probe), query('resolve6', probe)])
    result.dns = { probe, addresses: a.values, ipv6: aaaa.values, state: 'observed' }
    if (a.state === 'unknown' || aaaa.state === 'unknown') {
      result.dns.state = 'unknown'
      issue('unknown', 'DNS check is inconclusive', 'The server resolver timed out or failed. Check DNS resolver connectivity, then Recheck. This does not prove the record is missing.')
    } else if (!a.values.length && !aaaa.values.length) {
      result.dns.state = 'missing'
      issue('dns', 'Wildcard app DNS is missing', `Create the wildcard record shown below. A record for the Harness hostname alone does not cover app subdomains. Wait for propagation, then Recheck.`)
    }
    if (expected && isIP(expected) === 4) {
      if (a.state !== 'unknown' && (a.values.length !== 1 || a.values[0] !== expected || aaaa.values.length)) {
        issue('dns', 'App DNS does not match the configured ingress', `Set *.${g.domain} to A ${expected}, DNS only. Remove conflicting A/AAAA records unless the operator has explicitly provisioned those ingress addresses.`)
      }
    } else issue('configuration', 'Expected ingress address is not configured', 'Ask the operator for the public ingress IP and configure the TLS onboarding snapshot. Do not use a private container IP or copy an unrelated instance’s address.')
    const delegation = records.find(r => r.type === 'CNAME' && r.name === `_acme-challenge.${g.domain}`)
    if (delegation) {
      const cname = await query('resolveCname', delegation.name)
      result.dns.cnames = cname.values
      if (cname.state === 'unknown') issue('unknown', 'Certificate-validation DNS check is inconclusive', 'Check resolver connectivity and Recheck; do not replace the delegation based on a timeout.')
      else if (cname.values.length !== 1 || cname.values[0].toLowerCase().replace(/\.$/, '') !== delegation.value.toLowerCase().replace(/\.$/, '')) issue('dns', 'Certificate-validation CNAME is missing or incorrect', 'Create or correct the exact CNAME shown below. It enables certificate issuance and renewal; it does not route app traffic.')
    }
    if (!configured) issue('tls', 'Wildcard HTTPS setup is not provisioned', `Ask the operator to provision a certificate for *.${g.domain}, its renewal method, and a private HTTPS ingress route. If delegated validation is used, its unique CNAME appears here after provisioning; do not guess it.`)
    else {
      if (snapshot.staging || !snapshot.certificate || !(snapshot.certificate.expires > this.now())) issue('tls', 'Wildcard certificate is not production-ready', `Ask the operator to complete or renew the trusted wildcard certificate. Worker phase: ${snapshot.phase}.`)
      if (snapshot.error || snapshot.pendingDeployment) issue('tls', 'Certificate worker needs attention', 'Ask the operator to inspect the certificate worker and finish the pending deployment. DNS alone may not be the cause.')
    }
    if (!this.listenerReady()) issue('gateway', 'Private app gateway is unavailable', 'Ask the operator to check the private listener, bind address and ingress peer allowlist. Do not open public app ports as a workaround.')
    return result
  }
}
