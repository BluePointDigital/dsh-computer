/** Run only inside the private canary worker after initial staging activation. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { TlsManager } from '/opt/dsh-applications/lib/tls-manager.js'
import { NpmTls } from '/opt/dsh-applications/lib/tls-services.js'
const m = new TlsManager()
const original = await m.read()
assert.equal(original.config.domain, 'tls-canary.bluepointdigital.com')
assert.equal(original.config.staging, true)
assert.equal(original.phase, 'ready')
const certId = original.certId, hostId = original.hostId, fingerprint = original.certificate.fingerprint
await m.reconcile({ issue: true, deployStaging: true })
assert.equal((await m.read()).certificate.fingerprint, fingerprint)
console.log(JSON.stringify({ check: 'not-due-reconcile', sameCertId: true, fingerprint }))
// Exercise durable pending recovery using the already issued staging bundle.
// No extra order or certificate/key exposure. Fault before upload, then rollback
// through the real adapter. A new manager must then retry without issuance.
await m.store.locked(async () => {
  const s = await m.read()
  s.pending = { ...s.current, info: s.certificate }; s.phase = 'pending-deployment'
  await m.save(s)
})
let attempts = 0
const failing = new TlsManager({ npmFactory: config => {
  const api = new NpmTls(config), upload = api.upload.bind(api)
  api.upload = async (...args) => { if (++attempts === 1) throw Error('Controlled pre-upload fault'); return upload(...args) }
  return api
} })
await assert.rejects(failing.reconcile({ deployStaging: true }))
const failed = await m.read()
assert.equal(failed.phase, 'pending-deployment-rolled-back')
assert.ok(failed.pending)
console.log(JSON.stringify({ check: 'controlled-deploy-failure', phase: failed.phase, pendingRetained: true }))
const resumed = new TlsManager({ issue: async () => { throw Error('Must not place a new order for pending retry') } })
await resumed.reconcile({ deployStaging: true })
const ready = await resumed.read()
assert.equal(ready.certId, certId); assert.equal(ready.hostId, hostId)
assert.equal(ready.certificate.fingerprint, fingerprint); assert.equal(ready.pending, null)
console.log(JSON.stringify({ check: 'pending-retry-real-upload-reload', certId, hostId, fingerprint }))
// Certbot's actual automated renewal simulation, against staging only; hooks
// update the real scoped TXT registration. It must not replace current material.
execFileSync('certbot', ['renew', '--dry-run', '--no-random-sleep-on-renew', '--non-interactive', '--cert-name', 'dsh-apps',
  '--config-dir', m.root + '/certbot/config', '--work-dir', m.root + '/certbot/work', '--logs-dir', m.root + '/certbot/logs'],
  { stdio: ['ignore','pipe','pipe'], timeout: 600000, env: { ...process.env, DSH_TLS_HOOK: '1' } })
assert.equal((await m.read()).certificate.fingerprint, fingerprint)
console.log(JSON.stringify({ check: 'real-certbot-renew-dry-run', passed: true, deployedFingerprintUnchanged: true }))
