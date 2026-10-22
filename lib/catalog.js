/** Direct, read-only catalog metadata. Reading never inspects or starts Docker. */
import fs from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { durableCatalog } from './catalog-state.mjs'
import { appStateRoot } from './app-manager.js'

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const SOCKET = /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/
const PREFIX = /^\/(?:[A-Za-z0-9_-]+\/)+$/
const ENTRY = /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]*\/?$/
const check = (ok, message) => { if (!ok) throw new Error(message) }
const trim = value => value.trim().replace(/^"|"$/g, '')
const present = value => value !== undefined && value !== ''

/** The historical flat dialect: # always starts a comment; values are strings.
 * Do not upgrade this to implicit YAML types: yes/no, numeric IDs, commands and
 * host:container port pairs must retain their existing spelling and meaning.
 */
function parseFlat(text) {
  const apps = []
  let inApps = false, current
  for (const [index, raw] of text.split('\n').entries()) {
    const line = trim(raw.replace(/\r$/, '').replace(/#.*/, ''))
    if (!line) continue
    const fail = message => { throw new Error(`Catalog line ${index + 1}: ${message}`) }
    if (line === 'apps:') {
      if (inApps) fail('duplicate apps section')
      inApps = true
      continue
    }
    if (!inApps) {
      if (/^[A-Za-z_][A-Za-z0-9_]*:/.test(line)) continue
      fail('unexpected content before apps:')
    }
    const item = line.startsWith('-')
    const content = item ? trim(line.slice(1)) : line
    const colon = content.indexOf(':')
    if (colon < 1) fail('expected flat key: value')
    const key = trim(content.slice(0, colon)), value = trim(content.slice(colon + 1))
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) fail('invalid field name')
    if (/[\u0000-\u001f\u007f]/.test(value)) fail('control character in value')
    if (item) {
      if (key !== 'id' || !value) fail('entry must begin with id')
      current = Object.create(null)
      apps.push(current)
    }
    if (!current) fail('key outside an entry')
    if (Object.hasOwn(current, key)) fail(`duplicate field ${key}`)
    // Every value is inert text, including YAML-looking punctuation. Never
    // expand tags, aliases, objects or commands from this historical dialect.
    current[key] = value
  }
  check(inApps && apps.length > 0, 'Catalog defines no apps')
  return apps
}

function port(value, field, id) {
  check(/^\d+$/.test(String(value)) && Number(value) >= 1 && Number(value) <= 65535, `app '${id}': invalid ${field} port`)
  return String(Number(value))
}
function mapping(value, fallback, field, id) {
  if (!present(value)) return null
  const parts = String(value).split(':')
  check(parts.length <= 2, `app '${id}': ${field} must be hostPort:containerPort`)
  return { hostPort: port(parts[0], field, id), containerPort: port(parts[1] ?? fallback, field, id) }
}
function paths(value, pattern, field, id) {
  const result = present(value) ? value.split(/\s+/) : []
  for (const item of result) check(pattern.test(item), `app '${id}': ${field} entries must be canonical absolute paths${field === 'webRewrite' ? ' ending in /' : ' without a trailing /'}`)
  return [...new Set(result)]
}
function hostname(value, id) {
  const host = value.toLowerCase().replace(/\.$/, '')
  check(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(host), `app '${id}': webHost must be a bare hostname (no scheme, port or path)`)
  return host
}
function validate(definitions) {
  const ids = new Set(), hosts = new Set()
  for (const app of definitions) {
    const { id } = app
    check(ID.test(id), `Malformed app id '${id}'`)
    check(!ids.has(id), `Duplicate app id '${id}'`)
    ids.add(id)
    check(!present(app.autostart) || ['true', 'yes', '1', 'false', 'no', '0'].includes(app.autostart), `app '${id}': autostart must be true or false`)
    check(!present(app.webMode) || ['proxy', 'direct'].includes(app.webMode), `app '${id}': webMode must be proxy or direct`)
    paths(app.webSockets, SOCKET, 'webSockets', id)
    paths(app.webRewrite, PREFIX, 'webRewrite', id)
    const viewer = mapping(app.viewer, 6080, 'viewer', id), web = mapping(app.web, 80, 'web', id)
    if (viewer && web) check(viewer.hostPort !== web.hostPort || viewer.containerPort === web.containerPort, `app '${id}': viewer and web share host port ${web.hostPort} but disagree on container port`)
    if (present(app.webPort)) port(app.webPort, 'webPort', id)
    if (present(app.webPath)) check(ENTRY.test(app.webPath) && !app.webPath.split('/').some(part => part === '.' || part === '..'), `app '${id}': invalid webPath`)
    if (present(app.webHost)) {
      check(web, `app '${id}': webHost requires a web mapping`)
      const host = hostname(app.webHost, id)
      check(!hosts.has(host), `webHost '${host}' is claimed by more than one app`)
      hosts.add(host)
    }
  }
  return definitions
}

function metadata(definition, env) {
  // Unknown flat metadata survives, but execution/private configuration never
  // crosses the public boundary, even though it remains in readDefinitions().
  const app = Object.fromEntries(Object.entries(definition).filter(([key]) => !/^(?:command|env|environment|config|hostconfig|labels|owner|containerId|containerName|managed|existing|project|projectName|deployment|services|aliases|launch|appPort|appPortError|webCandidates|webService|infrastructure)$|password|secret|token|credential/i.test(key)))
  const { id } = definition
  const viewer = mapping(definition.viewer, 6080, 'viewer', id)
  const web = mapping(definition.web, 80, 'web', id) || viewer
  const bind = env.COMPUTER_BIND_IP || networkInterfaces().tailscale0?.find(item => item.family === 'IPv4')?.address || '127.0.0.1'
  const host = bind.includes(':') && !bind.startsWith('[') ? `[${bind}]` : bind
  Object.assign(app, { name: definition.name || id, description: definition.description || '', image: definition.image || '', state: 'new', source: 'catalog', autostart: ['true', 'yes', '1'].includes(definition.autostart), webPath: definition.webPath || '/' })
  delete app.viewer
  delete app.web
  delete app.webSockets
  delete app.webRewrite
  const sockets = paths(definition.webSockets, SOCKET, 'webSockets', id)
  if (!sockets.length && viewer) sockets.push('/websockify')
  if (sockets.length) app.webSockets = sockets
  const rewrite = paths(definition.webRewrite, PREFIX, 'webRewrite', id)
  if (rewrite.length) app.webRewrite = rewrite
  if (viewer) {
    const base = env.COMPUTER_PUBLIC_URL ? env.COMPUTER_PUBLIC_URL.replace(/\/$/, '') : `http://${host}:${viewer.hostPort}`
    app.viewer = { hostPort: viewer.hostPort, url: `${base}/vnc.html?autoconnect=1&resize=scale` }
  }
  if (web) {
    app.webPort = Number(web.containerPort)
    app.web = { ...web, path: `/apps/web/${id}${app.webPath}`, mode: definition.webMode || 'proxy', url: definition.web ? `http://${host}:${web.hostPort}/` : app.viewer.url }
    if (present(definition.webHost)) app.web.webHost = definition.webHost
  } else if (present(definition.webPort)) app.webPort = Number(definition.webPort)
  return app
}

export class Catalog {
  constructor({ root, env = process.env } = {}) { this.root = root; this.env = env; this.cached = null }
  async readDefinitions() {
    const explicit = this.env.COMPUTER_APPS_FILE || null
    const file = await durableCatalog({ root: this.root || (explicit ? undefined : appStateRoot(this.env)), explicit })
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await fs.stat(file)
      check(before.isFile(), 'Catalog must be a regular file')
      const version = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
      const stamp = version(before)
      if (this.cached?.file === file && this.cached.version === stamp) return structuredClone(this.cached.definitions)
      this.cached = null
      const text = await fs.readFile(file, 'utf8')
      if (version(await fs.stat(file)) !== stamp) continue
      const definitions = validate(parseFlat(text))
      this.cached = { file, version: stamp, definitions }
      return structuredClone(definitions)
    }
    throw new Error('Catalog changed while being read; retry')
  }
  async list() { return (await this.readDefinitions()).map(app => metadata(app, this.env)) }
}

export async function readCatalog(options = {}) { return new Catalog(options).list() }
export async function readDefinitions(options = {}) { return new Catalog(options).readDefinitions() }
