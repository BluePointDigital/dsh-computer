/**
 * The plugin must declare what it is compatible with, and the declaration must
 * actually reject what we have not tested.
 *
 * DSH's `evaluatePluginCompatibility` (dsh-app-boot) reads `peerDependencies`
 * for `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` and compares with
 * `semver.satisfies(runtime, range, {includePrerelease: true})`. Declaring
 * nothing means the gate can never trip; declaring a caret range is nearly as
 * useless here — `^0.2.0-rc.2` ACCEPTS `0.2.1-alpha.1`, verified below, which is
 * the exact version we have never run.
 *
 * `semver` is resolved from the DSH installation rather than this repository,
 * which declares no @deepseek-ai dependency. Skips when there is no DSH here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const DSH_PEER = /^@deepseek-ai\/dsh(-|$)/

/** DSH's own semver, not a bundled copy: the gate's behaviour is what matters. */
function installedSemver() {
  let entries
  try { entries = readdirSync('/opt/dsh/node_modules/.pnpm') }
  catch { return null }
  for (const entry of entries) {
    if (!entry.startsWith('@deepseek-ai+dsh-tools@')) continue
    // Anchor inside the installed package: from /opt/dsh itself there is no
    // parent chain for Node to walk, so the pnpm store is not reachable.
    const anchor = `/opt/dsh/node_modules/.pnpm/${entry}/node_modules/@deepseek-ai/dsh-tools/package.json`
    try { return createRequire(anchor)('semver') } catch { /* try the next copy */ }
  }
  return null
}

const semver = installedSemver()

test('manifest: the plugin declares what it is compatible with', () => {
  const peers = manifest.peerDependencies
  assert.ok(peers && typeof peers === 'object', 'peerDependencies must be declared')

  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-tools']) {
    assert.equal(typeof peers[name], 'string', `${name} must have a peer range`)
    assert.notEqual(peers[name].trim(), '', `${name} must not declare an empty range`)
  }
  // A range of "*" is the failure this test exists to prevent: the gate would
  // never trip and a breaking DSH upgrade would load silently.
  for (const [name, range] of Object.entries(peers)) {
    if (!DSH_PEER.test(name)) continue
    assert.notEqual(range, '*', `${name} must not be an unconstrained "*" range`)
  }
})

test('manifest: the dsh.engines declaration matches the peer range', () => {
  const engines = manifest.dsh?.engines
  assert.ok(engines && typeof engines.dsh === 'string', 'dsh.engines.dsh must be declared')
  assert.equal(engines.dsh, manifest.peerDependencies['@deepseek-ai/dsh'],
    'the human-facing declaration and the gate-visible one must not drift')
})

test('peer range', { skip: semver ? false : 'no DSH installation to resolve semver from' }, async (t) => {
  const range = manifest.peerDependencies['@deepseek-ai/dsh']
  const accepts = (version) => semver.satisfies(version, range, { includePrerelease: true })

  await t.test('accepts the version actually in service', () => {
    assert.equal(accepts('0.2.0-rc.2'), true)
  })

  await t.test('rejects what we have never tested', () => {
    for (const untested of ['0.1.7-rc.2', '0.2.0-rc.1', '0.2.1-alpha.1', '0.2.1-alpha.2', '0.3.0', '1.0.0']) {
      assert.equal(accepts(untested), false, `${untested} must be rejected by "${range}"`)
    }
  })

  await t.test('a caret range would NOT have rejected 0.2.1-alpha.1 (why this range exists)', () => {
    assert.equal(semver.satisfies('0.2.1-alpha.1', '^0.2.0-rc.2', { includePrerelease: true }), true,
      'if this ever becomes false, a caret range would have been sufficient')
  })
})
