/** Raw TCP regressions: a WS client's FIN cancels work, not just its response.
 * No containers, private credentials, fixed ports, sleeps, or mocked sessions.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { gatewayConfig, describeApps } from '../lib/app-launch.js'
import { AppSessions } from '../lib/app-sessions.js'
import { startHostListener } from '../lib/host-listen.js'

const WAIT_MS = 2000
const TEST_TIMEOUT = 10_000
const config = gatewayConfig({ appDomain: 'control.example.org', controlOrigin: 'https://control.example.org' }, {})
const app = describeApps([{ id: 'files', containerId: 'a'.repeat(64), web: { containerPort: 80, path: '/apps/web/files/' } }], config)[0]
const WS_KEY = 'dGhlIHNhbXBsZSBub25jZQ=='
const WS_ACCEPT = createHash('sha1').update(WS_KEY + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  const result = { promise, resolve, reject }
  // An expected abandoned socket need never produce a handshake/frame. Observe
  // rejection immediately even when a test fails before reaching its next wait.
  result.promise.catch(() => {})
  return result
}

async function within(promise, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish within ${WAIT_MS} ms`)), WAIT_MS)
    })])
  } finally { clearTimeout(timer) }
}

function gate() {
  return { entered: deferred(), released: deferred(), returned: deferred() }
}

async function hold(gate) {
  gate.entered.resolve()
  await gate.released.promise
  gate.returned.resolve()
}

function listen(server) {
  return within(new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(server.address().port)
    })
  }), 'backend listen')
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close(error => {
    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
    else resolve()
  }))
}

// These fixtures send one short text frame. Parse TCP fragmentation/coalescing,
// and retain the wire bytes so an opaque byte echo cannot pass as a WS echo.
function receiveFrame(socket, initial = Buffer.alloc(0)) {
  const result = deferred()
  let buffer = initial
  const cleanup = () => {
    socket.removeListener('data', data)
    socket.removeListener('error', failed)
    socket.removeListener('close', closed)
  }
  const failed = error => { cleanup(); result.reject(error) }
  const closed = () => failed(new Error('socket closed before a complete WS frame'))
  const data = chunk => {
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length < 2) return
    const length = buffer[1] & 0x7f
    if (length >= 126) { failed(new Error('fixture expects a short WS frame')); return }
    const masked = Boolean(buffer[1] & 0x80)
    const offset = masked ? 6 : 2
    if (buffer.length < offset + length) return
    const payload = Buffer.from(buffer.subarray(offset, offset + length))
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[2 + i % 4]
    cleanup()
    result.resolve({ opcode: buffer[0], masked, payload, wire: buffer.subarray(0, offset + length) })
  }
  socket.on('data', data)
  socket.once('error', failed)
  socket.once('close', closed)
  data(Buffer.alloc(0))
  return result.promise
}

function receiveHandshake(socket) {
  const result = deferred()
  let buffer = Buffer.alloc(0)
  const cleanup = () => {
    socket.removeListener('data', data)
    socket.removeListener('error', failed)
    socket.removeListener('close', closed)
  }
  const failed = error => { cleanup(); result.reject(error) }
  const closed = () => failed(new Error('socket closed before the WS handshake'))
  const data = chunk => {
    buffer = Buffer.concat([buffer, chunk])
    const end = buffer.indexOf('\r\n\r\n')
    if (end === -1) return
    cleanup()
    result.resolve({ headers: buffer.subarray(0, end).toString(), frame: receiveFrame(socket, buffer.subarray(end + 4)) })
  }
  socket.on('data', data)
  socket.once('error', failed)
  socket.once('close', closed)
  return result.promise
}

function maskedFrame(payload) {
  assert.ok(payload.length < 126)
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
  const bytes = Buffer.from(payload)
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= mask[i % 4]
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, bytes])
}

async function fixture(t, held = undefined) {
  const sessions = new AppSessions()
  const hosts = new Map([[app.launch.host, app]])
  const hostsGate = gate(), endpointGate = gate()
  const clients = new Set(), ingress = new Set(), backends = new Set()
  const closures = new WeakMap()
  const clientUpgrades = new Map(), backendUpgrades = new Map()
  const counts = { hosts: 0, endpoints: 0, backendConnections: 0, backend101s: 0 }
  const backendPaths = []
  let gateway, tearingDown = false
  const track = (set, socket) => {
    const closed = deferred()
    set.add(socket); closures.set(socket, closed.promise)
    socket.on('error', () => {}) // Cancellation may legitimately reset a TCP peer.
    socket.once('close', () => { set.delete(socket); closed.resolve() })
    return socket
  }
  const observation = (map, path) => {
    if (!map.has(path)) map.set(path, deferred())
    return map.get(path)
  }
  const backend = http.createServer((_req, res) => res.writeHead(500).end('WS fixture only'))
  backend.on('connection', socket => { counts.backendConnections++; track(backends, socket) })
  backend.on('upgrade', (req, socket, head) => {
    backendPaths.push(req.url)
    // The backend honors a peer FIN; it never initiates closure itself. In
    // particular the no-101 case cannot be rescued by a backend timeout.
    socket.once('end', () => socket.end())
    const item = { req, socket, closed: closures.get(socket) }
    if (req.url === '/withhold-101') {
      socket.resume()
      observation(backendUpgrades, req.url).resolve(item)
      return
    }
    item.frame = receiveFrame(socket, head)
    item.frame.then(frame => {
      socket.write(Buffer.concat([Buffer.from([0x81, frame.payload.length]), frame.payload]))
    }, () => socket.destroy())
    counts.backend101s++
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    observation(backendUpgrades, req.url).resolve(item)
  })

  // Register teardown BEFORE either listener starts, so partial startup and
  // assertion failures release gates, sessions, and every socket we own.
  t.after(async () => {
    tearingDown = true
    hostsGate.released.resolve(); endpointGate.released.resolve()
    sessions.close()
    const closing = gateway?.close()
    for (const socket of [...clients, ...ingress, ...backends]) socket.destroy()
    await within(Promise.all([closing, closeServer(backend)]), 'fixture cleanup')
  })
  const backendPort = await listen(backend)
  gateway = await within(startHostListener({
    host: '127.0.0.1', port: 0, sessions, controlOrigin: config.controlOrigin,
    hosts: async () => {
      if (++counts.hosts === 1 && held === 'hosts') await hold(hostsGate)
      return hosts
    },
    endpointFor: async () => {
      if (++counts.endpoints === 1 && held === 'endpoint') await hold(endpointGate)
      return { hostAddress: '127.0.0.1', port: backendPort }
    },
  }).then(async listener => {
    // If startup exceeds its bound, teardown has already run by the time it
    // resolves. Do not strand a listener created after that teardown.
    gateway = listener
    if (tearingDown) await listener.close()
    return listener
  }), 'gateway listen')
  gateway.server.on('connection', socket => track(ingress, socket))
  gateway.server.prependListener('upgrade', (req, socket) => {
    const fin = deferred()
    // Observe, but do not repair, Node's half-open upgraded socket. This listener
    // runs before the implementation's upgrade-entry cancellation listener.
    socket.once('end', () => fin.resolve({ readableEnded: socket.readableEnded, destroyed: socket.destroyed }))
    observation(clientUpgrades, req.url).resolve({ socket, fin: fin.promise, closed: closures.get(socket) })
  })
  const ticket = new URL(sessions.issue(app)).hash.slice(1)
  const cookie = sessions.exchange(ticket, app).cookie.split(';')[0]
  assert.equal(sessions.authorize({ headers: { cookie } }, app), true)

  async function open(path) {
    const incoming = observation(clientUpgrades, path)
    const socket = track(clients, net.createConnection({ host: '127.0.0.1', port: gateway.address.port, allowHalfOpen: true }))
    const handshake = receiveHandshake(socket)
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${app.launch.host}\r\nOrigin: ${app.launch.origin}\r\nCookie: ${cookie}; app=synthetic\r\nAuthorization: Bearer gateway-cancellation-fixture\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${WS_KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    return { socket, handshake, incoming: await within(incoming.promise, `ingress upgrade ${path}`), closed: closures.get(socket) }
  }
  async function fin(client) {
    // end(), deliberately NOT destroy(): a half-close leaves its readable leg
    // open, reproducing readableEnded=true/destroyed=false on Node v24 ingress.
    client.socket.end()
    const state = await within(client.incoming.fin, 'ingress observes client FIN')
    assert.equal(state.readableEnded, true)
    assert.equal(state.destroyed, false, 'FIN observation must precede any gateway destroy handler')
  }
  async function echo(path) {
    const client = await open(path)
    const { headers, frame } = await within(client.handshake, `101 handshake ${path}`)
    assert.match(headers, /^HTTP\/1\.1 101 /)
    assert.ok(headers.toLowerCase().includes(`sec-websocket-accept: ${WS_ACCEPT}`.toLowerCase()))
    const payload = Buffer.from(`echo:${path}`)
    const wire = maskedFrame(payload)
    client.socket.write(wire)
    const response = await within(frame, `unmasked echo ${path}`)
    const upstream = await within(observation(backendUpgrades, path).promise, `backend upgrade ${path}`)
    const received = await within(upstream.frame, `masked frame ${path}`)
    assert.equal(received.opcode, 0x81); assert.equal(received.masked, true)
    assert.deepEqual(received.wire, wire); assert.deepEqual(received.payload, payload)
    assert.equal(response.opcode, 0x81); assert.equal(response.masked, false)
    assert.deepEqual(response.wire, Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
    assert.equal(upstream.req.headers.cookie, 'app=synthetic')
    assert.equal(upstream.req.headers.authorization, 'Bearer gateway-cancellation-fixture')
    return { client, upstream }
  }
  async function barrier(path) {
    // A fresh authenticated upgrade + real frame round trip after gate release
    // crosses the async continuation and TCP I/O queues. No negative sleep.
    const { client, upstream } = await echo(path)
    await fin(client)
    await within(Promise.all([client.closed, client.incoming.closed, upstream.closed]), `successful barrier closes ${path}`)
  }
  async function assertDrained() {
    await within(Promise.all([...clients, ...ingress, ...backends].map(socket => closures.get(socket))),
      `TCP drain (clients=${clients.size}, ingress=${ingress.size}, backend=${backends.size})`)
    assert.equal(clients.size, 0, 'all raw clients drained before fixture cleanup')
    assert.equal(ingress.size, 0, 'all ingress sockets drained before fixture cleanup')
    assert.equal(backends.size, 0, 'all backend sockets drained before fixture cleanup')
  }
  return { open, fin, echo, barrier, assertDrained, hostsGate, endpointGate, counts, backendPaths,
    backendUpgrade: path => within(observation(backendUpgrades, path).promise, `backend upgrade ${path}`) }
}

test('WS FIN while hosts() is held never calls endpointFor or dials a backend', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t, 'hosts')
  const abandoned = await f.open('/abandoned-hosts')
  await within(f.hostsGate.entered.promise, 'held hosts lookup entered')
  assert.equal(f.counts.endpoints, 0); assert.equal(f.counts.backendConnections, 0)
  await f.fin(abandoned)
  f.hostsGate.released.resolve()
  await within(f.hostsGate.returned.promise, 'held hosts lookup released')
  await f.barrier('/fresh-after-hosts')
  assert.equal(f.counts.hosts, 2)
  assert.equal(f.counts.endpoints, 1, 'only the fresh request may call endpointFor; abandoned hosts lookup must not')
  assert.equal(f.counts.backendConnections, 1, 'only the fresh request may dial a backend')
  assert.deepEqual(f.backendPaths, ['/fresh-after-hosts'])
  await f.assertDrained()
})

test('WS FIN while endpointFor() is held never dials a backend after release', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t, 'endpoint')
  const abandoned = await f.open('/abandoned-endpoint')
  await within(f.endpointGate.entered.promise, 'held endpoint lookup entered')
  assert.equal(f.counts.endpoints, 1); assert.equal(f.counts.backendConnections, 0)
  await f.fin(abandoned)
  f.endpointGate.released.resolve()
  await within(f.endpointGate.returned.promise, 'held endpoint lookup released')
  await f.barrier('/fresh-after-endpoint')
  assert.equal(f.counts.hosts, 2); assert.equal(f.counts.endpoints, 2)
  assert.equal(f.counts.backendConnections, 1, 'abandoned endpoint resolution must not dial; only the fresh request may')
  assert.deepEqual(f.backendPaths, ['/fresh-after-endpoint'])
  await f.assertDrained()
})

test('WS FIN cancels a pending backend handshake without waiting for the 10s timeout', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t)
  const abandoned = await f.open('/withhold-101')
  const pending = await f.backendUpgrade('/withhold-101')
  assert.equal(f.counts.backend101s, 0, 'backend has accepted the upgrade but deliberately sent no 101')
  await f.fin(abandoned)
  await within(pending.closed, 'pending upstream cancelled by client FIN, not the 10s proxy timeout')
  await within(Promise.all([abandoned.closed, abandoned.incoming.closed]), 'abandoned handshake client closes')
  await f.barrier('/fresh-after-pending')
  assert.equal(f.counts.endpoints, 2); assert.equal(f.counts.backendConnections, 2)
  assert.deepEqual(f.backendPaths, ['/withhold-101', '/fresh-after-pending'])
  await f.assertDrained()
})

test('established WS relays masked/unmasked echo and FIN drains both TCP legs', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t)
  const { client, upstream } = await f.echo('/established')
  assert.equal(client.socket.destroyed, false); assert.equal(upstream.socket.destroyed, false)
  await f.fin(client)
  await within(Promise.all([client.closed, client.incoming.closed, upstream.closed]), 'established WS both legs close on FIN')
  assert.equal(f.counts.endpoints, 1); assert.equal(f.counts.backendConnections, 1)
  assert.equal(f.counts.backend101s, 1)
  await f.assertDrained()
})
