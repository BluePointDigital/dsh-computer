import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { tlsConfig, onboarding } from '../lib/tls-config.js'
import { AcmeDns, NpmTls, checkDns, waitForTxt, certificateInfo, jsonRequest, verifyServed } from '../lib/tls-services.js'
import { TlsManager } from '../lib/tls-manager.js'
const config = () => ({ domain: 'dev.customer.example', ingressAddress: '192.0.2.10', email: 'ops@customer.example', termsAgreed: true, staging: false,
  privateIngressConfirmed: true, cacheBypassConfirmed: true,
  acmeDns: { url: 'https://validation.example', zone: 'auth.validation.example' },
  npm: { url: 'http://npm:81', allowPrivateHttp: true, identity: 'operator', secret: 'NPM-SECRET-NEVER-PUBLIC', forwardHost: 'dsh-instance', forwardPort: 3099 } })
const account = { username: '11111111-1111-4111-8111-111111111111', password: 'validation-secret-never-public-12345', subdomain: '22222222-2222-4222-8222-222222222222', fulldomain: '22222222-2222-4222-8222-222222222222.auth.validation.example' }
const resolver = overrides => ({ resolveCname: async () => [account.fulldomain + '.'], resolve4: async () => ['192.0.2.10'], resolve6: async () => { throw Object.assign(Error(), { code: 'ENODATA' }) }, resolveTxt: async () => [['x'.repeat(43)]], ...overrides })
async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-tls-test-'))
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), 'dsh-tls-test-'))); await fs.rm(root, { recursive: true, force: true }) })
  return root
}
test('provider-neutral two-record onboarding; dangerous and incomplete config rejected', () => {
  const c = tlsConfig(config()), records = onboarding(c, account)
  assert.deepEqual(records.map(r => r.type), ['A','CNAME'])
  assert.equal(records[1].name, '_acme-challenge.dev.customer.example')
  assert.equal(records[1].value, account.fulldomain)
  assert.equal(c.staging, false)
  assert.equal(tlsConfig({ ...config(), staging: undefined }).staging, true)
  for (const patch of [{ domain: '*.customer.example' }, { domain: 'UPPER.example' }, { domain: '127.0.0.1' }, { ingressAddress: 'not-an-IP' }, { termsAgreed: false }, { privateIngressConfirmed: false }, { cacheBypassConfirmed: false }, { acmeDns: { ...c.acmeDns, url: 'http://validation.example' } }, { npm: { ...c.npm, allowPrivateHttp: false } }, { npm: { ...c.npm, url: 'https://user:password@npm.example' } }]) assert.throws(() => tlsConfig({ ...config(), ...patch }))
})
test('DNS checks exact delegation, wildcard A and conflicting IPv6; diagnostics contain no credentials', async () => {
  const c = tlsConfig(config())
  assert.equal((await checkDns(c, account, resolver())).ok, true)
  for (const r of [resolver({ resolveCname: async () => ['attacker.example'] }), resolver({ resolve4: async () => ['192.0.2.11'] }), resolver({ resolve6: async () => ['2001:db8::1'] })]) assert.equal((await checkDns(c, account, r)).ok, false)
  const result = await checkDns(c, account, resolver({ resolveCname: async () => { throw Error('DNS failure') } }))
  assert.equal(result.delegation, false)
  assert.ok(!JSON.stringify(result).includes(account.password))
})
test('challenge propagation observes CNAME + TXT, times out and rejects changed delegation', async () => {
  await waitForTxt(config(), account, 'x'.repeat(43), { resolver: resolver(), timeout: 1 })
  await assert.rejects(waitForTxt(config(), account, 'y'.repeat(43), { resolver: resolver(), timeout: 0, pause: async () => {} }), /timed out/)
  await assert.rejects(waitForTxt(config(), account, 'x'.repeat(43), { resolver: resolver({ resolveCname: async () => ['wrong.example'] }) }), /delegation changed/)
})
test('acme-dns registration is scoped; only valid challenge digests are sent', async () => {
  const calls = []
  const service = new AcmeDns(config().acmeDns, async (...args) => { calls.push(args); return account })
  assert.deepEqual(await service.register(), account)
  await service.update(account, 'x'.repeat(43))
  assert.equal(calls[1][2].headers['X-Api-Key'], account.password)
  assert.deepEqual(calls[1][2].body, { subdomain: account.subdomain, txt: 'x'.repeat(43) })
  await assert.rejects(service.update(account, 'wrong'), /challenge/)
  const bad = new AcmeDns(config().acmeDns, async () => ({ ...account, fulldomain: 'attacker.example' }))
  await assert.rejects(bad.register(), /outside/)
})
test('remote failures never expose response secrets; redirects and deadlines enforced', async () => {
  await assert.rejects(jsonRequest('https://api.example', '/', { fetcher: async (_url, opts) => { assert.equal(opts.redirect, 'error'); assert.ok(opts.signal); return { ok: false, status: 401, text: async () => account.password } } }), e => !e.message.includes(account.password) && /401/.test(e.message))
  await assert.rejects(jsonRequest('https://api.example', '/', { fetcher: async () => { throw Error(account.password) } }), e => !e.message.includes(account.password))
})
function npmFixture(overrides = {}) {
  const calls = [], certs = [], hosts = []
  const request = async (_base, url, opts) => {
    calls.push({ url, ...opts })
    if (url === '/api/tokens') return { token: 'private-bearer-token' }
    const p = url.replace('/api/nginx/', '')
    if (p === 'certificates' && opts.method === 'GET') return certs
    if (p === 'certificates' && opts.method === 'POST') { const row = { ...opts.body, id: 5 }; certs.push(row); return row }
    if (p === 'certificates/5' && opts.method === 'GET') return certs[0]
    if (p === 'certificates/5/upload') { assert.ok(opts.body instanceof FormData); return { privateKey: 'DO NOT LOG' } }
    if (['redirection-hosts', 'dead-hosts', 'streams'].includes(p)) return overrides[p] || []
    if (p === 'proxy-hosts' && opts.method === 'GET') return hosts
    if (p === 'proxy-hosts' && opts.method === 'POST') { const h = { ...opts.body, id: 7, meta: { ...opts.body.meta, nginx_online: true } }; hosts.push(h); return h }
    if (p === 'proxy-hosts/7' && opts.method === 'GET') return hosts[0]
    if (p === 'proxy-hosts/7' && opts.method === 'PUT') { Object.assign(hosts[0], opts.body, { meta: { ...opts.body.meta, nginx_online: true } }); return hosts[0] }
    throw Error('Unexpected fixture request ' + p)
  }
  return { api: new NpmTls(config().npm, request), calls, certs, hosts }
}
test('NPM custom cert ownership, multipart leaf/chain/key, same-ID reload and safe wildcard route', async () => {
  const { api, calls, hosts } = npmFixture()
  await api.login()
  const id = await api.certificate('deployment-id', undefined, async id => assert.equal(id, 5))
  const pem = '-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nchain\n-----END CERTIFICATE-----'
  await api.upload(id, pem, 'PRIVATE-KEY')
  const form = calls.at(-1).body
  assert.match(await form.get('certificate').text(), /leaf/)
  assert.ok(!(await form.get('certificate').text()).includes('chain'))
  assert.match(await form.get('intermediate_certificate').text(), /chain/)
  assert.equal(await form.get('certificate_key').text(), 'PRIVATE-KEY')
  await api.route(config().domain, 'deployment-id', id, undefined, async () => {})
  assert.equal(hosts[0].certificate_id, id); assert.equal(hosts[0].access_list_id, 0)
  assert.equal(hosts[0].ssl_forced, true); assert.equal(hosts[0].caching_enabled, false)
  assert.equal(hosts[0].enabled, true); assert.deepEqual(hosts[0].domain_names, ['*.dev.customer.example'])
  assert.equal(await api.certificate('deployment-id', id, async () => {}), id)
  await api.upload(id, pem, 'NEW-KEY')
  await api.route(config().domain, 'deployment-id', id, 7, async () => {})
  assert.ok(calls.some(c => c.url.endsWith('proxy-hosts/7') && c.method === 'PUT'))
  assert.equal(calls.filter(c => c.url.endsWith('certificates') && c.method === 'POST').length, 1)
  await api.audit(config().domain, 'deployment-id', id, 7)
  for (const field of ['block_exploits', 'hsts_enabled', 'hsts_subdomains', 'http2_support']) {
    const original = hosts[0][field]; hosts[0][field] = !original
    await assert.rejects(api.audit(config().domain, 'deployment-id', id, 7), /drift/)
    hosts[0][field] = original
  }
  hosts[0].meta.nginx_online = false
  await assert.rejects(api.audit(config().domain, 'deployment-id', id, 7), /offline/)
  await api.audit(config().domain, 'deployment-id', id, 7, { recovering: true })
  hosts[0].meta.nginx_online = true
  hosts[0].caching_enabled = true
  await assert.rejects(api.audit(config().domain, 'deployment-id', id, 7), /drift/)
  await assert.rejects(api.certificate('foreign-id', 5, async () => {}), /ownership/)
})
test('NPM refuses unowned wildcard, explicit child, redirect, location and offline routes', async () => {
  for (const name of ['*.dev.customer.example', 'app.dev.customer.example']) {
    const f = npmFixture(); f.hosts.push({ id: 88, domain_names: [name], meta: {} })
    await assert.rejects(f.api.planRoute(config().domain, 'owner', 5), /Conflicting/)
    assert.equal(f.calls.some(c => c.method === 'POST'), false)
  }
  for (const kind of ['redirection-hosts', 'dead-hosts']) {
    const f = npmFixture({ [kind]: [{ domain_names: ['*.dev.customer.example'] }] })
    await assert.rejects(f.api.planRoute(config().domain, 'owner', 5), /Conflicting/)
  }
  const f = npmFixture(); f.hosts.push({ id: 7, domain_names: ['*.dev.customer.example'], locations: [{ path: '/' }], meta: { dsh_apps_tls: 'owner' } })
  await assert.rejects(f.api.planRoute(config().domain, 'owner', 5, 7), /ownership/)
})
async function fixture(t, overrides = {}) {
  const root = await temp(t), calls = [], clock = { now: Date.now() }, counters = { register: 0, issue: 0, fail: false }
  const manager = new TlsManager({ root, now: () => clock.now,
    dnsFactory: () => ({ register: async () => { counters.register++; return account } }), dnsCheck: async () => ({ ok: true }),
    issue: async () => { counters.issue++; return { fullchain: 'FULLCHAIN-' + counters.issue, privateKey: 'PRIVATEKEY-' + counters.issue } },
    inspect: () => ({ fingerprint: 'FP-' + counters.issue, starts: clock.now, expires: clock.now + 90 * 86400000 }),
    verify: async () => { calls.push('verify'); if (counters.fail) throw Error('PRIVATEKEY-SECRET') },
    npmFactory: () => ({ login: async () => calls.push('login'), certificate: async (_deployment, id, save) => { await save(id || 5); return id || 5 },
      audit: async () => calls.push('audit'), planRoute: async () => calls.push('plan'), upload: async () => calls.push('upload'), route: async (_d, _o, _c, id, save) => { calls.push('reload'); await save(id || 7); return id || 7 } }), ...overrides })
  return { manager, root, calls, counters, clock }
}
test('TLS setup idempotent, owner-only and secret-free; different config cannot silently take over', async t => {
  const { manager, root, counters } = await fixture(t)
  const first = await manager.setup(config())
  assert.equal(first.records.length, 2); await manager.setup(config()); assert.equal(counters.register, 1)
  const publicText = JSON.stringify(await manager.status())
  for (const secret of [account.password, config().npm.secret]) assert.ok(!publicText.includes(secret))
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700)
  assert.equal((await fs.stat(path.join(root, 'deployment.json'))).mode & 0o777, 0o600)
  await assert.rejects(manager.setup({ ...config(), domain: 'other.customer.example' }), /differently/)
})
test('successful issuance, reload and public verification; no fresh order when certificate not due', async t => {
  const f = await fixture(t); await f.manager.setup(config())
  const ready = await f.manager.reconcile({ issue: true })
  assert.equal(ready.phase, 'ready'); assert.equal(ready.pendingDeployment, false)
  assert.deepEqual(f.calls, ['login','plan','plan','upload','reload','verify'])
  await f.manager.reconcile({ issue: true }); assert.equal(f.counters.issue, 1)
  f.clock.now += 65 * 86400000; await f.manager.reconcile({ issue: true }); assert.equal(f.counters.issue, 2)
  assert.equal((await f.manager.read()).previous.privateKey, 'PRIVATEKEY-1')
})
test('issuance survives failed deployment and process replacement; retry does not request another cert', async t => {
  const f = await fixture(t); await f.manager.setup(config()); f.counters.fail = true
  await assert.rejects(f.manager.reconcile({ issue: true }), e => !e.message.includes('PRIVATEKEY'))
  assert.equal((await f.manager.status()).pendingDeployment, true)
  f.counters.fail = false
  // New instance reads the persisted pending bundle, no new issuance.
  const resumed = new TlsManager({ root: f.root, inspect: f.manager.inspect, verify: f.manager.verify, npmFactory: f.manager.npmFactory, dnsCheck: f.manager.dnsCheck, issue: async () => { throw Error('Must not reissue') } })
  assert.equal((await resumed.reconcile()).phase, 'ready'); assert.equal(f.counters.issue, 1)
})
test('failed renewal attempts rollback and preserve pending deployment for retry', async t => {
  const f = await fixture(t); await f.manager.setup(config()); await f.manager.reconcile({ issue: true })
  f.clock.now += 65 * 86400000; f.counters.fail = true
  await assert.rejects(f.manager.reconcile({ issue: true }))
  assert.equal((await f.manager.status()).phase, 'pending-deployment-rollback-failed')
  assert.equal(f.calls.filter(c => c === 'upload').length, 3, 'initial, renewal, rollback')
  assert.equal((await f.manager.status()).pendingDeployment, true)
})
test('staging defaults fail closed; DNS failure causes zero issuance or NPM mutation', async t => {
  const f = await fixture(t); await f.manager.setup({ ...config(), staging: true })
  await assert.rejects(f.manager.reconcile({ issue: true })); assert.equal(f.counters.issue, 0)
  assert.equal((await f.manager.reconcile({ issue: true, deployStaging: true })).staging, true)
  const b = await fixture(t, { dnsCheck: async () => ({ ok: false, delegation: false }) }); await b.manager.setup(config())
  await assert.rejects(b.manager.reconcile({ issue: true })); assert.equal(b.calls.length, 0); assert.equal(b.counters.issue, 0)
})
test('kernel lock serializes lifecycle work; symlinked TLS state refused', async t => {
  const f = await fixture(t); await f.manager.setup(config())
  await f.manager.store.locked(async () => { await assert.rejects(f.manager.check(), /Another application operation/) })
  const directory = await temp(t), link = path.join(directory, 'link')
  await fs.symlink(f.root, link)
  await assert.rejects(new TlsManager({ root: link }).status(), /symlink/)
})
test('native certificate validation checks namespace, key, chain and public trust', async t => {
  const root = await temp(t)
  const run = args => execFileSync('openssl', args, { cwd: root, stdio: 'pipe' })
  run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.crt','-days','2','-subj','/CN=Test CA','-addext','basicConstraints=critical,CA:TRUE'])
  run(['req','-new','-newkey','rsa:2048','-nodes','-keyout','leaf.key','-out','leaf.csr','-subj','/CN=*.dev.customer.example'])
  await fs.writeFile(path.join(root, 'extensions.cnf'), 'subjectAltName=DNS:*.dev.customer.example\nbasicConstraints=critical,CA:FALSE\n')
  run(['x509','-req','-in','leaf.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-out','leaf.crt','-days','1','-extfile','extensions.cnf'])
  const ca = await fs.readFile(path.join(root, 'ca.crt'), 'utf8'), leaf = await fs.readFile(path.join(root, 'leaf.crt'), 'utf8'), key = await fs.readFile(path.join(root, 'leaf.key'), 'utf8')
  const info = certificateInfo(leaf + ca, key, config().domain, Date.now(), false, [ca])
  assert.ok(info.expires > Date.now())
  assert.throws(() => certificateInfo(leaf + ca, key, 'other.example', Date.now(), false, [ca]), /wildcard/)
  assert.throws(() => certificateInfo(leaf + ca, key, config().domain), /trust root/)
  assert.throws(() => certificateInfo(leaf + ca, key, config().domain, Date.now() + 3 * 86400000, false, [ca]), /valid/)
  assert.throws(() => certificateInfo(leaf, key, config().domain), /intermediate/)
  assert.throws(() => certificateInfo(leaf + ca, awaitKeyPlaceholder, config().domain), /./)
})
const awaitKeyPlaceholder = 'not a key'

test('public TLS verification retries fresh handshakes and never disables production trust', async () => {
  const options = []; let pauses = 0
  const connect = opts => {
    options.push(opts)
    const socket = new EventEmitter()
    socket.setTimeout = () => {}; socket.destroy = () => {}; socket.end = () => {}
    queueMicrotask(() => socket.emit('error', Error('unavailable')))
    return socket
  }
  await assert.rejects(verifyServed(config(), 'expected', { attempts: 3, connect, pause: async () => { pauses++ } }), /verification failed/)
  assert.equal(options.length, 3); assert.equal(pauses, 2)
  for (const opts of options) { assert.equal(opts.rejectUnauthorized, true); assert.equal(opts.servername, 'dsh-tls-check.dev.customer.example'); assert.equal(opts.port, 443) }
})

test('expired pending certificate is replaced rather than wedging renewal forever', async t => {
  const f = await fixture(t); await f.manager.setup(config()); f.counters.fail = true
  await assert.rejects(f.manager.reconcile({ issue: true }))
  f.clock.now += 100 * 86400000; f.counters.fail = false
  await assert.rejects(f.manager.reconcile(), /operation failed/)
  assert.equal(f.counters.issue, 1)
  assert.equal((await f.manager.reconcile({ issue: true })).phase, 'ready')
  assert.equal(f.counters.issue, 2)
})
test('foreign certificate consumers block rotation outside the managed namespace', async () => {
  const stream = npmFixture({ streams: [{ id: 99, certificate_id: 5 }] })
  await assert.rejects(stream.api.planRoute(config().domain, 'owner', 5), /foreign stream/)
  const f = npmFixture()
  f.hosts.push({ id: 90, certificate_id: 5, domain_names: ['control.other.example'] })
  await assert.rejects(f.api.planRoute(config().domain, 'owner', 5), /foreign proxy/)
  for (const kind of ['redirection-hosts', 'dead-hosts']) {
    const r = npmFixture({ [kind]: [{ certificate_id: 5, domain_names: ['other.example'] }] })
    await assert.rejects(r.api.planRoute(config().domain, 'owner', 5), /foreign redirect/)
  }
})
test('collision preflight happens before issuance and renewal drift blocks rotation', async t => {
  const api = { login: async () => {}, planRoute: async () => { throw Error('collision') } }
  const f = await fixture(t, { npmFactory: () => api }); await f.manager.setup(config())
  await assert.rejects(f.manager.reconcile({ issue: true }))
  assert.equal(f.counters.issue, 0)
  const g = await fixture(t); await g.manager.setup(config()); await g.manager.reconcile({ issue: true })
  g.clock.now += 65 * 86400000
  g.manager.npmFactory = () => ({ login: async () => {}, audit: async () => { throw Error('policy drift') } })
  await assert.rejects(g.manager.reconcile({ issue: true }))
  assert.equal(g.counters.issue, 1)
})
test('state symlink and group-readable state are rejected', async t => {
  const f = await fixture(t); await f.manager.setup(config())
  const file = path.join(f.root, 'deployment.json')
  await fs.chmod(file, 0o644)
  await assert.rejects(f.manager.status(), /owner-only/)
  await fs.chmod(file, 0o600)
  const target = path.join(f.root, 'copy.json')
  await fs.copyFile(file, target)
  // Verify resolved target before replacing the exact temporary fixture file.
  assert.ok(path.resolve(file).startsWith(path.join(os.tmpdir(), 'dsh-tls-test-')))
  await fs.unlink(file); await fs.symlink(target, file)
  await assert.rejects(f.manager.status(), /owner-only/)
})
test('Certbot adapter uses fixed DNS-only wildcard argv, private directories and safely quoted hook', async t => {
  const root = await temp(t), calls = []
  const manager = new TlsManager({ root, execute: async (bin, args, opts) => {
    calls.push({ bin, args, opts })
    const live = path.join(root, 'certbot/config/live/dsh-apps')
    await fs.mkdir(live, { recursive: true })
    await fs.writeFile(path.join(live, 'fullchain.pem'), 'FULLCHAIN')
    await fs.writeFile(path.join(live, 'privkey.pem'), 'PRIVATEKEY')
  } })
  assert.deepEqual(await manager.certbot(config()), { fullchain: 'FULLCHAIN', privateKey: 'PRIVATEKEY' })
  assert.equal(calls[0].bin, 'certbot')
  const a = calls[0].args
  assert.equal(a[a.indexOf('-d') + 1], '*.dev.customer.example')
  assert.equal(a[a.indexOf('--preferred-challenges') + 1], 'dns')
  assert.match(a[a.indexOf('--manual-auth-hook') + 1], /tls-cli.mjs.*auth-hook/)
  assert.equal(a[a.indexOf('--manual-auth-hook') + 1].split(/\s/, 1)[0], '/bin/sh', 'Certbot 2.x validates the initial word without parsing shell quotes')
  assert.equal(calls[0].opts.env.DSH_TLS_HOOK, '1')
  assert.ok(!a.join(' ').includes(config().npm.secret))
  for (const leaf of ['config','work','logs']) assert.equal((await fs.stat(path.join(root, 'certbot', leaf))).mode & 0o777, 0o700)
})
