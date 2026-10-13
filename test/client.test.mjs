import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Execute the actual loader bundle, exposing local functions in this test only.
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  .replace('exports.apply = apply', 'exports.resolveView = resolveView; exports.Viewer = Viewer; exports.apply = apply')
function load(headers = {}, status = 200) {
  let exports
  const context = { URL, AbortController, setTimeout, clearTimeout,
    window: { location: new URL('https://harness.example/'), __ModuleLoader__: { load: ({ factory }) => {
      exports = factory(() => ({ createElement: (type, props, ...children) => ({ type, props, children }) }))
    } } },
    fetch: async () => ({ ok: status === 200, headers: { get: (key) => headers[key] ?? null } }),
  }
  vm.runInNewContext(source, context)
  return exports
}
const headers = { 'x-dsh-app-proxy': 'desktop', 'x-dsh-app-proxy-features': 'ws' }
const desktop = { id: 'desktop', name: 'Desktop', viewer: { url: 'http://100.1.2.3:6081/', password: 'test' }, web: { path: '/apps/web/desktop/' }, webSockets: ['/websockify'] }

test('desktop uses same-origin mount with explicit secure noVNC socket URL', async () => {
  const view = await load(headers).resolveView(desktop)
  const url = new URL(view.src, 'https://harness.example')
  assert.equal(url.pathname, '/apps/web/desktop/vnc.html')
  assert.equal(url.searchParams.get('path'), 'apps/web/desktop/websockify')
  assert.equal(url.searchParams.get('encrypt'), '1')
  assert.equal(url.searchParams.get('host'), 'harness.example')
  assert.equal(url.searchParams.get('port'), '443')
  assert.equal(url.searchParams.get('password'), 'test')
})
test('legacy viewer-only catalog still chooses the mount', async () => {
  const view = await load(headers).resolveView({ id: 'desktop', viewer: desktop.viewer })
  assert.ok(view.src.startsWith('/apps/web/desktop/vnc.html'))
})
test('missing capability, mismatched marker, direct mode and failed mount fail closed', async () => {
  assert.equal((await load({ 'x-dsh-app-proxy': 'desktop' }).resolveView(desktop)).src, null)
  assert.equal((await load({ ...headers, 'x-dsh-app-proxy': 'other' }).resolveView(desktop)).src, null)
  assert.equal((await load(headers).resolveView({ ...desktop, web: { ...desktop.web, mode: 'direct' } })).src, null)
  assert.equal((await load(headers, 502).resolveView(desktop)).src, null)
})
test('ordinary app supports old marker but rewrite app requires js capability', async () => {
  const ordinary = { id: 'desktop', web: desktop.web }
  const view = await load({ 'x-dsh-app-proxy': 'desktop' }).resolveView(ordinary)
  const url = new URL(view.src, 'https://harness.example')
  assert.equal(url.pathname, '/apps/web/desktop/')
  assert.equal((await load(headers).resolveView({ ...ordinary, webRewrite: ['/api/'] })).src, null)
})
test('every load carries a fresh salt so no app can come up from a cached bundle', async () => {
  const app = { id: 'desktop', web: { path: '/apps/web/desktop/' } }
  const first = new URL((await load(headers).resolveView(app)).src, 'https://harness.example')
  const second = new URL((await load(headers).resolveView(app)).src, 'https://harness.example')
  assert.match(first.searchParams.get('dsha'), /^[a-z0-9]{1,16}$/)
  assert.match(second.searchParams.get('dsha'), /^[a-z0-9]{1,16}$/)
  assert.notEqual(first.searchParams.get('dsha'), second.searchParams.get('dsha'))
  // The salt rides alongside a viewer's own parameters rather than replacing them.
  const viewer = await load(headers).resolveView(desktop)
  const vurl = new URL(viewer.src, 'https://harness.example')
  assert.equal(vurl.searchParams.get('path'), 'apps/web/desktop/websockify')
  assert.match(vurl.searchParams.get('dsha'), /^[a-z0-9]{1,16}$/)
})
test('no published URLs or new-tab action exist; back callback is passed', () => {
  assert.ok(!source.includes('window.open'))
  assert.ok(source.includes('h(Viewer, { ...view, onBack })'))
  const onBack = () => {}
  const tree = load(headers).Viewer({ app: desktop, src: null, mode: 'blocked', reason: 'test', onBack })
  assert.equal(tree.children[0].children[0].props.onClick, onBack)
  assert.ok(!JSON.stringify(tree).includes('iframe'))
})
