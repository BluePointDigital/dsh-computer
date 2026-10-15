import test from 'node:test'
import assert from 'node:assert/strict'
import { APP_ID } from '../lib/app-manager.js'
import { RuntimeInventory } from '../lib/runtime-inventory.js'

const cid = (number) => number.toString(16).padStart(64, '0')
function container(number, name, { project, service, ports = [], state = 'running', health, labels = {}, ...rest } = {}) {
  return {
    Id: cid(number), Name: `/${name}`, Image: `sha256:${cid(number + 1000)}`,
    State: { Status: state, Running: state === 'running', ...(health ? { Health: { Status: health, Log: [{ Output: 'health-secret' }] } } : {}), Error: 'state-secret' },
    Config: { Image: 'example:test', Env: ['PASSWORD=do-not-leak', 'TOKEN=token-secret', 'EMPTY='],
      Labels: { ...(project ? { 'com.docker.compose.project': project } : {}), ...(service ? { 'com.docker.compose.service': service } : {}), ...labels },
      ExposedPorts: Object.fromEntries(ports.map((port) => [String(port).includes('/') ? port : `${port}/tcp`, {}])),
      Cmd: ['secret-command'], Entrypoint: ['secret-entrypoint'], User: '1000', WorkingDir: '/app',
    },
    HostConfig: { PortBindings: {}, Privileged: false },
    Mounts: [{ Type: 'volume', Name: `${name}-data`, Source: '/var/lib/docker/volumes/data', Destination: '/data', RW: true }],
    NetworkSettings: { Ports: {}, Networks: { app: { NetworkID: 'network-1', IPAddress: '172.20.0.2', Gateway: '172.20.0.1', Aliases: [name] } } },
    ...rest,
  }
}
function fixture(initial, settings = { apps: {} }) {
  let infos = initial
  const calls = [], reads = []
  const docker = async (args) => {
    calls.push(args)
    if (args[0] === 'ps') return { code: 0, stdout: infos.map((info) => info.Id).join('\n') }
    assert.equal(args[0], 'inspect', 'inventory is read-only')
    const found = args.slice(1).map((id) => infos.find((info) => info.Id === id)).filter(Boolean)
    return { code: found.length === args.length - 1 ? 0 : 1, stdout: JSON.stringify(found), stderr: found.length === args.length - 1 ? '' : 'No such object' }
  }
  const manager = { read: async (leaf, fallback) => { reads.push([leaf, fallback]); assert.equal(leaf, 'runtime-settings.json'); return settings } }
  return { inventory: new RuntimeInventory({ docker, manager }), calls, reads, setInfos: (next) => { infos = next }, docker }
}
function noSecrets(value) {
  for (const secret of ['do-not-leak', 'token-secret', 'health-secret', 'state-secret', 'secret-command', 'secret-entrypoint']) assert(!JSON.stringify(value).includes(secret), `leaked ${secret}`)
}

test('discovers every Docker container, groups compose services, and keeps all runtime states', async () => {
  const states = ['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']
  const infos = states.map((state, i) => container(i + 1, `standalone-${state}`, { state }))
  infos.push(container(10, 'shop-web-1', { project: 'shop', service: 'web', ports: [3000], health: 'healthy' }),
    container(11, 'shop-db-1', { project: 'shop', service: 'db', ports: [5432], state: 'exited', health: 'unhealthy' }))
  const f = fixture(infos), apps = await f.inventory.list()
  assert.equal(apps.length, 8)
  assert.deepEqual(apps.filter((app) => !app.project).map((app) => app.state).sort(), [...states].sort())
  const stack = apps.find((app) => app.project === 'shop')
  assert.equal(stack.source, 'compose'); assert.equal(stack.state, 'partial'); assert.equal(stack.health, 'unhealthy')
  assert.deepEqual(stack.services.map((service) => service.service), ['db', 'web'])
  assert.equal(stack.web, undefined); assert.equal(stack.containerId, undefined)
  assert.equal(stack.webCandidates.length, 2)
  assert.deepEqual(f.calls, [['ps', '-aq', '--no-trunc'], ['inspect', ...infos.map((info) => info.Id)]])
  assert.deepEqual(f.reads, [['runtime-settings.json', { apps: {} }]])
  for (const app of apps) { assert(APP_ID.test(app.id)); assert(app.id.length <= 32); assert(!('owner' in app)) }
  noSecrets(apps)
})

test('generated names are stable across order/replacement, slug collisions and long names', async () => {
  const names = ['Some__Name', 'some--name', 'a'.repeat(100)]
  const f = fixture(names.map((name, index) => container(index + 1, name)))
  const first = await f.inventory.list()
  assert.equal(new Set(first.map((app) => app.id)).size, 3)
  assert(first.every((app) => APP_ID.test(app.id) && app.id.startsWith('docker-')))
  f.setInfos(names.map((name, index) => container(index + 20, name)).reverse())
  const second = await f.inventory.list()
  assert.deepEqual(second.map((app) => app.id), first.map((app) => app.id))
  const stack = fixture([container(50, 'renamed-replica', { project: 'Project_With.UPPER_and-a-very-long-name', service: 'web' })])
  const [app] = await stack.inventory.list(); assert(APP_ID.test(app.id)); assert(app.id.startsWith('stack-'))
  stack.setInfos([container(51, 'new-replica', { project: app.project, service: 'web' })])
  assert.equal((await stack.inventory.list())[0].id, app.id)
})

test('known metadata deduplicates discovered apps, preserves endpoints and missing templates', async () => {
  const info = container(1, 'dsh-app-editor', { ports: [8080, 9090] })
  info.Config.Labels['dsh.apps.install'] = 'installation-owner'
  const f = fixture([info])
  const web = { containerPort: '8080', path: '/apps/web/editor/code/', mode: 'proxy' }
  const known = [
    { id: 'editor', name: 'Friendly Editor', managed: true, owner: 'installation-owner', containerId: info.Id, web },
    { id: 'alias', containerId: info.Id, owner: 'not-owned', env: { SECRET: 'do-not-leak' } },
    { id: 'template', name: 'New app', state: 'new', web: { containerPort: '80' } },
    { id: 'gone', containerId: cid(20), state: 'running', web, owner: 'not-owned' },
  ]
  const apps = await f.inventory.list(known)
  assert.equal(apps.length, 3)
  const editor = apps.find((app) => app.id === 'editor')
  assert.equal(editor.name, 'Friendly Editor'); assert.equal(editor.source, 'managed'); assert.equal(editor.owner, 'installation-owner')
  assert.deepEqual(editor.web, web); assert.equal(editor.containerId, info.Id); assert.deepEqual(editor.aliases, ['alias'])
  const template = apps.find((app) => app.id === 'template')
  assert.equal(template.state, 'new'); assert.deepEqual(template.services, []); assert.equal(template.web, undefined)
  const gone = apps.find((app) => app.id === 'gone')
  assert.equal(gone.state, 'missing'); assert.deepEqual(gone.services, []); assert.equal(gone.containerId, undefined); assert.equal(gone.owner, undefined)
  noSecrets(apps)
  assert.equal(known[0].web, web, 'does not mutate known metadata')
})

test('matches legacy dsh-app names and reserves known IDs against discovery collisions', async () => {
  const info = container(1, 'dsh-app-editor', { ports: [8080] }), other = container(2, 'other')
  const f = fixture([info, other]), original = (await f.inventory.list()).find((app) => app.name === 'other')
  const apps = await f.inventory.list([{ id: 'editor', name: 'Editor', webPort: 8080, webPath: '/code/' }, { id: original.id, name: 'Reserved', state: 'new' }])
  assert.equal(apps.length, 3)
  assert.equal(new Set(apps.map((app) => app.id)).size, 3)
  const editor = apps.find((app) => app.id === 'editor')
  assert.equal(editor.containerId, info.Id); assert.equal(editor.web.path, '/apps/web/editor/code/')
})

test('immutable known match wins over a reused legacy container name in another project', async () => {
  const original = container(1, 'renamed-original', { project: 'z-original', service: 'web', ports: [8080] })
  const reused = container(2, 'dsh-app-editor', { project: 'a-replacement', service: 'web', ports: [9090] })
  const f = fixture([reused, original])
  const apps = await f.inventory.list([{ id: 'editor', containerId: original.Id, web: { containerPort: '8080', path: '/apps/web/editor/', mode: 'proxy' } }])
  assert.equal(apps.length, 2)
  assert.equal(new Set(apps.map((app) => app.id)).size, 2)
  const known = apps.find((app) => app.id === 'editor')
  assert.equal(known.project, 'z-original'); assert.equal(known.containerId, original.Id)
  assert.notEqual(apps.find((app) => app.project === 'a-replacement').id, 'editor')
})

test('TCP candidates include bound ports, exclude UDP, and never invent port 80', async () => {
  const one = container(1, 'single', { ports: [3000, '53/udp'] })
  one.HostConfig.PortBindings = { '3000/tcp': [{ HostPort: '4567' }] }
  const multi = container(2, 'multi', { ports: [8080, 9090] })
  const empty = container(3, 'no-ports'), bound = container(4, 'bound-only')
  bound.NetworkSettings.Ports = { '8443/tcp': [{ HostPort: '8444' }] }
  const apps = await fixture([one, multi, empty, bound]).inventory.list()
  assert.equal(apps.find((app) => app.name === 'single').web.containerPort, '3000')
  assert.deepEqual(apps.find((app) => app.name === 'single').services[0].ports, [3000])
  assert.equal(apps.find((app) => app.name === 'multi').web, undefined)
  assert.equal(apps.find((app) => app.name === 'multi').webCandidates.length, 2)
  assert.equal(apps.find((app) => app.name === 'no-ports').web, undefined)
  assert.deepEqual(apps.find((app) => app.name === 'no-ports').webCandidates, [])
  assert.equal(apps.find((app) => app.name === 'bound-only').web.containerPort, '8443')
})

test('explicit labels select frontend, ambiguous labels do not, saved endpoints are not adoption', async () => {
  const db = container(1, 'suite-db-1', { project: 'suite', service: 'db', ports: [5432] })
  const web = container(2, 'suite-web-1', { project: 'suite', service: 'web', ports: [3000, 9229], labels: { 'dsh.apps.web-port': '3000', 'dsh.apps.web-path': '/ui/' } })
  const settings = { apps: {} }, f = fixture([db, web], settings)
  const [app] = await f.inventory.list()
  assert.equal(app.containerId, web.Id); assert.equal(app.web.containerPort, '3000'); assert.equal(app.webService, 'web')
  assert.equal(app.web.path, `/apps/web/${app.id}/ui/`)
  settings.apps[app.id] = { service: 'db', webPort: 8181, webPath: '/admin/' }
  const [configured] = await f.inventory.list()
  assert.equal(configured.containerId, db.Id); assert.equal(configured.web.containerPort, '8181'); assert.equal(configured.web.path, `/apps/web/${app.id}/admin/`)
  assert.equal(configured.managed, false); assert.equal(configured.owner, undefined)
  settings.apps[app.id] = { service: 'missing', webPort: 8181 }
  const [invalid] = await f.inventory.list(); assert.equal(invalid.web, undefined); assert.match(invalid.endpointError, /unavailable/)
  delete settings.apps[app.id]
  db.Config.Labels['dsh.apps.web-port'] = '5432'
  assert.equal((await f.inventory.list())[0].web, undefined)
  noSecrets(configured)
})

test('compose project with one exposed port selects it and known endpoint beats heuristics', async () => {
  const db = container(1, 'suite-db-1', { project: 'suite', service: 'db' })
  const web = container(2, 'dsh-app-suite', { project: 'suite', service: 'web', ports: [3000] })
  const f = fixture([db, web]), [app] = await f.inventory.list()
  assert.equal(app.containerId, web.Id); assert.equal(app.web.containerPort, '3000')
  web.Config.Labels['dsh.apps.web-port'] = '8080'
  const known = [{ id: 'suite', containerId: web.Id, web: { containerPort: '9090', path: '/apps/web/suite/existing/', mode: 'proxy' } }]
  const [matched] = await f.inventory.list(known)
  assert.equal(matched.id, 'suite'); assert.equal(matched.services.length, 2); assert.equal(matched.web.containerPort, '9090')
})

test('infrastructure is marked but never filtered out', async () => {
  const box = container(1, 'dsh-computer-12345678')
  const portainer = container(2, 'admin', { Config: { Image: 'portainer/portainer-ce:latest' } })
  const app = container(3, 'ordinary')
  const apps = await fixture([box, portainer, app]).inventory.list()
  assert.equal(apps.length, 3)
  assert.equal(apps.filter((app) => app.infrastructure).length, 2)
})

test('details expose env keys, permissions, mounts and networks but no secret values or raw config', async () => {
  const info = container(1, 'details', { ports: [3000] })
  Object.assign(info.HostConfig, { Privileged: true, ReadonlyRootfs: true, CapAdd: ['NET_ADMIN'], Devices: [{ PathOnHost: '/dev/dri', PathInContainer: '/dev/dri', CgroupPermissions: 'rwm' }], SecurityOpt: ['no-new-privileges'] })
  const f = fixture([info]), [app] = await f.inventory.list(), details = await f.inventory.details(app.id)
  const [service] = details.services
  assert.deepEqual(service.config.environmentKeys, ['EMPTY', 'PASSWORD', 'TOKEN'])
  assert.equal(service.config.user, '1000'); assert.equal(service.permissions.privileged, true)
  assert.equal(service.permissions.readOnlyRootfs, true); assert.deepEqual(service.permissions.addedCapabilities, ['NET_ADMIN'])
  assert.equal(service.permissions.devices[0].source, '/dev/dri')
  assert.equal(service.mounts[0].target, '/data'); assert.equal(service.networks[0].ipAddress, '172.20.0.2')
  assert.deepEqual(details.config, service.config); assert.equal(service.Config, undefined)
  noSecrets(details)
})

test('saved deployment project matches its friendly identity and selected frontend; endpoint path overrides metadata', async () => {
  const web = container(81, 'dsh-notes-web-1', { project: 'dsh-notes', service: 'web', ports: [8080] })
  const db = container(82, 'dsh-notes-db-1', { project: 'dsh-notes', service: 'db', ports: [5432] })
  const f = fixture([web, db], { apps: { notes: { service: 'web', webPort: 8080, webPath: '/new/' } } })
  const apps = await f.inventory.list([{ id: 'notes', name: 'Notes', deployment: true, projectName: 'dsh-notes', service: 'web', webPort: 8080, webPath: '/old/' }])
  assert.equal(apps.length, 1); assert.equal(apps[0].id, 'notes'); assert.equal(apps[0].services.length, 2)
  assert.equal(apps[0].webPath, '/new/'); assert.equal(apps[0].containerId, web.Id)
})

test('stale managed ownership is not attached to a replacement; desktop viewer gets working live password', async () => {
  const replacement = container(84, 'dsh-app-demo', { ports: [6080] })
  replacement.Config.Env.push('VNC_PASSWORD=viewer-password')
  const f = fixture([replacement])
  const [app] = await f.inventory.list([{ id: 'demo', managed: true, owner: 'old-install', webPort: 6080, viewer: true, state: 'new' }])
  assert.equal(app.containerId, replacement.Id); assert.equal(app.owner, undefined); assert.equal(app.managed, false)
  assert.equal(app.viewer.password, 'viewer-password')
})

test('inspect requires full immutable IDs, handles absence, and fails closed on changed identity', async () => {
  const f = fixture([container(1, 'original')])
  await assert.rejects(f.inventory.inspect('original'), /immutable/)
  await assert.rejects(f.inventory.inspect(cid(1).slice(0, 12)), /immutable/)
  assert.equal((await f.inventory.inspect(cid(1))).Id, cid(1))
  assert.equal(await f.inventory.inspect(cid(2)), null)
  const changed = new RuntimeInventory({ docker: async () => ({ code: 0, stdout: JSON.stringify([container(2, 'replacement')]) }) })
  await assert.rejects(changed.inspect(cid(1)), /identity/)
  const down = new RuntimeInventory({ docker: async () => ({ code: 1, stderr: 'daemon unavailable' }) })
  await assert.rejects(down.inspect(cid(1)), /absence is not proven/)
  await assert.rejects(down.list(), /discovery unavailable/)
})

test('resolve verifies membership, selects frontend and pins actual identity', async () => {
  const infos = [container(1, 'web', { project: 'suite', service: 'web', ports: [3000] }), container(2, 'worker', { project: 'suite', service: 'worker' }), container(3, 'unrelated')]
  const f = fixture(infos), apps = await f.inventory.list(), app = apps.find((app) => app.project)
  const selected = await f.inventory.resolve(app.id)
  assert.equal(selected.containerId, cid(1)); assert.equal(selected.info.Id, cid(1)); assert.equal(selected.app.id, app.id)
  assert.equal((await f.inventory.resolve(app.id, cid(2))).service.service, 'worker')
  await assert.rejects(f.inventory.resolve(app.id, cid(3)), /does not belong/)
  await assert.rejects(f.inventory.resolve('missing'), /not found/)
  await assert.rejects(f.inventory.details('missing'), /not found/)
  const byKnown = await f.inventory.resolve('known', [{ id: 'known', containerId: cid(1) }])
  assert.equal(byKnown.containerId, cid(1))
})

test('batching bounds inspect arguments and empty daemon does not run inspect', async () => {
  const infos = Array.from({ length: 205 }, (_, index) => container(index + 1, `app-${index}`))
  const f = fixture(infos)
  assert.equal((await f.inventory.list()).length, 205)
  assert.deepEqual(f.calls.filter((args) => args[0] === 'inspect').map((args) => args.length - 1), [100, 100, 5])
  const empty = fixture([])
  assert.deepEqual(await empty.inventory.list(), [])
  assert.deepEqual(empty.calls, [['ps', '-aq', '--no-trunc']])
})

test('container disappearance between ps/inspect retains other rows; daemon errors and malformed IDs fail closed', async () => {
  const info = container(1, 'survivor')
  const inventory = new RuntimeInventory({ docker: async (args) => args[0] === 'ps'
    ? { code: 0, stdout: `${cid(1)}\n${cid(2)}` }
    : { code: 1, stdout: JSON.stringify([info]), stderr: `No such container: ${cid(2)}` } })
  assert.equal((await inventory.list()).length, 1)
  const down = new RuntimeInventory({ docker: async (args) => args[0] === 'ps' ? { code: 0, stdout: cid(1) } : { code: 1, stdout: '', stderr: 'permission denied' } })
  await assert.rejects(down.list(), /inspection unavailable/)
  const invalid = new RuntimeInventory({ docker: async () => ({ code: 0, stdout: 'name-not-id' }) })
  await assert.rejects(invalid.list(), /identities/)
  const swapped = new RuntimeInventory({ docker: async (args) => args[0] === 'ps' ? { code: 0, stdout: cid(1) } : { code: 0, stdout: JSON.stringify([container(2, 'wrong')]) } })
  await assert.rejects(swapped.list(), /identity/)
})
