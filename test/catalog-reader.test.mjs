import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Catalog, readCatalog, readDefinitions } from '../lib/catalog.js'

async function fixture(t, text) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-catalog-reader-'))
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('dsh-catalog-reader-')); await fs.rm(root, { recursive: true, force: true }) })
  const file = path.join(root, 'explicit.yaml')
  await fs.writeFile(file, text)
  return { root, file, env: { COMPUTER_APPS_FILE: file, COMPUTER_APPS_STATE: root, COMPUTER_BIND_IP: '127.0.0.1', PATH: '/nonexistent' } }
}
const entry = extra => `version: 1\napps:\n  - id: example\n    image: fixture\n${extra}\n`

test('reader emits legacy-compatible web metadata without Docker or subprocesses', async t => {
  const options = await fixture(t, entry('    name: "Example App"\n    web: 8090:80\n    webSockets: /socket /other\n    webRewrite: /api/ /rpc/\n    webHost: Files.Example.COM\n    customNote: preserved\n    containerId: spoofed\n    managed: true\n    project: arbitrary-project\n    services: fabricated\n    command: echo private\n    password: private\n    environment: private'))
  const [app] = await readCatalog(options)
  assert.equal(app.state, 'new'); assert.equal(app.source, 'catalog')
  assert.equal(app.name, 'Example App'); assert.equal(app.customNote, 'preserved')
  assert.deepEqual(app.webSockets, ['/socket', '/other']); assert.deepEqual(app.webRewrite, ['/api/', '/rpc/'])
  assert.equal(app.webPort, 80); assert.equal(app.webPath, '/')
  assert.deepEqual(app.web, { hostPort: '8090', containerPort: '80', path: '/apps/web/example/', mode: 'proxy', url: 'http://127.0.0.1:8090/', webHost: 'Files.Example.COM' })
  for (const field of ['command', 'password', 'environment', 'containerId', 'managed', 'project', 'services']) assert.equal(Object.hasOwn(app, field), false)
  assert.equal((await readDefinitions(options))[0].command, 'echo private')
})

test('viewer-only mapping and single-port defaults remain compatible, no password lookup', async t => {
  const options = await fixture(t, entry('    viewer: 6081\n    webMode: direct'))
  options.env.COMPUTER_PUBLIC_URL = 'https://desktop.example.com/'
  const [app] = await readCatalog(options)
  assert.equal(app.web.containerPort, '6080'); assert.equal(app.web.hostPort, '6081')
  assert.equal(app.web.mode, 'direct'); assert.deepEqual(app.webSockets, ['/websockify'])
  assert.equal(app.viewer.url, 'https://desktop.example.com/vnc.html?autoconnect=1&resize=scale')
  assert.equal(app.web.url, app.viewer.url); assert.equal(Object.hasOwn(app.viewer, 'password'), false)
  await fs.writeFile(options.file, entry('    web: 8090'))
  assert.equal((await readCatalog(options))[0].web.containerPort, '80')
})

test('all historical autostart aliases and defaults retain semantics', async t => {
  const options = await fixture(t, entry(''))
  for (const [value, expected] of [['', false], ['true', true], ['yes', true], ['1', true], ['false', false], ['no', false], ['0', false]]) {
    await fs.writeFile(options.file, entry(value ? `    autostart: ${value}` : ''))
    assert.equal((await readCatalog(options))[0].autostart, expected, value)
  }
})

test('flat compatibility: comments, quoted text, CRLF, numeric ID strings and inert fields', async t => {
  const options = await fixture(t, 'version: 1\r\napps:\r\n  - id: 123\r\n    name: "Numeric App" # comment\r\n    command: sleep infinity\r\n    custom: value # ignored\r\n')
  const [app] = await readCatalog(options)
  assert.equal(app.id, '123'); assert.equal(app.name, 'Numeric App'); assert.equal(app.custom, 'value')
  assert.equal(app.web, undefined)
})

test('invalid IDs, booleans, paths, port mappings and structure throw instead of becoming an empty catalog', async t => {
  const options = await fixture(t, entry(''))
  const invalid = [
    entry('    autostart: perhaps'), entry('    webMode: invalid'), entry('    web: 0:80'), entry('    web: 8090:65536'), entry('    web: 127.0.0.1:8090:80'), entry('    viewer: 6081:6080\n    web: 6081:80'),
    ...['relative', '/bad?x=1', '//socket', '/one/../two', '/foo*', '/socket/'].map(value => entry(`    webSockets: ${value}`)),
    entry('    webRewrite: /api'), entry('    webPath: /../private'), entry('    webHost: files.example.com'),
    ...['https://files.example.com', 'files.example.com:8080', 'files.example.com/path', 'files example.com', '-bad.example.com', 'über.example.com'].map(value => entry(`    web: 8090:80\n    webHost: ${value}`)),
    'apps:\n  - id: Bad_ID\n', 'apps:\n  - id: one\n  - id: one\n', 'apps:\n  - image: fixture\n', 'apps:\n', 'apps:\n  - id: fixture\n    broken\n', 'apps:\n  - id: fixture\n    image: first\n    image: second\n',
    'apps:\n  - id: one\n    web: 8090:80\n    webHost: files.example.com\n  - id: two\n    web: 8091:80\n    webHost: FILES.example.com.\n',
  ]
  const reader = new Catalog(options)
  for (const text of invalid) { await fs.writeFile(options.file, text); await assert.rejects(reader.list(), undefined, text) }
})

test('stat cache refreshes edits and atomic replacements, isolates callers, never caches malformed data', async t => {
  const options = await fixture(t, entry('    name: First'))
  const reader = new Catalog(options)
  const first = await reader.list(); first[0].name = 'Caller mutation'
  const definitions = await reader.readDefinitions(); definitions[0].name = 'Private mutation'
  assert.equal((await reader.list())[0].name, 'First')
  await fs.writeFile(options.file, entry('    name: Changed name'))
  assert.equal((await reader.list())[0].name, 'Changed name')
  const replacement = path.join(options.root, 'replacement.yaml')
  await fs.writeFile(replacement, entry('    name: Replacement'))
  assert.equal(path.resolve(options.file), path.join(options.root, 'explicit.yaml'))
  await fs.rename(replacement, options.file)
  assert.equal((await reader.list())[0].name, 'Replacement')
  await fs.writeFile(options.file, 'apps:\nmalformed')
  await assert.rejects(reader.list()); await assert.rejects(reader.list())
  await fs.writeFile(options.file, entry('    name: Recovered'))
  assert.equal((await reader.list())[0].name, 'Recovered')
})

test('durable seed honors provided env root and does not rewrite operator catalog', async t => {
  const options = await fixture(t, entry(''))
  delete options.env.COMPUTER_APPS_FILE
  delete options.root
  const reader = new Catalog(options)
  assert.ok((await reader.list()).length > 0)
  const durable = path.join(options.env.COMPUTER_APPS_STATE, 'catalog.yaml')
  await fs.writeFile(durable, entry('    name: Operator catalog\n    command: keep private'))
  const before = await fs.stat(durable)
  assert.equal((await reader.list())[0].name, 'Operator catalog')
  assert.equal(await fs.readFile(durable, 'utf8'), entry('    name: Operator catalog\n    command: keep private'))
  assert.equal((await fs.stat(durable)).mtimeMs, before.mtimeMs)
  await fs.writeFile(durable, 'apps:\n  broken')
  await assert.rejects(reader.list())
  assert.equal(await fs.readFile(durable, 'utf8'), 'apps:\n  broken')
})
