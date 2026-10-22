import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeInventoryStore, pollRuntimeVisible, runtimeInventoryLabel } from '../lib/runtime-ui.js'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const inventory = (apps = []) => ({ ok: true, apps, deployments: [], inventory: { updatedAt: 1234, stale: false, refreshing: false, dockerAvailable: true } })

test('inventory store shares polls across mounts and preserves last good snapshot on failure', async () => {
  const first = deferred(), calls = []
  let response = first.promise
  const store = createRuntimeInventoryStore(path => { calls.push(path); return response })
  let changes = 0
  const unsubscribe = store.subscribe(() => changes++)
  const one = store.refresh(), two = store.refresh()
  assert.equal(one, two)
  await Promise.resolve()
  assert.deepEqual(calls, ['runtime/inventory'])
  first.resolve(inventory([{ id: 'desktop', name: 'Desktop', state: 'running' }]))
  await one
  unsubscribe()
  const cached = store.getSnapshot()
  assert.equal(cached.loading, false)
  assert.equal(cached.apps[0].name, 'Desktop')
  assert.ok(changes >= 2)
  response = Promise.reject(new Error('offline'))
  await assert.rejects(store.refresh(), /offline/)
  assert.equal(store.getSnapshot().apps[0].id, 'desktop')
  assert.equal(store.getSnapshot().inventory.stale, true)
  assert.match(store.getSnapshot().error, /offline/)
  store.dispose()
})

test('manual refresh explicitly revalidates once after an in-flight ordinary poll', async () => {
  const first = deferred(), second = deferred(), calls = []
  const store = createRuntimeInventoryStore(path => { calls.push(path); return calls.length === 1 ? first.promise : second.promise })
  const poll = store.refresh()
  const manual = store.refresh(true)
  assert.equal(store.refresh(true), manual)
  await Promise.resolve()
  assert.equal(calls.length, 1)
  first.resolve(inventory())
  await poll
  // Let the queued forced call run, without a timer or overlapping request.
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(calls, ['runtime/inventory', 'runtime/inventory?refresh=1'])
  assert.equal(store.refresh(), store.refresh(true), 'poll joins forced request')
  second.resolve(inventory([{ id: 'fresh' }]))
  await manual
  assert.equal(store.getSnapshot().apps[0].id, 'fresh')
  store.dispose()
})

test('cache excludes definitions, environment values and viewer credentials without changing source objects', async () => {
  const app = { id: 'desktop', state: 'running', deployment: { env: { SECRET: 'private-value' } }, savedDefinition: { env: 'private-value' }, env: { SECRET: 'private-value' }, definition: { image: 'private-value' }, viewer: { password: 'viewer-secret', url: 'private-value' }, services: [{ containerId: 'abc', name: 'desktop', config: { env: 'private-value' } }] }
  const store = createRuntimeInventoryStore(async () => ({ ...inventory([app]), deployments: [{ id: 'job', input: { id: 'desktop', env: { SECRET: 'private-value' } }, definition: { env: 'private-value' }, events: [{ message: 'Starting', env: 'private-value' }] }] }))
  await store.refresh()
  const snapshot = store.getSnapshot(), serialized = JSON.stringify(snapshot)
  assert.ok(!serialized.includes('private-value'))
  assert.ok(!serialized.includes('viewer-secret'))
  assert.deepEqual(snapshot.apps[0].viewer, {})
  assert.equal(snapshot.apps[0].deployment, true)
  assert.equal(snapshot.deployments[0].appId, 'desktop')
  assert.equal(app.viewer.password, 'viewer-secret')
  store.dispose()
})

test('authentication rejection clears inventory and invalidates concurrent successful responses', async () => {
  for (const status of [401, 403]) {
    const later = deferred()
    let response = inventory([{ id: 'private-app' }])
    const store = createRuntimeInventoryStore(async () => response)
    await store.refresh()
    response = later.promise
    const pending = store.refresh()
    store.clear({ status, message: 'Authentication rejected' })
    later.resolve(inventory([{ id: 'must-not-return' }]))
    await pending
    assert.deepEqual(store.getSnapshot().apps, [])
    assert.match(store.getSnapshot().error, /Authentication rejected/)
    response = Promise.reject(Object.assign(new Error('denied'), { status }))
    await assert.rejects(store.refresh(), /denied/)
    assert.equal(store.getSnapshot().hasInventory, false)
    store.dispose()
  }
})

test('disposal clears cached data and prevents late writes or further requests', async () => {
  const later = deferred(); let calls = 0
  const store = createRuntimeInventoryStore(() => { calls++; return later.promise })
  const pending = store.refresh()
  await Promise.resolve()
  store.dispose()
  later.resolve(inventory([{ id: 'late' }]))
  await pending
  await store.refresh(true)
  assert.equal(calls, 1)
  assert.deepEqual(store.getSnapshot().apps, [])
})

test('visibility polling pauses while hidden, revalidates on visible and cleans up', () => {
  const listeners = new Map(), timers = new Map(); let next = 0, calls = 0
  const document = { hidden: true, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) }
  const stop = pollRuntimeVisible(() => { calls++ }, { document, setInterval: (callback, ms) => { assert.equal(ms, 5000); timers.set(++next, callback); return next }, clearInterval: id => timers.delete(id) })
  assert.equal(calls, 0)
  document.hidden = false; listeners.get('visibilitychange')()
  assert.equal(calls, 1); assert.equal(timers.size, 1)
  timers.values().next().value(); assert.equal(calls, 2)
  document.hidden = true; listeners.get('visibilitychange')()
  assert.equal(timers.size, 0)
  document.hidden = false; listeners.get('visibilitychange')()
  assert.equal(calls, 3)
  stop(); assert.equal(timers.size, 0); assert.equal(listeners.size, 0)
})

test('a daemon-unavailable response cannot replace successful inventory with false emptiness', async () => {
  let response = inventory([{ id: 'last-good' }])
  const store = createRuntimeInventoryStore(async () => response)
  await store.refresh()
  response = { ...inventory(), inventory: { dockerAvailable: false, stale: true } }
  await store.refresh()
  assert.equal(store.getSnapshot().apps[0].id, 'last-good')
  assert.equal(store.getSnapshot().inventory.dockerAvailable, false)
  store.dispose()
})

test('inventory labels distinguish stale, refreshing and daemon unavailable from live', () => {
  assert.equal(runtimeInventoryLabel({}), 'Live inventory')
  assert.match(runtimeInventoryLabel({}, true), /Refreshing/)
  assert.match(runtimeInventoryLabel({ stale: true }), /Stale/)
  assert.match(runtimeInventoryLabel({ stale: true, refreshing: true }), /Stale.*refreshing/)
  assert.equal(runtimeInventoryLabel({ dockerAvailable: false, stale: true }), 'Docker daemon unavailable')
})
