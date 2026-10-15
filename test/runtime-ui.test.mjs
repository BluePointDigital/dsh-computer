import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import fs from 'node:fs/promises'
import { createRuntimeUI } from '../lib/runtime-ui.js'

test('runtime Applications renders a deployment manager, not adoption/registration gates', () => {
  const UI = createRuntimeUI({ React, api: async () => ({ ok: true, apps: [], deployments: [] }), resolveView: async () => ({}), Viewer: () => null })
  const html = renderToStaticMarkup(React.createElement(UI))
  assert.ok(html.includes('Deploy application'))
  assert.ok(html.includes('Search applications'))
  assert.ok(html.includes('Infrastructure'))
  assert.ok(!/register|adopt|accept existing/i.test(html))
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
