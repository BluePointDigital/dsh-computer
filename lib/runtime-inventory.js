/** Read-only inventory of the nested Docker daemon. Discovery never implies ownership. */
import { createHash } from 'node:crypto'
import { APP_ID, dockerCommand } from './app-manager.js'

const CID = /^[a-f0-9]{64}$/
const PROJECT = 'com.docker.compose.project'
const SERVICE = 'com.docker.compose.service'
const check = (ok, message) => { if (!ok) throw new Error(message) }
const containerName = (info) => String(info.Name || '').replace(/^\//, '') || info.Id
const portNumber = (value) => /^\d+$/.test(String(value ?? '')) && Number(value) > 0 && Number(value) <= 65535 ? Number(value) : null
const webPath = (value) => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\\\u0000-\u0020]/.test(value) ? value : '/'
const labels = (info) => info.Config?.Labels ?? {}
const sorted = (items) => [...items].sort((a, b) => a.localeCompare(b))

function ports(info) {
  return [...new Set([
    ...Object.keys(info.Config?.ExposedPorts ?? {}),
    ...Object.keys(info.HostConfig?.PortBindings ?? {}),
    ...Object.keys(info.NetworkSettings?.Ports ?? {}),
  ].filter((key) => key.endsWith('/tcp')).map((key) => portNumber(key.split('/')[0])).filter(Boolean))].sort((a, b) => a - b)
}
function mounts(info) {
  return (info.Mounts ?? []).map((mount) => ({
    type: mount.Type ?? '', name: mount.Name ?? '', source: mount.Source ?? '',
    target: mount.Destination ?? '', readOnly: mount.RW === false, propagation: mount.Propagation ?? '',
  }))
}
function serviceSummary(info) {
  const state = info.State ?? {}
  return {
    containerId: info.Id, name: containerName(info), service: labels(info)[SERVICE] || containerName(info),
    image: info.Config?.Image ?? '', imageId: info.Image ?? '',
    state: state.Status || (state.Dead ? 'dead' : state.Restarting ? 'restarting' : state.Paused ? 'paused' : state.Running ? 'running' : 'stopped'),
    health: state.Health?.Status || 'none', ports: ports(info), mounts: mounts(info),
  }
}
function aggregate(services, field) {
  const values = new Set(services.map((service) => service[field]))
  if (values.size === 1) return [...values][0]
  const priority = field === 'health' ? ['unhealthy', 'starting'] : ['dead', 'restarting', 'removing']
  return priority.find((value) => values.has(value)) || (field === 'health' ? 'none' : 'partial')
}
function generatedId(kind, name, attempt = 0) {
  const prefix = kind === 'compose' ? 'stack' : 'docker'
  const hash = createHash('sha256').update(`${kind}\0${name}\0${attempt}`).digest('hex').slice(0, 10)
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app'
  return `${prefix}-${slug.slice(0, 32 - prefix.length - hash.length - 2).replace(/-+$/, '')}-${hash}`
}
function infrastructure(info) {
  const name = containerName(info).toLowerCase(), image = String(info.Config?.Image ?? '').toLowerCase()
  return /^dsh-computer(?:-|$)/.test(name) || /^portainer(?:[-_.]|$)/.test(name) || /(?:^|\/)portainer(?:-ce|-ee)?(?:[:@]|$)/.test(image)
}
// Known entries normally already come from public catalogs. Still refuse accidental
// raw environment/config blobs here; endpoint metadata must never become a secret store.
function publicKnown(app) {
  const { env, Env, environment, Config, HostConfig, command, labels, owner, ...rest } = app
  return { ...rest, ...(app.managed === true && owner ? { owner } : {}) }
}
function configSummary(info) {
  const config = info.Config ?? {}, host = info.HostConfig ?? {}
  return {
    config: {
      image: config.Image ?? '', imageId: info.Image ?? '', hostname: config.Hostname ?? '',
      user: config.User ?? '', workingDir: config.WorkingDir ?? '',
      environmentKeys: sorted([...new Set((config.Env ?? []).map((entry) => String(entry).split('=', 1)[0]))]),
      exposedPorts: ports(info),
    },
    permissions: {
      privileged: host.Privileged === true, readOnlyRootfs: host.ReadonlyRootfs === true,
      networkMode: host.NetworkMode ?? 'default', usernsMode: host.UsernsMode ?? '',
      pidMode: host.PidMode ?? '', ipcMode: host.IpcMode ?? '',
      addedCapabilities: host.CapAdd ?? [], droppedCapabilities: host.CapDrop ?? [],
      securityOptions: host.SecurityOpt ?? [], devices: (host.Devices ?? []).map((device) => ({
        source: device.PathOnHost ?? '', target: device.PathInContainer ?? '', permissions: device.CgroupPermissions ?? '',
      })), autoRemove: host.AutoRemove === true,
    },
    mounts: mounts(info),
    networks: Object.entries(info.NetworkSettings?.Networks ?? {}).map(([name, network]) => ({
      name, networkId: network.NetworkID ?? '', ipAddress: network.IPAddress ?? '',
      gateway: network.Gateway ?? '', globalIPv6Address: network.GlobalIPv6Address ?? '',
      aliases: network.Aliases ?? [],
    })).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

export class RuntimeInventory {
  constructor({ docker = dockerCommand, engine, manager } = {}) { this.docker = docker; this.engine = engine; this.manager = manager }

  /** Raw inspection is private server-side data. Require the immutable full ID. */
  async inspect(containerId) {
    check(typeof containerId === 'string' && CID.test(containerId), 'Expected immutable container identity')
    if (this.engine) {
      const info = await this.engine.inspectContainer(containerId)
      check(!info || info.Id === containerId, 'Container identity changed')
      return info
    }
    const out = await this.docker(['inspect', containerId], { timeout: 10000 })
    if (out.code) {
      if (/No such (object|container)/i.test(out.stderr ?? '')) return null
      throw new Error('Docker inspection unavailable; container absence is not proven')
    }
    let data
    try { data = JSON.parse(out.stdout) } catch { throw new Error('Invalid Docker inspection response') }
    check(Array.isArray(data) && data.length === 1 && data[0]?.Id === containerId, 'Container identity changed')
    return data[0]
  }

  async snapshot() {
    if (this.engine) {
      const listed = await this.engine.listContainers()
      check(Array.isArray(listed) && listed.every(info => CID.test(info.Id)), 'Invalid Docker container identities')
      const ids = [...new Set(listed.map(info => info.Id))], result = []
      let cursor = 0, failure
      await Promise.all(Array.from({ length: Math.min(8, ids.length) }, async () => {
        while (!failure && cursor < ids.length) {
          const id = ids[cursor++]
          try { const info = await this.inspect(id); if (info) result.push(info) }
          catch (error) { failure ??= error }
        }
      }))
      if (failure) throw failure
      return result.sort((a, b) => a.Id.localeCompare(b.Id))
    }
    const out = await this.docker(['ps', '-aq', '--no-trunc'], { timeout: 10000 })
    check(out.code === 0, 'Docker discovery unavailable')
    const ids = [...new Set(out.stdout.trim().split(/\s+/).filter(Boolean))]
    check(ids.every((id) => CID.test(id)), 'Invalid Docker container identities')
    const result = []
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100)
      const inspected = await this.docker(['inspect', ...batch], { timeout: 10000 })
      // A container may disappear between ps and inspect. Docker returns the other
      // inspections even with exit 1. Never mistake a daemon failure for an empty list.
      check(inspected.code === 0 || /No such (object|container)/i.test(inspected.stderr ?? ''), 'Docker inventory inspection unavailable')
      let data
      try { data = inspected.stdout?.trim() ? JSON.parse(inspected.stdout) : [] } catch { throw new Error('Invalid Docker inspection response') }
      check(Array.isArray(data) && data.every((info) => batch.includes(info?.Id)), 'Container identity changed during inventory')
      check(new Set(data.map((info) => info.Id)).size === data.length, 'Duplicate Docker container identity')
      if (inspected.code === 0) check(data.length === batch.length, 'Incomplete Docker inspection response')
      result.push(...data)
    }
    return result
  }

  async list(known = [], snapshot) {
    const infos = snapshot ?? await this.snapshot()
    const settings = this.manager ? await this.manager.read('runtime-settings.json', { apps: {} }) : { apps: {} }
    const entries = known.filter((app) => app && APP_ID.test(app.id))
    const groups = new Map(), claimed = new Set(), reserved = new Set(entries.map((app) => app.id))
    for (const info of infos) {
      const project = labels(info)[PROJECT]
      const key = project ? `compose:${project}` : `container:${info.Id}`
      if (!groups.has(key)) groups.set(key, { project, infos: [] })
      groups.get(key).infos.push(info)
    }
    const apps = []
    for (const [, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      group.infos.sort((a, b) => (labels(a)[SERVICE] || containerName(a)).localeCompare(labels(b)[SERVICE] || containerName(b)) || a.Id.localeCompare(b.Id))
      const matches = entries.filter((app) => !claimed.has(app.id) && ((group.project && (app.project === group.project || app.projectName === group.project)) || group.infos.some((info) =>
        app.containerId === info.Id || (!app.existing && !infos.some((candidate) => candidate.Id === app.containerId) && containerName(info) === `dsh-app-${app.id}`))))
        .sort((a, b) => Number(b.managed === true) - Number(a.managed === true) || Number(group.infos.some((info) => info.Id === b.containerId)) - Number(group.infos.some((info) => info.Id === a.containerId)) || a.id.localeCompare(b.id))
      const knownApp = matches[0]
      matches.forEach((app) => claimed.add(app.id))
      const kind = group.project ? 'compose' : 'container', name = group.project || containerName(group.infos[0])
      let id = knownApp?.id
      if (!id) {
        let attempt = 0
        do { id = generatedId(kind, name, attempt++) } while (reserved.has(id))
        reserved.add(id)
      }
      const services = group.infos.map(serviceSummary)
      const app = {
        ...(knownApp ? publicKnown(knownApp) : {}), id, name: knownApp?.name || name,
        source: group.project ? 'compose' : knownApp?.managed ? 'managed' : knownApp?.source || 'container',
        managed: knownApp?.managed === true, state: aggregate(services, 'state'), health: aggregate(services, 'health'),
        services, ...(group.project ? { project: group.project } : {}), infrastructure: group.infos.some(infrastructure),
      }
      delete app.containerId
      delete app.web
      const candidates = services.flatMap((service) => service.ports.map((port) => ({
        service: service.service, name: service.name, containerId: service.containerId, port, webPort: port,
      })))
      app.webCandidates = candidates
      const setting = settings?.apps?.[id]
      let selected, port, entryPath = '/'
      if (setting) {
        const matching = services.filter((service) => service.service === setting.service || service.name === setting.service || service.containerId === setting.service)
        if (matching.length === 1 && portNumber(setting.webPort)) {
          selected = matching[0]; port = portNumber(setting.webPort); entryPath = webPath(setting.webPath)
        } else app.endpointError = 'Configured web service or port is unavailable'
      } else if (knownApp?.web && portNumber(knownApp.web.containerPort)) {
        selected = services.find((service) => service.containerId === knownApp.containerId) || services.find((service) => service.name === `dsh-app-${knownApp.id}`)
        if (selected) { port = portNumber(knownApp.web.containerPort); app.web = { ...knownApp.web } }
      } else if (knownApp && portNumber(knownApp.webPort)) {
        selected = services.find((service) => service.containerId === knownApp.containerId) || services.find((service) => service.service === knownApp.service) || services.find((service) => service.name === `dsh-app-${knownApp.id}`)
        if (selected) { port = portNumber(knownApp.webPort); entryPath = webPath(knownApp.webPath) }
      } else {
        const explicit = group.infos.filter((info) => portNumber(labels(info)['dsh.apps.web-port']))
        if (explicit.length === 1) {
          selected = services.find((service) => service.containerId === explicit[0].Id)
          port = portNumber(labels(explicit[0])['dsh.apps.web-port']); entryPath = webPath(labels(explicit[0])['dsh.apps.web-path'])
        } else if (!explicit.length && candidates.length === 1) {
          selected = services.find((service) => service.containerId === candidates[0].containerId); port = candidates[0].port
        }
      }
      if (selected && port) {
        app.containerId = selected.containerId
        const selectedInfo = group.infos.find(info => info.Id === selected.containerId)
        if (app.owner && labels(selectedInfo)['dsh.apps.install'] !== app.owner) { delete app.owner; app.managed = false }
        app.webPath = setting ? entryPath : knownApp?.webPath ?? (app.web?.path?.startsWith(`/apps/web/${id}/`) ? app.web.path.slice(`/apps/web/${id}`.length) : entryPath)
        app.web ??= { containerPort: String(port), path: `/apps/web/${id}${entryPath}`, mode: 'proxy' }
        app.webService = selected.service
        if (app.viewer) {
          const password = (selectedInfo.Config?.Env ?? []).find(value => value.startsWith('VNC_PASSWORD='))?.slice('VNC_PASSWORD='.length)
          app.viewer = { ...(typeof app.viewer === 'object' ? app.viewer : {}), ...(password ? { password } : {}) }
        }
      } else if (services.length === 1) app.containerId = services[0].containerId
      // Multiple known records for one project are aliases, not duplicate UI apps.
      if (matches.length > 1) app.aliases = matches.slice(1).map((entry) => entry.id)
      apps.push(app)
    }
    const seen = new Set(apps.map((app) => app.id))
    for (const entry of entries) {
      if (claimed.has(entry.id) || seen.has(entry.id)) continue
      const app = { ...publicKnown(entry), services: [], state: entry.deployment ? entry.state : entry.state === 'new' ? 'new' : 'missing', health: 'none', source: entry.source || (entry.managed ? 'managed' : 'catalog'), infrastructure: entry.infrastructure === true, webCandidates: [] }
      delete app.containerId
      delete app.web
      apps.push(app); seen.add(entry.id)
    }
    return apps.sort((a, b) => a.id.localeCompare(b.id))
  }

  /** Resolve only members of the current app; never use a reusable container name. */
  async resolve(id, containerId, known = []) {
    if (Array.isArray(containerId)) { known = containerId; containerId = undefined }
    check(typeof id === 'string' && APP_ID.test(id), 'Invalid application id')
    const app = (await this.list(known)).find((entry) => entry.id === id)
    check(app, 'Application not found')
    const selected = containerId ?? app.containerId
    const service = app.services.find((entry) => entry.containerId === selected)
    check(service, 'Container does not belong to application or no service was selected')
    const info = await this.inspect(service.containerId)
    check(info, 'Original container is missing')
    check(!app.project || labels(info)[PROJECT] === app.project, 'Container project identity changed')
    return { app, service, info, containerId: service.containerId }
  }

  async details(id, known = []) {
    check(typeof id === 'string' && APP_ID.test(id), 'Invalid application id')
    const app = (await this.list(known)).find((entry) => entry.id === id)
    check(app, 'Application not found')
    const services = []
    for (const service of app.services) {
      const info = await this.inspect(service.containerId)
      services.push(info ? { ...service, ...configSummary(info) } : { ...service, state: 'missing' })
    }
    const selected = services.find((service) => service.containerId === app.containerId)
    return { ...app, services, ...(selected?.config ? { config: selected.config } : {}) }
  }
}
