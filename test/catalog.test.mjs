import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const dir = mkdtempSync(join(tmpdir(), 'dsh-catalog-test-'))
const docker = join(dir, 'docker')
writeFileSync(docker, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
const cli = new URL('../bin/computer', import.meta.url).pathname
const source = new URL('../bin/computer', import.meta.url)
const { readFileSync } = await import('node:fs')
function list(extra = '', viewer = false) {
  const file = join(dir, 'apps.yaml')
  writeFileSync(file, `apps:\n  - id: example\n    image: fixture\n    ${viewer ? 'viewer: 6081:6080' : 'web: 8090:80'}\n${extra}\n`)
  return spawnSync('bash', [cli, 'apps', 'list', '--json'], { encoding: 'utf8', env: {
    ...process.env, PATH: `${dir}:${process.env.PATH}`, COMPUTER_BIND_IP: '127.0.0.1', COMPUTER_APPS_FILE: file,
    COMPUTER_APPS_STATE: join(dir, 'state'), DSH_HOME: dir,
  } })
}
test('catalog emits WebSocket paths and rewrite prefixes as arrays', () => {
  const out = list('    webSockets: /socket /other\n    webRewrite: /api/ /rpc/')
  assert.equal(out.status, 0, out.stderr)
  const app = JSON.parse(out.stdout).apps[0]
  assert.deepEqual(app.webSockets, ['/socket', '/other'])
  assert.deepEqual(app.webRewrite, ['/api/', '/rpc/'])
})
test('legacy viewer-only declaration receives mount and default websockify route', () => {
  const out = list('', true); assert.equal(out.status, 0, out.stderr)
  const app = JSON.parse(out.stdout).apps[0]
  assert.equal(app.web.containerPort, '6080'); assert.equal(app.web.path, '/apps/web/example/')
  assert.deepEqual(app.webSockets, ['/websockify'])
})
test('invalid paths fail in main shell before emitting JSON', () => {
  for (const line of ['webSockets: relative', 'webSockets: /bad?x=1', 'webSockets: //socket', 'webSockets: /one/../two', 'webSockets: /foo*', 'webSockets: /socket/', 'webRewrite: /api', 'webMode: invalid']) {
    const out = list(`    ${line}`); assert.equal(out.status, 1, line); assert.equal(out.stdout, '', line)
  }
})
test('conflicting viewer/web bindings fail rather than silently dropping a port', () => {
  const out = list('    web: 6081:80', true)
  assert.equal(out.status, 1); assert.ok(out.stderr.includes('disagree on container port'))
})
test('publication deduplicates shared listener across all bind shapes', () => {
  const text = readFileSync(source, 'utf8')
  const start = text.indexOf('PUBLISHED=()'), end = text.indexOf('\napp_viewer_url()', start)
  const funcs = text.slice(start, end)
  for (const [ip, count] of [['127.0.0.1', 1], ['100.1.2.3', 2], ['0.0.0.0', 1]]) {
    const script = `${funcs}\nlog(){ :; }; BIND_IP=${ip}; a=(); app_publish 6081 6080; app_publish 6081 6080; printf '%s\\n' "\${a[@]}"`
    const out = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    assert.equal(out.status, 0, out.stderr)
    assert.equal(out.stdout.trim().split('\n').filter((part) => part === '-p').length, count)
  }
})
