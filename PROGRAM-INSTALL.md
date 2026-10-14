# Agent install authority — design note

**Date:** 2026-10-13 · **State:** outline, not implemented · **Subject:** who may install
what, on which machine, and how a program becomes a *program* rather than a command.

Reads with [INSTALLATION.md](INSTALLATION.md) (the installer contract) and
[DEVELOPING.md](DEVELOPING.md) (the release loop). Where the two disagree, the
installed code wins and this file is wrong.

## Premise

The agent runs containers in the nested Docker daemon. Inside its own boxes it
should have full control and need no approvals — they are its machine. Approval is
required for exactly one thing: **turning a container into a program the whole
machine can see.** Everything below follows from that split.

Two claims about the environment are load-bearing, and both are already true:

- The nested daemon can bind-mount only what *this* container can see
  (`/data`, `/workspace`, the box home) and cannot reach the host. `CapEff` is zero.
- Therefore "unattended execution in a box" and "a new program on the machine" are
  genuinely different risk classes, and can be treated differently without
  hand-waving.

## 1. Authority is a property of the box, not the operation

| Tier | What the agent may do unattended | Gate | Why |
|---|---|---|---|
| **Workspace box** — `computer up`, `exec`, `sh` | Install anything, run any image, any process, inside the box | **none** | Blast radius is one container with a bind-mounted home. Disposable by design: `destroy` keeps the home, loses `/usr`. |
| **Program** — a managed app with a name, a named volume, a panel, a same-origin embed | Propose only | **owner approval** (`prepare → approve → run`) | Outlives the turn, enters the catalog other sessions read, and joins the DSH browser origin. |
| **Machine resources** — `/data/.secrets`, tailnet identity, Portainer control plane | nothing unattended | **owner, always** | Not contained by sysbox. Escalation path is container → tailnet → other machines. |

The middle row is deliberately narrow. `apt-get install postgresql` in a box is
row 1 and needs nothing. Making that database a *named program* is row 2. Friction
should scale with blast radius, and today it does not: the agent's ordinary in-box
work is fine, but there is no path at all from "I need this program" to a review.

## 2. The two paths, stated so they stop being confused

1. **In-box, full control — the default answer to "I need a tool."**
   `computer exec 'apt-get install -y …'` already works with no approval and should
   stay that way. This belongs in `SKILL.md` as the *first* answer, not the
   fallback, so the approval path is not reached for work that never needed it.
2. **Promotion to a program — the approval path.**
   `prepare → approve → run` becomes: the agent proposes, a card appears in
   Applications, the owner clicks. Nothing about the existing safety schema changes.

## 3. What the agent can derive, and what it must ask

The review card is only trustworthy if the reader knows which parts were inferred.
So the proposal separates them explicitly.

| Derivable (agent fills, review confirms) | Must be asked (review requires) |
|---|---|
| Image, from ecosystem knowledge; local presence confirmed | Credential and secret **values** |
| Resource shape from the task at hand | Which port, when several TCP ports are candidates |
| Data targets, if the image declares `VOLUME` | HTTP base path and any socket paths |
| That a port answers HTTP at all | Any claim of publisher trust |

Rule: a proposal may leave a field **blank**, never **guessed**. An invented port or
base path is exactly the failure that makes an embedded app look broken while the
server is correct.

The `why` on a card should be *the task*, quoted — `webpack: command not found` in
this turn — not a persuasive summary. Summaries written by the party seeking
approval are the wrong evidence.

## 4. The review card

Reuse the existing review surface; add only the proposal provenance.

- Job id, image + immutable content id, caps, declared data targets (existing).
- **Why:** the failing command or the task, verbatim.
- **Unknowns:** the fields above, rendered as blanks the owner fills in — not as
  defaults with an implied blessing.
- **Publisher trust:** a distinct tick, never pre-set.

Approval remains bound to job UUID + normalized plan + environment key **names** +
image content + review expiry, as INSTALLATION.md specifies. Secrets are entered in
the review's own value input, never prefilled from conversation.

## 5. The honest limit on "the agent must not self-approve"

The card is a GUI event; `computer apps approve <job> <hash> --trust-publisher` is
an operator CLI surface. **The agent has `bash`, so it can run that command.**
INSTALLATION.md already says this is not a permission boundary against an
operator-level agent, and that stays true — the guard is policy and the skill's
instructions, not a capability fence.

If the client story needs a fence rather than a policy, that is a **separate scoped
change** (refuse `approve` when the caller is agent-attributed) with its own
decision. Do not ship it by assumption; do not claim the card is enforcement.

## 6. Trigger: missing capability, not a command

The natural moment is not "install Postgres." It is `psql: command not found`
**during real work**. Triggering on that is what turns this from a form into a
workflow.

Cheapest first version: the skill instructs the agent to propose when a task hits a
missing program; the proposal path itself is unchanged. Do not build a detector
before that is tried.

## 7. Agent affordance: a thin shim, and only for one reason

The agent already has `bash` and `computer apps prepare` works, so a tool is not
needed for *capability*. It is justified for **discoverability** and because
publishing a proposal into the human's GUI is a host-side effect `bash` cannot
express cleanly. If it is added:

- one typed tool, `propose_program` (name to be settled), whose body calls
  `apps prepare` — **not** a second implementation;
- it returns unknowns alongside the job, so the proposal is one call;
- it never approves and never runs.

## 8. Discovery is reconciliation, and that part is landed

Docker is the inventory of record; the durable registry is the app *experience*;
`apps.yaml` is a seed repository. Current code already does this:

- `lib/catalog-state.mjs` seeds `$DSH_HOME/.dsh-applications/catalog.yaml` once
  (atomic no-clobber) so a package upgrade cannot replace the operator catalog.
- `lib/existing-apps.js` registers a container against immutable identity
  (`containerId`, re-checked every read) and **discloses** real posture —
  `privileged`, `networkMode`, `capAdd`, host mounts, devices.
- `bin/app-cli.mjs list` merges legacy catalog + installed registry + discovered
  containers and **fails closed on duplicate ids**.

The only human-gated step is promotion: a container that exists but has no saved
entry appears as an unmanaged label to promote, never auto-embedded and never
recreated. That rule stays.

## 9. Slice plan

Each slice ships alone. **An app install does not need a harness restart** — only
patch-layer changes do — and the first acceptance criterion exists to keep that
honest.

| # | Slice | Acceptance |
|---|---|---|
| **A** | Reconciliation residual: promote a discovered container to a saved listing | Listing survives `pnpm install`, a harness restart, and a box `destroy`. Reconcile is idempotent. |
| **B** | `propose_program` + plan derivation | A missing-program trigger yields a review card carrying a verbatim `why` and non-empty unknowns; the owner approves from the GUI; the app appears **with no restart**. |
| **C** | Box-authority guarantee | A box runs an install unattended; `SKILL.md` states full control inside the box; the machine-resource exclusions are asserted. |
| **D** | Structured readback (below) | An app declares what state matters; a call returns text the model reasons over, with no screenshot. |

Acceptance tests to write (**deterministic, no Docker** where possible):
plan-derivation leaves blanks rather than guessing; reconcile is idempotent;
`list --json` is identical across reinstall / restart / destroy; the approve path is
refused when invoked as the agent — **verified, then what actually happened is
recorded, not what was intended.**

## 10. Structured readback — the first non-app-system feature

Today the loop is act → screenshot → read the PNG → decide. That works, and it makes
his *eyes* the product when his **judgment** is the scarce thing.

The move mirrors one the app system already made: prefer a declared, addressable
interface over coordinates. An app (or a task) declares a small readback contract —
"this is the state that matters" — and a call returns **text** the model reasons over
directly. Screenshots stay for visual-only truth.

Boundaries, so this does not become a second automation layer:

- Readback is **read-only**. Mutations stay in the CLI behind `--write`, as today.
- It is per app or per task, declared, not discovered.
- It is separate from the error path: the app is responsible for a readable failure,
  and a missing contract is an explicit "no text view," never a silent screenshot.

Chosen as the first outside-the-app-system feature because it is the difference
between a visible desktop and a *work* machine.

## 11. Explicitly not doing

- No host bind mounts, no Docker socket in any app, no added capabilities.
- No auto-embedding of untrusted discovered containers.
- No Portainer clone, no Compose orchestration, no multi-service app.
- No new state file duplicating Docker.
- No change to the `--write` convention.
- The agent never approves, and the design does not pretend it cannot.

## 12. Unknowns and risks

1. **Tool naming and shape** — `propose_program` vs extending the `computer` CLI
   surface; settled before B, not during it.
2. **Proposal volume** — a chatty agent could emit cards nobody asked for. First
   version is skill-instructed; revisit only with evidence.
3. **Agent-attributed caller detection** — how to refuse `approve` to an agent, if
   that is wanted at all.
4. **Readback contract authoring** — who writes it, and whether it can be inferred
   for unknown third-party images (likely not; likely operator-written).
5. **Director is live on an older tag.** Any of this landing must account for the
   rollout in [ROLLOUT-v0.2.2-2026-10-12.md](ROLLOUT-v0.2.2-2026-10-12.md).

## Next

Slice **B** is the one that makes the concept legible: *ask the agent for something
it cannot do, watch it propose, approve, and use the program.* Before writing code,
settle the two decisions in §12 that change the shape — tool vs. CLI (§12.1) and
whether the approve fence is in scope (§12.3).
