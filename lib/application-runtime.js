/** Shared Docker runtime. Display snapshots are never an authority for mutations or routing. */
import { DockerEngine } from './docker-engine.js'
import { Catalog } from './catalog.js'
import { AppManager, APP_ID } from './app-manager.js'
import { ExistingApps } from './existing-apps.js'
import { RuntimeInventory } from './runtime-inventory.js'
import { Deployments } from './deployments.js'
import { AppPorts } from './app-ports.js'
import { describeApps, gatewayConfig } from './app-launch.js'

const CID = /^[a-f0-9]{64}$/
const check = (ok, message) => { if (!ok) throw Error(message) }
const publicError = 'Docker is unavailable; showing last known inventory.'

export function resourceStats(info, previous) {
  const cpu = info.cpu_stats ?? {}, pre = previous?.cpu_stats ?? info.precpu_stats ?? {}
  const delta = (cpu.cpu_usage?.total_usage ?? 0) - (pre.cpu_usage?.total_usage ?? 0)
  const system = (cpu.system_cpu_usage ?? 0) - (pre.system_cpu_usage ?? 0)
  const cores = cpu.online_cpus || cpu.cpu_usage?.percpu_usage?.length || 1
  const memory = info.memory_stats ?? {}, cache = memory.stats?.inactive_file ?? memory.stats?.total_inactive_file ?? memory.stats?.cache ?? 0
  const usage = memory.usage == null ? null : Math.max(0, memory.usage - (cache < memory.usage ? cache : 0))
  const size = bytes => { const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let n = Number(bytes), i = 0; while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ } return `${n.toFixed(i ? 1 : 0)} ${units[i]}` }
  return {
    ID: info.id, Name: String(info.name ?? '').replace(/^\//, ''),
    CPUPerc: system > 0 && delta >= 0 ? `${(delta / system * cores * 100).toFixed(2)}%` : undefined,
    MemUsage: usage === null ? undefined : memory.limit > 0 ? `${size(usage)} / ${size(memory.limit)}` : size(usage),
    MemPerc: usage !== null && memory.limit > 0 ? `${(usage / memory.limit * 100).toFixed(2)}%` : undefined,
  }
}

export class ApplicationRuntime {
  constructor({ manager = new AppManager(), engine, catalog, env = process.env, config, freshMs = 3000, clock = Date.now, deployments } = {}) {
    this.manager = manager
    this.engine = engine ?? manager.engine ?? new DockerEngine({ env })
    manager.engine = this.engine
    // Provisioning/Compose exceptions must select the exact same daemon as runtime HTTP.
    const executor = manager.docker.bind(manager)
    manager.docker = (args, options = {}) => executor(args, { ...options, env: { ...env, ...(options.env ?? {}), DOCKER_HOST: `unix://${this.engine.socketPath ?? '/var/run/docker.sock'}`, DOCKER_CONTEXT: '' } })
    this.catalog = catalog ?? new Catalog({ root: manager.root, env })
    manager.legacy = () => this.catalog.list()
    this.existing = new ExistingApps(manager)
    this.reader = new RuntimeInventory({ engine: this.engine, manager })
    this.deployments = deployments ?? new Deployments({ manager })
    this.config = config; this.env = env; this.clock = clock; this.freshMs = freshMs
    this.snapshot = null; this.loading = null; this.generation = 0; this.closed = false
    this.lastMetadata = new Map(); this.metrics = new Map(); this.metricWork = new Map()
    this.available = true
  }
  invalidate() { this.generation++ }
  async policy() {
    if (this.config !== undefined) return this.config
    const explicit = this.env.DSH_APPS_ACCESS || this.env.DSH_APPS_DOMAIN || this.env.DSH_APPS_CONTROL_ORIGIN
    const saved = await this.manager.read('launch-config.json', {})
    return explicit ? gatewayConfig({}, this.env) : Object.keys(saved).length ? gatewayConfig(saved, {}) : gatewayConfig({}, this.env)
  }
  async metadata(name, work, warnings) {
    try { const value = await work(); this.lastMetadata.set(name, value); return value }
    catch { warnings.push(`Saved ${name} metadata could not be loaded; live Docker discovery remains available.`); return this.lastMetadata.get(name) ?? [] }
  }
  async refresh() {
    check(!this.closed, 'Application runtime is closed')
    if (this.loading) return this.loading
    const generation = this.generation
    this.loading = (async () => {
      const warnings = []
      const infos = await this.reader.snapshot()
      const sources = await Promise.all([
        this.metadata('catalog', () => this.catalog.list(), warnings),
        this.metadata('installed apps', () => this.manager.list(infos), warnings),
        this.metadata('registered apps', () => this.existing.list(infos), warnings),
        this.metadata('deployments', () => this.deployments.inventory(), warnings),
      ])
      const known = sources.flat(), policy = await this.policy()
      const merged = await this.reader.list(known, infos)
      const assigned = await new AppPorts(this.manager).assign(merged, policy)
      const apps = assigned.map(app => {
        try { return describeApps([app], policy)[0] }
        catch { return { ...app, launch: { mode: 'unavailable', reason: 'Invalid application web entry point; edit its web settings.' } } }
      })
      const deployments = await this.metadata('deployment history', () => this.deployments.list(), warnings)
      const snapshot = { at: this.clock(), apps, infos, known, warnings, deployments, generation }
      if (!this.closed && generation === this.generation) {
        this.snapshot = snapshot
        const live = new Set(infos.map(info => info.Id))
        for (const id of this.metrics.keys()) if (!live.has(id)) this.metrics.delete(id)
      }
      this.available = true
      return snapshot
    })().catch(error => { this.available = false; throw error }).finally(() => { this.loading = null })
    return this.loading
  }
  async current({ fresh = false } = {}) {
    check(!this.closed, 'Application runtime is closed')
    if (fresh || !this.snapshot) {
      let snapshot
      for (let attempt = 0; attempt < 3; attempt++) {
        snapshot = await this.refresh()
        if (snapshot.generation === this.generation) return snapshot
      }
      throw Error('Application state changed during refresh; retry')
    }
    if (this.clock() - this.snapshot.at >= this.freshMs || this.snapshot.generation !== this.generation) void this.refresh().catch(() => {})
    return this.snapshot
  }
  async inventory(options = {}) {
    let snapshot
    try { snapshot = await this.current(options) }
    catch (error) {
      if (!this.snapshot) { error.status = 503; throw error }
      snapshot = this.snapshot
    }
    const stale = !this.available || snapshot.generation !== this.generation || this.clock() - snapshot.at >= this.freshMs
    return {
      apps: snapshot.apps, deployments: snapshot.deployments,
      warnings: [...snapshot.warnings, ...(!this.available ? [publicError] : [])],
      inventory: { updatedAt: new Date(snapshot.at || 0).toISOString(), stale, refreshing: Boolean(this.loading), dockerAvailable: this.available },
    }
  }
  /** Refresh metadata membership, then inspect the immutable selected identity again. */
  async resolve(id, containerId, snapshot) {
    check(APP_ID.test(id ?? ''), 'Invalid application id')
    snapshot ??= await this.current({ fresh: true })
    const app = snapshot.apps.find(app => app.id === id)
    check(app, 'Application not found')
    const selected = containerId ?? app.containerId
    check(CID.test(selected ?? ''), 'Choose an application service')
    const service = app.services.find(service => service.containerId === selected)
    check(service, 'Container does not belong to application')
    const info = await this.engine.inspectContainer(selected)
    check(info?.Id === selected, 'Original container is missing')
    const labels = info.Config?.Labels ?? {}
    check(!app.project || labels['com.docker.compose.project'] === app.project, 'Container project identity changed')
    check(!app.owner || labels['dsh.apps.install'] === app.owner && labels['dsh.apps.id'] === id, 'Container ownership changed')
    if (app.deployment) {
      const saved = (await this.deployments.state()).apps[id]
      check(saved && labels['dsh.apps.deployment-owner'] === saved.owner, 'Deployment ownership changed')
    }
    return { app, service, info, containerId: selected }
  }
  /** A targeted fresh check for an already-known gateway identity; never refresh the whole daemon per asset. */
  async endpoint(app) {
    check(!this.closed, 'Application runtime is closed')
    if (!CID.test(app?.containerId ?? '')) return null
    const info = await this.engine.inspectContainer(app.containerId)
    if (!info || info.Id !== app.containerId || !info.State?.Running) return null
    const labels = info.Config?.Labels ?? {}
    if (app.owner && (labels['dsh.apps.install'] !== app.owner || labels['dsh.apps.id'] !== app.id)) return null
    if (app.project && labels['com.docker.compose.project'] !== app.project) return null
    const installed = (await this.manager.registry()).apps[app.id]
    if (installed && !this.manager.owns(info, installed)) return null
    const registered = (await this.existing.registry()).apps[app.id]
    if (registered && registered.containerId !== info.Id) return null
    const setting = (await this.manager.read('runtime-settings.json', { apps: {} })).apps?.[app.id]
    if (setting && (Number(setting.webPort) !== Number(app.web?.containerPort) || setting.webPath !== app.webPath || ![app.webService, info.Name?.replace(/^\//, ''), info.Id].includes(setting.service))) return null
    if (app.deployment) {
      const saved = (await this.deployments.state()).apps[app.id]
      if (!saved || labels['dsh.apps.deployment-owner'] !== saved.owner) return null
    }
    const ip = Object.values(info.NetworkSettings?.Networks ?? {}).find(network => network.IPAddress)?.IPAddress
    const port = Number(app.web?.containerPort)
    return ip && Number.isInteger(port) && port > 0 && port <= 65535 ? { hostAddress: ip, port } : null
  }
  async details(id) {
    check(APP_ID.test(id ?? ''), 'Invalid application id')
    const snapshot = await this.current()
    // Reuse all sanitized details logic without rescanning or issuing Docker requests.
    const reader = new RuntimeInventory({ manager: this.manager })
    reader.list = async () => snapshot.apps
    reader.inspect = async cid => snapshot.infos.find(info => info.Id === cid) ?? null
    return reader.details(id)
  }
  cachedStats(id) { return this.snapshot?.apps.find(app => app.id === id)?.services.flatMap(service => this.metrics.has(service.containerId) ? [this.metrics.get(service.containerId).public] : []) ?? [] }
  async stats(id) {
    check(APP_ID.test(id ?? ''), 'Invalid application id')
    if (this.metricWork.has(id)) return this.metricWork.get(id)
    const work = (async () => {
      const snapshot = await this.current(), app = snapshot.apps.find(app => app.id === id)
      check(app, 'Application not found')
      const services = app.services.filter(service => service.state === 'running')
      let cursor = 0
      await Promise.all(Array.from({ length: Math.min(8, services.length) }, async () => {
        while (cursor < services.length && !this.closed) {
          const service = services[cursor++]
          try {
            const raw = await this.engine.stats(service.containerId)
            const old = this.metrics.get(service.containerId)
            if (!this.closed) this.metrics.set(service.containerId, { raw, public: { ...resourceStats(raw, old?.raw), ID: service.containerId, Name: service.name } })
          } catch { this.metrics.delete(service.containerId) }
        }
      }))
      return services.flatMap(service => this.metrics.has(service.containerId) ? [this.metrics.get(service.containerId).public] : [])
    })().finally(() => this.metricWork.delete(id))
    this.metricWork.set(id, work)
    return work
  }
  async action(id, action, { container, deleteData = false, tail = 80 } = {}) {
    check(['start', 'stop', 'restart', 'remove', 'logs'].includes(action), 'Unknown lifecycle action')
    check(!deleteData || action === 'remove', 'Data deletion is only valid for removal')
    const snapshot = await this.current({ fresh: true }), app = snapshot.apps.find(app => app.id === id)
    check(app, 'Application no longer exists')
    if (action === 'logs') {
      const selected = await this.resolve(id, container)
      const stream = await this.engine.logs(selected.containerId, { follow: false, tail: Math.max(1, Math.min(5000, Number(tail) || 80)), timestamps: true, tty: selected.info.Config?.Tty === true })
      let output = ''; for await (const chunk of stream) { output += chunk; if (output.length > 16000) output = output.slice(-16000) }
      const installed = (await this.manager.registry()).apps[id]
      if (installed?.secretRef) {
        const values = await this.manager.read(`secrets/${installed.secretRef}`, {})
        for (const value of Object.values(values)) if (typeof value === 'string' && value) output = output.split(value).join('[REDACTED]')
      }
      return { ok: true, output }
    }
    if (app.deployment) {
      try { return await this.deployments.lifecycle(id, action, { deleteData }) }
      finally { this.invalidate() }
    }
    const selected = container ? app.services.filter(service => service.containerId === container) : app.services
    check(selected.length, 'No container selected')
    return this.manager.locked(async () => {
      let completed = 0
      try {
        for (const service of selected) {
          const resolved = await this.resolve(id, service.containerId, snapshot)
          const registered = (await this.existing.registry()).apps[id]
          if (registered) check(registered.containerId === resolved.containerId, 'Registered container identity changed')
          const installed = (await this.manager.registry()).apps[id]
          if (installed) check(this.manager.owns(resolved.info, installed), 'Refusing action on an unowned installed container')
          check(!resolved.info.HostConfig?.AutoRemove || action === 'remove', 'This auto-remove container would be deleted when stopped')
          if (action === 'remove') {
            await this.engine.remove(resolved.containerId, { volumes: deleteData, force: true, timeout: 180000 })
          } else {
            await this.engine[action](resolved.containerId, { timeout: 180000 })
            if (['start', 'restart'].includes(action) && app.viewer) {
              const result = await this.engine.exec(resolved.containerId, ['sh', '-lc', 'for i in $(seq 1 80); do xdpyinfo >/dev/null 2>&1 && exec box-desktop; sleep .25; done; exit 1'], { timeout: 45000 })
              check(result.code === 0, 'Container started but desktop viewer did not start')
            }
          }
          completed++
        }
        return { ok: true, completed, output: 'Application action completed.' }
      } catch (error) { throw Error(`${completed ? `${completed} container action(s) completed; ` : ''}${error.message}`) }
      finally { this.invalidate() }
    })
  }
  async close() { this.closed = true; await this.engine.close(); this.snapshot = null; this.lastMetadata.clear(); this.metrics.clear() }
}
