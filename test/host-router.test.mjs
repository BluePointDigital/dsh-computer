/**
 * Host-routing tests. Run: node --test test/host-router.test.mjs
 *
 * Two layers, matching the proxy suite's approach:
 *   1. the pure resolvers, asserted directly — including the malformed and
 *      hostile `Host` values a request can actually carry;
 *   2. the listener in front of a synthetic app that ECHOES what it received,
 *      which is the only way to prove the path arrives unchanged rather than
 *      merely looking right.
 *
 * The load-bearing assertion is that a root-absolute path (`/api/login`) reaches
 * the app byte-for-byte. Under the path mount that same request is the bug being
 * fixed here, so if this test ever starts failing, the feature has regressed
 * into the thing it exists to avoid.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { normalizeHost, indexHostApps, matchHostApp, unroutedResponse } from '../lib/host-router.js'
import { startHostListener } from '../lib/host-listen.js'

const app = (id, webHost, containerPort = 80) => ({ id, web: { webHost, containerPort } })

test('normalizeHost accepts the shapes a Host header legitimately takes', () => {
  assert.equal(normalizeHost('app.example.com'), 'app.example.com')
  assert.equal(normalizeHost('APP.Example.COM'), 'app.example.com')
  assert.equal(normalizeHost('app.example.com:8443'), 'app.example.com')
  assert.equal(normalizeHost('  app.example.com  '), 'app.example.com')
  assert.equal(normalizeHost('app.example.com.'), 'app.example.com')
  assert.equal(normalizeHost('[::1]:3080'), '::1')
})

test('normalizeHost refuses anything that is not a hostname', () => {
  for (const bad of [
    undefined, null, 42, '', '   ',
    'app.example.com,evil.example.com', // Host is single-valued; do not guess
    'app.example.com/path', 'app.example.com?x=1', 'app.example.com#f',
    'user@app.example.com', 'app example.com', 'app\\example.com',
    'app..example.com', '-app.example.com', 'app-.example.com',
    'app.example.com:notaport', 'über.example.com', '_dmarc.example.com',
  ]) {
    assert.equal(normalizeHost(bad), '', `expected ${JSON.stringify(bad)} to be refused`)
  }
})

test('indexHostApps keys by normalized host and carries the port', () => {
  const { byHost, problems } = indexHostApps([
    app('files', 'Files.Example.com', 8080),
    app('wiki', 'wiki.example.com'),
    { id: 'plain', web: { containerPort: 80 } }, // no webHost: not host-routed
  ])
  assert.deepEqual(problems, [])
  assert.deepEqual([...byHost.keys()].sort(), ['files.example.com', 'wiki.example.com'])
  assert.equal(byHost.get('files.example.com').id, 'files')
})

test('indexHostApps treats a duplicate hostname as an error, not a preference', () => {
  const { byHost, problems } = indexHostApps([app('one', 'a.example.com'), app('two', 'a.example.com')])
  assert.equal(byHost.has('a.example.com'), false, 'an ambiguous host must not be served')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /claimed by both 'one' and 'two'/)
})

test('indexHostApps refuses a webHost with no usable port', () => {
  const { byHost, problems } = indexHostApps([app('broken', 'b.example.com', 0), app('text', 'c.example.com', 'http')])
  assert.equal(byHost.size, 0)
  assert.equal(problems.length, 2)
  assert.match(problems.join('\n'), /not a port/)
})

test('matchHostApp matches exactly and never by suffix', () => {
  const { byHost } = indexHostApps([app('files', 'files.example.com')])
  assert.equal(matchHostApp('files.example.com', byHost).app.id, 'files')
  assert.equal(matchHostApp('FILES.example.com:443', byHost).app.id, 'files')
  // A name that merely ENDS with a routed host must not route. This is the
  // difference between a declared set and "anything DNS points here".
  for (const near of ['evil-files.example.com', 'files.example.com.evil.test', 'files.example.co']) {
    assert.equal(matchHostApp(near, byHost).app, null, `${near} must not route`)
  }
})

test('unroutedResponse names the problem and the hostnames that would work', () => {
  const { byHost } = indexHostApps([app('files', 'files.example.com')])
  const body = unroutedResponse('typo.example.com', byHost)
  assert.match(body, /no app is routed/)
  assert.match(body, /typo\.example\.com/)
  assert.match(body, /files\.example\.com/)
  // It must not echo a hostname the request invented as though it were known.
  assert.doesNotMatch(body, /hostnames that would work:.*typo/)
})

test('an empty catalog is reported as such rather than as a bad request', () => {
  const body = unroutedResponse('', new Map())
  assert.match(body, /no app declares a webHost/)
  assert.match(body, /absent or malformed/)
})

/**
 * The round trip: a synthetic app that echoes the request it received. The
 * assertions are about what the APP saw, because the whole design claim is that
 * the app sees its true address.
 */
async function withEchoApp(fn) {
  const seen = []
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, method: req.method })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url, host: req.headers.host }))
  })
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done))
  const port = upstream.address().port
  const listener = await startHostListener({
    hosts: async () => indexHostApps([app('files', 'files.example.com', port)]).byHost,
    endpointFor: async () => ({ hostAddress: '127.0.0.1', port }),
    port: 0,
  })
  try {
    const front = listener.address.port
    await fn({ front, seen })
  } finally {
    await listener.close()
    await new Promise((done) => upstream.close(() => done()))
  }
}

function request(port, { host, path, method = 'GET' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host } }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('a root-absolute path reaches the app unchanged', async () => {
  await withEchoApp(async ({ front, seen }) => {
    const res = await request(front, { host: 'files.example.com', path: '/api/login', method: 'POST' })
    assert.equal(res.status, 200)
    const echoed = JSON.parse(res.body)
    assert.equal(echoed.url, '/api/login', 'the app must see its own path, not a mount')
    // The app must not receive the public hostname: that is the harness front
    // door's name, and forwarding it invites host-header confusion.
    assert.equal(echoed.host, '127.0.0.1')
    assert.equal(seen.length, 1)
  })
})

test('a query string survives intact', async () => {
  await withEchoApp(async ({ front }) => {
    const res = await request(front, { host: 'files.example.com', path: '/api/raw?path=/a/b&x=1' })
    assert.equal(JSON.parse(res.body).url, '/api/raw?path=/a/b&x=1')
  })
})

test('a request for an unrouted host is refused, not forwarded', async () => {
  await withEchoApp(async ({ front, seen }) => {
    const res = await request(front, { host: 'typo.example.com', path: '/api/login' })
    assert.equal(res.status, 404)
    assert.match(res.body, /no app is routed/)
    assert.equal(seen.length, 0, 'nothing may reach an app for an unrouted host')
  })
})

test('Host is what routes, not the port or the interface', async () => {
  await withEchoApp(async ({ front, seen }) => {
    await request(front, { host: 'files.example.com:443', path: '/' })
    assert.equal(seen.length, 1)
    const res = await request(front, { host: '127.0.0.1', path: '/' })
    assert.equal(res.status, 404, 'a bare loopback Host must not select an app')
    assert.equal(seen.length, 1)
  })
})

test('the listener reports catalog problems instead of serving an ambiguous host', async () => {
  const { byHost, problems } = indexHostApps([app('one', 'dup.example.com'), app('two', 'dup.example.com')])
  const listener = await startHostListener({
    hosts: async () => byHost,
    endpointFor: async () => ({ hostAddress: '127.0.0.1', port: 9 }),
    port: 0,
  })
  try {
    assert.equal(problems.length, 1)
    assert.equal(byHost.has('dup.example.com'), false)
    const res = await request(listener.address.port, { host: 'dup.example.com', path: '/' })
    assert.equal(res.status, 404)
  } finally {
    await listener.close()
  }
})

test('a WebSocket upgrade is tunneled to the host-routed app, path unused', async () => {
  const received = []
  const upstream = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      received.push(chunk.toString('utf8').split('\r\n')[0])
      socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    })
  })
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done))
  const port = upstream.address().port
  const listener = await startHostListener({
    hosts: async () => indexHostApps([app('files', 'files.example.com', port)]).byHost,
    endpointFor: async () => ({ hostAddress: '127.0.0.1', port }),
    port: 0,
  })
  try {
    const socket = net.connect(listener.address.port, '127.0.0.1', () => {
      socket.write([
        'GET /websockify?token=abc HTTP/1.1',
        'Host: files.example.com',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '', '',
      ].join('\r\n'))
    })
    await new Promise((done) => setTimeout(done, 250))
    socket.destroy()
    assert.equal(received.length, 1)
    // The upgrade path is forwarded as-is; no mount is prepended anywhere.
    assert.equal(received[0], 'GET /websockify?token=abc HTTP/1.1')
  } finally {
    await listener.close()
    await new Promise((done) => upstream.close(() => done()))
  }
})

test('an upgrade for an unrouted host is dropped rather than tunneled', async () => {
  const received = []
  const upstream = net.createServer((socket) => { received.push(socket); socket.end() })
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done))
  const listener = await startHostListener({
    hosts: async () => indexHostApps([app('files', 'files.example.com', upstream.address().port)]).byHost,
    endpointFor: async () => ({ hostAddress: '127.0.0.1', port: upstream.address().port }),
    port: 0,
  })
  try {
    const socket = net.connect(listener.address.port, '127.0.0.1', () => {
      socket.write('GET /ws HTTP/1.1\r\nHost: evil.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    })
    const closed = await new Promise((done) => {
      socket.once('close', () => done(true))
      socket.once('error', () => done(true))
      setTimeout(() => done(false), 500)
    })
    assert.equal(closed, true, 'the socket must be destroyed')
    assert.equal(received.length, 0)
  } finally {
    await listener.close()
    await new Promise((done) => upstream.close(() => done()))
  }
})
