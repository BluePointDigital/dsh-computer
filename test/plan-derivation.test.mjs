/**
 * Plan derivation must be provably conservative.
 *
 * The load-bearing test is `never guesses a port`: an invented entry port
 * produces an app that looks broken while the proxy is correct, so the plan
 * must LACK the field rather than carry a default.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveProposal, describeProposal, APP_ID } from '../lib/plan-derivation.js'

const task = 'webpack: command not found'
const base = { id: 'webpack', image: 'node:20-bookworm', task }

test('a decidable proposal is ready and carries the task verbatim', () => {
  const proposal = deriveProposal({ ...base, webPort: 8080 })
  assert.equal(proposal.ready, true)
  assert.equal(proposal.provenance.task, task)
  assert.equal(proposal.plan.webPort, 8080)
  assert.equal(proposal.plan.id, 'webpack')
  assert.equal(proposal.plan.image, 'node:20-bookworm')
})

test('never guesses a port: the field is absent, not defaulted', () => {
  const proposal = deriveProposal(base)
  assert.equal(proposal.ready, false)
  assert.equal(Object.hasOwn(proposal.plan, 'webPort'), false)
  const missing = proposal.unknowns.find((entry) => entry.field === 'webPort')
  assert.ok(missing, 'webPort must be reported as an unknown')
  assert.equal(missing.required, true)
})

test('an unusable image reference is reported, never repaired', () => {
  // Mirrors the installer's own rule: shape, length, and an explicit tag/digest.
  for (const image of ['', 'no-tag', 'repo/app', '-flag', 'UPPER CASE', 'x'.repeat(300), 'node@sha256:zzz']) {
    const proposal = deriveProposal({ ...base, image, webPort: 80 })
    assert.equal(proposal.ready, false, `expected ${JSON.stringify(image)} to block`)
    assert.equal(Object.hasOwn(proposal.plan, 'image'), false)
    assert.ok(proposal.unknowns.some((entry) => entry.field === 'image' && entry.required))
  }
  for (const image of ['node:20-bookworm', 'repo/app@sha256:' + 'a'.repeat(64)]) {
    const proposal = deriveProposal({ ...base, image, webPort: 80 })
    assert.equal(proposal.ready, true, `expected ${image} to be acceptable`)
    assert.equal(proposal.plan.image, image)
  }
})

test('credentials are never carried in the plan, only named as key names', () => {
  const proposal = deriveProposal({ ...base, webPort: 80, env: { PG_PASSWORD: 'hunter2' } })
  assert.equal(Object.hasOwn(proposal.plan, 'env'), false)
  assert.equal(JSON.stringify(proposal.plan).includes('hunter2'), false)
  const keys = proposal.unknowns.find((entry) => entry.field === 'environment')
  assert.ok(keys)
  assert.equal(keys.required, false, 'credentials do not block a proposal, they gate the review')
})

test('unknown input keys are omitted from the plan and recorded', () => {
  const proposal = deriveProposal({ ...base, webPort: 80, privileged: true, networkHost: true })
  assert.equal(Object.hasOwn(proposal.plan, 'privileged'), false)
  assert.equal(Object.hasOwn(proposal.plan, 'networkHost'), false)
  assert.deepEqual(proposal.provenance.omitted.sort(), ['networkHost', 'privileged'])
})

test('supplied and derived are partitioned, not overlapping', () => {
  const proposal = deriveProposal({ ...base, webPort: 80 })
  for (const key of proposal.provenance.supplied) {
    assert.equal(proposal.provenance.derived.includes(key), false, `${key} cannot be both supplied and derived`)
  }
  assert.ok(proposal.provenance.derived.includes('name'), 'a defaulted name is derived evidence')
})

test('data volumes are targets only; a host path can never be expressed', () => {
  const proposal = deriveProposal({ ...base, webPort: 80, volumes: ['/var/lib/postgresql/data'] })
  assert.deepEqual(proposal.plan.volumes, [{ target: '/var/lib/postgresql/data' }])
  const proposal2 = deriveProposal({ ...base, webPort: 80, volumes: [{ target: '/data', host: '/etc' }] })
  assert.deepEqual(proposal2.plan.volumes, [{ target: { target: '/data', host: '/etc' } }],
    'a non-string target is passed through so validatePlan rejects it; it is never silently reshaped')
})

test('task evidence is required and bounded', () => {
  assert.throws(() => deriveProposal({ id: 'x', image: 'a:1' }), /task/i)
  assert.throws(() => deriveProposal({ id: 'x', image: 'a:1', task: '   ' }), /task/i)
  assert.throws(() => deriveProposal({ id: 'x', image: 'a:1', task: 'z'.repeat(401) }), /400/)
})

test('app ids are validated before anything else', () => {
  assert.throws(() => deriveProposal({ id: 'Bad Id', image: 'a:1', task }), /lowercase slug/)
  assert.throws(() => deriveProposal({ id: '', image: 'a:1', task }), /lowercase slug/)
  assert.equal(APP_ID.test('webpack-2'), true)
})

test('describeProposal tells the agent to ask rather than choose', () => {
  assert.match(describeProposal(deriveProposal(base)), /webPort/)
  assert.match(describeProposal(deriveProposal(base)), /Ask the owner/)
  assert.match(describeProposal(deriveProposal({ ...base, webPort: 80 })), /ready to submit/)
})

test('derivation is deterministic', () => {
  const args = { ...base, webPort: 80, volumes: ['/data'] }
  assert.deepEqual(deriveProposal(args), deriveProposal(args))
})
