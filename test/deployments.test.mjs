import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
import { AppManager } from '../lib/app-manager.js'
import { Deployments } from '../lib/deployments.js'

const input = { id: 'notes', kind: 'image', name: 'Notes', image: 'example/notes:1', webPort: 8080, env: { PASSWORD: 'TOP_SECRET_CANARY' }, volumes: [{ target: '/data' }], command: ['--title', 'hello; $(touch /tmp/never)'] }
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-deployments-'))
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('dsh-deployments-')); await fs.rm(root, { recursive: true, force: true }) })
  const commands = [], composeCalls = [], containers = new Map(), volumes = new Map(), networks = new Map()
  const docker = async (args, opts) => {
    commands.push({ args, opts })
    if (args[0] === 'ps') {
      assert.ok(args.includes('--no-trunc'))
      assert.ok(args.includes('{"ID":{{json .ID}},"Names":{{json .Names}},"Labels":{{json .Labels}}}'))
      assert.ok(opts.timeout >= 30000)
      return { code: 0, stdout: [...containers.values()].map(info => JSON.stringify({ ID: info.Id, Names: info.Name, Labels: Object.entries(info.Config.Labels).map(([k, v]) => `${k}=${v}`).join(',') })).join('\n') }
    }
    if (args[0] === 'inspect') return containers.has(args[1]) ? { code: 0, stdout: JSON.stringify([containers.get(args[1])]) } : { code: 1, stderr: 'No such container', stdout: '' }
    if (args[0] === 'image' && args[1] === 'inspect') return { code: 0, stdout: JSON.stringify([{ Config: { Volumes: options.imageVolumes?.[args[2]] ?? {} } }]) }
    if (['volume', 'network'].includes(args[0])) {
      const resources = args[0] === 'volume' ? volumes : networks
      if (args[1] === 'ls') return { code: 0, stdout: [...resources.values()].map(resource => JSON.stringify({ Name: resource.Name })).join('\n') }
      if (args[1] === 'inspect') return { code: 0, stdout: JSON.stringify([resources.get(args[2])]) }
    }
    return { code: 0, stdout: '' }
  }
  const compose = async (args, opts) => {
    composeCalls.push({ args, opts })
    const source = JSON.parse(await fs.readFile(args[args.indexOf('--file') + 1], 'utf8'))
    const project = args[args.indexOf('--project-name') + 1]
    const operation = args[args.indexOf('--env-file') + 2]
    if (options.block && operation === 'config') await options.block()
    if (options.throw && operation === options.throw) throw new Error('Compose raw TOP_SECRET_CANARY inline-yaml-secret')
    if (operation === 'config') {
      const normalized = structuredClone(source)
      normalized.name = project
      for (const field of ['volumes', 'networks']) for (const [name, resource] of Object.entries(normalized[field] ?? {})) normalized[field][name] = { ...resource, name: `${project}_${name}` }
      return { code: 0, stdout: JSON.stringify(normalized) }
    }
    if (operation === 'up') {
      for (const [field, resources] of [['volumes', volumes], ['networks', networks]]) for (const [name, spec] of Object.entries(source[field] ?? {})) {
        const actual = spec.name ?? `${project}_${name}`
        if (!resources.has(actual)) resources.set(actual, { Name: actual, Labels: { ...spec.labels, 'com.docker.compose.project': project, [`com.docker.compose.${field === 'volumes' ? 'volume' : 'network'}`]: name } })
      }
      for (const [service, spec] of Object.entries(source.services)) {
        const id = `cid-${service}`
        containers.set(id, { Id: id, Name: `${project}-${service}-1`, Config: { Labels: { ...spec.labels, 'com.docker.compose.project': project, 'com.docker.compose.service': service } }, State: { Running: true, Status: 'running', ...(options.unhealthy ? { Health: { Status: 'unhealthy' } } : {}) }, NetworkSettings: { Networks: { default: { IPAddress: '127.0.0.1' } } } })
      }
      if (options.failUp) return { code: 1, stdout: '', stderr: 'TOP_SECRET_CANARY startup failed' }
    }
    if (operation === 'ps') return { code: 0, stdout: `cid-${args.at(-1)}\n` }
    if (operation === 'down') containers.clear()
    return { code: 0, stdout: '', stderr: '' }
  }
  const manager = new AppManager({ root, docker, health: async () => options.health !== false, readyMs: 5 })
  const deployments = new Deployments({ manager, composeCommand: compose })
  return { root, manager, deployments, compose, composeCalls, commands, containers, volumes, networks }
}
function operation(call) { return call.args[call.args.indexOf('--env-file') + 2] }

test('background services without a web port deploy and become ready without an HTTP probe', async t => {
  const { deployments: d, manager } = await fixture(t, { health: false })
  const job = await d.submit({ ...input, webPort: undefined, command: ['sleep', '86400'] })
  assert.equal((await d.run(job.id)).state, 'ready')
  const runtime = await manager.read(`deployments/notes/revisions/1.runtime.json`)
  assert.equal(runtime.services.app.labels['dsh.apps.web-port'], undefined)
  assert.equal((await d.inventory())[0].webPort, null)
})

test('one owner submit queues durably without Docker/Compose, hides env/source publicly', async t => {
  const { deployments: d, commands, composeCalls, root, manager } = await fixture(t)
  const job = await d.submit(input)
  assert.match(job.id, /^[a-f0-9-]{36}$/); assert.equal(job.state, 'queued'); assert.equal(job.appId, 'notes')
  assert.equal(commands.length, 0); assert.equal(composeCalls.length, 0)
  assert.equal((await d.get(job.id)).state, 'queued')
  const reopened = new Deployments({ manager })
  assert.equal((await reopened.list())[0].id, job.id)
  assert.deepEqual((await reopened.definition('notes')).env, input.env)
  assert.equal((await d.inventory())[0].projectName, 'dsh-notes')
  for (const value of [job, await d.list(), await d.inventory()]) {
    assert.ok(!JSON.stringify(value).includes('TOP_SECRET_CANARY'))
    assert.ok(!JSON.stringify(value).includes('touch /tmp'))
  }
  assert.equal((await fs.stat(path.join(root, 'deployments/notes/revisions/1.json'))).mode & 0o777, 0o600)
  await assert.rejects(d.submit(input), /active/)
})

test('worker uses argv, private env and controlled interpolation; image has caps and no published ports', async t => {
  const { deployments: d, composeCalls, root, commands } = await fixture(t)
  const old = process.env.HOST_CANARY; process.env.HOST_CANARY = 'HOST_SECRET'
  t.after(() => { if (old === undefined) delete process.env.HOST_CANARY; else process.env.HOST_CANARY = old })
  const job = await d.submit(input)
  assert.equal((await d.run(job.id)).state, 'ready')
  const config = composeCalls.find(call => operation(call) === 'config')
  assert.equal(config.opts.env.HOST_CANARY, undefined); assert.equal(config.opts.env.PASSWORD, input.env.PASSWORD)
  assert.equal(config.opts.env.COMPOSE_DISABLE_ENV_FILE, '1')
  assert.equal(config.args[config.args.indexOf('--project-name') + 1], 'dsh-notes')
  assert.equal(config.args[config.args.indexOf('--project-directory') + 1], path.join(root, 'deployments/notes'))
  for (const { args } of composeCalls) assert.ok(!args.join(' ').includes(input.env.PASSWORD))
  const document = JSON.parse(await fs.readFile(config.args[config.args.indexOf('--file') + 1], 'utf8'))
  assert.equal(document.services.app.restart, 'no'); assert.ok(document.services.app.mem_limit)
  assert.equal(document.services.app.ports, undefined)
  assert.equal(document.services.app.labels['dsh.apps.web-port'], '8080')
  assert.deepEqual(document.services.app.command, ['--title', 'hello; $$(touch /tmp/never)'])
  assert.ok(!commands.some(call => call.args.includes('touch /tmp/never')))
  assert.equal((await fs.stat(path.join(root, 'deployments/notes/private.env'))).mode & 0o777, 0o600)
  await assert.rejects(d.run(job.id), /not queued/)
})

test('updates, redeploy and rollback retain stable named data volume and private revision history', async t => {
  const { deployments: d, composeCalls, root } = await fixture(t)
  await d.run((await d.submit(input)).id)
  const runtime = async n => JSON.parse(await fs.readFile(path.join(root, `deployments/notes/revisions/${n}.runtime.json`), 'utf8'))
  const first = await runtime(1)
  const updated = await d.action('notes', 'update', { image: 'example/notes:2', env: { PASSWORD: 'SECOND_SECRET' } })
  assert.equal(updated.state, 'queued'); assert.equal((await d.run(updated.id)).state, 'ready')
  const second = await runtime(2)
  assert.deepEqual(first.services.app.volumes, second.services.app.volumes)
  assert.equal((await d.definition('notes')).env.PASSWORD, 'SECOND_SECRET')
  await d.run((await d.action('notes', 'redeploy')).id)
  assert.ok(composeCalls.some(call => call.args.includes('--force-recreate')))
  await d.run((await d.action('notes', 'rollback', { revision: 1 })).id)
  const definition = await d.definition('notes')
  assert.equal(definition.image, input.image); assert.equal(definition.env.PASSWORD, input.env.PASSWORD)
  assert.equal(definition.revisions.length, 4)
  assert.deepEqual(first.services.app.volumes, (await runtime(4)).services.app.volumes)
})

test('failed startup/health stays visible, retains containers, source/env and progress; never rollback deletes', async t => {
  for (const option of [{ unhealthy: true }, { health: false }, { failUp: true }, { throw: 'pull' }]) {
    const { deployments: d, composeCalls, commands, containers } = await fixture(t, option)
    const result = await d.run((await d.submit(input)).id)
    assert.equal(result.state, 'failed'); assert.ok(result.events.length >= 3)
    assert.ok(!JSON.stringify(result).includes('TOP_SECRET_CANARY')); assert.ok(!JSON.stringify(result).includes('inline-yaml-secret'))
    if (!option.throw) assert.equal(containers.size, 1)
    assert.ok(!composeCalls.some(call => operation(call) === 'down'))
    assert.ok(!commands.some(call => ['rm', 'rmi'].includes(call.args[0])))
    assert.equal((await d.definition('notes')).env.PASSWORD, input.env.PASSWORD)
    assert.equal((await d.inventory())[0].state, 'failed')
    assert.equal((await d.list())[0].state, 'failed')
  }
})

test('raw Compose supports ordinary volumes/networks/depends_on/health and frontend selection', async t => {
  const { deployments: d, composeCalls, root } = await fixture(t)
  const compose = `services:\n  web:\n    image: nginx:1\n    depends_on:\n      db:\n        condition: service_healthy\n    environment:\n      PASSWORD: \${PASSWORD}\n    healthcheck:\n      test: [CMD, 'true']\n    networks: [backend]\n  db:\n    image: postgres:17\n    volumes: [data:/var/lib/postgresql/data]\n    networks: [backend]\nvolumes:\n  data: {}\nnetworks:\n  backend: {}\n`
  const job = await d.submit({ id: 'stack', kind: 'compose', compose, service: 'web', webPort: 80, env: { PASSWORD: 'COMPOSE_CANARY' } })
  assert.equal((await d.definition('stack')).compose, compose)
  assert.equal((await d.run(job.id)).state, 'ready')
  const config = composeCalls.find(call => operation(call) === 'config')
  const document = JSON.parse(await fs.readFile(config.args[config.args.indexOf('--file') + 1], 'utf8'))
  assert.equal(document.services.db.volumes[0], 'data:/var/lib/postgresql/data')
  assert.deepEqual(document.services.web.depends_on.db, { condition: 'service_healthy' })
  assert.equal((await d.inventory())[0].service, 'web')
  assert.ok(!JSON.stringify(await d.list()).includes('COMPOSE_CANARY'))
  assert.equal((await fs.stat(path.join(root, 'deployments/stack/revisions/1.json'))).mode & 0o777, 0o600)
})

test('unrequested builds and filesystem references rejected before any Compose/config call', async t => {
  const { deployments: d, composeCalls, commands } = await fixture(t)
  const sources = [
    'include: /tmp/secrets.yaml\nservices: { app: { image: nginx:1 } }',
    'services: { app: { image: nginx:1, build: . } }',
    'services: { app: { image: nginx:1, extends: { file: /tmp/private, service: app } } }',
    'services: { app: { image: nginx:1, env_file: /tmp/private } }',
    'services: { app: { image: nginx:1, label_file: /tmp/private } }',
    'services: { app: { image: nginx:1, volumes: ["/tmp/private:/data"] } }',
    'services: { app: { image: nginx:1, volumes: ["data:/data"] } }\nvolumes: { data: { driver_opts: { device: /tmp } } }',
    'services: { app: { image: nginx:1 } }\nconfigs: { config: { file: /tmp/private } }',
    'services: { app: { image: nginx:1, container_name: victim } }',
    'name: victim\nservices: { app: { image: nginx:1 } }',
    'services: { app: { image: nginx:1 } }\nnetworks: { ext: { external: true } }',
    'services: { app: { image: nginx:1, security_opt: [seccomp=/tmp/private.json] } }',
    'services: { app: { image: nginx:1, security_opt: [seccomp:/tmp/private.json] } }',
    'services: { app: { image: nginx:1, post_start: [{ command: whoami, privileged: true }] } }',
    'services: { app: { image: nginx:1, pre_stop: [{ command: whoami, privileged: true }] } }',
    'services: { app: { image: nginx:1, gpus: all } }',
    'services: { app: { image: nginx:1, deploy: { resources: { reservations: { devices: [{ capabilities: [gpu] }] } } } } }',
    'services: { app: { image: nginx:1, deploy: { resources: { limits: { devices: [{ capabilities: [gpu] }] } } } } }',
    'services: { app: { image: nginx:1, uts: host } }',
    'services: { app: { image: nginx:1, cgroup: host } }',
    'services: { app: { image: nginx:1 } }\nvolumes: { data: { labels: { dsh.apps.deployment-owner: forged } } }',
  ]
  for (const compose of sources) await assert.rejects(d.submit({ id: 'bad', kind: 'compose', compose, service: 'app' }))
  assert.equal(composeCalls.length, 0); assert.equal(commands.length, 0)
  for (const env of [{ COMPOSE_FILE: '/tmp/private' }, { DOCKER_HOST: 'tcp://evil' }, { PATH: '/tmp' }]) await assert.rejects(d.submit({ ...input, env }), /reserved/)
  await assert.rejects(d.submit({ ...input, id: '../escape' }), /id/)
})

test('lifecycle uses saved project and retains named volumes unless remove deleteData explicitly true', async t => {
  const { deployments: d, composeCalls } = await fixture(t)
  await d.run((await d.submit(input)).id)
  await d.lifecycle('notes', 'stop'); await d.lifecycle('notes', 'start'); await d.lifecycle('notes', 'restart')
  assert.equal((await d.lifecycle('notes', 'remove')).dataRetained, true)
  assert.ok(!composeCalls.at(-1).args.includes('--volumes'))
  assert.equal((await d.inventory())[0].state, 'removed')
  assert.equal((await d.definition('notes')).image, input.image)
  await d.lifecycle('notes', 'start')
  assert.equal((await d.lifecycle('notes', 'remove', { deleteData: true })).dataRetained, false)
  assert.ok(composeCalls.at(-1).args.includes('--volumes'))
  await assert.rejects(d.lifecycle('notes', 'stop', { deleteData: true }), /only valid/)
  await assert.rejects(d.lifecycle('external', 'stop'), /discovered projects/)
})

test('lifecycle targets latest attempted normalized revision after a failed update', async t => {
  const { deployments: d, composeCalls } = await fixture(t)
  await d.run((await d.submit(input)).id)
  const good = d.composeCommand
  d.composeCommand = async (args, options) => args.includes('up') ? { code: 1, stdout: '', stderr: '' } : good(args, options)
  const update = await d.action('notes', 'update', { image: 'example/notes:2' })
  assert.equal((await d.run(update.id)).state, 'failed')
  assert.equal((await d.definition('notes')).currentRevision, 1)
  await d.lifecycle('notes', 'stop')
  assert.match(composeCalls.at(-1).args[composeCalls.at(-1).args.indexOf('--file') + 1], /2\.runtime\.json$/)
})

test('Docker project/name collisions fail closed before config and do not adopt containers', async t => {
  const { deployments: d, composeCalls, containers } = await fixture(t)
  containers.set('foreign', { Id: 'foreign', Name: 'dsh-notes-web-1', Config: { Labels: { 'com.docker.compose.project': 'dsh-notes' } } })
  const result = await d.run((await d.submit(input)).id)
  assert.equal(result.state, 'failed'); assert.match(result.error, /collision/)
  assert.equal(composeCalls.length, 0); assert.equal(containers.size, 1)
})

test('cross-instance workers are sequential; duplicate workers and queued same-app submits rejected', async t => {
  let release, enteredResolve
  const entered = new Promise(resolve => { enteredResolve = resolve })
  const { deployments: d, manager, compose } = await fixture(t, { block: () => { enteredResolve(); return new Promise(resolve => { release = resolve }) } })
  const job = await d.submit(input)
  await assert.rejects(d.action('notes', 'update', { image: 'example/notes:2' }), /active/)
  const running = d.run(job.id)
  await entered
  const second = new Deployments({ manager, composeCommand: compose })
  await assert.rejects(second.run(job.id), /Another application operation/)
  await assert.rejects(second.submit({ ...input, id: 'other' }), /Another application operation/)
  release(); assert.equal((await running).state, 'ready')
  await assert.rejects(second.run(job.id), /not queued/)
})

test('startup recovery retains queued work but fails interrupted workers without Docker mutations', async t => {
  const { deployments: d, manager, commands, composeCalls } = await fixture(t)
  const queued = await d.submit(input)
  assert.deepEqual(await d.recover(), [])
  assert.equal((await d.get(queued.id)).state, 'queued')
  const job = await manager.read(`deployment-jobs/${queued.id}.json`)
  job.state = 'starting'; await manager.save(`deployment-jobs/${queued.id}.json`, job)
  assert.deepEqual(await d.recover(), [queued.id])
  assert.equal((await d.get(queued.id)).state, 'failed')
  assert.equal((await d.inventory())[0].state, 'failed')
  assert.equal((await d.definition('notes')).env.PASSWORD, input.env.PASSWORD)
  assert.equal(commands.length, 0); assert.equal(composeCalls.length, 0)
})

test('YAML merge aliases are expanded before rejecting hidden external references', async t => {
  const { deployments: d, composeCalls } = await fixture(t)
  await assert.rejects(d.submit({ id: 'alias', kind: 'compose', service: 'app', compose: 'x-base: &base\n  image: nginx:1\n  env_file: /tmp/private\nservices:\n  app:\n    <<: *base\n' }), /env_file/)
  assert.equal(composeCalls.length, 0)
})

test('operator Docker transport/config reaches Compose and inspections but input cannot override it', async t => {
  const { deployments: d, commands, composeCalls, root } = await fixture(t)
  const old = Object.fromEntries(['DOCKER_HOST', 'DOCKER_CONFIG', 'DSH_HOME'].map(key => [key, process.env[key]]))
  t.after(() => { for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value })
  process.env.DOCKER_HOST = 'unix:///operator.sock'
  process.env.DOCKER_CONFIG = path.join(root, 'operator-config')
  assert.equal((await d.run((await d.submit(input)).id)).state, 'ready')
  for (const call of [...commands, ...composeCalls]) {
    assert.equal(call.opts.env.DOCKER_HOST, 'unix:///operator.sock')
    assert.equal(call.opts.env.DOCKER_CONFIG, process.env.DOCKER_CONFIG)
  }
  await assert.rejects(d.submit({ ...input, id: 'evil', env: { DOCKER_CONFIG: '/tmp/evil' } }), /reserved/)
  delete process.env.DOCKER_CONFIG
  process.env.DSH_HOME = path.join(root, 'dsh-home')
  await fs.mkdir(path.join(process.env.DSH_HOME, 'tools/docker/cli-plugins'), { recursive: true })
  await fs.writeFile(path.join(process.env.DSH_HOME, 'tools/docker/cli-plugins/docker-compose'), '')
  assert.equal((await d.executionEnv()).DOCKER_CONFIG, path.join(process.env.DSH_HOME, 'tools/docker'))
})

test('normalized dollars are saved once, deploy restart policy is overridden and deploy limits are respected', async t => {
  const { deployments: d, root, composeCalls } = await fixture(t)
  const compose = JSON.stringify({ services: { app: { image: 'nginx:1', command: ['echo', '$$HOME'], environment: { PASSWORD: '$$literal' }, deploy: { restart_policy: { condition: 'any' }, resources: { limits: { cpus: '2', memory: '1g', pids: 100 } } } } } })
  assert.equal((await d.run((await d.submit({ id: 'limits', kind: 'compose', compose, webPort: 80 })).id)).state, 'ready')
  const runtime = JSON.parse(await fs.readFile(path.join(root, 'deployments/limits/revisions/1.runtime.json')))
  assert.deepEqual(runtime.services.app.command, ['echo', '$$HOME'])
  assert.equal(runtime.services.app.environment.PASSWORD, '$$literal')
  assert.equal(runtime.services.app.restart, 'no')
  assert.equal(runtime.services.app.deploy.restart_policy, undefined)
  assert.equal(runtime.services.app.cpus, '2'); assert.equal(runtime.services.app.mem_limit, '1g'); assert.equal(runtime.services.app.pids_limit, 100)
  assert.ok(composeCalls.find(call => operation(call) === 'up').args.includes('--remove-orphans'))
})

test('image-declared anonymous volume targets become stable service-specific owned named volumes', async t => {
  const { deployments: d, root, commands } = await fixture(t, { imageVolumes: { 'redis:7': { '/data': {} } } })
  const compose = 'services:\n  web: { image: redis:7 }\n  worker: { image: redis:7 }\n'
  assert.equal((await d.run((await d.submit({ id: 'redis', kind: 'compose', compose, service: 'web', webPort: 6379 })).id)).state, 'ready')
  const read = async rev => JSON.parse(await fs.readFile(path.join(root, `deployments/redis/revisions/${rev}.runtime.json`)))
  const first = await read(1)
  const a = first.services.web.volumes[0], b = first.services.worker.volumes[0]
  assert.equal(a.target, '/data'); assert.equal(b.target, '/data'); assert.notEqual(a.source, b.source)
  assert.ok(first.volumes[a.source].labels['dsh.apps.deployment-owner'])
  assert.ok(first.networks.default.labels['dsh.apps.deployment-owner'])
  await d.run((await d.action('redis', 'redeploy')).id)
  assert.deepEqual((await read(2)).services.web.volumes, first.services.web.volumes)
  assert.ok(commands.some(call => call.args.join(' ') === 'image inspect redis:7'))
})

test('resource collisions fail even without containers; destructive down verifies complete project ownership', async t => {
  for (const kind of ['volume', 'network']) {
    const { deployments: d, volumes, networks, composeCalls, containers, manager } = await fixture(t)
    const resources = kind === 'volume' ? volumes : networks
    const job = await d.submit(input)
    const app = (await manager.read('deployments.json')).apps.notes
    const name = kind === 'volume' ? 'dsh-notes_data-' + (await import('node:crypto')).createHash('sha256').update('/data').digest('hex').slice(0, 16) : 'dsh-notes_default'
    resources.set(name, { Name: name, Labels: {} })
    const failed = await d.run(job.id)
    assert.equal(failed.state, 'failed'); assert.match(failed.error, /collision/)
    assert.equal(composeCalls.length, 0)
    resources.clear()
    assert.equal((await d.run((await d.action('notes', 'redeploy')).id)).state, 'ready')
    containers.clear()
    resources.set('retained-orphan', { Name: 'retained-orphan', Labels: { 'com.docker.compose.project': app.projectName } })
    const count = composeCalls.length
    await assert.rejects(d.lifecycle('notes', 'remove', { deleteData: true }), /collision/)
    assert.equal(composeCalls.length, count, 'foreign retained resource must block down --volumes')
    resources.delete('retained-orphan')
    await d.lifecycle('notes', 'remove', { deleteData: true })
    assert.ok(composeCalls.at(-1).args.includes('--remove-orphans'))
  }
})

test('exact project labels do not confuse notes with notes-extra; foreign project orphans block removal', async t => {
  const { deployments: d, containers, manager, composeCalls } = await fixture(t)
  containers.set('neighbor', { Id: 'neighbor', Name: 'dsh-notes-extra-app-1', Config: { Labels: { 'com.docker.compose.project': 'dsh-notes-extra', 'dsh.apps.deployment-owner': 'other' } } })
  assert.equal((await d.run((await d.submit(input)).id)).state, 'ready')
  const app = (await manager.read('deployments.json')).apps.notes
  containers.set('orphan', { Id: 'orphan', Name: 'unrelated-name', Config: { Labels: { 'com.docker.compose.project': app.projectName, 'dsh.apps.deployment-owner': 'other' } } })
  const before = composeCalls.length
  await assert.rejects(d.lifecycle('notes', 'remove'), /collision/)
  assert.equal(composeCalls.length, before)
})

test('real private Compose config roundtrip preserves literal dollars and normalized resource limits', async t => {
  const configDir = path.join(process.env.DSH_HOME || '/data', 'tools', 'docker')
  try { await fs.access(path.join(configDir, 'cli-plugins/docker-compose')) } catch { t.skip('private Compose plugin is not installed'); return }
  const { deployments: d, root } = await fixture(t)
  const original = d.composeCommand
  const snapshots = [], configErrors = []
  d.composeCommand = async (args, opts) => {
    if (args.includes('config')) {
      const result = await exec('docker', args, { ...opts, env: { ...opts.env, DOCKER_CONFIG: configDir } }).catch(error => { configErrors.push(error.stderr); throw error })
      snapshots.push(JSON.parse(result.stdout)); return { code: 0, stdout: result.stdout }
    }
    return original(args, opts)
  }
  const literal = 'literal $HOME ${UNKNOWN} $$ cash'
  assert.equal((await d.run((await d.submit({ ...input, env: { PASSWORD: literal }, command: ['echo', literal] })).id)).state, 'ready')
  const app = (await d.manager.read('deployments.json')).apps.notes
  const first = JSON.parse(await fs.readFile(path.join(root, 'deployments/notes/revisions/1.runtime.json')))
  const second = await exec('docker', ['compose', '--project-name', app.projectName, '--file', path.join(root, 'deployments/notes/revisions/1.runtime.json'), 'config', '--format', 'json'], { env: { ...await d.executionEnv(), DOCKER_CONFIG: configDir } })
  const roundtrip = JSON.parse(second.stdout)
  assert.deepEqual(roundtrip.services.app.environment, first.services.app.environment)
  assert.deepEqual(roundtrip.services.app.command, first.services.app.command)
  // A resolved model consumed by Docker contains the originally intended value.
  const resolved = await exec('docker', ['compose', '--project-name', app.projectName, '--file', path.join(root, 'deployments/notes/revisions/1.runtime.json'), 'config', '--format', 'json', '--no-interpolate'], { env: { ...await d.executionEnv(), DOCKER_CONFIG: configDir } })
  assert.equal(JSON.parse(resolved.stdout).services.app.environment.PASSWORD, literal.replaceAll('$', () => '$$'))
  assert.equal(snapshots.length, 1)
  const compose = JSON.stringify({ services: { app: { image: 'nginx:1', environment: { PASSWORD: '${PASSWORD}' }, deploy: { restart_policy: { condition: 'any' }, resources: { limits: { cpus: '2', memory: '1g' } } } } } })
  const composed = await d.run((await d.submit({ id: 'roundtrip', kind: 'compose', compose, env: { PASSWORD: literal }, webPort: 80 })).id)
  assert.equal(composed.state, 'ready', composed.error + JSON.stringify(configErrors))
  const limits = JSON.parse(await fs.readFile(path.join(root, 'deployments/roundtrip/revisions/1.runtime.json')))
  assert.equal(Number(limits.services.app.cpus), 2)
  assert.equal(limits.services.app.mem_limit, '1073741824')
  assert.equal(limits.services.app.restart, 'no')
  assert.equal(limits.services.app.deploy.restart_policy, undefined)
  assert.equal(limits.services.app.environment.PASSWORD, literal.replaceAll('$', () => '$$'))
})

test('desktop template uses local image and box-desktop without pulling substitute', async t => {
  const { deployments: d, commands, composeCalls } = await fixture(t)
  const result = await d.run((await d.submit({ id: 'workstation', kind: 'template', recipe: 'my-desktop' })).id)
  assert.equal(result.state, 'ready')
  assert.ok(commands.some(call => call.args[0] === 'image' && call.args.at(-1) === 'dsh-computer:bookworm'))
  assert.ok(commands.some(call => call.args[0] === 'exec' && call.args.at(-1).includes('box-desktop')))
  assert.ok(!composeCalls.some(call => operation(call) === 'pull'))
  assert.ok((await d.definition('workstation')).env.VNC_PASSWORD.length >= 20)
  assert.ok(!JSON.stringify(await d.list()).includes((await d.definition('workstation')).env.VNC_PASSWORD))
})
