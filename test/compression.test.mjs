import http from 'node:http'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gzip, gunzipSync } from 'node:zlib'
import { proxyHttp } from '../lib/proxy.js'
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

test('normal upstream close must not abort asynchronous host compression', async (t) => {
  const backend = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<p>completed</p>'))
  const port = await listen(backend)
  const front = http.createServer((req, res) => {
    const writeHead = res.writeHead.bind(res), end = res.end.bind(res)
    let status, headers
    // Mirrors a carrier that defers its real end() while compression runs.
    res.writeHead = (code, out) => { status = code; headers = { ...out }; return res }
    res.end = (body) => {
      gzip(body, (error, compressed) => {
        if (error) { res.destroy(error); return }
        delete headers['content-length']; headers['content-encoding'] = 'gzip'
        writeHead(status, headers); end(compressed)
      })
      return res
    }
    proxyHttp(req, res, { target: { hostname: '127.0.0.1', port, path: '/' }, mount: '/apps/web/demo' })
  })
  const fp = await listen(front)
  t.after(() => { front.closeAllConnections(); front.close(); backend.closeAllConnections(); backend.close() })
  const body = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${fp}/`, (res) => {
    const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve(Buffer.concat(chunks)));res.on('error',reject)
  }).on('error',reject))
  // The proxy also opts the embedded document out of translation, hence the meta.
  assert.equal(gunzipSync(body).toString(), '<meta name="google" content="notranslate"><p>completed</p>')
})
