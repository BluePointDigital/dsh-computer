#!/usr/bin/env node
/** Operator CLI. Secrets enter on stdin, never argv or public output. */
import { TlsManager } from '../lib/tls-manager.js'
import { AcmeDns, waitForTxt } from '../lib/tls-services.js'
import { check } from '../lib/tls-config.js'
const [command = 'status', ...args] = process.argv.slice(2)
try {
  if (command === 'auth-hook') {
    check(process.env.DSH_TLS_HOOK === '1' && args.length === 1, 'Authentication hook is Certbot-only')
    const manager = new TlsManager({ root: args[0] }), state = await manager.read()
    check(state?.account, 'Missing validation registration')
    check([state.config.domain, `*.${state.config.domain}`].includes(process.env.CERTBOT_DOMAIN), 'Unexpected certificate namespace')
    const value = process.env.CERTBOT_VALIDATION
    await new AcmeDns(state.config.acmeDns).update(state.account, value)
    await waitForTxt(state.config, state.account, value)
  } else {
    const manager = new TlsManager()
    let result
    if (command === 'setup') {
      let text = ''
      for await (const chunk of process.stdin) { text += chunk; check(text.length <= 16384, 'TLS configuration exceeds 16 KiB') }
      let input
      try { input = JSON.parse(text) } catch { throw Error('Invalid TLS configuration JSON; private input suppressed') }
      result = await manager.setup(input)
    } else if (command === 'status') result = await manager.status()
    else if (command === 'check') result = await manager.check()
    else if (command === 'activate' || command === 'renew') result = await manager.reconcile({ issue: true, deployStaging: args.includes('--isolated-staging-ingress') })
    else if (command === 'deploy') result = await manager.reconcile({ deployStaging: args.includes('--isolated-staging-ingress') })
    else throw Error('Usage: node bin/tls-cli.mjs setup|status|check|activate|renew|deploy [--isolated-staging-ingress]')
    console.log(JSON.stringify({ ok: true, tls: result }))
  }
} catch (error) {
  // Never serialize cause/stack or external API bodies.
  console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1
}
