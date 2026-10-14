/**
 * The output contract, tested against the REAL AppManager.
 *
 * This file exists because a fake manager hid two real bugs, both found on the
 * live instance 2026-10-14 after the tool was invoked for real:
 *
 *   1. `manager.prepare()` also returns FAILED jobs, where `job.approval` is
 *      absent. Copying it into the output produced `approvalHash: undefined`,
 *      which the runtime rejects with `value is not lossless JSON` — *after* the
 *      tool had already created the failed job, so the caller saw a validation
 *      error and never learned the job id.
 *   2. The same failed job was reported as `ok: true` with "Prepared for review",
 *      claiming success when nothing had been prepared. The fake manager only
 *      ever returned `state: 'review'`, so it could not see either.
 *
 * A hand-built fake returning one happy shape is not a test of a real seam. This
 * one drives `AppManager` through a mocked docker so the real state machine runs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildProposalTool } from '../lib/index.js'
import { AppManager } from '../lib/app-manager.js'

// Resolved from the DSH installation, not this repository (which declares no
// @deepseek-ai dependency). Same technique as propose-program.test.mjs.
function installedDefineTool() {
  const entry = readdirSync('/opt/dsh/node_modules/.pnpm').find((name) => name.startsWith('@deepseek-ai+dsh-tools@'))
  if (!entry) return null
  const module = `/opt/dsh/node_modules/.pnpm/${entry}/node_modules/@deepseek-ai/dsh-tools/lib/index.js`
  return import(pathToFileURL(module).href).then((m) => m.defineTool)
}
const defineTool = await installedDefineTool()

/**
 * Mirrors the sequence the live failure actually took: no such container, image
 * not local, pull fails. (A docker that fails the FIRST inspect makes prepare()
 * throw instead, which is a different path and not the bug being pinned.)
 */
const failingDocker = async (args) => {
  if (args[0] === 'inspect') return { code: 1, stdout: '', stderr: 'Error: No such container' }
  if (args[0] === 'image' && args[1] === 'inspect') return { code: 1, stdout: '', stderr: 'Error: No such image' }
  if (args[0] === 'pull') return { code: 1, stdout: '', stderr: 'manifest unknown' }
  return { code: 1, stdout: '', stderr: 'unexpected docker call' }
}

/** A docker that resolves an image, so prepare() reaches the review state. */
const resolvingDocker = async (args) => {
  if (args[0] === 'inspect') return { code: 1, stdout: '', stderr: 'Error: No such container' }
  if (args[0] === 'image' && args[1] === 'inspect') {
    return { code: 0, stdout: JSON.stringify([{ Id: `sha256:${'a'.repeat(64)}`, Config: { Volumes: null } }]), stderr: '' }
  }
  return { code: 1, stdout: '', stderr: 'unexpected docker call' }
}

async function withStateRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-proposal-'))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

const args = { id: 'probe', image: 'example.test/thing:1', task: 'probe: no such command', webPort: 8080 }

test('a prepare that FAILS stays lossless JSON and does not claim success', async () => {
  await withStateRoot(async (root) => {
    const tool = buildProposalTool(defineTool, new AppManager({ root, docker: failingDocker }), () => {})
    const result = await tool.execute(args, { agent: { id: 'session-probe' } })

    // The exact failure the live instance produced: an undefined optional field.
    assert.equal(Object.values(result).some((value) => value === undefined), false,
      'no property may be undefined — that is what "not lossless JSON" meant')
    assert.equal(JSON.stringify(result), JSON.stringify(JSON.parse(JSON.stringify(result))),
      'the output must survive a JSON round-trip unchanged')

    assert.equal(result.state, 'failed')
    assert.equal(result.ok, false, 'a failed prepare is not a success')
    assert.equal(Object.hasOwn(result, 'approvalHash'), false, 'no approval exists, so no approval hash')
    assert.match(result.failure, /Image download failed/)
    assert.match(result.next, /No approval is possible/)
    // The job id must still reach the caller: it is how the failure is inspected.
    assert.match(result.jobId, /^[a-f0-9-]{36}$/)
  })
})

test('a prepare that SUCCEEDS reports review with its approval hash', async () => {
  await withStateRoot(async (root) => {
    const tool = buildProposalTool(defineTool, new AppManager({ root, docker: resolvingDocker }), () => {})
    const result = await tool.execute(args, { agent: { id: 'session-probe' } })

    assert.equal(result.ok, true)
    assert.equal(result.state, 'review')
    assert.match(result.approvalHash, /^[a-f0-9]{64}$/)
    assert.equal(Object.hasOwn(result, 'failure'), false)
    assert.match(result.next, /Prepared for review/)
    assert.equal(Object.values(result).some((value) => value === undefined), false)
  })
})

test('unknowns are reported before any manager is touched', async () => {
  const manager = { prepare: () => { throw new Error('prepare must not be called while a required unknown remains') } }
  const tool = buildProposalTool(defineTool ?? ((definition) => definition), manager, () => {})
  // Omit the key entirely: the model cannot send `undefined` either — passing it
  // fails argument validation before the body runs.
  const result = await tool.execute({ id: 'probe', image: 'example.test/thing:1', task: 'probe: no such command' }, { agent: { id: 's' } })

  assert.equal(result.ok, false)
  assert.equal(result.ready, false)
  assert.equal(Object.hasOwn(result, 'jobId'), false)
  assert.deepEqual(result.unknowns.filter((u) => u.required).map((u) => u.field), ['webPort'])
  assert.equal(JSON.stringify(result), JSON.stringify(JSON.parse(JSON.stringify(result))))
})
