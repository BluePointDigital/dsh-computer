/** Read-only GUI view: never opens the worker's credential/private-key volume. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { appStateRoot } from './app-manager.js'
import { check, dnsName } from './tls-config.js'
import { checkDns } from './tls-services.js'

export function publicTlsStatus(s) {
  if (!s?.configured) return { configured: false }
  check(dnsName(s.domain) && typeof s.phase === 'string' && /^[a-z-]{1,64}$/.test(s.phase), 'Invalid public TLS status')
  const records = (s.records || []).map(r => {
    check(['A', 'CNAME'].includes(r.type) && typeof r.name === 'string' && typeof r.value === 'string', 'Invalid public TLS DNS record')
    return { type: r.type, name: r.name, value: r.value, proxy: 'DNS only' }
  })
  return { configured: true, domain: s.domain, staging: s.staging === true, phase: s.phase, records,
    certificate: s.certificate ? { fingerprint: s.certificate.fingerprint, expires: s.certificate.expires, starts: s.certificate.starts,
      expiresInDays: Math.floor((s.certificate.expires - Date.now()) / 86400000) } : null,
    pendingDeployment: s.pendingDeployment === true, lastAttempt: s.lastAttempt, lastSuccess: s.lastSuccess,
    error: s.error ? 'Certificate worker reports an error; operator inspection required.' : null,
    authorityNotice: `Delegation permits certificate validation for ${s.domain} AND *.${s.domain}; it does not change traffic DNS. Removing the CNAME stops future validation, not already issued certificates.`,
    readinessNote: 'TLS status is not proof of gateway authentication, cache bypass or installed browser acceptance.' }
}
export class PublicTls {
  constructor({ root = process.env.DSH_TLS_STATUS_ROOT || path.join(appStateRoot(), 'tls-status') } = {}) { this.file = path.join(root, 'public-status.json') }
  async status() {
    let stat
    try { stat = await fs.lstat(this.file) } catch (error) { if (error.code === 'ENOENT') return { configured: false }; throw error }
    check(stat.isFile() && !stat.isSymbolicLink() && stat.size < 65536 && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'Public TLS snapshot must be an owner-only regular file')
    return publicTlsStatus(JSON.parse(await fs.readFile(this.file, 'utf8')))
  }
  async check() {
    const s = await this.status(); check(s.configured, 'TLS status is not configured')
    const a = s.records.find(r => r.type === 'A' && r.name === `*.${s.domain}`)
    const cname = s.records.find(r => r.type === 'CNAME' && r.name === `_acme-challenge.${s.domain}`)
    check(a && cname && dnsName(cname.value), 'Public DNS onboarding records unavailable')
    return { ...s, dns: await checkDns({ domain: s.domain, ingressAddress: a.value }, { fulldomain: cname.value }) }
  }
}
