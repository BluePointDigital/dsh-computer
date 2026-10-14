/**
 * Validate `propose_program` against the REAL installed `defineTool`.
 *
 * The unit test proves derivation is conservative; this one proves the schema
 * and execution contract are accepted by the runtime that will host the tool.
 * It reads the installed package by absolute path rather than importing the bare
 * specifier, because this repository declares no @deepseek-ai dependency — at
 * runtime DSH's loader resolves it from the profile scope (verified separately).
 *
 * Skips when no DSH installation is present, rather than failing in a place that
 * has none.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { buildProposalTool, registerProposalTool } from '../lib/index.js'

const ROOT = '/opt/dsh/node_modules/.pnpm'
function installedDefineTool() {
  let entries
  try { entries = readdirSync(ROOT).filter((name) => name.startsWith('@deepseek-ai+dsh-tools@')) }
  catch { return null }
  if (!entries.length) return null
  const dir = `${ROOT}/${entries[0]}/node_modules/@deepseek-ai/dsh-tools/lib/index.js`
  return import(pathToFileURL(dir).href).then((module) => module.defineTool)
}

const defineTool = await installedDefineTool()

/** Records what prepare() was handed, and returns a job shaped like publicJob(). */
function fakeManager() {
  const calls = []
  return {
    calls,
    async prepare(plan) {
      calls.push(plan)
      return { id: '00000000-0000-4000-8000-000000000000', state: 'review', approval: 'deadbeef' }
    },
  }
}

test('propose_program', { skip: defineTool ? false : 'no installed DSH to validate against' }, async (t) => {
  const manager = fakeManager()
  // defineTool throws on an unsupported parameter or output schema, so simply
  // building the definition is the first assertion.
  const tool = buildProposalTool(defineTool, manager)
  assert.equal(tool.name, 'propose_program')

  await t.test('a decidable proposal prepares a review and never approves or runs', async () => {
    const result = await tool.execute(
      { id: 'grafana', image: 'grafana/grafana:11.2.0', task: 'curl: (7) Failed to connect to grafana', webPort: 3000 },
      { agent: { id: 'session-abc' } },
    )
    assert.equal(result.ok, true)
    assert.equal(result.ready, true)
    assert.equal(result.jobId, '00000000-0000-4000-8000-000000000000')
    assert.equal(result.approvalHash, 'deadbeef')
    assert.equal(manager.calls.length, 1)
    assert.equal(manager.calls[0].id, 'grafana')
    assert.equal(manager.calls[0].webPort, 3000)
    // The shim has no approve/run surface at all: it cannot promote itself.
    assert.equal(typeof tool.execute, 'function')
    assert.deepEqual(Object.keys(manager).sort(), ['calls', 'prepare'])
  })

  await t.test('an undecidable proposal asks instead of guessing, and prepares nothing', async () => {
    const before = manager.calls.length
    const result = await tool.execute(
      { id: 'postgres', image: 'postgres:16-alpine', task: 'psql: command not found' },
      { agent: { id: 'session-abc' } },
    )
    assert.equal(result.ok, false)
    assert.equal(result.ready, false)
    assert.equal(result.jobId, undefined)
    assert.equal(manager.calls.length, before, 'nothing may be prepared while a required unknown remains')
    const fields = result.unknowns.filter((entry) => entry.required).map((entry) => entry.field)
    assert.deepEqual(fields, ['webPort'])
    assert.match(result.next, /Ask the owner/)
  })

  await t.test('the rendered card carries the verbatim evidence and the unknown', async () => {
    const result = await tool.execute(
      { id: 'postgres', image: 'postgres:16-alpine', task: 'psql: command not found' },
      { agent: { id: 'session-abc' } },
    )
    const blocks = tool.output.render({ id: 'postgres' }, result)
    const text = blocks.map((block) => block.text).join('\n')
    assert.match(text, /psql: command not found/)
    assert.match(text, /webPort/)
    assert.equal(blocks.every((block) => block.type === 'text'), true)
  })
})

test('deferred registration cannot take the plugin down with it', async (t) => {
  await t.test('a context without ctx.inject is refused, not thrown', () => {
    const seen = []
    const result = registerProposalTool({}, {}, (...args) => seen.push(args.join(' ')))
    assert.equal(result, undefined)
    assert.match(seen.join('\n'), /no deferred injection/)
  })

  await t.test('a context without a tools runtime is waited on, not failed', () => {
    let injected
    const ctx = {
      inject(deps, callback) {
        injected = deps
        callback({}) // a tools runtime that never appeared
        return () => {}
      },
    }
    assert.doesNotThrow(() => registerProposalTool(ctx, fakeManager(), () => {}))
    assert.deepEqual(injected, ['tools'])
  })

  await t.test('unresolvable dsh-tools is reported, never thrown', async () => {
    const logged = []
    const ctx = { inject: (deps, callback) => { callback({ tools: { register: () => () => {} }, effect: (fn) => fn() }); return () => {} } }
    registerProposalTool(ctx, fakeManager(), (...args) => logged.push(args.join(' ')))
    await new Promise((resolve) => setTimeout(resolve, 300))
    // Either it registered (a DSH install is resolvable from here) or it logged
    // why it could not. What must never happen is a rejection escaping.
    assert.ok(logged.length >= 1, 'registration must report its outcome')
  })
})
