import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import fs from 'node:fs/promises'
import { createRuntimeUI, filterRuntimeApps, runtimeCategory, runtimeNeedsAttention, runtimeStatusLabel, runtimeControls } from '../lib/runtime-ui.js'

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
