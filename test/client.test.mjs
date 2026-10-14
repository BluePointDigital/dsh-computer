import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Execute the actual loader bundle, exposing local functions in this test only.
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  .replace('exports.apply = apply', 'exports.resolveView = resolveView; exports.Viewer = Viewer; exports.apply = apply')
function load(headers = {}, status = 200, byMethod = null) {
  let exports
  const context = { URL, AbortController, setTimeout, clearTimeout,
    window: { location: new URL('https://harness.example/'), __ModuleLoader__: { load: ({ factory }) => {
      exports = factory((id) => id === '@deepseek-ai/dsh-client-ui-primitives'
        ? { Button: 'Button', Tag: 'Tag', Menu: 'Menu', StateDot: 'StateDot' }
        : { createElement: (type, props, ...children) => ({ type, props, children }) })
    } } },
    fetch: async (_url, init = {}) => {
      const code = byMethod && init.method && byMethod[init.method] !== undefined ? byMethod[init.method] : status
      return { ok: code >= 200 && code < 300, status: code, headers: { get: (key) => headers[key] ?? null } }
    },
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
  const tree2 = load(headers).Viewer({ app: desktop, src: '/apps/web/desktop/', mode: 'proxy', onBack: () => {} })
  const frame = tree2.children[1]
  assert.equal(frame.type, 'iframe')
  assert.equal(frame.props.translate, 'no', 'the embed must tell translators to leave the app alone')
  const onBack = () => {}
  const tree = load(headers).Viewer({ app: desktop, src: null, mode: 'blocked', reason: 'test', onBack })
  assert.equal(tree.children[0].children[0].props.onClick, onBack)
  assert.ok(!JSON.stringify(tree).includes('iframe'))
})

test('a mount that answers HEAD with 404 but GET with 200 still opens', async () => {
  // File Browser does exactly this. Treating the HEAD failure as "mount missing"
  // made a healthy installed app unopenable in the panel.
  const files = { id: 'files', name: 'File Browser', web: { path: '/apps/web/files/' } }
  const mountHeaders = { 'x-dsh-app-proxy': 'files', 'x-dsh-app-proxy-features': 'js' }
  const viaGet = await load(mountHeaders, 200, { HEAD: 404, GET: 200 }).resolveView(files)
  assert.notEqual(viaGet.mode, 'blocked', 'HEAD-hostile app must still open')
  assert.ok(viaGet.src.startsWith('/apps/web/files/'), `unexpected mount src ${viaGet.src}`)
  const dead = await load(mountHeaders, 200, { HEAD: 404, GET: 500 }).resolveView(files)
  assert.equal(dead.mode, 'blocked', 'a mount that fails both ways is still refused')
  const unmounted = await load({}, 200, { HEAD: 200, GET: 200 }).resolveView(files)
  assert.equal(unmounted.mode, 'blocked', 'a 200 without the proxy marker is the shell, not the app')
})
