/** Per-deployment durable TLS control plane. Not imported into the app data path. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { AppManager, appStateRoot } from './app-manager.js'
import { tlsConfig, onboarding, check } from './tls-config.js'
import { publicTlsStatus } from './tls-public.js'
import { AcmeDns, NpmTls, checkDns, certificateInfo, verifyServed } from './tls-services.js'
const exec = promisify(execFile)
const DAY = 86400000
export class TlsManager {
  constructor({ root = path.join(appStateRoot(), 'tls'), dnsFactory = c => new AcmeDns(c), npmFactory = c => new NpmTls(c), dnsCheck = checkDns, issue, inspect = certificateInfo, verify = verifyServed, now = Date.now, execute = exec } = {}) {
    this.store = new AppManager({ root }); this.root = this.store.root
    this.dnsFactory = dnsFactory; this.npmFactory = npmFactory; this.dnsCheck = dnsCheck
    this.issue = issue ?? ((c) => this.certbot(c)); this.inspect = inspect; this.verify = verify; this.now = now; this.execute = execute
  }
  async read() {
    await this.store.init()
    try {
      const stat = await fs.lstat(path.join(this.root, 'deployment.json'))
      check(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'TLS state must be an owner-only regular file')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    let state
    try { state = await this.store.read('deployment.json', null) }
    catch { throw Error('TLS deployment state is unreadable or corrupt; private contents suppressed') }
    if (!state) return null
    check(state.version === 1 && /^[a-f0-9-]{36}$/.test(state.id), 'Unsupported/corrupt TLS deployment state')
    tlsConfig(state.config)
    return state
  }
  async save(s) {
    await this.store.save('deployment.json', s)
    if (process.env.DSH_TLS_STATUS_ROOT) {
      const snapshots = new AppManager({ root: process.env.DSH_TLS_STATUS_ROOT })
      await snapshots.init()
      await snapshots.save('public-status.json', publicTlsStatus(this.public(s)))
    }
  }
  public(s) {
    if (!s) return { configured: false }
    return { configured: true, domain: s.config.domain, staging: s.config.staging, phase: s.phase,
      records: s.account ? onboarding(s.config, s.account) : [], dns: s.dns ?? null,
      certificate: s.certificate ? { ...s.certificate, expiresInDays: Math.floor((s.certificate.expires - this.now()) / DAY) } : null,
      pendingDeployment: !!s.pending, lastAttempt: s.lastAttempt ?? null, lastSuccess: s.lastSuccess ?? null,
      error: s.error ?? null, authorityNotice: `Delegation permits certificate validation for ${s.config.domain} AND *.${s.config.domain}; it does not change traffic DNS. Removing the CNAME stops future validation, not already issued certificates.`,
      readinessNote: 'TLS status is not proof of gateway authentication, cache bypass or installed browser acceptance.' }
  }
  async status() { return this.public(await this.read()) }
  async setup(input) {
    const config = tlsConfig(input)
    return this.store.locked(async () => {
      let s = await this.read()
      if (s) check(JSON.stringify(s.config) === JSON.stringify(config), 'TLS deployment already configured differently; explicit operator migration required')
      else { s = { version: 1, id: randomUUID(), config, phase: 'registering' }; await this.save(s) }
      if (!s.account) {
        s.account = await this.dnsFactory(config.acmeDns).register()
        s.phase = 'awaiting-dns'; await this.save(s)
      }
      return this.public(s)
    })
  }
  async check() {
    return this.store.locked(async () => {
      const s = await this.read(); check(s?.account, 'Complete TLS setup first')
      s.dns = await this.dnsCheck(s.config, s.account); await this.save(s)
      return this.public(s)
    })
  }
  async reconcile({ issue = false, deployStaging = false } = {}) {
    return this.store.locked(async () => {
      const s = await this.read(); check(s?.account, 'Complete TLS setup first')
      s.lastAttempt = this.now(); s.error = null; await this.save(s)
      try {
        // Never install staging into ingress unless explicitly acknowledged. Use a
        // separate domain/NPM instance for staging: one state cannot switch CA mode.
        check(!s.config.staging || deployStaging || !issue, 'Staging certificate deployment requires explicit acknowledgement on isolated ingress')
        s.dns = await this.dnsCheck(s.config, s.account)
        check(s.dns.ok, 'DNS delegation/routing is not ready; use Check DNS for observed records')
        // Check hostname ownership/security before placing an order or uploading
        // material. Renewal must not silently repair an operator's policy drift.
        const npm = this.npmFactory(s.config.npm)
        await npm.login()
        if (s.current) await npm.audit(s.config.domain, s.id, s.certId, s.hostId, { recovering: !!s.pending })
        else await npm.planRoute(s.config.domain, s.id, s.certId, s.hostId)
        const remaining = s.certificate ? s.certificate.expires - this.now() : 0
        const lifetime = s.certificate ? s.certificate.expires - s.certificate.starts : 0
        const due = !s.certificate || remaining < Math.min(30 * DAY, lifetime / 3)
        // A successful issuance followed by failed upload is retried WITHOUT a
        // fresh order, even if renewal is no longer due. Crash state is durable.
        if (s.pending && s.pending.info.expires <= this.now()) {
          check(issue, 'Pending certificate expired; run renew to replace it')
          s.pending = null; s.phase = 'expired-pending-replaced'; await this.save(s)
        }
        if (!s.pending && (due || !s.current)) {
          check(issue, 'Certificate issuance is due; run renew/activate')
          s.phase = 'issuing'; await this.save(s)
          const material = await this.issue(s.config)
          const info = this.inspect(material.fullchain, material.privateKey, s.config.domain, this.now(), s.config.staging)
          s.pending = { ...material, info }; s.phase = 'pending-deployment'; await this.save(s)
        }
        if (!s.pending) {
          s.phase = 'auditing-ingress'; await this.save(s)
          await this.verify(s.config, s.certificate.fingerprint)
          s.lastSuccess = this.now(); s.phase = 'ready'; await this.save(s)
          return this.public(s)
        }
        check(!s.config.staging || deployStaging, 'Refusing staging deployment without isolated-ingress acknowledgement')
        const p = s.pending
        this.inspect(p.fullchain, p.privateKey, s.config.domain, this.now(), s.config.staging)
        s.phase = 'npm-login'; await this.save(s)
        s.certId = await npm.certificate(s.id, s.certId, async id => { s.certId = id; await this.save(s) })
        // Preserve the old material locally; NPM itself is not transactional. A
        // failed reload is reported and remains pending for operator retry.
        s.phase = 'deploying'; await this.save(s)
        await npm.planRoute(s.config.domain, s.id, s.certId, s.hostId)
        try {
          await npm.upload(s.certId, p.fullchain, p.privateKey)
          s.hostId = await npm.route(s.config.domain, s.id, s.certId, s.hostId, async id => { s.hostId = id; await this.save(s) })
          await this.verify(s.config, p.info.fingerprint)
        } catch (error) {
          if (s.current) {
            try {
              this.inspect(s.current.fullchain, s.current.privateKey, s.config.domain, this.now(), s.config.staging)
              await npm.upload(s.certId, s.current.fullchain, s.current.privateKey)
              await npm.route(s.config.domain, s.id, s.certId, s.hostId, async id => { s.hostId = id; await this.save(s) })
              await this.verify(s.config, s.certificate.fingerprint)
              s.phase = 'pending-deployment-rolled-back'
            } catch { s.phase = 'pending-deployment-rollback-failed' }
          }
          throw error
        }
        s.previous = s.current ?? null; s.current = { fullchain: p.fullchain, privateKey: p.privateKey }
        s.certificate = p.info; s.pending = null; s.phase = 'ready'; s.lastSuccess = this.now(); await this.save(s)
        return this.public(s)
      } catch (error) {
        // Raw upstream errors can contain credentials/PEMs. Only stable stage is
        // exposed; detailed external response bodies are deliberately discarded.
        const safeReason = typeof error.tlsCode === 'string' && /^[A-Z0-9_]{1,48}$/.test(error.tlsCode) ? error.tlsCode : 'OPERATION_FAILED'
        s.error = `TLS operation failed during ${s.phase} (${safeReason}); inspect DNS, service availability and private operator logs. Retry reconciles pending deployment.`
        await this.save(s)
        throw Error(s.error, { cause: error })
      }
    })
  }
  async certbot(config) {
    const base = path.join(this.root, 'certbot')
    for (const leaf of ['', 'config', 'work', 'logs']) await fs.mkdir(path.join(base, leaf), { recursive: true, mode: 0o700 })
    const cli = fileURLToPath(new URL('../bin/tls-cli.mjs', import.meta.url))
    // Certbot hooks are shell commands; quote operator paths, never customer data.
    const quote = s => `'${s.replaceAll("'", "'\\''")}'`
    // Certbot 2.x validates the first whitespace-delimited word without shell
    // parsing. Keep that executable unquoted; safely quote the complete inner
    // command so paths containing spaces/apostrophes still work.
    const hook = '/bin/sh -c ' + quote('exec ' + [process.execPath, cli, 'auth-hook', this.root].map(quote).join(' '))
    const args = ['certonly', '--non-interactive', '--agree-tos', '--email', config.email, '--manual', '--preferred-challenges', 'dns',
      '--manual-auth-hook', hook, '--cert-name', 'dsh-apps', '--keep-until-expiring', '--key-type', 'rsa',
      '--config-dir', path.join(base, 'config'), '--work-dir', path.join(base, 'work'), '--logs-dir', path.join(base, 'logs'),
      '--server', config.staging ? 'https://acme-staging-v02.api.letsencrypt.org/directory' : 'https://acme-v02.api.letsencrypt.org/directory', '-d', `*.${config.domain}`]
    try { await this.execute('certbot', args, { timeout: 600000, maxBuffer: 1024 * 1024, env: { ...process.env, DSH_TLS_HOOK: '1' } }) }
    catch { throw Error('Certbot unavailable or issuance failed; see owner-only Certbot logs') }
    const live = path.join(base, 'config', 'live', 'dsh-apps')
    return { fullchain: await fs.readFile(path.join(live, 'fullchain.pem'), 'utf8'), privateKey: await fs.readFile(path.join(live, 'privkey.pem'), 'utf8') }
  }
}
