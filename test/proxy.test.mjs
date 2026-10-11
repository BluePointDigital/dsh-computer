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
import { execFileSync } from 'node:child_process'
import {
  rewriteHtml,
  rewriteCsp,
  rewriteLocation,
  scopeCookie,
  proxyHttp,
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

// --------------------------------------------------------- integration layer
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      )
    })
    req.on('error', reject)
  })
}

async function main() {
  console.log('\nproxy in front of a synthetic dashboard')

  const upstream = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/login', 'set-cookie': 'sid=1; Path=/' })
      res.end()
      return
    }
    if (req.url === '/thing.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-frame-options': 'DENY' })
      res.end(JSON.stringify({ saw: req.url }))
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

  upstream.close()
  front.close()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

await main()
