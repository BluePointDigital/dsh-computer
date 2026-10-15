#!/usr/bin/env node
/** Install a pinned verified Compose CLI plugin in private persistent tool storage. */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const version = 'v2.40.3'
const arch = { x64: 'x86_64', arm64: 'aarch64' }[os.arch()]
if (os.platform() !== 'linux' || !arch) throw Error('Compose provisioning supports Linux x64 and arm64')
const root = path.resolve(process.env.DSH_HOME || os.homedir(), 'tools/docker')
if (root.startsWith('/workspace/')) throw Error('Tool binaries must stay outside the synced workspace')
const directory = path.join(root, 'cli-plugins')
await fs.mkdir(directory, { recursive: true, mode: 0o700 })
const asset = `docker-compose-linux-${arch}`
const base = `https://github.com/docker/compose/releases/download/${version}`
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw Error(`Compose download failed (${response.status})`)
  return Buffer.from(await response.arrayBuffer())
}
const checksums = (await get(`${base}/checksums.txt`)).toString()
const expected = checksums.split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1]?.replace(/^\*/, '') === asset)?.[0]
if (!/^[a-f0-9]{64}$/.test(expected || '')) throw Error('Compose checksum entry missing')
const binary = await get(`${base}/${asset}`)
if (createHash('sha256').update(binary).digest('hex') !== expected) throw Error('Compose checksum mismatch')
const temp = path.join(directory, `compose-${randomUUID()}.tmp`)
await fs.writeFile(temp, binary, { flag: 'wx', mode: 0o755 })
await fs.rename(temp, path.join(directory, 'docker-compose'))
const result = execFileSync('docker', ['compose', 'version', '--short'], { env: { ...process.env, DOCKER_CONFIG: root }, encoding: 'utf8' }).trim()
if (!result.startsWith('2.')) throw Error('Compose v2 validation failed')
console.log(`Docker Compose ${result} installed and verified; DOCKER_CONFIG=${root}`)
