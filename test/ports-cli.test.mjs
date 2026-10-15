import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

test('CLI shares saved server range and reports assigned URLs for catalog web and viewer apps', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ports-cli-'))
  t.after(async () => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'dsh-ports-cli-'))); await fs.rm(root, { recursive: true, force: true }) })
  const state = path.join(root, 'state'); await fs.mkdir(state, { mode: 0o700 })
  await fs.writeFile(path.join(root, 'docker'), `#!/bin/sh
case "$*" in
  *State.Running*) echo true;;
  *State.Status*) echo running;;
  *Config.Env*) echo VNC_PASSWORD=test;;
  *'{{.Id}}'*) printf '%064d\\n' 1;;
  *) exit 1;;
esac
`, { mode: 0o755 })
  const catalog = path.join(root, 'apps.yaml')
  await fs.writeFile(catalog, 'apps:\n  - id: web\n    image: fixture\n    web: 8090:80\n  - id: viewer\n    image: fixture\n    viewer: 6081:6080\n')
  await fs.writeFile(path.join(state, 'launch-config.json'), JSON.stringify({ appAccess: 'ports', controlOrigin: 'https://harness.example', appPortStart: 21000, appPortEnd: 21009 }))
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, COMPUTER_APPS_FILE: catalog, COMPUTER_APPS_STATE: state, COMPUTER_BIND_IP: '127.0.0.1', DSH_PUBLIC_URL: 'https://harness.example' }
  for (const key of ['DSH_APPS_ACCESS', 'DSH_APPS_DOMAIN', 'DSH_APPS_CONTROL_ORIGIN', 'COMPUTER_APPS_LEGACY']) delete env[key]
  const cli = new URL('../bin/app-cli.mjs', import.meta.url).pathname
  const run = async args => (await exec(process.execPath, [cli, ...args], { env })).stdout.trim()
  const listed = JSON.parse(await run(['list', '--json'])).apps
  assert.equal(listed[0].launch.origin, 'https://harness.example:21000')
  assert.equal(listed[1].launch.origin, 'https://harness.example:21001')
  assert.equal(await run(['url', 'web']), 'https://harness.example:21000/')
  assert.match(await run(['url', 'viewer']), /^https:\/\/harness.example:21001\/vnc.html\?/)
  const status = JSON.parse(await run(['status', 'web']))
  assert.equal(status.app.launch.origin, listed[0].launch.origin)
})
