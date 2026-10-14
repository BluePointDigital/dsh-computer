/**
 * The box's own `docker run` invocation is a security posture, and one flag in it
 * is a trap that costs the whole machine.
 *
 * Measured 2026-10-14 on a throwaway box: `--security-opt no-new-privileges` stops
 * sudo escalating, so `apt-get install` fails with "The 'no new privileges' flag
 * is set, which prevents sudo from running as root". Passwordless sudo IS the box,
 * so that flag is mutually exclusive with the feature. Managed apps legitimately
 * carry it — they have no sudo — which is exactly why a blanket grep for the flag
 * across this repo would be wrong and this test scopes to the box's invocation.
 *
 * Static on purpose: it needs no Docker and no running box, so it cannot be
 * skipped into uselessness on the machine that would actually regress.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const script = readFileSync(new URL('../bin/computer', import.meta.url), 'utf8')

/** The box creation call specifically — not the app launcher, not `docker exec`. */
function boxRunBlock() {
  const start = script.indexOf('docker run -d --name "$NAME"')
  assert.notEqual(start, -1, 'the box run invocation moved; update this test with it')
  const end = script.indexOf('"$IMAGE" >/dev/null', start)
  assert.notEqual(end, -1, 'cannot find the end of the box run invocation')
  return script.slice(start, end)
}

test('box posture: pids are capped, as every managed app already is', () => {
  assert.match(boxRunBlock(), /--pids-limit 2048/,
    'the box runs the most code of anything here and had no pid cap')
})

test('box posture: no flag that breaks passwordless sudo', () => {
  const block = boxRunBlock()
  for (const flag of ['no-new-privileges', '--read-only', '--readonly']) {
    assert.equal(block.includes(flag), false,
      `${flag} makes sudo fail, which makes the box useless — see the comment at the top of this file`)
  }
})

test('box posture: isolation that is compatible with sudo is still present', () => {
  const block = boxRunBlock()
  assert.match(block, /--cpus/, 'CPU cap missing')
  assert.match(block, /--memory/, 'memory cap missing')
  // --network is what makes --offline (--network none) expressible at all.
  assert.match(block, /--network/, 'network mode missing')
  assert.equal(block.includes('--privileged'), false, 'never --privileged')
})
