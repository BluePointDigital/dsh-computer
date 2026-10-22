import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'
import { TlsManager } from '../lib/tls-manager.js'
import vm from 'node:vm'
import { PublicTls, publicTlsStatus } from '../lib/tls-public.js'

test('TLS control APIs require DSH auth and exact Origin; never expose secrets or support HTTP issuance', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-tls-api-')), previous = process.env.COMPUTER_APPS_STATE
  process.env.COMPUTER_APPS_STATE = root
  const effects = [], routes = new Map()
  const config = { appDomain: 'control.customer.example', controlOrigin: 'https://control.customer.example', appListenPort: 0 }
  const manager = new TlsManager()
  const setup = { domain: config.appDomain, ingressAddress: '192.0.2.10', email: 'ops@customer.example', termsAgreed: true, staging: false, privateIngressConfirmed: true, cacheBypassConfirmed: true,
    acmeDns: { url: 'https://validation.example', zone: 'auth.validation.example' }, npm: { url: 'https://npm.customer.example', identity: 'admin', secret: 'PRIVATE-NPM-SECRET', forwardHost: 'gateway', forwardPort: 3099 } }
  const account = { username: '11111111-1111-4111-8111-111111111111', password: 'PRIVATE-DNS-SECRET', subdomain: '22222222-2222-4222-8222-222222222222', fulldomain: '22222222-2222-4222-8222-222222222222.auth.validation.example' }
  await manager.store.init(); await manager.save({ version: 1, id: '33333333-3333-4333-8333-333333333333', config: setup, account, phase: 'awaiting-dns' })
  const publicRoot = path.join(root, 'tls-status'); await fs.mkdir(publicRoot, { mode: 0o700 })
  await fs.writeFile(path.join(publicRoot, 'public-status.json'), JSON.stringify(await manager.status()), { mode: 0o600 })
  // The GUI must work without permission to read the worker's private state.
  await fs.chmod(path.join(manager.root, 'deployment.json'), 0o000)
  const ctx = { connection: { requestRejection: req => req.headers['x-auth'] === 'yes' ? undefined : 401 },
    logger: { info() {} }, effect(fn) { const cleanup = fn(); if (cleanup) effects.push(cleanup) },
    webServer: { register(r) { routes.set(r.path, r); return () => routes.delete(r.path) }, registerUpgrade() { return () => {} } } }
  t.after(async () => {
    while (effects.length) await effects.pop()()
    if (previous === undefined) delete process.env.COMPUTER_APPS_STATE; else process.env.COMPUTER_APPS_STATE = previous
    assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), 'dsh-tls-api-'))); await fs.rm(root, { recursive: true, force: true })
  })
  await apply(ctx, config)
  const request = async (method, name, headers = {}) => {
    const res = { writeHead(status, h) { this.status = status; this.headers = h; return this }, end(data) { this.text = data } }
    await routes.get('/apps/api').handler({ method, url: '/apps/api/' + name, headers }, res)
    return { status: res.status, text: res.text, body: JSON.parse(res.text) }
  }
  for (const name of ['access-health', 'access-check']) assert.equal((await request('GET', name)).status, 401)
  assert.equal((await request('POST', 'access-health', { 'x-auth': 'yes' })).status, 405)
  for (const origin of [undefined, 'https://evil.example']) assert.equal((await request('POST', 'access-check', { 'x-auth': 'yes', origin, 'content-type': 'application/json' })).status, 403)
  assert.equal((await request('GET', 'tls-status')).status, 401)
  const status = await request('GET', 'tls-status', { 'x-auth': 'yes' })
  assert.equal(status.status, 200); assert.equal(status.body.tls.records.length, 2)
  assert.ok(!status.text.includes('PRIVATE-'))
  assert.equal((await request('POST', 'tls-status', { 'x-auth': 'yes' })).status, 405)
  assert.equal((await request('GET', 'tls-check', { 'x-auth': 'yes' })).status, 405)
  for (const origin of [undefined, 'https://evil.example', 'https://app.control.customer.example']) assert.equal((await request('POST', 'tls-check', { 'x-auth': 'yes', 'content-type': 'application/json', origin })).status, 403)
  for (const name of ['tls-setup', 'tls-activate', 'tls-renew']) assert.notEqual((await request('POST', name, { 'x-auth': 'yes' })).status, 200)
})

test('public snapshot allowlist strips worker secrets and ignores private deployment state', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-tls-snapshot-'))
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), 'dsh-tls-snapshot-'))); await fs.rm(root, { recursive: true, force: true }) })
  const source = { configured: true, domain: 'control.customer.example', phase: 'ready', records: [], npm: { secret: 'PRIVATE' }, current: { privateKey: 'PRIVATE' }, certificate: { expires: Date.now()+86400000, privateKey: 'PRIVATE' } }
  assert.ok(!JSON.stringify(publicTlsStatus(source)).includes('PRIVATE'))
  await fs.writeFile(path.join(root, 'public-status.json'), JSON.stringify(source), { mode: 0o600 })
  const view = new PublicTls({ root })
  assert.ok(!JSON.stringify(await view.status()).includes('PRIVATE'))
  await fs.chmod(path.join(root, 'public-status.json'), 0o644)
  await assert.rejects(view.status(), /owner-only/)
})
test('initial HTTPS status failure remains visible with retry action', async () => {
  const source = (await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8')).replace('exports.apply = apply', 'exports.TlsSetup = TlsSetup; exports.apply = apply')
  let exported, effects = [], slots = [], cursor = 0
  const React = { createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], v => { slots[i] = v }] },
    useCallback: fn => fn, useEffect: fn => effects.push(fn) }
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load({ factory }) { exported = factory(id => id === 'react' ? React : {}) } } },
    fetch: async () => { throw Error('Status mount unavailable') } })
  exported.TlsSetup(); await effects[0](); await new Promise(resolve => setImmediate(resolve)); cursor = 0
  const text = JSON.stringify(exported.TlsSetup())
  assert.match(text, /Status mount unavailable/); assert.match(text, /Retry HTTPS status/)
})
test('DNS onboarding client displays records as text and Check DNS, with no secret form or issuance button', async () => {
  const source = (await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8')).replace('exports.apply = apply', 'exports.TlsSetup = TlsSetup; exports.apply = apply')
  let exported, effects = [], slots = [], cursor = 0, calls = []
  const React = { createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value }] },
    useCallback: fn => fn, useEffect: fn => effects.push(fn) }
  const status = { configured: true, staging: false, phase: 'awaiting-dns', records: [{ type: 'CNAME', name: '_acme-challenge.control.customer.example', value: 'unique.auth.validation.example', proxy: 'DNS only' }], authorityNotice: 'Delegated certificate authority', readinessNote: 'TLS only' }
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load({ factory }) { exported = factory(id => id === 'react' ? React : {}) } } },
    fetch: async (url, init = {}) => { calls.push({ url, init }); return { ok: true, json: async () => ({ ok: true, tls: status }) } } })
  exported.TlsSetup(); await effects[0]()
  // Effects intentionally schedule async load; yield until its response settles.
  await new Promise(resolve => setImmediate(resolve)); cursor = 0
  const tree = exported.TlsSetup(), text = JSON.stringify(tree)
  assert.match(text, /unique.auth.validation.example/); assert.match(text, /Check DNS/)
  assert.ok(!text.includes('dangerouslySetInnerHTML')); assert.ok(!text.includes('password'))
  const visit = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(visit)] : []
  const button = visit(tree).find(n => n.type === 'button' && n.children.includes('Check DNS'))
  await button.props.onClick()
  assert.equal(calls.at(-1).url, '/apps/api/tls-check'); assert.equal(calls.at(-1).init.method, 'POST')
})
