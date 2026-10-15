#!/usr/bin/env node
/** Supervise independently of DSH. Daily reconciliation; bounded retry on failures. */
import { TlsManager } from '../lib/tls-manager.js'
const manager = new TlsManager()
let stopped = false, timer, wake
const stop = () => { stopped = true; clearTimeout(timer); wake?.() }
process.once('SIGTERM', stop); process.once('SIGINT', stop)
while (!stopped) {
  let delay = 12 * 60 * 60 * 1000
  try {
    const status = await manager.status()
    if (status.configured) {
      if (status.staging) throw Error('Automatic worker refuses staging; use explicit isolated staging CLI')
      const result = await manager.reconcile({ issue: true })
      console.log(JSON.stringify({ event: 'tls-reconciled', phase: result.phase, expires: result.certificate?.expires }))
    } else console.log(JSON.stringify({ event: 'tls-not-configured' }))
  } catch {
    delay = 60 * 60 * 1000
    const status = await manager.status().catch(() => null)
    console.error(JSON.stringify({ event: 'tls-reconcile-failed', phase: status?.phase, error: status?.error, action: 'Inspect private status and Certbot logs; retry in one hour' }))
  }
  if (!stopped) await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, delay) })
}
