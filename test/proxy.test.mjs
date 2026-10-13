/**
 * Proxy tests. Run: node test/proxy.test.mjs
 *
 * Two layers, deliberately:
 *   1. the pure rewriters, asserted directly;
 *   2. the whole proxy in front of a synthetic dashboard that behaves like the
 *      awkward ones (root-absolute assets, X-Frame-Options, CSP frame-ancestors,
 *      a Path=/ cookie, a root-absolute redirect);
 *   3. the same proxy in front of the real `whoami` container, which echoes the
 *      request it received — the only way to prove the mount is actually
 *      stripped rather than merely looking right.
 */
import http from 'node:http'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import net from 'node:net'
import { gzipSync, gunzipSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import {
  rewriteHtml,
  embedToken,
  rewriteJs,
  rewriteCsp,
  rewriteLocation,
  scopeCookie,
  proxyHttp,
  proxyUpgrade,
  featuresFor,
  FEATURES_HEADER,
  mountFor,
} from '../lib/proxy.js'

const MOUNT = '/apps/web/demo'
let pass = 0
let fail = 0

function check(name, fn) {
  try {
    fn()
    console.log(`  ok    ${name}`)
    pass += 1
  } catch (error) {
    console.log(`  FAIL  ${name}\n        ${error.message}`)
    fail += 1
  }
}

// ---------------------------------------------------------------- pure layer
console.log('pure rewriters')

check('mountFor builds the app mount', () => {
  assert.equal(mountFor('demo'), '/apps/web/demo')
})

check('rewriteHtml re-points root-absolute src/href/action', () => {
  const out = rewriteHtml(
    '<script src="/a.js"></script><a href="/b">x</a><form action="/c">',
    MOUNT,
  )
  assert.match(out, /src="\/apps\/web\/demo\/a\.js"/)
  assert.match(out, /href="\/apps\/web\/demo\/b"/)
  assert.match(out, /action="\/apps\/web\/demo\/c"/)
})

check('rewriteHtml leaves protocol-relative URLs alone', () => {
  const out = rewriteHtml('<script src="//cdn.example/a.js"></script>', MOUNT)
  assert.match(out, /src="\/\/cdn\.example\/a\.js"/)
})

check('rewriteHtml re-points inline CSS url()', () => {
  const out = rewriteHtml('<style>body{background:url(/bg.png)}</style>', MOUNT)
  assert.match(out, /url\(\/apps\/web\/demo\/bg\.png\)/)
})

check('embed token versions script/style URLs so immutable bundles cannot mask a config change', () => {
  const out = rewriteHtml(
    '<script src="/assets/a.js"></script><link href="/assets/a.css?v=1" rel="stylesheet">'
    + '<link href="/assets/a.css#x" rel="stylesheet"><a href="/page">p</a><form action="/api/submit">',
    MOUNT,
    'tok123',
  )
  assert.match(out, /src="\/apps\/web\/demo\/assets\/a\.js\?dsha=tok123"/)
  assert.match(out, /href="\/apps\/web\/demo\/assets\/a\.css\?v=1&dsha=tok123"/)
  assert.match(out, /href="\/apps\/web\/demo\/assets\/a\.css\?dsha=tok123#x"/)
  // Navigation and API endpoints keep their exact paths.
  assert.match(out, /href="\/apps\/web\/demo\/page"/)
  assert.match(out, /action="\/apps\/web\/demo\/api\/submit"/)
})

check('embed token is omitted when absent and never touches non-asset URLs', () => {
  const plain = rewriteHtml('<script src="/assets/a.js"></script>', MOUNT)
  assert.match(plain, /src="\/apps\/web\/demo\/assets\/a\.js"/)
  assert.ok(!plain.includes('dsha='))
})

check('embed token changes with mount configuration and is otherwise stable', () => {
  const base = { containerId: 'abc', port: 3002, path: '/', sockets: ['/websockify'], prefixes: ['/api/'] }
  const first = embedToken(base)
  assert.equal(embedToken({ ...base }), first, 'same configuration must keep cached bundles valid')
  assert.notEqual(embedToken({ ...base, prefixes: [] }), first, 'rewrite change must version assets')
  assert.notEqual(embedToken({ ...base, sockets: [] }), first, 'socket change must version assets')
  assert.notEqual(embedToken({ ...base, containerId: 'def' }), first, 'different container must not share a token')
  assert.match(first, /^[a-f0-9]{10}$/)
})

check('rewriteCsp drops frame-ancestors and keeps the rest', () => {
  const out = rewriteCsp("default-src 'self'; frame-ancestors 'none'; img-src *")
  assert.ok(!/frame-ancestors/i.test(out), 'frame-ancestors survived')
  assert.match(out, /default-src 'self'/)
  assert.match(out, /img-src \*/)
})

check('rewriteLocation prefixes a root-absolute redirect', () => {
  assert.equal(rewriteLocation('/login', MOUNT), '/apps/web/demo/login')
})

check('rewriteLocation is idempotent inside the mount', () => {
  assert.equal(rewriteLocation('/apps/web/demo/login', MOUNT), '/apps/web/demo/login')
})

check('rewriteLocation maps the upstream origin into the mount', () => {
  assert.equal(
    rewriteLocation('http://10.0.0.5/a?b=1#c', MOUNT, '10.0.0.5'),
    '/apps/web/demo/a?b=1#c',
  )
})

check('rewriteLocation leaves foreign origins alone', () => {
  assert.equal(rewriteLocation('https://example.com/a', MOUNT, '10.0.0.5'), 'https://example.com/a')
})

check('scopeCookie scopes an existing Path=/', () => {
  assert.equal(scopeCookie('sid=abc; Path=/; HttpOnly', MOUNT), 'sid=abc; Path=/apps/web/demo/; HttpOnly')
})

check('scopeCookie adds a Path when the app set none', () => {
  assert.equal(scopeCookie('sid=abc', MOUNT), 'sid=abc; Path=/apps/web/demo/')
})

check('scopeCookie preserves a sub-path scope', () => {
  assert.equal(scopeCookie('sid=abc; Path=/sub', MOUNT), 'sid=abc; Path=/apps/web/demo/sub')
})

check('featuresFor advertises only what the mount can do', () => {
  assert.equal(featuresFor(), '')
  assert.equal(featuresFor({ js: true, ws: false }), 'js')
  assert.equal(featuresFor({ js: true, ws: true }), 'js ws')
  assert.equal(featuresFor({ js: false, ws: true }), 'ws')
})

check('JS rewrite is opt-in, prefix-scoped and idempotent across quote forms', () => {
  const source = 'fetch("/api/x");fetch(\'/rpc/y\');fetch(`/api/z`);const p="/music/a";const u="https://other/api/x";const c="//cdn/api/y"'
  assert.equal(rewriteJs(source, MOUNT), source)
  const out = rewriteJs(source, MOUNT, ['/api/', '/rpc/'])
  assert.ok(out.includes('"/apps/web/demo/api/x"'))
  assert.ok(out.includes("'/apps/web/demo/rpc/y'"))
  assert.ok(out.includes('`/apps/web/demo/api/z`'))
  assert.ok(out.includes('"/music/a"'))
  assert.ok(out.includes('"https://other/api/x"'))
  assert.ok(out.includes('"//cdn/api/y"'))
  assert.equal(rewriteJs(out, MOUNT, ['/api/', '/rpc/']), out)
})

// --------------------------------------------------------- integration layer
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          raw: Buffer.concat(chunks),
        }),
      )
    })
    req.on('error', reject)
  })
}

// ------------------------------------------------------------------ WebSocket
/**
 * A real RFC 6455 echo endpoint, so the upgrade path is exercised as a socket
 * and not merely as a header rewrite. `saw` records the request line the
 * upstream received, which is how we prove the mount was stripped.
 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function websocketServer() {
  const seen = []
  let echoSocket
  const server = http.createServer((_req, res) => res.writeHead(404).end())
  server.on('upgrade', (req, socket) => {
    seen.push(req.url)
    const key = req.headers['sec-websocket-key']
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    echoSocket = socket
    socket.on('data', (buf) => {
      // Minimal unmask for a short masked text frame; enough to prove bytes flow.
      const masked = (buf[1] & 0x80) === 0x80
      const len = buf[1] & 0x7f
      const mask = masked ? buf.subarray(2, 6) : null
      const payload = buf.subarray(masked ? 6 : 2, (masked ? 6 : 2) + len)
      const out = Buffer.from(payload)
      if (mask) for (let i = 0; i < out.length; i += 1) out[i] ^= mask[i % 4]
      // Echo as unmasked text (server frames must not be masked).
      socket.write(Buffer.concat([Buffer.from([0x81, out.length]), out]))
    })
    socket.on('error', () => {})
  })
  return { server, seen, hasSocket: () => echoSocket !== undefined }
}

function upgradeThrough(port, path) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64')
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    })
    req.on('upgrade', (res, socket) => {
      assert.equal(
        res.headers['sec-websocket-accept'],
        crypto.createHash('sha1').update(key + WS_GUID).digest('base64'),
        'accept key mismatch — the upstream did not complete the handshake',
      )
      const masked = Buffer.alloc(6)
      const payload = Buffer.from('ping')
      masked[0] = 0x81
      masked[1] = 0x80 | payload.length
      const mask = crypto.randomBytes(4)
      mask.copy(masked, 2)
      const body = Buffer.from(payload)
      for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4]
      socket.write(Buffer.concat([masked, body]))
      socket.once('data', (reply) => {
        socket.destroy()
        resolve(reply)
      })

    })
    req.on('error', reject)
    req.end()
  })
}

async function main() {
  console.log('\nproxy in front of a synthetic dashboard')

  const upstream = http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: first\n\n')
      return
    }
    if (req.url === '/app.js' || req.url === '/encoded.js') {
      const text = 'fetch("/api/projects");new EventSource("/api/events")'
      const encoded = req.url === '/encoded.js'
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'public, max-age=31536000, immutable', etag: '"original"', ...(encoded ? { 'content-encoding': 'gzip' } : {}) })
      res.end(encoded ? gzipSync(text) : text)
      return
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/login', 'set-cookie': 'sid=1; Path=/' })
      res.end()
      return
    }
    if (req.url === '/thing.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-frame-options': 'DENY' })
      res.end(JSON.stringify({ saw: req.url, ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}), ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) }))
      return
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      'set-cookie': 'sid=xyz; Path=/',
    })
    res.end(`<html><head><script src="/app.js"></script></head><body>saw ${req.url}</body></html>`)
  })
  const upstreamPort = await listen(upstream)

  const front = http.createServer((req, res) => {
    const rest = req.url.startsWith(MOUNT) ? req.url.slice(MOUNT.length) || '/' : req.url
    proxyHttp(req, res, {
      target: { hostname: '127.0.0.1', port: upstreamPort, path: rest },
      mount: MOUNT,
      marker: 'demo',
      features: featuresFor({ js: true, ws: true }),
      rewritePrefixes: ['/api/'],
    })
  })
  const frontPort = await listen(front)

  const html = await get(frontPort, `${MOUNT}/dash`)
  check('HTML body: the mount is stripped before forwarding', () => {
    assert.match(html.body, /saw \/dash/)
  })
  check('HTML body: root-absolute asset is re-pointed', () => {
    assert.match(html.body, /src="\/apps\/web\/demo\/app\.js"/)
  })
  check('HTML body: content-length matches the rewritten body', () => {
    assert.equal(Number(html.headers['content-length']), Buffer.byteLength(html.body))
  })
  check('header: x-frame-options removed', () => {
    assert.equal(html.headers['x-frame-options'], undefined)
  })
  check('header: CSP kept but frame-ancestors dropped', () => {
    const csp = String(html.headers['content-security-policy'])
    assert.ok(!/frame-ancestors/i.test(csp), 'frame-ancestors survived')
    assert.match(csp, /default-src/)
  })
  check('header: cookie scoped to the mount', () => {
    assert.equal(html.headers['set-cookie'][0], 'sid=xyz; Path=/apps/web/demo/')
  })
  check('header: proxy marker present (how the client knows the route is mounted)', () => {
    assert.equal(html.headers['x-dsh-app-proxy'], 'demo')
  })
  check('header: capability list tells the client what the mount can carry', () => {
    assert.equal(html.headers['x-dsh-app-proxy-features'], 'js ws')
  })

  const redirect = await get(frontPort, `${MOUNT}/redirect`)
  check('redirect: Location rewritten into the mount', () => {
    assert.equal(redirect.headers.location, '/apps/web/demo/login')
  })

  const json = await get(frontPort, `${MOUNT}/thing.json`)
  check('non-HTML: body is streamed through untouched', () => {
    assert.deepEqual(JSON.parse(json.body), { saw: '/thing.json' })
  })
  check('non-HTML: frame headers still stripped', () => {
    assert.equal(json.headers['x-frame-options'], undefined)
  })

  const credentials = await get(frontPort, `${MOUNT}/thing.json`, { cookie: 'dsh-auth-test=secret; app=keep', authorization: 'Basic frontdoor' })
  check('HTTP consumes harness credentials without dropping app cookies', () => {
    const body = JSON.parse(credentials.body)
    assert.equal(body.authorization, undefined)
    assert.equal(body.cookie.trim(), 'app=keep')
  })
  const js = await get(frontPort, `${MOUNT}/app.js`)
  check('JS body: configured API literals are rewritten and length recomputed', () => {
    assert.ok(js.body.includes('fetch("/apps/web/demo/api/projects")'))
    assert.equal(Number(js.headers['content-length']), js.raw.length)
    assert.equal(js.headers.etag, undefined)
    assert.equal(js.headers['cache-control'], 'no-store')
  })
  const encoded = await get(frontPort, `${MOUNT}/encoded.js`)
  check('gzip JS stays byte-safe and unrewritten', () => {
    assert.equal(gunzipSync(encoded.raw).toString(), 'fetch("/api/projects");new EventSource("/api/events")')
  })
  const sse = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(); reject(new Error('SSE buffered')) }, 2000)
    const req = http.get({ host: '127.0.0.1', port: frontPort, path: `${MOUNT}/events` }, (res) => {
      res.once('data', (data) => { clearTimeout(timer); req.destroy(); resolve(data.toString()) })
    })
    req.on('error', reject)
  })
  check('SSE emits first event without waiting for stream completion', () => assert.equal(sse, 'data: first\n\n'))

  // ------------------------------------------- real upstream (whoami)
  let containerIp
  try {
    containerIp = execFileSync(
      'docker',
      ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', 'dsh-app-whoami'],
      { encoding: 'utf8' },
    ).trim()
  } catch {
    containerIp = ''
  }

  if (containerIp === '') {
    console.log('\nreal upstream (whoami): SKIPPED — container not running')
  } else {
    console.log('\nproxy in front of the real whoami container')
    const realMount = '/apps/web/whoami'
    const realFront = http.createServer((req, res) => {
      const rest = req.url.startsWith(realMount) ? req.url.slice(realMount.length) || '/' : req.url
      proxyHttp(req, res, {
        target: { hostname: containerIp, port: 80, path: rest },
        mount: realMount,
      })
    })
    const realPort = await listen(realFront)

    const deep = await get(realPort, `${realMount}/a/b/c?x=1`)
    check('whoami: it received the path WITHOUT the mount prefix', () => {
      assert.match(deep.body, /GET \/a\/b\/c\?x=1/, `whoami said:\n${deep.body}`)
    })
    check('whoami: the mount prefix does not appear in the request line', () => {
      assert.ok(!/GET \/apps\/web\/whoami/.test(deep.body))
    })

    realFront.close()
  }

  // --------------------------------------------------- WebSocket upgrade path
  console.log('\nWebSocket upgrade through the mount')

  const ws = websocketServer()
  const wsPort = await listen(ws.server)

  // The front mirrors what lib/index.js does: ONE EXACT upgrade route per
  // declared path, because the host webserver matches upgrades by exact
  // pathname and a prefix route cannot own a socket.
  const wsFront = http.createServer((_req, res) => res.writeHead(404).end())
  const wsMount = '/apps/web/demo'
  wsFront.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://x').pathname
    if (pathname === `${wsMount}/websockify`) {
      proxyUpgrade(req, socket, head, {
        target: { hostname: '127.0.0.1', port: wsPort, path: '/websockify' },
        mount: wsMount,
      })
      return
    }
    socket.destroy()
  })
  const wsFrontPort = await listen(wsFront)

  const reply = await upgradeThrough(wsFrontPort, `${wsMount}/websockify?token=abc`)
  check('upgrade: the handshake completes through the proxy', () => {
    assert.equal(reply[0] & 0x0f, 0x1, 'expected a text frame back')
  })
  check('upgrade: the echoed payload survives both directions', () => {
    assert.equal(reply.subarray(2, 2 + (reply[1] & 0x7f)).toString('utf8'), 'ping')
  })
  check('upgrade: the mount is stripped, query string preserved', () => {
    assert.equal(ws.seen[0], '/websockify?token=abc', `upstream saw ${ws.seen[0]}`)
  })
  await new Promise((resolve) => {
    const socket = net.connect(wsFrontPort, '127.0.0.1', () => {
      socket.write(
        'GET /apps/web/demo/other HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\n' +
          'Upgrade: websocket\r\nSec-WebSocket-Key: aaaa\r\nSec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    socket.on('close', resolve)
    socket.on('error', resolve)
  })
  check('upgrade: undeclared paths never reach the app', () => {
    assert.equal(ws.seen.length, 1, `upstream saw ${ws.seen.length} upgrades`)
  })

  wsFront.close()
  ws.server.close()

  upstream.close()
  front.close()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

await main()
