/** Durable app-id → public-port assignments, shared by CLI and server. */
import { APP_ID } from './app-manager.js'

export class AppPorts {
  constructor(manager) { this.manager = manager }
  async assign(apps, config) {
    if (config?.mode !== 'ports') return apps
    const allocate = async (state, save) => {
      if (state.version !== 1 || !state.assignments || typeof state.assignments !== 'object' || Array.isArray(state.assignments)) throw Error('Invalid app port registry')
      const used = new Set()
      for (const [id, port] of Object.entries(state.assignments)) {
        if (!APP_ID.test(id) || !Number.isInteger(port) || port < 1024 || port > 65535 || used.has(port)) throw Error('Invalid or duplicate saved app port')
        used.add(port)
      }
      const control = new URL(config.controlOrigin)
      const controlPort = Number(control.port || (control.protocol === 'https:' ? 443 : 80))
      used.add(controlPort)
      let changed = false
      const result = apps.map(app => {
        if (!app.web || !APP_ID.test(app.id)) return app
        let port = Object.hasOwn(state.assignments, app.id) ? state.assignments[app.id] : undefined
        if (port !== undefined && (port < config.portStart || port > config.portEnd || port === controlPort)) throw Error(`Saved port for ${app.id} is outside the configured app range or conflicts with the harness`)
        if (port === undefined) {
          for (let candidate = config.portStart; candidate <= config.portEnd; candidate++) if (!used.has(candidate)) { port = candidate; break }
          if (port === undefined) return { ...app, appPortError: 'Application port range exhausted; expand appPortEnd' }
          state.assignments[app.id] = port; used.add(port); changed = true
        }
        return { ...app, appPort: port }
      })
      // Never recycle an absent app's port automatically. Stops, reinstalls and
      // catalog ordering must not change links or route an old link to another app.
      if (changed && save) await this.manager.save('ports.json', state)
      return { result, changed }
    }
    const snapshot = await this.manager.read('ports.json', { version: 1, assignments: {} })
    const preview = await allocate(structuredClone(snapshot), false)
    if (!preview.changed) return preview.result
    return this.manager.locked(async () => {
      const fresh = await this.manager.read('ports.json', { version: 1, assignments: {} })
      return (await allocate(fresh, true)).result
    }, 'ports.lock')
  }
}
