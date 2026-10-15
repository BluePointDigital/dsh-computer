/** Opt-in real nested-Docker Compose deployment acceptance. Creates only random smoke projects. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { AppManager } from '../lib/app-manager.js'
import { Deployments } from '../lib/deployments.js'
import { RuntimeInventory } from '../lib/runtime-inventory.js'
if (process.env.RUN_RUNTIME_LIVE !== '1') console.log('SKIP runtime Docker deployment acceptance (RUN_RUNTIME_LIVE=1)')
else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-deploy-live-'))
  const id = 'smoke-' + randomBytes(5).toString('hex')
  const manager = new AppManager({ root, readyMs: 15000 })
  const deployments = new Deployments({ manager })
  const inventory = new RuntimeInventory({ manager })
  try {
    const submitted = await deployments.submit({ id, kind: 'compose', name: 'Runtime acceptance', compose: JSON.stringify({ services: {
      web: { image: 'nginx:alpine', expose: [80], volumes: ['data:/smoke-data'], environment: { SMOKE_VALUE: '${SMOKE_VALUE}' } },
      helper: { image: 'alpine:3', command: ['sh', '-c', 'echo helper-ready; sleep 86400'] },
    }, volumes: { data: {} } }), service: 'web', webPort: 80, webPath: '/', env: { SMOKE_VALUE: 'private-$literal' } })
    const result = await deployments.run(submitted.id)
    assert.equal(result.state, 'ready', JSON.stringify(result))
    const apps = await inventory.list(await deployments.inventory())
    const app = apps.find(app => app.id === id)
    assert.ok(app, JSON.stringify(apps)); assert.equal(app.services.length, 2)
    assert.equal(app.web.containerPort, '80')
    const frontend = await inventory.resolve(id, app.containerId, apps)
    assert.equal(frontend.info.State.Running, true)
    assert.ok(frontend.info.Config.Env.includes('SMOKE_VALUE=private-$literal'), 'dollar-bearing private env reaches the real service unchanged')
    const written = await manager.docker(['exec', frontend.containerId, 'sh', '-c', 'echo retained > /smoke-data/value'])
    assert.equal(written.code, 0)
    const redeploy = await deployments.action(id, 'redeploy')
    assert.equal((await deployments.run(redeploy.id)).state, 'ready')
    const recreated = await inventory.list(await deployments.inventory())
    const selected = recreated.find(app => app.id === id)
    assert.notEqual(selected.containerId, app.containerId)
    const content = await manager.docker(['exec', selected.containerId, 'cat', '/smoke-data/value'])
    assert.equal(content.stdout.trim(), 'retained')
    await deployments.lifecycle(id, 'stop')
    assert.equal((await inventory.list(await deployments.inventory())).find(app => app.id === id).state, 'exited')
    await deployments.lifecycle(id, 'start')
    assert.equal((await inventory.list(await deployments.inventory())).find(app => app.id === id).state, 'running')
    console.log('PASS real Docker Compose: owner-click deployment, two-service discovery, frontend, redeploy, retained data and lifecycle')
  } finally {
    try { await deployments.lifecycle(id, 'remove', { deleteData: true }) } catch (error) { console.error('Smoke cleanup:', error.message); process.exitCode = 1 }
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'dsh-deploy-live-'))); await fs.rm(root, { recursive: true, force: true })
  }
}
