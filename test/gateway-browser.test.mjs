/** Optional scratch HTTPS / real Chromium acceptance test; never a live deployment test.
 * RUN_GATEWAY_SMOKE=1 node test/gateway-browser.test.mjs
 * Requires openssl, installed httpxy, and an ALREADY RUNNING dsh-app-desktop with
 * Chromium + Node. No container creation/restart, DNS changes, live browser use,
 * harness profile changes, or production ingress. All fixtures are memory-only;
 * certificate/key and the isolated browser/download profile live privately in /tmp.
 * Download coverage: iframe navigation + Content-Disposition, and authenticated
 * top-level HTML download. The iframe uses the production sandbox flags.
 * Chromium 154 drops partitioned cookies on a cross-site iframe <a download>:
 * that separate compatibility probe returned gateway 401, not an app download.
 * This fixture does not weaken authentication or claim that variant works.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs/promises'
import path from 'node:path'
import { networkInterfaces } from 'node:os'
import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const desktop = 'dsh-app-desktop'
const downloadBody = 'scratch gateway download\nroot-hosted, authenticated, unchanged\n'
const appAuthorization = 'Bearer synthetic-app-authorization'
const protectedCsp = "default-src 'none'; frame-ancestors 'none'"
const listen = (server, host) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, host, () => { server.removeListener('error', reject); resolve(server.address().port) })
})
function track(server) {
  const sockets = new Set()
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  return async () => {
    const closed = new Promise(resolve => server.close(resolve))
    for (const socket of sockets) socket.destroy()
    server.closeAllConnections()
    await closed
  }
}

// This whole function is serialized into the existing desktop's Node process.
// Its only filesystem writes are its random private /tmp profile and downloads.
async function browserDriver(options) {
  const { spawn } = require('node:child_process')
  const fs = require('node:fs')
  const assert = require('node:assert/strict')
  const { profile, controlOrigin, appOrigin, appHost, controlSite, appSite, sameSite, resolver, spki, sessionCookie, sessionPath, expectedDownload, expectedCsp } = options
  assert.match(profile, /^\/tmp\/dsh-gateway-browser-[a-f0-9]{24}$/)
  fs.mkdirSync(profile, { mode: 0o700 })
  assert.equal(fs.realpathSync(profile), profile)
  const chrome = spawn('chromium', [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--no-proxy-server', `--host-resolver-rules=${resolver}`,
    `--ignore-certificate-errors-spki-list=${spki}`, `--user-data-dir=${profile}`,
    '--remote-debugging-pipe',
  ], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  let sequence = 0, buffer = '', stopping = false
  const pending = new Map(), downloads = new Map(), sessions = new Map(), contexts = new Map()
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const exited = new Promise(resolve => chrome.once('exit', resolve))
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)) }, 8000)
    pending.set(id, { resolve, reject, timer })
    chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId: typeof sessionId === 'object' ? sessionId.sessionId : sessionId } : {}) }) + '\0')
  })
  chrome.stdio[3].on('error', () => {})
  chrome.stdio[4].on('data', data => {
    buffer += data
    let end
    while ((end = buffer.indexOf('\0')) >= 0) {
      const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      if (!raw) continue
      const message = JSON.parse(raw), request = pending.get(message.id)
      if (request) {
        clearTimeout(request.timer); pending.delete(message.id)
        if (message.error) request.reject(Error(`${message.error.message}`))
        else request.resolve(message.result)
      }
      if (message.method === 'Runtime.executionContextCreated') {
        const context = message.params.context
        contexts.set(`${message.sessionId}:${context.id}`, { ...context, sessionId: message.sessionId })
      }
      if (message.method === 'Runtime.executionContextDestroyed') contexts.delete(`${message.sessionId}:${message.params.executionContextId}`)
      if (message.method === 'Runtime.executionContextsCleared') {
        for (const [key, context] of contexts) if (context.sessionId === message.sessionId) contexts.delete(key)
      }
      if (message.method === 'Browser.downloadWillBegin') downloads.set(message.params.guid, message.params)
      if (message.method === 'Browser.downloadProgress') downloads.set(message.params.guid, { ...downloads.get(message.params.guid), ...message.params })
    }
  })
  const evaluate = async (session, expression) => {
    // Same-site cross-origin frames may share the page target; select their current
    // default execution context after every navigation instead of assuming an OOPIF.
    const context = typeof session === 'object'
      ? [...contexts.values()].find(c => c.sessionId === session.sessionId && c.origin === session.origin && c.auxData?.isDefault)
      : null
    if (typeof session === 'object' && !context) throw Error('App frame execution context not ready')
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true, ...(context ? { contextId: context.id } : {}) }, session)
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description?.split('\n')[0] || 'Browser evaluation failed')
    return result.result?.value
  }
  const until = async (description, check) => {
    const deadline = Date.now() + 18000
    let last
    while (Date.now() < deadline) {
      try { const value = await check(); if (value) return value } catch (error) { last = error.message }
      await delay(100)
    }
    throw Error(`Timed out: ${description}${last ? ' (' + last + ')' : ''}`)
  }
  const attach = async id => {
    if (!sessions.has(id)) {
      const { sessionId } = await call('Target.attachToTarget', { targetId: id, flatten: true })
      sessions.set(id, sessionId)
      await call('Runtime.enable', {}, sessionId)
    }
    return sessions.get(id)
  }
  const open = async url => {
    const { targetId } = await call('Target.createTarget', { url: 'about:blank' })
    const session = await attach(targetId)
    await call('Page.enable', {}, session)
    await call('Page.navigate', { url }, session)
    return session
  }
  const appSession = async control => until('app iframe execution context', async () => {
    const { targetInfos } = await call('Target.getTargets')
    const target = targetInfos.find(t => t.type === 'iframe' && t.url.startsWith(appOrigin + '/'))
    if (target) return attach(target.targetId)
    const context = [...contexts.values()].find(c => c.sessionId === control && c.origin === appOrigin && c.auxData?.isDefault)
    return context && { sessionId: control, origin: appOrigin }
  })
  const probe = (session, stage) => until(`app ${stage}`, async () => {
    const result = await evaluate(session, 'window.smoke')
    if (result?.error) throw Error(result.error)
    return result?.stage === stage && result.ready && result
  })
  const gatewayCookies = async () => (await call('Storage.getCookies')).cookies.filter(c => c.name === sessionCookie && c.domain === appHost)
  const cookieEvidence = cookie => ({ name: cookie.name, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, partitionKey: cookie.partitionKey })
  const checkCookie = (cookie, site) => {
    assert.ok(cookie, `missing browser-accepted cookie for ${site}`)
    assert.equal(cookie.domain, appHost, 'host-only cookie, not a Domain cookie')
    assert.equal(cookie.path, '/')
    assert.equal(cookie.secure, true)
    assert.equal(cookie.httpOnly, true)
    assert.equal(cookie.sameSite, 'None')
    assert.equal(cookie.partitionKey?.topLevelSite, site)
  }
  async function stop() {
    if (stopping) return
    stopping = true
    await Promise.race([call('Browser.close').catch(() => {}), delay(1200)])
    await Promise.race([exited, delay(1200)])
    // Only the process group created immediately above; never pkill the desktop.
    try { process.kill(-chrome.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('Browser closed')) }
    pending.clear()
    assert.equal(fs.realpathSync(profile), profile)
    assert.equal(fs.lstatSync(profile).isSymbolicLink(), false)
    fs.rmSync(profile, { recursive: true, force: true })
  }
  const watchdog = setTimeout(() => { console.error('Browser watchdog expired'); void stop().finally(() => process.exit(2)) }, 90000)
  process.once('SIGTERM', () => { void stop().finally(() => process.exit(2)) })
  process.once('SIGINT', () => { void stop().finally(() => process.exit(2)) })
  try {
    const version = await call('Browser.getVersion')
    await call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: profile + '/downloads', eventsEnabled: true })
    const anonymous = await open(appOrigin + '/')
    await until('anonymous app rejection before launch', () => evaluate(anonymous, 'document.body?.innerText.includes("Open this application from DSH Applications to authenticate.")'))
    const control = await open(controlOrigin + '/')
    await until('synthetic HTTPS control', () => evaluate(control, 'window.controlReady && isSecureContext'))
    await evaluate(control, 'openFrame()')
    const frame = await appSession(control)
    const initial = await probe(frame, 'login')
    assert.equal(initial.secureContext, true)
    assert.equal(initial.asset, 'root-asset-loaded')
    assert.equal(initial.css, 'rgb(12, 34, 56)')
    assert.equal(initial.parentStorage, 'SecurityError')
    assert.equal(initial.parentDOM, 'SecurityError')
    assert.equal(initial.appAuth, 401, 'gateway auth must not silently bypass the app login')
    assert.equal(initial.challenge, 'Bearer realm="scratch-app"')
    assert.equal(initial.authorization, 'Bearer synthetic-app-authorization')
    assert.equal(initial.policy.csp, expectedCsp)
    assert.equal(initial.policy.xfo, 'DENY')
    assert.equal(initial.visibleCookies.includes(sessionCookie), false)
    assert.equal(await evaluate(frame, 'location.hash'), '', 'ticket fragment removed before app code executes')
    let cookies = await gatewayCookies()
    assert.equal(cookies.length, 1)
    checkCookie(cookies[0], controlSite)
    assert.equal(cookies[0].partitionKey.hasCrossSiteAncestor, !sameSite)
    const embeddedCookie = cookies[0]

    // Reuse the very same issued ticket: the real session endpoint must refuse it.
    const firstLaunch = await evaluate(control, 'window.lastLaunch')
    assert.equal(new URL(firstLaunch).pathname, '/__dsh_apps/launch')
    assert.equal(new URL(firstLaunch).search, '')
    assert.match(new URL(firstLaunch).hash, /^#[A-Za-z0-9_-]{43}$/)
    const replay = await evaluate(frame, `fetch(${JSON.stringify(sessionPath)}, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket:${JSON.stringify(new URL(firstLaunch).hash.slice(1))}})}).then(r=>r.status)`)
    assert.equal(replay, 401)

    await evaluate(frame, 'document.getElementById("login").requestSubmit()')
    const signedIn = await probe(frame, 'dashboard')
    assert.equal(signedIn.appAuth, 200)
    assert.equal(signedIn.wsText, 'echo:browser-text')
    assert.deepEqual(signedIn.wsBinary, [0, 1, 2, 254, 255])
    assert.equal(signedIn.parentStorage, 'SecurityError')
    assert.equal(signedIn.parentDOM, 'SecurityError')
    assert.equal(signedIn.visibleCookies.includes('app_login'), false)
    const framing = await evaluate(frame, 'testFraming()')
    assert.deepEqual(framing, { allowed: true, xfo: false, csp: false })
    // Real user-gesture navigation; Content-Disposition triggers the download.
    await evaluate(frame, 'document.getElementById("download").focus()')
    await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, frame)
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, frame)
    const download = await until('browser attachment download', () => [...downloads.values()].find(d => d.state === 'completed'))
    assert.equal(download.suggestedFilename, 'gateway-proof.txt')
    assert.equal(fs.readFileSync(profile + '/downloads/gateway-proof.txt', 'utf8'), expectedDownload)
    // Measure the chosen nested layout too; the historical cross-site limitation
    // must not be assumed to apply to same-site iframe HTML downloads.
    if (sameSite) {
      await evaluate(frame, 'document.getElementById("download").setAttribute("download", ""); document.getElementById("download").focus()')
      await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, frame)
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, frame)
      await until('same-site iframe HTML download', () => [...downloads.values()].filter(d => d.state === 'completed').length === 2)
    }

    // CHIPS keys sites, not origins: nested apps share their iframe/top-level
    // partition, whereas a separate-site deployment does not. Neither shares DOM.
    const top = await open(appOrigin + (sameSite ? '/private' : '/dashboard'))
    if (sameSite) {
      await until('same-site top-level session continuity', () => evaluate(top, 'document.body?.innerText === "app authenticated"'))
    } else {
      await until('top-level unauthenticated rejection', () => evaluate(top, 'document.body?.innerText.includes("Open this application from DSH Applications to authenticate.")'))
    }
    const freshLaunch = await evaluate(control, 'issueLaunch()')
    assert.notEqual(freshLaunch, firstLaunch)
    await call('Page.navigate', { url: freshLaunch }, top)
    const topInitial = await probe(top, sameSite ? 'dashboard' : 'login')
    assert.equal(topInitial.appAuth, sameSite ? 200 : 401, 'app login follows the browser site partition')
    cookies = await gatewayCookies()
    assert.equal(cookies.length, sameSite ? 1 : 2, 'same-site partition is shared; cross-site partitions are independent')
    const topCookie = cookies.find(c => c.partitionKey?.topLevelSite === appSite)
    checkCookie(topCookie, appSite)
    assert.ok(topCookie.value !== embeddedCookie.value, 'fresh ticket creates a distinct session value')
    if (!sameSite) await evaluate(top, 'document.getElementById("login").requestSubmit()')
    const topSignedIn = await probe(top, 'dashboard')
    assert.equal(topSignedIn.appAuth, 200)
    assert.equal(topSignedIn.wsText, 'echo:browser-text')
    assert.deepEqual(topSignedIn.wsBinary, [0, 1, 2, 254, 255])
    // Verify the generic new-tab escape for the iframe HTML-download limitation.
    await evaluate(top, 'document.getElementById("download").setAttribute("download", ""); document.getElementById("download").focus()')
    await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, top)
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, top)
    await until('top-level HTML download', () => [...downloads.values()].filter(d => d.state === 'completed').length === (sameSite ? 3 : 2))
    const downloaded = fs.readdirSync(profile + '/downloads')
    // CDP's allow policy may overwrite the same suggested filename.
    assert.ok(downloaded.length >= 1)
    for (const name of downloaded) assert.equal(fs.readFileSync(profile + '/downloads/' + name, 'utf8'), expectedDownload)
    assert.equal(await evaluate(control, 'localStorage.getItem("control-secret")'), 'synthetic-parent-only')
    console.log(JSON.stringify({ browser: version.product, topology: sameSite ? 'nested same-site' : 'separate-site', anonymousDeniedBeforeLaunch: true, iframeHtmlDownload: sameSite ? 'completed; exact bytes verified' : 'not exercised (known cross-site limitation)', iframe: { https: initial.secureContext, rootAsset: initial.asset, parentStorage: initial.parentStorage, parentDOM: initial.parentDOM, appLogin: signedIn.appAuth, websocketText: signedIn.wsText, websocketBinary: signedIn.wsBinary }, replayStatus: replay, framing, download: { mode: 'iframe navigation + Content-Disposition attachment (not HTML download attribute)', name: download.suggestedFilename, bytes: Buffer.byteLength(expectedDownload) }, topLevel: { deniedWithoutFreshTicket: !sameSite, appLogin: topSignedIn.appAuth, websocketText: topSignedIn.wsText, websocketBinary: topSignedIn.wsBinary, htmlDownload: 'completed; exact bytes verified' }, cookies: cookies.map(cookieEvidence) }))
  } catch (error) {
    // Never print launch URL fragments or cookie values in failures.
    console.error((error.stack || error.message).replace(/[A-Za-z0-9_-]{43}/g, '[redacted-token]'))
    process.exitCode = 1
  } finally {
    clearTimeout(watchdog)
    await stop()
  }
}

function appScript() {
  window.smoke = { stage: document.body.dataset.stage, secureContext: isSecureContext, asset: 'root-asset-loaded', css: getComputedStyle(document.body).color, visibleCookies: document.cookie }
  async function run() {
    if (parent !== window) {
      try { parent.localStorage.getItem('control-secret'); smoke.parentStorage = 'ACCESSIBLE' } catch (error) { smoke.parentStorage = error.name }
      try { parent.document.getElementById('secret').textContent; smoke.parentDOM = 'ACCESSIBLE' } catch (error) { smoke.parentDOM = error.name }
    }
    const auth = await fetch('/private')
    smoke.appAuth = auth.status
    smoke.challenge = auth.headers.get('www-authenticate')
    smoke.authorization = (await (await fetch('/authorization', { headers: { authorization: 'Bearer synthetic-app-authorization' } })).json()).authorization
    const policy = await fetch('/policy')
    smoke.policy = { csp: policy.headers.get('content-security-policy'), xfo: policy.headers.get('x-frame-options') }
    if (smoke.stage === 'dashboard') {
      await new Promise((resolve, reject) => {
        const socket = new WebSocket(location.origin.replace('https:', 'wss:') + '/socket')
        socket.binaryType = 'arraybuffer'
        const timer = setTimeout(() => { socket.close(); reject(Error('WebSocket frame timeout')) }, 6000)
        socket.onopen = () => { socket.send('browser-text'); socket.send(new Uint8Array([0, 1, 2, 254, 255])) }
        socket.onerror = () => { clearTimeout(timer); reject(Error('WebSocket failed')) }
        socket.onmessage = event => {
          if (typeof event.data === 'string') smoke.wsText = event.data
          else smoke.wsBinary = Array.from(new Uint8Array(event.data))
          if (smoke.wsText && smoke.wsBinary) { clearTimeout(timer); socket.close(); resolve() }
        }
      })
    }
    smoke.ready = true
  }
  window.testFraming = async () => {
    const result = {}
    for (const name of ['allowed', 'xfo', 'csp']) {
      const frame = document.createElement('iframe')
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Framing probe timeout: ' + name)), 6000)
        frame.onload = () => { clearTimeout(timer); resolve() }
        frame.src = '/frame-' + name; document.body.append(frame)
      })
      try { result[name] = !!frame.contentDocument?.getElementById('policy-marker') } catch { result[name] = false }
      frame.remove()
    }
    return result
  }
  run().catch(error => { smoke.error = error.message })
}

function webSocketFixture(server, requests) {
  server.on('upgrade', (req, socket, head) => {
    requests.push({ method: 'WS', path: req.url, headers: { ...req.headers } })
    if (req.url !== '/socket' || !req.headers.cookie?.includes('app_login=synthetic-login')) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    let buffer = Buffer.alloc(0)
    const consume = chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15, length = buffer[1] & 127, masked = !!(buffer[1] & 128)
        if (length > 125 || !masked) { socket.destroy(); return }
        if (buffer.length < 6 + length) return
        const payload = Buffer.from(buffer.subarray(6, 6 + length)), mask = buffer.subarray(2, 6)
        for (let i = 0; i < length; i++) payload[i] ^= mask[i % 4]
        buffer = buffer.subarray(6 + length)
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return }
        if (![1, 2, 9].includes(opcode)) { socket.destroy(); return }
        const out = opcode === 1 ? Buffer.from('echo:' + payload.toString()) : payload
        socket.write(Buffer.concat([Buffer.from([0x80 | (opcode === 9 ? 10 : opcode), out.length]), out]))
      }
    }
    socket.on('data', consume)
    socket.on('error', () => {})
    if (head.length) consume(head)
  })
}

// Failure fallback: only exact process argv matching our random profile is killed.
// Validate both the lexical absolute path and realpath before recursive deletion.
function cleanBrowserProfile(profile) {
  const fs = require('node:fs'), assert = require('node:assert/strict')
  assert.match(profile, /^\/tmp\/dsh-gateway-browser-[a-f0-9]{24}$/)
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    let argv
    try { argv = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0') } catch { continue }
    if (argv.includes(`--user-data-dir=${profile}`) && /(?:^|\/)chromium$/.test(argv[0])) {
      const pid = Number(entry)
      // Only the detached browser process (no --type) owns this process group.
      // Renderer/utility leftovers with this exact private profile are also safe.
      const target = argv.some(arg => arg.startsWith('--type=')) ? pid : -pid
      try { process.kill(target, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
  if (fs.existsSync(profile)) {
    assert.equal(fs.realpathSync(profile), profile)
    assert.equal(fs.lstatSync(profile).isSymbolicLink(), false)
    fs.rmSync(profile, { recursive: true, force: true })
  }
  assert.equal(fs.existsSync(profile), false)
}

for (const sameSite of [true, false]) await test(`optional real-browser isolated app gateway acceptance (${sameSite ? 'nested same-site' : 'separate-site'})`, { skip: process.env.RUN_GATEWAY_SMOKE !== '1' && 'set RUN_GATEWAY_SMOKE=1; requires an existing running desktop', timeout: 150000 }, async () => {
  // Import evolving application modules only in opt-in mode; skip needs no Docker.
  const [{ createProxyServer }, { gatewayConfig, describeApps, SESSION_PATH }, { AppSessions, SESSION_COOKIE }, { startHostListener }] = await Promise.all([
    import('httpxy'), import('../lib/app-launch.js'), import('../lib/app-sessions.js'), import('../lib/host-listen.js'),
  ])
  const info = JSON.parse((await exec('docker', ['inspect', desktop], { timeout: 10000 })).stdout)[0]
  assert.equal(info.State.Running, true, 'start the desktop separately; this test never starts it')
  const localIPs = Object.values(networkInterfaces()).flat().filter(n => n.family === 'IPv4').map(n => n.address)
  const network = Object.values(info.NetworkSettings.Networks).find(n => localIPs.includes(n.Gateway))
  assert.ok(network, 'No existing desktop network gateway is a local private bridge')
  const bridge = network.Gateway
  assert.match(bridge, /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/, 'fixture binds only to a private bridge')
  const run = randomBytes(6).toString('hex')
  const controlDomain = `control-${run}.test`
  const controlHost = `dev.${controlDomain}`, domain = sameSite ? controlHost : `apps-${run}.test`
  const profile = '/tmp/dsh-gateway-browser-' + randomBytes(12).toString('hex')
  const home = await fs.mkdtemp('/tmp/dsh-gateway-smoke-')
  await fs.chmod(home, 0o700)
  const cleanup = [], requests = [], ingress = [], sessionHeaders = [], failures = []
  let gateway, ingressProxy
  try {
    const keyPath = path.join(home, 'key.pem'), certPath = path.join(home, 'cert.pem')
    await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=' + controlHost, '-addext', `subjectAltName=DNS:${controlHost},DNS:*.${domain}`, '-keyout', keyPath, '-out', certPath], { timeout: 20000 })
    await fs.chmod(keyPath, 0o600)
    const [key, cert] = await Promise.all([fs.readFile(keyPath), fs.readFile(certPath)])
    const spki = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
    const sessions = new AppSessions()
    let app, controlOrigin
    const downloadRequests = []
    const controlCookie = randomBytes(24).toString('base64url')
    ingressProxy = createProxyServer({ changeOrigin: false, xfwd: false, prependPath: false, agent: false })
    ingressProxy.on('proxyRes', (response, req) => {
      ingress.push({ method: req.method, path: req.url, status: response.statusCode })
      if (req.url === SESSION_PATH && response.headers['set-cookie']) sessionHeaders.push(...response.headers['set-cookie'])
    })
    const edge = https.createServer({ key, cert, requestTimeout: 10000 }, async (req, res) => {
      try {
        if (req.headers.host === new URL(controlOrigin).host) {
          if (req.url === '/' && req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store', 'set-cookie': `__Host-control-auth=${controlCookie}; Secure; HttpOnly; Path=/; SameSite=Strict` }).end(`<!doctype html><title>Synthetic DSH-like control, not the real shell</title><p id="secret">parent DOM secret</p><iframe id="app" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe><script>
localStorage.setItem('control-secret','synthetic-parent-only');
window.issueLaunch=async()=>{const r=await fetch('/open',{method:'POST'});if(!r.ok)throw Error('control authorization failed');return (await r.json()).url};
window.openFrame=async()=>{window.lastLaunch=await issueLaunch();document.getElementById('app').src=lastLaunch};window.controlReady=true;
</script>`)
            return
          }
          if (req.url === '/open' && req.method === 'POST' && req.headers.origin === controlOrigin && req.headers.cookie === `__Host-control-auth=${controlCookie}`) {
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ url: sessions.issue(app) })); return
          }
          res.writeHead(403).end('synthetic control denied'); return
        }
        if (req.url === '/download') downloadRequests.push({ cookieNames: (req.headers.cookie || '').split(';').map(c => c.trim().split('=')[0]).filter(Boolean), origin: req.headers.origin, destination: req.headers['sec-fetch-dest'], site: req.headers['sec-fetch-site'], mode: req.headers['sec-fetch-mode'] })
        await ingressProxy.web(req, res, { target: `http://127.0.0.1:${gateway.address.port}` })
      } catch (error) { failures.push(error.code || error.message); res.destroy() }
    })
    cleanup.push(track(edge))
    edge.on('upgrade', (req, socket, head) => {
      ingressProxy.ws(req, socket, { target: `http://127.0.0.1:${gateway.address.port}` }, head).catch(error => { failures.push(error.code || error.message); socket.destroy() })
    })
    const publicPort = await listen(edge, bridge)
    controlOrigin = `https://${controlHost}:${publicPort}`
    const normalCsp = `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' wss:; frame-ancestors ${controlOrigin}`
    const upstream = http.createServer({ requestTimeout: 10000 }, async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      requests.push({ method: req.method, path: req.url, headers: { ...req.headers }, body })
      const loggedIn = req.headers.cookie?.split(';').some(part => part.trim() === 'app_login=synthetic-login')
      const send = (status, content, headers = {}) => res.writeHead(status, { 'cache-control': 'no-store', ...headers }).end(content)
      if (req.url === '/' || req.url === '/dashboard') {
        if (req.url === '/dashboard' && !loggedIn) { send(303, '', { location: '/' }); return }
        send(200, `<!doctype html><title>Synthetic app</title><link rel="stylesheet" href="/assets/app.css"><body data-stage="${loggedIn ? 'dashboard' : 'login'}"><form id="login" method="post" action="/login"><input name="username" value="synthetic-user"><input name="password" value="synthetic-password" type="password"><button>Log in</button></form><a id="download" href="/download">Download</a><script src="/assets/app.js"></script></body>`, { 'content-type': 'text/html', 'content-security-policy': normalCsp }); return
      }
      if (req.url === '/assets/app.js') { send(200, `(${appScript.toString()})()`, { 'content-type': 'application/javascript' }); return }
      if (req.url === '/assets/app.css') { send(200, 'body { color: rgb(12, 34, 56); }', { 'content-type': 'text/css' }); return }
      if (req.url === '/login' && req.method === 'POST') {
        if (body !== 'username=synthetic-user&password=synthetic-password') { send(403, 'bad app credentials'); return }
        send(303, '', { location: '/dashboard', 'set-cookie': 'app_login=synthetic-login; Path=/; Secure; HttpOnly; SameSite=None; Partitioned' }); return
      }
      if (req.url === '/private') { send(loggedIn ? 200 : 401, loggedIn ? 'app authenticated' : 'app login required', loggedIn ? {} : { 'www-authenticate': 'Bearer realm="scratch-app"' }); return }
      if (req.url === '/authorization') { send(200, JSON.stringify({ authorization: req.headers.authorization }), { 'content-type': 'application/json' }); return }
      if (req.url === '/policy') { send(200, 'unchanged app policy', { 'content-security-policy': protectedCsp, 'x-frame-options': 'DENY' }); return }
      if (req.url.startsWith('/frame-')) {
        const headers = { 'content-type': 'text/html' }
        if (req.url === '/frame-xfo') headers['x-frame-options'] = 'DENY'
        if (req.url === '/frame-csp') headers['content-security-policy'] = "frame-ancestors 'none'"
        send(200, '<!doctype html><p id="policy-marker">must render only when allowed</p>', headers); return
      }
      if (req.url === '/download' && loggedIn) { send(200, downloadBody, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="gateway-proof.txt"' }); return }
      send(404, 'fixture not found')
    })
    cleanup.push(track(upstream))
    webSocketFixture(upstream, requests)
    const upstreamPort = await listen(upstream, bridge)
    const config = gatewayConfig({ appDomain: domain, controlOrigin, appPublicPort: publicPort, appListenHost: '127.0.0.1', appListenPort: 0, appIngressPeers: ['127.0.0.1'] }, {})
    ;[app] = describeApps([{ id: 'browser-smoke', containerId: 'synthetic-container-' + run, status: 'running', web: { path: '/apps/web/browser-smoke/', containerPort: upstreamPort } }], config)
    assert.equal(app.launch.mode, 'isolated')
    gateway = await startHostListener({ hosts: async () => new Map([[app.launch.host, app]]), sessions, controlOrigin: config.controlOrigin, ingressPeers: config.peers, host: config.bind, port: config.port, endpointFor: async () => ({ hostAddress: bridge, port: upstreamPort }), log: (...args) => failures.push(args.join(' ')) })
    const driver = `(${browserDriver.toString()})(${JSON.stringify({ profile, controlOrigin, appOrigin: app.launch.origin, appHost: app.launch.host, controlSite: `https://${controlDomain}`, appSite: `https://${sameSite ? controlDomain : domain}`, sameSite, resolver: `MAP ${controlHost} ${bridge}, MAP *.${domain} ${bridge}`, spki, sessionCookie: SESSION_COOKIE, sessionPath: SESSION_PATH, expectedDownload: downloadBody, expectedCsp: protectedCsp })}).catch(e=>{console.error(e.message);process.exitCode=1})`
    let output
    try {
      output = (await exec('docker', ['exec', desktop, 'node', '-e', driver], { timeout: 105000, maxBuffer: 2 * 1024 * 1024 })).stdout
    } catch (error) {
      // execFile's message includes its argv (and synthetic origins); stderr is
      // more useful and does not echo the driver or any private session material.
      throw Error(`Browser driver failed (exit ${error.code ?? 'unknown'}): ${error.stderr || error.signal || 'no stderr'}; upstream paths=${requests.map(r => r.method + ' ' + r.path).join(', ')}; ingress statuses=${ingress.map(r => r.status + ' ' + r.path).join(', ')}; download requests=${JSON.stringify(downloadRequests)}`)
    }
    const evidence = JSON.parse(output.trim())
    assert.equal(failures.length, 0, failures.join('; '))
    assert.equal(sessionHeaders.length, 2, 'two successful bootstrap exchanges')
    for (const cookie of sessionHeaders) {
      assert.match(cookie, /^__Host-dsh-app-session=/)
      for (const attribute of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=None', 'Partitioned']) assert.ok(cookie.split('; ').includes(attribute), `missing ${attribute}`)
      assert.doesNotMatch(cookie, /;\s*Domain=/i)
    }
    assert.equal(ingress.filter(r => r.path === SESSION_PATH && r.status === 401).length, 1)
    assert.equal(ingress.some(r => r.path === '/dashboard' && r.status === 401), !sameSite, 'only cross-site top-level visits need a separate partition')
    assert.equal(requests.filter(r => r.path === '/login' && r.method === 'POST').length, sameSite ? 1 : 2)
    assert.equal(requests.filter(r => r.method === 'WS').length, 2)
    for (const request of requests) {
      assert.equal(request.headers.host, new URL(app.launch.origin).host, 'public HTTPS Host preserved')
      assert.equal(request.headers['x-forwarded-proto'], 'https')
      assert.equal(request.headers['x-forwarded-host'], new URL(app.launch.origin).host)
      assert.equal(request.headers['x-forwarded-port'], String(publicPort))
      assert.equal(request.headers['x-forwarded-for'], undefined)
      assert.doesNotMatch(request.headers.cookie || '', /(?:__Host-dsh-app-session|__Host-control-auth)=/)
      assert.doesNotMatch(request.path, /(?:__dsh_apps|apps\/web|#)/, 'no bootstrap URL/ticket or legacy mount reaches upstream')
      if (request.method === 'POST' || request.method === 'WS') assert.equal(request.headers.origin, app.launch.origin)
    }
    assert.ok(requests.some(r => r.path === '/authorization' && r.headers.authorization === appAuthorization))
    for (const route of ['/assets/app.js', '/assets/app.css', '/download', '/frame-allowed', '/frame-xfo', '/frame-csp']) assert.ok(requests.some(r => r.path === route), `real upstream request for ${route}`)
    assert.equal(sessions.tickets.size, 0, 'all issued tickets consumed')
    assert.equal(sessions.sessions.size, 2)
    console.log('PASS scratch HTTPS ingress → host-listen gateway → synthetic upstream; real browser evidence:')
    console.log(JSON.stringify(evidence, null, 2))
    console.log('Scope: synthetic control page, not DSH shell/auth or production DNS/TLS/CDN ingress; no service-worker lifecycle test.')
    console.log('Download limitation: cross-site iframe HTML download attribute failed separately on Chromium 154 (no cookies, gateway 401); iframe attachment navigation and top-level HTML download passed.')
  } finally {
    // Attempt every cleanup even if one fails; a failed cleanup fails the test.
    const results = await Promise.allSettled([
      exec('docker', ['exec', desktop, 'node', '-e', `(${cleanBrowserProfile.toString()})(${JSON.stringify(profile)})`], { timeout: 10000 }),
      (async () => { if (gateway) await gateway.close() })(),
      ...cleanup.reverse().map(close => close()),
    ])
    ingressProxy?.close()
    assert.match(home, /^\/tmp\/dsh-gateway-smoke-[A-Za-z0-9]+$/)
    assert.equal(await fs.realpath(home), home)
    assert.equal((await fs.lstat(home)).isSymbolicLink(), false)
    await fs.rm(home, { recursive: true, force: true })
    const rejected = results.filter(result => result.status === 'rejected')
    assert.equal(rejected.length, 0, 'Scratch cleanup failed: ' + rejected.map(r => r.reason.message).join('; '))
    console.log('CLEANUP: scratch listeners, browser process/profile/downloads, and private TLS directory removed')
  }
})
