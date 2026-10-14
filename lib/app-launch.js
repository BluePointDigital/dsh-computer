/** Instance-wide launch policy shared by the host and CLI. No per-app proxy recipes. */
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { normalizeHost } from './host-router.js'

export const LAUNCH_PATH = '/__dsh_apps/launch'
export const SESSION_PATH = '/__dsh_apps/session'
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const check = (ok, message) => { if (!ok) throw new Error(message) }

export function gatewayConfig(config = {}, env = process.env) {
  const domain = config.appDomain ?? env.DSH_APPS_DOMAIN
  if (!domain) return null // Existing installations stay explicitly in legacy mode.
  check(typeof domain === 'string' && normalizeHost(domain) === domain && !isIP(domain) && domain.includes('.') && domain.length <= 190, 'appDomain must be a lowercase DNS suffix, without a scheme, port or trailing dot')
  const control = new URL(config.controlOrigin ?? env.DSH_APPS_CONTROL_ORIGIN ?? '')
  check(control.protocol === 'https:' && control.origin === (config.controlOrigin ?? env.DSH_APPS_CONTROL_ORIGIN), 'controlOrigin must be an exact HTTPS origin')
  // Standard layout: the harness is the suffix apex; apps are its children.
  // Do not place the control host inside the app wildcard's routing namespace.
  check(!control.hostname.endsWith('.' + domain), 'The harness hostname must not be beneath the application domain')
  const publicPort = Number(config.appPublicPort ?? env.DSH_APPS_PUBLIC_PORT ?? 443)
  const port = Number(config.appListenPort ?? env.DSH_APPS_HOST_PORT ?? 3099)
  check(Number.isInteger(publicPort) && publicPort > 0 && publicPort <= 65535, 'appPublicPort must be a port')
  check(Number.isInteger(port) && port >= 0 && port <= 65535, 'appListenPort must be a port (0 is allowed for tests)')
  const peers = config.appIngressPeers ?? (env.DSH_APPS_INGRESS_PEERS ?? '127.0.0.1,::1').split(',')
  check(Array.isArray(peers) && peers.length > 0 && peers.every(p => typeof p === 'string' && isIP(p)), 'appIngressPeers must contain exact private ingress IP addresses')
  return Object.freeze({ domain, controlOrigin: control.origin, publicPort, port, bind: config.appListenHost ?? env.DSH_APPS_HOST_BIND ?? '127.0.0.1', peers })
}

export function appIdentity(app) {
  // New installation or imported/legacy container = new origin. Never reuse an
  // old origin's service workers/storage for a different trust identity.
  const identity = app.containerId ? `container:${app.containerId};install:${app.owner ?? ''}` : null
  return identity && createHash('sha256').update(`${app.id}\0${identity}`).digest('hex').slice(0, 20)
}

export function launchDescriptor(app, config) {
  if (!app.web) return null
  if (!config) return { mode: 'legacy', path: app.web.path }
  const identity = appIdentity(app)
  if (!ID.test(app.id) || !identity) return { mode: 'unavailable', reason: 'Launch requires an installed or registered container identity.' }
  const port = Number(app.web.containerPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { mode: 'unavailable', reason: 'Invalid application port.' }
  const host = `${app.id}-${identity}.${config.domain}`
  const origin = `https://${host}${config.publicPort === 443 ? '' : ':' + config.publicPort}`
  const mount = `/apps/web/${app.id}`
  const path = app.webPath ?? (app.web.path?.startsWith(mount + '/') ? app.web.path.slice(mount.length) : '/')
  check(typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !/[\\\u0000-\u0020\u007f]/.test(path), 'Invalid application entry path')
  const entry = new URL(path, origin)
  check(entry.origin === origin && !entry.pathname.startsWith('/__dsh_apps/'), 'Invalid or reserved application entry path')
  if (app.viewer) {
    if (entry.pathname.endsWith('/')) entry.pathname += 'vnc.html'
    for (const [key, value] of Object.entries({ autoconnect: '1', resize: 'scale', encrypt: '1', host, port: String(config.publicPort), path: 'websockify' })) entry.searchParams.set(key, value)
    // Password is delivered only in the authenticated launch exchange, not the descriptor.
  }
  return { mode: 'isolated', origin, host, identity, entryPath: entry.pathname + entry.search, openPath: `/apps/api/open?id=${encodeURIComponent(app.id)}` }
}

export function describeApps(apps, config) {
  const ids = new Set()
  return apps.map(app => {
    check(!ids.has(app.id), `Duplicate catalog/managed application id: ${app.id}`)
    ids.add(app.id)
    return { ...app, launch: launchDescriptor(app, config) }
  })
}
