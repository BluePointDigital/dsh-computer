import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { createRuntimeUI, createRuntimeInventoryStore, filterRuntimeApps, runtimeCategory, runtimeNeedsAttention, runtimeStatusLabel, runtimeControls } from '../lib/runtime-ui.js'

test('runtime Applications renders a deployment manager, not adoption/registration gates', () => {
  const UI = createRuntimeUI({ React, api: async () => ({ ok: true, apps: [], deployments: [] }), resolveView: async () => ({}), Viewer: () => null })
  const html = renderToStaticMarkup(React.createElement(UI))
  assert.ok(html.includes('Deploy application'))
  assert.ok(html.includes('Search applications'))
  assert.ok(html.includes('Infrastructure'))
  assert.ok(html.includes('Stopped'))
  assert.ok(html.includes('Filter applications by status'))
  assert.ok(html.includes('aria-pressed="true" aria-label="All apps: 0"'))
  assert.ok(!html.includes('Runtime summary'))
  assert.ok(!/register|adopt|accept existing/i.test(html))
})

test('status counts and views include stopped infrastructure and unhealthy apps without hiding resources', () => {
  const apps = [
    { id: 'desktop', name: 'Desktop', state: 'running' },
    { id: 'files', name: 'File Browser', state: 'exited', health: 'healthy' },
    { id: 'box', name: 'Workspace computer', state: 'exited', infrastructure: true },
    { id: 'new', state: 'created' }, { id: 'paused', state: 'paused' },
    { id: 'broken', state: 'running', health: 'unhealthy' }, { id: 'missing', state: 'missing' },
  ]
  assert.equal(filterRuntimeApps(apps).length, 7, 'all means all, including infrastructure')
  assert.deepEqual(filterRuntimeApps(apps, 'stopped').map(app => app.id), ['files', 'box', 'new'])
  assert.deepEqual(filterRuntimeApps(apps, 'infrastructure').map(app => app.id), ['box'])
  assert.deepEqual(filterRuntimeApps(apps, 'attention').map(app => app.id), ['paused', 'broken', 'missing'])
  assert.deepEqual(filterRuntimeApps(apps, 'stopped', 'workspace').map(app => app.id), ['box'])
  assert.equal(filterRuntimeApps(apps, 'all', 'stopped').length, 3)
  assert.equal(runtimeCategory(apps[1]), 'stopped')
  assert.equal(runtimeStatusLabel(apps[1]), 'Stopped', 'old healthy healthcheck does not hide stopped state')
  assert.equal(runtimeNeedsAttention(apps[1]), false, 'on-demand stopped is not an error')
  assert.equal(runtimeStatusLabel(apps[5]), 'Unhealthy')
})

test('menu lifecycle availability follows actual service states and saved deployment ownership', () => {
  const app = state => ({ state, services: [{ state }] })
  assert.deepEqual(runtimeControls(app('exited')), { start: true, stop: false, restart: true, remove: true, redeploy: false })
  assert.deepEqual(runtimeControls(app('running')), { start: false, stop: true, restart: true, remove: true, redeploy: false })
  assert.equal(runtimeControls(app('paused')).start, false)
  assert.equal(runtimeControls(app('paused')).stop, true)
  assert.equal(runtimeControls(app('paused')).restart, false)
  assert.equal(runtimeControls({ state: 'queued', services: [{ state: 'running' }] }, true).remove, false)
  assert.equal(runtimeControls({ state: 'missing', services: [] }).remove, false)
  assert.equal(runtimeControls({ state: 'removed', services: [] }, true).start, true)
  assert.equal(runtimeControls(app('exited'), true).redeploy, true)
  assert.equal(runtimeControls({ state: 'partial', services: [{ state: 'running' }, { state: 'exited' }] }).stop, true)
})

test('management UI provides real streamed logs, xterm transport, owner-click deploy and config privacy', async () => {
  const source = await fs.readFile(new URL('../lib/runtime-ui.js', import.meta.url), 'utf8')
  assert.ok(source.includes("new EventSource(`/apps/api/runtime/logs?"))
  assert.ok(source.includes('new window.Terminal('))
  assert.ok(source.includes("new URL('/apps/terminal'"))
  assert.ok(source.includes('socket.close()'))
  assert.ok(source.includes("request('runtime/deploy', payload)"))
  assert.ok(source.includes('Load configuration'))
  assert.ok(source.includes('setDefinition(null)'))
  assert.ok(source.includes('Save and redeploy'))
  assert.ok(!source.includes("request('approve'"))
})


test('remounted Applications immediately renders cached inventory and disables changes during daemon outage', async () => {
  const store = createRuntimeInventoryStore(async () => ({ ok: true,
    apps: [{ id: 'cached-app', name: 'Cached application', state: 'exited', services: [{ state: 'exited' }] }],
    inventory: { updatedAt: 123, stale: true, dockerAvailable: false }, deployments: [] }))
  await store.refresh()
  const render = () => renderToStaticMarkup(React.createElement(createRuntimeUI({ React, api: async () => ({}), inventoryStore: store })))
  for (const html of [render(), render()]) {
    assert.ok(html.includes('Cached application'))
    assert.ok(!html.includes('Loading your applications'))
    assert.ok(html.includes('Docker daemon unavailable'))
    assert.match(html, /disabled="" aria-label="Start Cached application"/)
    assert.match(html, /disabled="">Deploy application/)
    assert.ok(!html.includes('Make room for your next app'))
  }
  store.dispose()
})

test('unavailable empty inventory is not presented as a confirmed empty daemon', async () => {
  const store = createRuntimeInventoryStore(async () => ({ ok: true, apps: [], inventory: { stale: true, dockerAvailable: false } }))
  await store.refresh()
  const UI = createRuntimeUI({ React, api: async () => ({}), inventoryStore: store })
  const html = renderToStaticMarkup(React.createElement(UI))
  assert.ok(html.includes('Applications are unavailable'))
  assert.ok(html.includes('an empty inventory has not been confirmed'))
  assert.ok(!html.includes('Make room for your next app'))
  store.dispose()
})

// Minimal deterministic hook driver: exercise the real component functions without
// installing a browser, renderer, DOM shim or another React/UI package.
function hookDriver() {
  let cursor = 0, pending = [], writes = 0
  const slots = []
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const hooks = {
    ...React,
    useState(initial) {
      const index = cursor++
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [slots[index].value, next => { writes++; slots[index].value = typeof next === 'function' ? next(slots[index].value) : next }]
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial } },
    useCallback(callback, deps) {
      const index = cursor++
      if (!same(slots[index]?.deps, deps)) slots[index] = { deps, callback }
      return slots[index].callback
    },
    useEffect(effect, deps) {
      const index = cursor++
      if (!same(slots[index]?.deps, deps)) pending.push(() => {
        slots[index]?.cleanup?.()
        slots[index] = { deps, cleanup: effect() }
      })
    },
  }
  return { hooks, render(component, props) { cursor = 0; return component(props) },
    flush() { const effects = pending; pending = []; effects.forEach(effect => effect()) },
    unmount() { slots.forEach(slot => slot?.cleanup?.()) }, get writes() { return writes } }
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return [tree]
  return [tree, ...nodes(tree.props?.children)]
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('details renders inspection before slow stats; only Overview polls stats without overlap or late writes', async () => {
  const saved = { document: globalThis.document, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
  const timers = new Map(); let timerId = 0
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} }
  globalThis.setInterval = callback => { timers.set(++timerId, callback); return timerId }
  globalThis.clearInterval = id => timers.delete(id)
  const calls = []; let resolveStats
  const slowStats = new Promise(resolve => { resolveStats = resolve })
  const api = async path => {
    calls.push(path)
    if (path.startsWith('runtime/details?')) return { ok: true, app: { id: 'app', name: 'Inspected name', state: 'running', services: [{ containerId: 'abc', name: 'web', image: 'nginx', state: 'running' }] }, stats: [] }
    if (path.startsWith('runtime/stats?')) return slowStats
    return { ok: true, apps: [], deployments: [] }
  }
  const details = hookDriver()
  const store = createRuntimeInventoryStore(async () => ({ ok: true, apps: [{ id: 'app', name: 'Cached name', state: 'running', services: [{ containerId: 'abc', state: 'running' }] }] }))
  await store.refresh()
  try {
    // Route the outer list and nested details through independent hook lists.
    const routeDriver = hookDriver()
    const routeHooks = { ...routeDriver.hooks, useState: initial => {
      const value = typeof initial === 'function' ? initial() : initial
      return routeDriver.hooks.useState(value?.type === 'list' ? { type: 'detail', id: 'app', app: store.getSnapshot().apps[0] } : initial)
    } }
    const factoryHooks = { ...details.hooks }
    let outer = true
    for (const key of ['useState', 'useRef', 'useCallback', 'useEffect']) factoryHooks[key] = (...args) => (outer ? routeHooks : details.hooks)[key](...args)
    const factory = createRuntimeUI({ React: factoryHooks, api, inventoryStore: store })
    const detailNode = routeDriver.render(factory)
    outer = false
    details.render(detailNode.type, detailNode.props); details.flush()
    assert.equal(calls.filter(path => path.startsWith('runtime/stats?')).length, 1)
    await settle()
    let detailTree = details.render(detailNode.type, detailNode.props)
    assert.ok(nodes(detailTree).includes('Inspected name'), 'details completes while stats is unresolved')
    for (const callback of timers.values()) callback()
    assert.equal(calls.filter(path => path.startsWith('runtime/stats?')).length, 1, 'slow stats never overlaps')
    nodes(detailTree).find(node => node?.props?.role === 'tab' && node.props.children === 'Logs').props.onClick()
    detailTree = details.render(detailNode.type, detailNode.props); details.flush()
    await settle() // Allow the independent details poll to finish first.
    const writes = details.writes
    resolveStats({ ok: true, stats: [{ Name: 'web', CPUPerc: '1%' }] })
    await settle()
    assert.equal(details.writes, writes, 'leaving Overview ignores late stats')
    details.unmount()
    const afterUnmount = details.writes
    await settle()
    assert.equal(details.writes, afterUnmount)
  } finally {
    details.unmount(); store.dispose()
    globalThis.document = saved.document; globalThis.setInterval = saved.setInterval; globalThis.clearInterval = saved.clearInterval
  }
})


test('client cache belongs to apply lifetime, remount uses the cached component and API auth clears it', async () => {
  const source = (await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))
    .replace('exports.apply = apply', 'exports.api = api; exports.apply = apply')
  let exported, capturedMain, clearError, disposed = 0
  const cleanup = []
  vm.runInNewContext(source, {
    URL,
    window: { __ModuleLoader__: { load: ({ factory }) => { exported = factory(id => id === 'react' ? React : {}) } } },
    fetch: async () => ({ status: 401, ok: false, json: async () => ({ ok: false, error: 'denied' }) }),
  })
  exported.apply({ effect: callback => cleanup.push(callback()), slots: {
    inject: (_name, callback) => callback(), register: (options, render) => { if (options.name === 'main') capturedMain = render },
  } })
  const panel = capturedMain(), lifetime = panel.props.lifetime
  lifetime.store = { clear: error => { clearError = error }, dispose: () => { disposed++ } }
  lifetime.component = () => null
  // The real React element can be server-rendered without running useEffect or
  // importing the asset: the already-loaded component renders on the first pass.
  assert.equal(renderToStaticMarkup(React.createElement(panel.type, panel.props)), '')
  await assert.rejects(exported.api('runtime/details?id=app'), /denied/)
  assert.equal(clearError.status, 401)
  cleanup.forEach(dispose => dispose())
  assert.equal(disposed, 1)
  assert.equal(lifetime.disposed, true)
  assert.equal(lifetime.store, null)
  assert.equal(lifetime.component, null)
  assert.ok(source.includes('/apps/assets/runtime-ui.js?v=0.7.0'))
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(source))
})
