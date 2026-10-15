import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { WebSocket } from 'ws'
import { RuntimeConsole } from '../lib/runtime-console.js'
const CID = 'a'.repeat(64), EID = 'b'.repeat(64)
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

test('terminal is real TTY Docker exec, relays input/output, resizes and drains on close', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-terminal-'))
  const socketPath = path.join(root, 'docker.sock'), old = process.env.DOCKER_HOST
  process.env.DOCKER_HOST = 'unix://' + socketPath
  const calls = [], sockets = new Set()
  const daemon = http.createServer((req, res) => {
    let text = ''; req.on('data', b => { text += b }); req.on('end', () => {
      calls.push({ path: req.url, body: text ? JSON.parse(text) : undefined })
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.url.endsWith('/exec') ? { Id: EID } : {}))
    })
  })
  daemon.on('upgrade', (req, socket) => {
    calls.push({ path: req.url, upgrade: true })
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
    socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n')
    socket.on('data', b => socket.write(Buffer.from('echo:' + b.toString())))
  })
  await new Promise(resolve => daemon.listen(socketPath, resolve))
  const inventory = { resolve: async () => ({ containerId: CID, info: { State: { Running: true } } }) }
  const console = new RuntimeConsole({ inventory })
  const front = http.createServer()
  front.on('upgrade', (req, socket, head) => console.upgrade(req, socket, head, new URL(req.url, 'http://control.test')).catch(() => socket.destroy()))
  const port = await listen(front)
  t.after(async () => {
    console.close(); for (const socket of sockets) socket.destroy()
    await new Promise(resolve => front.close(resolve)); await new Promise(resolve => daemon.close(resolve))
    if (old === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = old
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'dsh-terminal-'))); await fs.rm(root, { recursive: true, force: true })
  })
  const ws = new WebSocket(`ws://127.0.0.1:${port}/apps/terminal?id=demo&container=${CID}`)
  let ready
  const readyPromise = new Promise(resolve => { ready = resolve })
  const output = new Promise(resolve => ws.on('message', raw => { const msg = JSON.parse(raw); if (msg.type === 'ready') ready(); if (msg.type === 'output') resolve(msg.data) }))
  await readyPromise
  ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }))
  ws.send(JSON.stringify({ type: 'input', data: 'hello\r' }))
  assert.equal(await output, 'echo:hello\r')
  assert.equal(calls[0].path, `/containers/${CID}/exec`)
  assert.equal(calls[0].body.Tty, true); assert.equal(calls[0].body.AttachStdin, true)
  assert.deepEqual(calls[0].body.Cmd, ['/bin/sh'])
  await new Promise(resolve => { if (calls.some(c => c.path.includes('/resize'))) return resolve(); daemon.on('request', req => { if (req.url.includes('/resize')) resolve() }) })
  assert.ok(calls.some(c => c.path === `/exec/${EID}/resize?w=100&h=30`))
  const ended = new Promise(resolve => ws.once('close', resolve))
  console.close(); await ended
  assert.equal(console.sessions.size, 0)
})

test('disconnect during exec creation aborts pending Docker request and closes tracked session', async () => {
  const ws = new EventEmitter(); ws.readyState = WebSocket.OPEN; ws.close = () => { ws.readyState = WebSocket.CLOSED; ws.emit('close') }
  let started
  const creating = new Promise(resolve => { started = resolve })
  const console = new RuntimeConsole({ inventory: {}, api: async (_method, _path, _body, options) => {
    started()
    await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }))
  } })
  const task = console.terminal(ws, CID, '/bin/sh')
  await creating; ws.close(); await task
  assert.equal(console.sessions.size, 0)
  console.close()
})

test('logs stream both channels and disconnect kills follower; download is finite', async t => {
  const children = [], inventory = { resolve: async () => ({ containerId: CID }) }
  const console = new RuntimeConsole({ inventory, spawnProcess: (_bin, args) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.args = args; child.stopped = new Promise(resolve => { child.kill = () => { child.killed = true; resolve() } }); children.push(child); return child
  } })
  const front = http.createServer((req, res) => console.logs(req, res, new URL(req.url, 'http://test')).catch(() => res.writeHead(500).end()))
  const port = await listen(front)
  t.after(async () => { console.close(); front.closeAllConnections(); await new Promise(resolve => front.close(resolve)) })
  const response = new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/logs?id=demo`, res => {
      let output = ''
      res.on('data', chunk => { output += chunk.toString(); if (!output.includes('hello')) return; assert.ok(output.includes('€')); assert.ok(!output.includes('�')); res.destroy(); resolve() })
    }).on('error', reject)
  })
  await new Promise(resolve => front.once('request', () => setImmediate(resolve)))
  const euro = Buffer.from('€')
  children[0].stdout.write(euro.subarray(0, 1)); children[0].stdout.write(euro.subarray(1))
  children[0].stdout.write('hello\n')
  await response
  assert.ok(children[0].args.includes('--follow'))
  await children[0].stopped
  assert.equal(children[0].killed, true)
  const download = new Promise(resolve => http.get(`http://127.0.0.1:${port}/logs?id=demo&download=1`, res => { let text = ''; res.on('data', b => { text += b }); res.on('end', () => resolve({ text, disposition: res.headers['content-disposition'] })) }))
  await new Promise(resolve => front.once('request', () => setImmediate(resolve)))
  children[1].stderr.write('error line\n'); children[1].emit('close', 0)
  assert.equal((await download).text, 'error line\n')
  assert.ok(!children[1].args.includes('--follow'))
})
