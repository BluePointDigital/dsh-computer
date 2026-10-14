/**
 * End-to-end host mounting, against a REAL app. Run: node test/host-mount-live.mjs
 *
 * The unit tests prove the router's decisions. This proves the claim that made
 * the feature worth building: that an app which cannot work under a path mount —
 * because it computes its own URLs at runtime — works unmodified when it owns a
 * hostname, with NO base-URL configuration and NO rewriting.
 *
 * The discriminating assertion is the login POST. File Browser built its request
 * from a server-injected `BaseURL`; under the path mount that value is empty and
 * the request goes to the harness root, which answers `{"ok":false,"error":"not
 * found"}`. Here the app receives `/api/login` at its own root and answers with
 * its own 403 (bad credentials). A 403 is the proof: it is File Browser talking,
 * not the harness.
 *
 * Skips — loudly — when no such app is running, rather than passing vacuously.
 */
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { indexHostApps } from '../lib/host-router.js'
import { startHostListener } from '../lib/host-listen.js'

const APP_ID = process.env.HOST_MOUNT_APP ?? 'filebrowser'
const HOST = process.env.HOST_MOUNT_NAME ?? 'filebrowser.test.invalid'

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 15_000 })
}

function containerIp(name) {
  const raw = docker(['inspect', '-f', '{{json .NetworkSettings.Networks}}', name])
  const networks = JSON.parse(raw)
  return Object.values(networks).find((n) => n.IPAddress)?.IPAddress ?? ''
}

function request(port, { host, path, method = 'GET', body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { host, ...headers } },
      (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
      },
    )
    req.on('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

async function main() {
  let ip = ''
  try {
    ip = containerIp(`dsh-app-${APP_ID}`)
  } catch {
    console.log(`SKIPPED — no container 'dsh-app-${APP_ID}'`)
    process.exit(0)
  }
  if (ip === '') {
    console.log(`SKIPPED — 'dsh-app-${APP_ID}' has no bridge address (not running?)`)
    process.exit(0)
  }

  const containerPort = Number(process.env.HOST_MOUNT_PORT ?? 80)
  const apps = [{ id: APP_ID, web: { webHost: HOST, containerPort } }]
  const { byHost, problems } = indexHostApps(apps)
  const listener = await startHostListener({
    hosts: async () => byHost,
    endpointFor: async () => ({ hostAddress: ip, port: containerPort }),
    port: 0,
  })
  const front = listener.address.port
  let pass = 0
  let fail = 0
  const check = (label, ok, detail = '') => {
    if (ok) { pass += 1; console.log(`  ok    ${label}`) } else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
  }

  try {
    check('the catalog has no host problems', problems.length === 0, problems.join('; '))
    console.log(`\n${APP_ID} at http://${HOST}/ via 127.0.0.1:${front} -> ${ip}:${containerPort}\n`)

    const index = await request(front, { host: HOST, path: '/' })
    check('the app root serves the app', index.status === 200, `status ${index.status}`)
    check('the document is the app, not the harness', /File Browser|filebrowser/i.test(index.body), index.body.slice(0, 80))

    // The whole point: the app's own base URL is empty, and that is now CORRECT
    // because the app really is at the root of this name.
    const baseUrl = /"BaseURL":"([^"]*)"/.exec(index.body)
    check('the app still reports an empty BaseURL', baseUrl !== null && baseUrl[1] === '', baseUrl?.[1])

    // A root-absolute API call must reach the APP. File Browser answers its own
    // 403 for bad credentials; the harness would answer 404 {"error":"not found"}.
    const login = await request(front, {
      host: HOST,
      path: '/api/login',
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json', 'content-length': '2' },
    })
    check('POST /api/login reaches the app', login.status !== 404, `status ${login.status}`)
    check(
      'the reply is the app\'s own auth result, not the harness 404',
      !/not found/.test(login.body),
      login.body.slice(0, 120),
    )
    check('unauthenticated login is refused by the app', login.status === 401 || login.status === 403, `status ${login.status}`)

    // A static asset path is also root-absolute in this app. Take the asset the
    // app actually references rather than a guessed name: the claim under test is
    // "root-absolute URLs the app emits resolve against the app", and guessing a
    // filename would test my guess instead.
    const assetPath = /src="(\/static\/[^"]+)"/.exec(index.body)?.[1] ?? ''
    check('the app emits a root-absolute asset URL', assetPath.startsWith('/static/'), assetPath || '(none found)')
    if (assetPath !== '') {
      const asset = await request(front, { host: HOST, path: assetPath })
      check(`root-absolute asset ${assetPath} is served by the app`, asset.status === 200, `status ${asset.status}`)
      check('and it is real content, not the app shell', !/text\/html/i.test(String(asset.headers['content-type'] ?? '')), String(asset.headers['content-type']))
    }

    // And the negative case: an undeclared name must not reach anything.
    const stray = await request(front, { host: 'not-declared.test.invalid', path: '/api/login', method: 'POST', body: '{}' })
    check('an undeclared hostname is refused', stray.status === 404, `status ${stray.status}`)
  } finally {
    await listener.close()
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

await main()
