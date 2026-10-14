import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recipes, recipePlan } from '../lib/recipes.js'
import { validatePlan, APP_ID } from '../lib/app-manager.js'

// These are the checks that turn "the recipe list looks right" into something
// the installer agrees with. The Kanboard case is why they exist: it declares
// /etc/nginx/ssl as a volume, the installer requires every declared volume to be
// in the plan, and the plan validator refuses volumes that mask system
// directories — so that image could never install, and nothing said so until the
// recipe was measured.

test('every recipe is a plan the installer will accept', () => {
  for (const recipe of recipes) {
    const plan = recipePlan(recipe.id)
    const validated = validatePlan(plan)
    assert.equal(validated.id, recipe.id, `${recipe.id}: id survives validation`)
    assert.ok(validated.webPort > 0, `${recipe.id}: container web port`)
    assert.ok(validated.memoryMb >= 64, `${recipe.id}: memory`)
  }
})

test('recipe ids are unique and use the installer id format', () => {
  const ids = recipes.map((recipe) => recipe.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate recipe id')
  for (const id of ids) assert.match(id, APP_ID, `bad recipe id ${id}`)
})

test('no recipe floats on a :latest tag', () => {
  for (const recipe of recipes) {
    const plan = recipePlan(recipe.id)
    const pinned = plan.image.includes('@sha256:') || plan.localImage === true || !plan.image.endsWith(':latest')
    assert.ok(pinned, `${recipe.id}: pin a digest or a version tag — review means nothing on a moving tag`)
  }
})

test('a recipe may ask for a secret key but never carries the value', () => {
  for (const recipe of recipes) {
    const plan = recipePlan(recipe.id)
    for (const [key, value] of Object.entries(plan.env ?? {})) {
      assert.match(key, /^[A-Z_][A-Z0-9_]{0,63}$/, `${recipe.id}: env key ${key}`)
      assert.equal(value, '', `${recipe.id}: recipe must ship the key with an empty value, got a value for ${key}`)
    }
  }
})
