import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The client is a hand-written bundle with no bundler and no type checker, so a
// stale reference survives every existing suite: removing a useState pair once
// left `setLastAction(...)` behind, and the only thing that caught it was a
// browser. This is the cheap static guard for that class of mistake.
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const BUILTINS = /^(setTimeout|setInterval|setImmediate|setView|setState)$/

test('every state setter the bundle calls is declared', () => {
  const declared = new Set(
    [...source.matchAll(/\[\s*[\w$]+\s*,\s*([\w$]+)\s*\]\s*=\s*React\.useState/g)].map((m) => m[1]),
  )
  const called = [...source.matchAll(/\b(set[A-Z][\w$]*)\s*\(/g)].map((m) => m[1])
  const dangling = [...new Set(called)].filter((name) => !declared.has(name) && !BUILTINS.test(name))
  assert.deepEqual(dangling, [], `undeclared state setters called: ${dangling.join(', ')}`)
})

test('every required primitive the bundle uses is destructured', () => {
  const destructured = new Set(
    [...source.matchAll(/const\s*\{([^}]*)\}\s*=\s*require\('@deepseek-ai\/dsh-client-ui-primitives'\)/g)]
      .flatMap((m) => m[1].split(',').map((s) => s.trim()))
      .filter(Boolean),
  )
  const used = new Set(
    [...source.matchAll(/\bh\((Menu|StateDot|Tag|Button|Pill|Modal|Input|Switch|Checkbox)\b/g)].map((m) => m[1]),
  )
  const missing = [...used].filter((name) => !destructured.has(name))
  assert.deepEqual(missing, [], `primitives used but not required: ${missing.join(', ')}`)
})
