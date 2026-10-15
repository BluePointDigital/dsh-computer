/** One transparent root proxy per durable public port. No per-app ingress recipes. */
import fs from 'node:fs/promises'
import { startHostListener } from './host-listen.js'

export class PortListeners {
  constructor({ config, endpointFor, log = () => {}, tls }) {
    Object.assign(this, { config, endpointFor, log, tls })
    this.listeners = new Map()
    this.apps = []
    this.closed = false
    this.pending = Promise.resolve()
  }
  reconcile(apps) {
    const work = this.pending.then(() => this.reconcileNow(apps))
    this.pending = work.catch(() => {})
    return work
  }
  async reconcileNow(apps) {
    if (this.closed) return apps
    this.apps = apps
    const wanted = new Map(apps.filter(app => app.launch?.mode === 'ports').map(app => [app.launch.port, app]))
    for (const [port, listener] of this.listeners) if (!wanted.has(port) || listener.identity !== wanted.get(port).launch.identity) {
      this.listeners.delete(port)
      await listener.close()
    }
    for (const [port, app] of wanted) {
      if (this.closed) break
      if (this.listeners.has(port)) continue
      try {
        const listener = await startHostListener({
          host: this.config.bind, port, portMode: true, tls: this.tls,
          controlOrigin: this.config.controlOrigin, endpointFor: this.endpointFor, log: this.log,
          // Resolve from this snapshot, not appsJson(): catalog reconciliation
          // must not recursively wait on the request's own catalog refresh.
          hosts: async () => new Map(this.apps.filter(item => item.launch?.mode === 'ports' && item.launch.port === port)
            .map(item => [new URL(item.launch.origin).host, item])),
        })
        if (this.closed) { await listener.close(); break }
        listener.identity = app.launch.identity
        this.listeners.set(port, listener)
        this.log('application port listening on', `${this.config.bind}:${port}`)
      } catch (error) {
        // Never pick a different port on bind failure: durable URLs must stay put.
        this.log('application port unavailable', app.id, port, error.code ?? error.message)
      }
    }
    return apps.map(app => app.launch?.mode === 'ports' && !this.listeners.has(app.launch.port)
      ? { ...app, launch: { mode: 'unavailable', reason: `Application port ${app.launch.port} is unavailable.` } } : app)
  }
  async close() {
    this.closed = true
    await this.pending
    this.apps = []
    const listeners = [...this.listeners.values()]
    this.listeners.clear()
    await Promise.all(listeners.map(listener => listener.close()))
  }
}

export async function portTls(config, env = process.env) {
  const cert = config.appTlsCert ?? env.DSH_APPS_TLS_CERT
  const key = config.appTlsKey ?? env.DSH_APPS_TLS_KEY
  if (!cert && !key) {
    if (new URL(config.controlOrigin ?? env.DSH_APPS_CONTROL_ORIGIN ?? env.DSH_PUBLIC_URL).protocol === 'https:' && config.appTlsTermination !== 'ingress' && env.DSH_APPS_TLS_TERMINATION !== 'ingress') throw Error('HTTPS app ports require appTlsCert/appTlsKey or appTlsTermination: ingress')
    return undefined
  }
  if (!cert || !key) throw Error('Both appTlsCert and appTlsKey are required')
  return { cert: await fs.readFile(cert), key: await fs.readFile(key) }
}
