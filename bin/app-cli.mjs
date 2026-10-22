#!/usr/bin/env node
/** CLI and GUI share direct catalog + daemon inventory; shell is creation-only. */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AppManager, recipes } from '../lib/app-manager.js'
import { ExistingApps } from '../lib/existing-apps.js'
import { Catalog } from '../lib/catalog.js'
import { ApplicationRuntime } from '../lib/application-runtime.js'

const bin = fileURLToPath(new URL('./computer', import.meta.url))
const args = process.argv.slice(2)
const [command = 'list', ...rest] = args
const catalog = new Catalog()
const manager = new AppManager({ legacy: () => catalog.list() })
const existing = new ExistingApps(manager)
let runtime
const json = value => console.log(JSON.stringify(value))
const fallback = async () => {
  const child = spawn(bin, ['apps', ...args], { stdio: 'inherit', env: { ...process.env, COMPUTER_APPS_LEGACY: '1' } })
  process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code ?? 1)) })
}
async function stdinJson() {
  let text = ''
  for await (const chunk of process.stdin) { text += chunk; if (text.length > 65536) throw Error('Plan exceeds 64 KiB') }
  return JSON.parse(text)
}
async function inventory() { return runtime.inventory({ fresh: true }) }
function findApp(result, id) {
  const app = result.apps.find(app => app.id === id || app.aliases?.includes(id))
  if (!app) throw Error('Unknown application')
  return app
}
function hasContainer(app) { return Boolean(app.services?.length || app.containerId) }
function applicationURL(app) {
  if (app.launch?.mode === 'ports' || app.launch?.mode === 'isolated') return new URL(app.launch.entryPath, app.launch.origin).href
  if (app.launch?.mode === 'unavailable') throw Error(app.launch.reason)
  const url = app.viewer?.url || app.web?.url || app.launch?.path || app.web?.path
  if (!url) throw Error('Application has no web or viewer URL')
  return url
}
function options() {
  const result = { deleteData: rest.includes('--delete-data') }
  const containerIndex = rest.indexOf('--container')
  if (containerIndex >= 0) {
    if (!rest[containerIndex + 1]) throw Error('--container requires an immutable container ID')
    result.container = rest[containerIndex + 1]
  }
  if (command === 'logs') {
    const value = rest[rest.indexOf('--tail') + 1]
    result.tail = rest.includes('--tail') ? Number(value) : Number(process.env.APPS_LOG_LINES || 60)
    if (!Number.isInteger(result.tail) || result.tail < 0 || result.tail > 10000) throw Error('Log tail must be an integer from 0 to 10000')
  }
  return result
}
try {
  runtime = new ApplicationRuntime({ manager, env: process.env })
  if (command === 'discover' || command === 'discover-existing') {
    const result = await inventory()
    json({ ok: true, schemaVersion: 1, apps: result.apps, warnings: result.warnings, inventory: result.inventory, ...(command === 'discover-existing' ? { containers: result.apps.flatMap(app => app.services || []) } : {}) })
  } else if (command === 'review-existing') json({ ok: true, review: await existing.review(await stdinJson()) })
  else if (command === 'add-existing') json({ ok: true, app: await existing.add(await stdinJson()) })
  else if (command === 'recipes') json({ ok: true, recipes })
  else if (command === 'prepare') json({ ok: true, job: await manager.prepare(await stdinJson()) })
  else if (command === 'approve') {
    if (rest[2] !== '--trust-publisher') throw Error('Usage: approve <job-id> <approval-hash> --trust-publisher')
    json({ ok: true, job: await manager.approve(rest[0], rest[1], true) })
  } else if (command === 'run') json({ ok: true, job: await manager.run(rest[0]) })
  else if (command === 'jobs') json({ ok: true, jobs: await manager.jobs() })
  else if (command === 'cancel') json({ ok: true, job: await manager.cancel(rest[0]) })
  else if (command === 'recover') json({ ok: true, recovered: await manager.recover() })
  else if (command === 'list' || command === 'ls') {
    const result = await inventory()
    if (rest.includes('--json')) json({ ok: true, schemaVersion: 1, apps: result.apps, warnings: result.warnings, inventory: result.inventory })
    else {
      console.log('ID\tNAME\tSTATE\tSOURCE')
      for (const app of result.apps) console.log([app.id, app.name, app.state, app.source || (app.managed ? 'installed' : 'catalog')].join('\t'))
      for (const warning of result.warnings || []) console.error('computer apps: ' + (warning.message || warning))
    }
  } else if (command === 'status' || command === 'url') {
    const result = await inventory(), app = findApp(result, rest[0])
    if (command === 'status') json({ ok: true, app, warnings: result.warnings, inventory: result.inventory })
    else if (rest.includes('--json')) json({ ok: true, app, url: applicationURL(app), warnings: result.warnings, inventory: result.inventory })
    else console.log(applicationURL(app))
  } else if (command === 'details') json({ ok: true, app: await runtime.details(rest[0]), stats: await runtime.stats(rest[0]) })
  else if (command === 'stats') json({ ok: true, stats: await runtime.stats(rest[0]) })
  else if (['up', 'start', 'down', 'stop', 'restart', 'rm', 'remove', 'logs'].includes(command)) {
    const result = await inventory(), app = findApp(result, rest[0])
    if (hasContainer(app) || app.deployment && command !== 'logs') {
      const action = { up: 'start', down: 'stop', rm: 'remove' }[command] || command
      const response = await runtime.action(app.id, action, options())
      json({ ...response, ok: true })
    } else if (command === 'up' || command === 'start') {
      if ((await manager.registry()).apps[app.id]) json(await manager.action('up', app.id))
      else if (app.source === 'catalog') {
        // No daemon container exists: only this explicit creation path may use
        // the fixed-flag legacy launcher. Never use it for inventory/lifecycle.
        if (command === 'start') args[0] = 'up'
        await fallback()
      } else throw Error('Original container is missing; no saved creation definition is available')
    } else throw Error('Application has no current container')
  } else if (command === 'uninstall') json(await manager.action(command, rest[0]))
  else if (command === 'forget') json(await existing.action(command, rest[0]))
  else {
    // Interactive exec, help and special diagnostics are intentionally outside
    // the runtime read/lifecycle surface, not inventory fallbacks.
    await fallback()
  }
} catch (error) {
  console.error('computer apps: ' + error.message)
  process.exitCode = 1
} finally {
  try { await runtime?.close() } catch (error) { console.error('computer apps: ' + error.message); process.exitCode = 1 }
}
