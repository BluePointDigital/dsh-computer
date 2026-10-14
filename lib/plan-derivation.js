/**
 * Plan derivation for agent-proposed installs.
 *
 * Pure and Docker-free on purpose: this is the part that must be *provably*
 * conservative, so the rule is enforced here rather than trusted to prompt text.
 *
 *   A proposal may leave a field BLANK. It may never GUESS one.
 *
 * So derivation produces a plan with the inferred fields filled and the
 * undecidable ones recorded as `unknowns` — never defaulted into something that
 * looks reviewed. `ready` is false while any required unknown remains.
 */

export const APP_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const IMAGE = /^[a-z0-9][a-z0-9._/:@-]*$/i
const TASK_MAX = 400
const IMAGE_MAX = 240

const check = (condition, message) => { if (!condition) throw new Error(message) }

/**
 * The installer's own image rule, enforced here too. A plan that reaches
 * `prepare()` without an explicit tag or digest is rejected there, so derivation
 * must not hand one over in the first place — an unusable image is an unknown,
 * never a repaired value.
 *
 * Digest is checked before tag: `node@sha256:zzz` otherwise matches the tag
 * pattern on the `:zzz` tail, which is not a pinned image.
 */
export const IMAGE_DIGEST = /@sha256:[a-f0-9]{64}$/
const IMAGE_TAGGED = /:[A-Za-z0-9_][A-Za-z0-9_.-]*$/

export function hasExplicitTagOrDigest(image) {
  if (image.includes('@sha256:')) return IMAGE_DIGEST.test(image)
  return IMAGE_TAGGED.test(image)
}

export function usableImage(value) {
  if (typeof value !== 'string') return false
  const image = value.trim()
  if (!image || image.length > IMAGE_MAX || image.startsWith('-')) return false
  if (!IMAGE.test(image)) return false
  return hasExplicitTagOrDigest(image)
}

/** One entry per undecided field, in the shape the review surface renders. */
const unknown = (field, reason, required = true, values) => ({
  field, reason, required, ...(values ? { values: [...values] } : {}),
})

/**
 * Fields an agent may supply. Anything else is ignored rather than smuggled
 * into a plan: extra keys never reach `validatePlan`.
 */
const INPUTS = new Set([
  'id', 'name', 'description', 'image', 'task',
  'webPort', 'webPath', 'webSockets', 'webRewrite',
  'volumes', 'cpus', 'memoryMb', 'shmMb', 'autostart',
])

export function deriveProposal(input) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'Proposal must be an object')

  const id = input.id
  check(typeof id === 'string' && APP_ID.test(id), 'App id must be a lowercase slug, at most 32 characters')

  // `task` is the evidence a reviewer reads. It is the failing command or the
  // job, quoted — not a summary written by the party seeking approval.
  const task = typeof input.task === 'string' ? input.task.trim() : ''
  check(task.length > 0, 'A proposal needs the task that required it, quoted from the work')
  check(task.length <= TASK_MAX, `Task evidence must be at most ${TASK_MAX} characters; quote the command, not the story`)

  const image = typeof input.image === 'string' ? input.image.trim() : ''
  const imageOk = usableImage(image)
  const broken = []
  if (!imageOk) broken.push('image')

  const omitted = []
  for (const key of Object.keys(input)) if (!INPUTS.has(key)) omitted.push(key)

  const plan = {
    id,
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : id,
  }
  if (typeof input.description === 'string' && input.description.trim()) plan.description = input.description.trim()
  if (!broken.includes('image')) plan.image = image
  if (Number.isInteger(input.cpus)) plan.cpus = input.cpus
  if (Number.isInteger(input.memoryMb)) plan.memoryMb = input.memoryMb
  if (Number.isInteger(input.shmMb)) plan.shmMb = input.shmMb
  if (typeof input.autostart === 'boolean') plan.autostart = input.autostart
  if (Array.isArray(input.volumes) && input.volumes.length > 0) {
    plan.volumes = input.volumes.map((volume) => ({ target: volume }))
  }

  // The entry point is the field most likely to be invented, and an invented
  // port produces an app that looks broken while the server is correct. It is
  // therefore passed only when supplied, and never defaulted here.
  const hasPort = Number.isInteger(input.webPort) && input.webPort >= 1 && input.webPort <= 65535
  if (hasPort) plan.webPort = input.webPort
  if (typeof input.webPath === 'string' && input.webPath.trim()) plan.webPath = input.webPath.trim()
  if (Array.isArray(input.webSockets) && input.webSockets.length > 0) plan.webSockets = [...input.webSockets]
  if (Array.isArray(input.webRewrite) && input.webRewrite.length > 0) plan.webRewrite = [...input.webRewrite]

  const unknowns = []
  if (broken.includes('image')) {
    unknowns.push(unknown(
      'image',
      image ? `"${image}" is not a usable image reference with an explicit tag or digest` : 'No image was supplied; the exact image is the one field the installer cannot infer',
    ))
  }
  if (!hasPort) {
    unknowns.push(unknown(
      'webPort',
      'Which container port serves HTTP. Guessing this is how an embedded app looks broken while the proxy is correct',
    ))
  }
  unknowns.push(unknown(
    'environment',
    'Credential and secret VALUES are entered by the owner in the review, never proposed',
    false,
  ))
  unknowns.push(unknown(
    'publisherTrust',
    'Same-origin embedding is a trust decision the owner makes on the review card',
    false,
  ))

  const supplied = Object.keys(input).filter((key) => INPUTS.has(key) && input[key] !== undefined)
  const derived = Object.keys(plan).filter((key) => !supplied.includes(key))

  return {
    plan,
    unknowns,
    ready: unknowns.every((entry) => !entry.required),
    provenance: { task, supplied, derived, omitted },
  }
}

/**
 * A short, honest statement of what the proposal still needs. Used as the
 * model-facing text so the agent asks the owner rather than inventing a value.
 */
export function describeProposal(proposal) {
  const required = proposal.unknowns.filter((entry) => entry.required)
  if (required.length === 0) return 'Every reviewed field is decidable; ready to submit for owner review.'
  return `Proposal is not submittable yet. Missing: ${required.map((entry) => entry.field).join(', ')}. ` +
    'Ask the owner for these rather than choosing values.'
}
