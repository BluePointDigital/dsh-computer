/** Owner-click deployments. All source/credentials are private; workers never log CLI output. */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { parse } from 'yaml'
import { APP_ID, validatePlan } from './app-manager.js'
import { recipePlan } from './recipes.js'

class DeploymentError extends Error {}
const check = (value, message) => { if (!value) throw new DeploymentError(message) }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const ACTIVE = new Set(['queued', 'validating', 'pulling', 'starting', 'checking'])
const stamp = () => new Date().toISOString()
const projectName = id => `dsh-${id}`
const revisionLeaf = (id, revision) => `deployments/${id}/revisions/${revision}.json`
const jobLeaf = id => `deployment-jobs/${id}.json`
const clone = value => structuredClone(value)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const literal = value => typeof value === 'string' ? value.replaceAll('$', () => '$$') : Array.isArray(value) ? value.map(literal) : object(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, literal(item)])) : value
const OWN = 'dsh.apps.deployment-owner'
const forbiddenEnv = /^(?:COMPOSE_|DOCKER_|LD_|DYLD_|BASH_ENV$|ENV$|PATH$|HOME$|SHELLOPTS$|NODE_OPTIONS$|PYTHONPATH$)/

function environment(env = {}) {
  check(object(env) && Object.keys(env).length <= 100, 'env must contain at most 100 values')
  const result = {}
  for (const [key, value] of Object.entries(env)) {
    check(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && !forbiddenEnv.test(key), 'Environment key is invalid or reserved by the deployment executor')
    check(typeof value === 'string' && value.length <= 32768 && !/[\0\r\n]/.test(value), 'Environment values must be single-line strings')
    result[key] = value
  }
  return result
}

// Parse before invoking Compose: config itself can read include/extends/env_file,
// secrets, configs and build paths. Never let those reach even the config command.
function validateSource(source, normalized = false, project) {
  check(object(source) && object(source.services) && Object.keys(source.services).length > 0 && Object.keys(source.services).length <= 40, 'Compose needs 1–40 services')
  check(!source.include, 'Compose include files are not supported; supply one self-contained document')
  check(!source.configs && !source.secrets, 'Compose configs/secrets file references are not supported in V1; use supplied environment values')
  check(!source.name || normalized && source.name === project, 'Compose project name is assigned by DSH; remove the top-level name')
  for (const [name, service] of Object.entries(source.services)) {
    check(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(name) && object(service), 'Invalid Compose service')
    check(!('build' in service), 'Builds are not supported in V1; supply a prebuilt image')
    for (const field of ['include', 'extends', 'env_file', 'label_file', 'configs', 'secrets', 'develop', 'credential_spec', 'use_api_socket']) check(!(field in service), `Compose ${field} is not supported; no external files may be read`)
    check(typeof service.image === 'string' && service.image.length <= 512 && !/[\0\r\n]/.test(service.image) && !service.image.startsWith('-'), 'Every service needs a prebuilt image')
    check(!service.container_name, 'container_name is not supported; Compose assigns names inside the DSH project')
    check(!service.privileged && !service.devices && !service.device_cgroup_rules && !service.volumes_from && !service.external_links && !service.provider, 'Host devices, privileged services and external service references are not supported')
    check(!service.network_mode || /^service:[a-zA-Z0-9_.-]+$/.test(service.network_mode), 'Only project-local service network modes are supported')
    check(!service.pid && !service.ipc && !service.userns_mode && !service.cgroup_parent && !service.runtime && !service.uts && !service.cgroup, 'Host namespace/runtime overrides are not supported')
    check(!service.gpus && !service.deploy?.resources?.reservations?.devices && !service.deploy?.resources?.limits?.devices, 'GPU and deployment device access is not supported')
    for (const hook of [...(service.post_start ?? []), ...(service.pre_stop ?? [])]) check(!hook.privileged, 'Privileged lifecycle hooks are not supported')
    for (const option of service.security_opt ?? []) {
      check(typeof option === 'string', 'Invalid security option')
      check(!/^seccomp[:=]/i.test(option) || /^seccomp[:=]unconfined$/i.test(option), 'External seccomp policy files are not supported')
    }
    check(!service.cap_add || service.cap_add.length === 0, 'Extra container capabilities are not supported')
    for (const volume of service.volumes ?? []) {
      if (typeof volume === 'string') {
        const bits = volume.split(':')
        check(bits.length >= 2 && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(bits[0]), 'Use named volumes with explicit targets; host paths and anonymous volumes are not supported')
        check(object(source.volumes) && Object.hasOwn(source.volumes, bits[0]), 'Declare each named volume at the top level')
      } else {
        check(object(volume) && ['volume', 'tmpfs'].includes(volume.type), 'Host bind mounts are not supported')
        check(volume.type === 'tmpfs' || typeof volume.source === 'string' && Object.hasOwn(source.volumes ?? {}, volume.source), 'Declare each named volume at the top level')
      }
    }
    const labels = Array.isArray(service.labels) ? Object.fromEntries(service.labels.map(label => { const i = label.indexOf('='); return [i < 0 ? label : label.slice(0, i), i < 0 ? '' : label.slice(i + 1)] })) : service.labels ?? {}
    check(!Object.keys(labels).some(key => key.startsWith('com.docker.compose.') || !normalized && key.startsWith('dsh.apps.')), 'DSH and Compose labels are reserved')
  }
  for (const field of ['volumes', 'networks']) for (const [name, resource] of Object.entries(source[field] ?? {})) {
    check(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name), 'Invalid Compose resource name')
    check(resource == null || object(resource), 'Invalid Compose resource definition')
    check(!resource?.external && !resource?.driver_opts && (!resource?.driver || ['local', 'bridge'].includes(resource.driver)), 'External resources, custom drivers and driver paths are not supported')
    check(!resource?.name || normalized && resource.name.startsWith(`${project}_`), 'Named resources must use Compose project-scoped names; remove explicit name')
    const labels = Array.isArray(resource?.labels) ? Object.fromEntries(resource.labels.map(label => { const at = label.indexOf('='); return [at < 0 ? label : label.slice(0, at), at < 0 ? '' : label.slice(at + 1)] })) : resource?.labels ?? {}
    check(!Object.keys(labels).some(key => key.startsWith('com.docker.compose.') || !normalized && key.startsWith('dsh.apps.')), 'DSH and Compose resource labels are reserved')
    check(!resource?.ipam?.config?.some(item => item.aux_addresses && !object(item.aux_addresses)), 'Invalid network IPAM configuration')
  }
  return source
}
function composeDocument(text) {
  check(typeof text === 'string' && text.length > 0 && text.length <= 1024 * 1024, 'Compose source must be a nonempty document under 1 MiB')
  let document
  try { document = parse(text, { maxAliasCount: 100, uniqueKeys: true, merge: true }) }
  catch { throw new DeploymentError('Invalid Compose YAML; provide one self-contained YAML or JSON document') }
  return validateSource(document)
}
function inputDefinition(input) {
  check(object(input) && APP_ID.test(input.id ?? ''), 'App id must be a lowercase slug, at most 32 characters')
  check(['image', 'compose', 'template'].includes(input.kind), 'Deployment kind must be image, compose or template')
  if (input.kind === 'compose') {
    const document = composeDocument(input.compose)
    const service = input.service || (input.webPort == null || input.webPort === '' ? Object.keys(document.services)[0] : Object.keys(document.services).length === 1 ? Object.keys(document.services)[0] : undefined)
    check(typeof service === 'string' && Object.hasOwn(document.services, service), 'Choose the single frontend service for this Compose project')
    // Reuse web-path and port validation without restricting ordinary Compose YAML.
    const front = validatePlan({ id: input.id, image: 'validation:1', webPort: input.webPort, webPath: input.webPath })
    return { id: input.id, name: String(input.name ?? input.id).slice(0, 80), kind: 'compose', compose: input.compose, service, webPort: input.webPort == null || input.webPort === '' ? null : front.webPort, webPath: front.webPath, env: environment(input.env), autostart: input.autostart === true }
  }
  const defaults = input.kind === 'template' ? recipePlan(input.recipe) : {}
  const fields = ['id', 'name', 'image', 'webPort', 'webPath', 'env', 'volumes', 'command', 'autostart', 'viewer', 'localImage', 'cpus', 'memoryMb', 'shmMb']
  const values = { ...defaults, ...Object.fromEntries(fields.filter(key => input[key] !== undefined).map(key => [key, input[key]])) }
  const plan = validatePlan(values)
  environment(plan.env)
  return { ...plan, webPort: values.webPort == null || values.webPort === '' ? null : plan.webPort, kind: input.kind, ...(input.recipe ? { recipe: input.recipe } : {}), service: 'app' }
}
function imageDocument(plan) {
  const volumes = {}, mounts = []
  for (const { target } of plan.volumes) {
    // Target-derived keys, not array indices or revision UUIDs: edits/reordering
    // never silently replace an application's persistent volume.
    const key = `data-${createHash('sha256').update(target).digest('hex').slice(0, 16)}`
    volumes[key] = {}; mounts.push({ type: 'volume', source: key, target })
  }
  return { services: { app: {
    image: plan.image, environment: literal(plan.env), ...(plan.command.length ? { command: literal(plan.command) } : {}),
    volumes: mounts, restart: plan.autostart ? 'unless-stopped' : 'no',
    cpus: plan.cpus, mem_limit: `${plan.memoryMb}m`, shm_size: `${plan.shmMb}m`, pids_limit: 2048,
    security_opt: ['no-new-privileges:true'], logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '2' } },
  } }, volumes }
}

export class Deployments {
  /** composeCommand has the same (docker argv, options) signature as manager.docker. */
  constructor({ manager, composeCommand } = {}) {
    check(manager?.root && manager?.read && manager?.save && manager?.locked && manager?.docker, 'An AppManager is required')
    this.manager = manager
    this.composeCommand = composeCommand ?? ((args, options) => manager.docker(args, options))
  }
  async directory(leaf) {
    let current = this.manager.root
    for (const part of leaf.split('/')) {
      current = path.join(current, part)
      await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      const stat = await fs.lstat(current)
      check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid(), 'Unsafe deployment state directory')
      await fs.chmod(current, 0o700)
    }
  }
  async init() {
    await this.manager.init()
    await this.directory('deployment-jobs')
    await this.directory('deployments')
  }
  async state() {
    const state = await this.manager.read('deployments.json', { version: 1, apps: {} })
    check(state.version === 1 && object(state.apps), 'Unsupported or corrupt deployment state')
    return state
  }
  async rawJob(id) {
    check(typeof id === 'string' && UUID.test(id), 'Invalid deployment job id')
    const job = await this.manager.read(jobLeaf(id))
    check(job, 'Deployment job not found')
    return job
  }
  publicJob(job) {
    // Allowlist, rather than dropping known private fields. No source, command,
    // arbitrary labels, CLI output, environment values or executor details.
    return Object.fromEntries(['id', 'appId', 'name', 'kind', 'action', 'state', 'projectName', 'revision', 'createdAt', 'updatedAt', 'events', 'error'].filter(key => job[key] !== undefined).map(key => [key, clone(job[key])]))
  }
  async get(id) { return this.publicJob(await this.rawJob(id)) }
  async list() {
    await this.init()
    const names = await fs.readdir(path.join(this.manager.root, 'deployment-jobs'))
    const jobs = []
    for (const name of names) if (name.endsWith('.json') && UUID.test(name.slice(0, -5))) jobs.push(await this.get(name.slice(0, -5)))
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async inventory() {
    const { apps } = await this.state()
    return Object.values(apps).map(app => ({ id: app.id, name: app.name, kind: app.kind, projectName: app.projectName, managed: true, deployment: true, state: app.state, jobId: app.jobId, revision: app.desiredRevision, currentRevision: app.currentRevision, service: app.service, webPort: app.webPort, webPath: app.webPath, viewer: app.viewer === true, createdAt: app.createdAt, updatedAt: app.updatedAt }))
  }
  /** PRIVATE owner API. The caller must authenticate before exposing this method. */
  async definition(id) {
    check(APP_ID.test(id ?? ''), 'Invalid application id')
    const app = (await this.state()).apps[id]
    check(app, 'Saved deployment not found')
    const saved = await this.manager.read(revisionLeaf(id, app.desiredRevision))
    check(saved, 'Saved deployment revision not found')
    return { ...clone(saved.input), revision: app.desiredRevision, currentRevision: app.currentRevision, projectName: app.projectName, revisions: clone(app.revisions), state: app.state }
  }
  async submit(input) {
    check(object(input), 'Deployment input must be an object')
    // No Compose or Docker commands here. A single owner click durably queues;
    // scheduling run() is the server/CLI's responsibility, never the model's.
    return this.manager.locked(async () => {
      await this.init()
      check(APP_ID.test(input.id ?? ''), 'Invalid application id')
      const state = await this.state(), old = state.apps[input.id]
      if (old?.jobId) check(!ACTIVE.has((await this.rawJob(old.jobId)).state), 'Another deployment for this app is active')
      const action = input.action ?? (old ? 'update' : 'deploy')
      check(['deploy', 'update', 'redeploy', 'rollback'].includes(action), 'Unsupported deployment action')
      check(action === 'deploy' ? !old : !!old, action === 'deploy' ? 'This deployment already exists; use update or redeploy' : 'Saved deployment not found')
      let draft = input
      if (old) {
        let revision = old.desiredRevision
        if (action === 'rollback') {
          check(Number.isSafeInteger(input.revision) && old.revisions.some(item => item.revision === input.revision), 'Unknown rollback revision')
          revision = input.revision
        }
        const saved = await this.manager.read(revisionLeaf(input.id, revision))
        check(saved, 'Saved deployment revision not found')
        draft = action === 'update' ? { ...saved.input, ...input } : saved.input
      } else {
        const registry = await this.manager.registry()
        const existing = await this.manager.read('existing.json', { apps: {} })
        check(!registry.apps[input.id] && !existing.apps[input.id] && !(await this.manager.legacy()).some(app => app.id === input.id), 'Application id already belongs to another application')
      }
      const definition = inputDefinition(draft)
      if (definition.viewer && !definition.env.VNC_PASSWORD) definition.env.VNC_PASSWORD = randomBytes(12).toString('hex')
      if (definition.viewer) definition.env.SCREEN_GEOMETRY ??= '1440x900x24'
      const id = randomUUID(), revision = (old?.revisions.at(-1)?.revision ?? 0) + 1, time = stamp()
      await this.directory(`deployments/${definition.id}/revisions`)
      await this.manager.save(revisionLeaf(definition.id, revision), { version: 1, revision, createdAt: time, input: definition })
      const job = { id, appId: definition.id, name: definition.name, kind: definition.kind, action, state: 'queued', projectName: projectName(definition.id), revision, createdAt: time, updatedAt: time, events: [{ state: 'queued', at: time, message: 'Deployment queued by the owner. Source and environment saved privately.' }] }
      await this.manager.save(jobLeaf(id), job)
      state.apps[definition.id] = { ...old, id: definition.id, name: definition.name, kind: definition.kind, projectName: job.projectName, owner: old?.owner ?? randomUUID(), desiredRevision: revision, jobId: id, state: 'queued', service: definition.service, webPort: definition.webPort, webPath: definition.webPath, viewer: definition.viewer === true, createdAt: old?.createdAt ?? time, updatedAt: time, revisions: [...(old?.revisions ?? []), { revision, action, createdAt: time, jobId: id }] }
      await this.manager.save('deployments.json', state)
      return this.publicJob(job)
    })
  }
  async action(id, action, options = {}) {
    check(['update', 'redeploy', 'rollback'].includes(action), 'Unsupported deployment action')
    return this.submit({ ...options, id, action })
  }
  async event(job, state, message) {
    job.state = state; job.updatedAt = stamp()
    job.events = [...job.events, { state, at: job.updatedAt, message }].slice(-60)
    await this.manager.save(jobLeaf(job.id), job)
  }
  async privateEnv(app, env) {
    // Single quotes suppress dotenv interpolation; escape backslashes and quotes.
    const content = Object.entries(env).map(([key, value]) => `${key}='${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`).join('\n') + '\n'
    const leaf = `deployments/${app.id}/private.env`, dest = path.join(this.manager.root, leaf), temp = `${dest}.${randomUUID()}.tmp`
    const file = await fs.open(temp, 'wx', 0o600)
    try { await file.writeFile(content); await file.sync() } finally { await file.close() }
    await fs.rename(temp, dest)
    const dir = await fs.open(path.dirname(dest), 'r'); try { await dir.sync() } finally { await dir.close() }
    return dest
  }
  async executionEnv(env = {}) {
    const controlled = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME || os.homedir(), ...env, COMPOSE_DISABLE_ENV_FILE: '1' }
    // Transport/plugin settings come only from the operator process, never the
    // submitted app environment. The private plugin is not under HOME/.docker.
    for (const key of ['DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) if (process.env[key]) controlled[key] = process.env[key]
    if (!controlled.DOCKER_CONFIG) {
      const directory = path.join(process.env.DSH_HOME || os.homedir(), 'tools', 'docker')
      try { if ((await fs.stat(path.join(directory, 'cli-plugins', 'docker-compose'))).isFile()) controlled.DOCKER_CONFIG = directory }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error }
    }
    return controlled
  }
  async docker(args, options = {}) {
    return this.manager.docker(args, { ...options, env: await this.executionEnv() })
  }
  async compose(app, revision, env, args, runtime = false) {
    const directory = path.join(this.manager.root, 'deployments', app.id)
    const envFile = await this.privateEnv(app, env)
    const file = path.join(directory, 'revisions', `${revision}.${runtime ? 'runtime' : 'source'}.json`)
    const controlled = await this.executionEnv(env)
    return this.composeCommand(['compose', '--project-name', app.projectName, '--project-directory', directory, '--file', file, '--env-file', envFile, ...args], { cwd: directory, env: controlled, timeout: 600000 })
  }
  async collision(app, source) {
    const result = await this.docker(['ps', '--all', '--no-trunc', '--format', '{"ID":{{json .ID}},"Names":{{json .Names}},"Labels":{{json .Labels}}}'], { timeout: 30000 })
    check(result.code === 0, 'Cannot verify Docker project ownership; check daemon availability')
    let rows
    try { rows = result.stdout.trim() ? result.stdout.trim().split('\n').map(line => JSON.parse(line)) : [] }
    catch { throw new DeploymentError('Cannot verify Docker project ownership: invalid container listing') }
    for (const row of rows) {
      const names = String(row.Names ?? '').split(',')
      const labelText = String(row.Labels ?? '')
      const expected = new Set(Object.keys(source?.services ?? {}).flatMap(service => [`${app.projectName}-${service}-1`, `${app.projectName}_${service}_1`]))
      const candidate = labelText.split(',').includes(`com.docker.compose.project=${app.projectName}`) || names.some(raw => { const name = raw.replace(/^\//, ''); return name === `dsh-app-${app.id}` || name === app.projectName || expected.has(name) })
      if (!candidate) continue
      check(typeof row.ID === 'string' && /^[a-zA-Z0-9_-]+$/.test(row.ID), 'Invalid Docker container identity')
      const inspect = await this.docker(['inspect', row.ID], { timeout: 15000 })
      check(inspect.code === 0, 'Cannot verify ownership of an existing project container')
      let info; try { info = JSON.parse(inspect.stdout)[0] } catch { throw new DeploymentError('Cannot verify existing project container metadata') }
      check(info?.Config?.Labels?.['com.docker.compose.project'] === app.projectName && info.Config.Labels[OWN] === app.owner, 'Docker project/name collision: an existing container is not owned by this deployment')
    }
    // Resources survive `down`, so an empty container list proves nothing about
    // ownership. Check every project-labelled resource plus exact intended names.
    for (const [kind, field] of [['volume', 'volumes'], ['network', 'networks']]) {
      const listed = await this.docker([kind, 'ls', '--format', '{{json .}}'], { timeout: 15000 })
      check(listed.code === 0, `Cannot verify Docker ${kind} ownership`)
      let resources
      try { resources = listed.stdout.trim() ? listed.stdout.trim().split('\n').map(line => JSON.parse(line)) : [] }
      catch { throw new DeploymentError(`Cannot verify Docker ${kind} listing`) }
      const expected = new Set(Object.entries(source?.[field] ?? {}).map(([key, resource]) => resource?.name ?? `${app.projectName}_${key}`))
      for (const row of resources) {
        const name = row.Name ?? row.ID
        check(typeof name === 'string' && /^[a-zA-Z0-9_.-]+$/.test(name), `Invalid Docker ${kind} identity`)
        const inspected = await this.docker([kind, 'inspect', name], { timeout: 15000 })
        check(inspected.code === 0, `Cannot verify Docker ${kind} metadata`)
        let info; try { info = JSON.parse(inspected.stdout)[0] } catch { throw new DeploymentError(`Invalid Docker ${kind} metadata`) }
        const labels = info?.Labels ?? {}
        if (labels['com.docker.compose.project'] !== app.projectName && !expected.has(info?.Name ?? name)) continue
        check(labels['com.docker.compose.project'] === app.projectName && labels[OWN] === app.owner, `Docker ${kind} collision: resource is not owned by this deployment`)
      }
    }
  }
  decorate(source, app, definition) {
    for (const [name, service] of Object.entries(source.services)) {
      const labels = Array.isArray(service.labels) ? Object.fromEntries(service.labels.map(value => { const i = value.indexOf('='); return [value.slice(0, i), value.slice(i + 1)] })) : service.labels ?? {}
      service.labels = { ...labels, 'dsh.apps.managed': '1', 'dsh.apps.id': app.id, [OWN]: app.owner, ...(name === definition.service && definition.webPort ? { 'dsh.apps.web-port': String(definition.webPort), 'dsh.apps.web-path': definition.webPath } : {}) }
      service.restart = definition.autostart ? 'unless-stopped' : 'no'
      // Compose deploy policy otherwise overrides restart:no on local up.
      if (service.deploy) delete service.deploy.restart_policy
      service.cpus ??= service.deploy?.resources?.limits?.cpus ?? 1
      service.mem_limit ??= service.deploy?.resources?.limits?.memory ?? '512m'
      service.pids_limit ??= service.deploy?.resources?.limits?.pids ?? 2048
      // Compose validates legacy/container limits against deploy limits; its
      // omitted deploy.pids defaults to zero, conflicting with our explicit cap.
      if (service.deploy?.resources?.limits) service.deploy.resources.limits.pids ??= service.pids_limit
      service.security_opt = [...new Set([...(service.security_opt ?? []), 'no-new-privileges:true'])]
    }
    // Compose creates the implicit default network even with no top-level map.
    if (Object.values(source.services).some(service => !service.network_mode && !service.networks)) {
      source.networks ??= {}; source.networks.default ??= {}
    }
    for (const field of ['volumes', 'networks']) for (const [name, resource] of Object.entries(source[field] ?? {})) {
      const item = resource ?? {}
      const labels = Array.isArray(item.labels) ? Object.fromEntries(item.labels.map(value => { const at = value.indexOf('='); return [at < 0 ? value : value.slice(0, at), at < 0 ? '' : value.slice(at + 1)] })) : item.labels ?? {}
      source[field][name] = { ...item, labels: { ...labels, 'dsh.apps.id': app.id, [OWN]: app.owner } }
    }
    return source
  }
  async imageVolumes(source, app) {
    for (const [serviceName, service] of Object.entries(source.services)) {
      const image = await this.docker(['image', 'inspect', service.image.replaceAll('$$', '$')], { timeout: 15000 })
      check(image.code === 0, 'Could not inspect pulled service image volume declarations')
      let info; try { info = JSON.parse(image.stdout)[0] } catch { throw new DeploymentError('Invalid image metadata for volume declarations') }
      const targets = Object.keys(info?.Config?.Volumes ?? {})
      const mounted = new Set((service.volumes ?? []).map(volume => typeof volume === 'string' ? volume.split(':')[1].replaceAll('$$', '$') : volume.target?.replaceAll('$$', '$')))
      for (const target of targets) {
        check(target.startsWith('/') && !target.includes('\0') && !target.split('/').includes('..'), 'Invalid image-declared volume target')
        if (mounted.has(target)) continue
        const key = `image-${createHash('sha256').update(`${serviceName}\0${target}`).digest('hex').slice(0, 20)}`
        source.volumes ??= {}
        source.volumes[key] = { name: `${app.projectName}_${key}`, labels: { 'dsh.apps.id': app.id, [OWN]: app.owner } }
        service.volumes ??= []; service.volumes.push({ type: 'volume', source: key, target: literal(target) })
        mounted.add(target)
      }
    }
    return source
  }
  async frontend(app, definition, revision) {
    const result = await this.compose(app, revision, definition.env, ['ps', '--all', '--quiet', definition.service], true)
    check(result.code === 0, 'Could not inspect the frontend service')
    const ids = result.stdout.trim().split(/\s+/).filter(Boolean)
    check(ids.length === 1 && /^[a-zA-Z0-9_-]+$/.test(ids[0]), 'The frontend service must have exactly one container')
    const output = await this.docker(['inspect', ids[0]], { timeout: 15000 })
    check(output.code === 0, 'Could not inspect the frontend container')
    const info = JSON.parse(output.stdout)[0]
    check(info?.Config?.Labels?.[OWN] === app.owner && info.Config.Labels['com.docker.compose.project'] === app.projectName, 'Frontend ownership verification failed')
    return info
  }
  async ready(app, definition, revision) {
    const deadline = Date.now() + (this.manager.readyMs ?? 60000)
    do {
      const info = await this.frontend(app, definition, revision)
      check(!info.State?.Dead && !['exited', 'dead'].includes(info.State?.Status), 'Frontend exited before it became ready; containers and data retained')
      check(info.State?.Health?.Status !== 'unhealthy', 'Frontend health check failed; containers and data retained')
      if (info.State?.Running && (!info.State.Health || info.State.Health.Status === 'healthy')) {
        const ip = Object.values(info.NetworkSettings?.Networks ?? {}).find(network => network.IPAddress)?.IPAddress
        if (!definition.webPort || ip && await this.manager.health(definition, ip)) return info
      }
      if (Date.now() >= deadline) break
      await pause(Math.min(500, Math.max(1, deadline - Date.now())))
    } while (Date.now() <= deadline)
    throw new DeploymentError('Frontend web entry point did not become ready; containers and data retained')
  }
  async run(id) {
    return this.manager.locked(async () => {
      await this.init()
      const job = await this.rawJob(id)
      check(job.state === 'queued', 'Deployment job is not queued; it cannot run twice')
      const state = await this.state(), app = state.apps[job.appId]
      check(app && app.jobId === id, 'Deployment is no longer the current queued job')
      const saved = await this.manager.read(revisionLeaf(app.id, job.revision))
      check(saved, 'Saved deployment source is missing')
      const definition = saved.input
      try {
        await this.event(job, 'validating', 'Checking project ownership and normalizing the saved Compose definition.')
        let source = definition.kind === 'compose' ? composeDocument(definition.compose) : imageDocument(definition)
        source = this.decorate(source, app, definition)
        await this.collision(app, source)
        await this.manager.save(`deployments/${app.id}/revisions/${job.revision}.source.json`, source)
        const config = await this.compose(app, job.revision, definition.env, ['config', '--format', 'json'])
        check(config.code === 0, 'Compose configuration failed; check YAML, required interpolation values and Compose CLI support')
        let normalized
        try { normalized = JSON.parse(config.stdout) } catch { throw new DeploymentError('Compose config did not return valid normalized JSON') }
        validateSource(normalized, true, app.projectName)
        check(Object.hasOwn(normalized.services, definition.service), 'Frontend service is missing after normalization')
        normalized = this.decorate(normalized, app, definition)
        // `compose config --format json` already escapes literal dollars for
        // reparsing as a Compose file. A second literal() pass changes app data.
        await this.manager.save(`deployments/${app.id}/revisions/${job.revision}.runtime.json`, normalized)
        if (definition.localImage) {
          const local = await this.docker(['image', 'inspect', definition.image], { timeout: 15000 })
          check(local.code === 0, 'The local desktop image is missing; build it separately. No public substitute will be pulled')
        } else {
          await this.event(job, 'pulling', 'Pulling prebuilt service images. Builds are disabled.')
          const pulled = await this.compose(app, job.revision, definition.env, ['pull'], true)
          check(pulled.code === 0, 'Compose image pull failed; check registry access and image names')
        }
        normalized = await this.imageVolumes(normalized, app)
        await this.manager.save(`deployments/${app.id}/revisions/${job.revision}.runtime.json`, normalized)
        // Recheck the complete project immediately before an orphan-removing up,
        // including resources which appeared while images were being pulled.
        await this.collision(app, normalized)
        await this.event(job, 'starting', 'Creating or updating this project; named data volumes are retained.')
        const up = await this.compose(app, job.revision, definition.env, ['up', '--detach', '--no-build', '--pull', 'never', '--remove-orphans', ...(job.action === 'redeploy' ? ['--force-recreate'] : [])], true)
        check(up.code === 0, 'Compose startup failed; existing/failed containers and named data volumes are retained')
        if (definition.viewer) {
          const info = await this.frontend(app, definition, job.revision)
          const viewer = await this.docker(['exec', info.Id, 'sh', '-lc', 'for i in $(seq 1 80); do xdpyinfo >/dev/null 2>&1 && exec box-desktop; sleep .25; done; exit 1'], { timeout: 45000 })
          check(viewer.code === 0, 'Desktop viewer did not start; container and home data retained')
        }
        await this.event(job, 'checking', 'Checking frontend container health and web readiness.')
        const info = await this.ready(app, definition, job.revision)
        app.containerId = info.Id; app.currentRevision = job.revision; app.state = 'ready'; app.updatedAt = stamp()
        await this.manager.save('deployments.json', state)
        await this.event(job, 'ready', 'Deployment ready. Source, environment, revision history and named data volumes retained.')
      } catch (error) {
        // Do not log subprocess output or source snippets. Even parser/executor
        // exceptions can embed inline YAML secrets not present in input.env.
        const safe = error instanceof DeploymentError ? error.message : 'Deployment failed during the current step; inspect the private definition and Docker state. Containers and data retained.'
        let message = safe
        for (const value of Object.values(definition.env).filter(Boolean).sort((a, b) => b.length - a.length)) message = message.split(value).join('[REDACTED]')
        job.error = message; app.state = 'failed'; app.updatedAt = stamp()
        await this.manager.save('deployments.json', state)
        await this.event(job, 'failed', message)
      }
      return this.publicJob(job)
    })
  }
  /** On startup only: never silently repeat a partially executed Compose operation. */
  async recover() {
    return this.manager.locked(async () => {
      await this.init()
      const state = await this.state(), recovered = []
      for (const item of await this.list()) {
        if (!ACTIVE.has(item.state) || item.state === 'queued') continue
        const job = await this.rawJob(item.id), app = state.apps[job.appId]
        if (app?.jobId === job.id) { app.state = 'failed'; app.updatedAt = stamp() }
        job.error = 'Deployment worker was interrupted. Existing containers, private source, credentials and data were retained; use redeploy after reviewing Docker state.'
        await this.event(job, 'failed', job.error)
        recovered.push(job.id)
      }
      // A crash can occur between durable job save and project-index save.
      // Fail orphan queued jobs rather than make them appear executable forever.
      for (const item of await this.list()) {
        if (item.state !== 'queued' || state.apps[item.appId]?.jobId === item.id) continue
        const job = await this.rawJob(item.id)
        job.error = 'Deployment queue commit was interrupted; no worker execution was started. Submit the saved source again.'
        await this.event(job, 'failed', job.error)
        recovered.push(job.id)
      }
      await this.manager.save('deployments.json', state)
      return recovered
    })
  }
  async lifecycle(id, action, { deleteData = false } = {}) {
    check(APP_ID.test(id ?? ''), 'Invalid application id')
    check(['start', 'stop', 'restart', 'remove'].includes(action), 'Unsupported project lifecycle action')
    check(typeof deleteData === 'boolean' && (!deleteData || action === 'remove'), 'deleteData is only valid for remove')
    return this.manager.locked(async () => {
      await this.init()
      const state = await this.state(), app = state.apps[id]
      check(app, 'Saved deployment not found; discovered projects must use container lifecycle controls')
      check(!app.jobId || !ACTIVE.has((await this.rawJob(app.jobId)).state), 'Another deployment for this app is active')
      const desiredRuntime = await this.manager.read(`deployments/${id}/revisions/${app.desiredRevision}.runtime.json`)
      const revision = desiredRuntime ? app.desiredRevision : app.currentRevision ?? app.desiredRevision
      const saved = await this.manager.read(revisionLeaf(id, revision))
      check(saved, 'Saved deployment revision not found')
      let runtime = await this.manager.read(`deployments/${id}/revisions/${revision}.runtime.json`)
      check(runtime, 'No normalized runtime definition exists yet; redeploy this project first')
      if (action === 'start') {
        runtime = await this.imageVolumes(runtime, app)
        await this.manager.save(`deployments/${id}/revisions/${revision}.runtime.json`, runtime)
      }
      await this.collision(app, runtime)
      const args = action === 'remove' ? ['down', '--remove-orphans', ...(deleteData ? ['--volumes'] : [])] : action === 'start' ? ['up', '--detach', '--no-build', '--pull', 'never', '--remove-orphans'] : [action]
      const result = await this.compose(app, revision, saved.input.env, args, true)
      check(result.code === 0, 'Compose lifecycle action failed; source and private credentials retained')
      if ((action === 'start' || action === 'restart') && saved.input.viewer) {
        const info = await this.frontend(app, saved.input, revision)
        const viewer = await this.docker(['exec', info.Id, 'sh', '-lc', 'for i in $(seq 1 80); do xdpyinfo >/dev/null 2>&1 && exec box-desktop; sleep .25; done; exit 1'], { timeout: 45000 })
        check(viewer.code === 0, 'Desktop viewer did not restart; data retained')
      }
      app.state = action === 'remove' ? 'removed' : action === 'stop' ? 'stopped' : 'running'; app.updatedAt = stamp()
      await this.manager.save('deployments.json', state)
      return { ok: true, id, action, projectName: app.projectName, state: app.state, dataRetained: !deleteData }
    })
  }
}
