# Applications panel — from bolt-on to first-party

**Date:** 2026-10-13 · **Subject:** `dsh-applications` (dsh-computer) client half, v0.2.6
**Directive:** it must feel like a first-party part of the system, not tacked on.

## Verdict

The *integration* is first-party; the *surface* is a separate application. The
server half uses only public DSH APIs, the mount protocol is self-describing, and
deployment is verified by `install.sh`. But the client carries **its own design
system**: ~582 lines of CSS, **130 `dsha-*` class references, 23 hardcoded colour
literals and zero theme variables** — while the shell ships a full primitive set
that it uses nowhere.

## Method

Read the installed DSH 0.2.0-rc.2 client packages and compared them against
`lib/client.js`; checked the shell's slot names; verified the running panel on
Director (live v0.2.6) and Wilson; used the panel header from the user's own
screenshot ("← All apps … SAME ORIGIN") as visual evidence.

## What is already first-party — keep it

| | Evidence |
|---|---|
| Server uses only public APIs | `webServer.register`, upgrade handling; no shell patching |
| Self-describing mount | `x-dsh-app-proxy` marker + features header; client can tell what a proxy *can do* |
| Real client module | `dsh.client.platform: web`, `exports["./client"]`, registers through the shell's **slots** service |
| Freshness and cache hygiene | per-load salt server-side, `no-store` on rewritten responses, translation opt-out, immutable assets — all verified live |
| Packaging | skill + plugin in one bundle, `install.sh verify` (8 checks), app state outside the package |

## Findings, ranked by impact

**F1 — Parallel design system (highest).** `lib/client.js` defines ~582 lines of its
own CSS with 130 `dsha-*` classes and 23 hardcoded colours, no `var(--…)`.
`@deepseek-ai/dsh-client-ui-primitives` exports `Button`, `Pill`, `Tag`, `StateDot`,
`Switch`, `Checkbox`, `Input`, `SegmentedTabs`, `SegmentedControl`, `Menu`, `Modal`,
`RiskConfirmation`, `ConnectionIndicator`, `DisclosureRow`, `PathLabel`,
`TextShimmer`, brand marks and permission icons. **None are used.** Consequence: the
panel cannot follow the theme, density, focus and keyboard conventions of the shell.

**F2 — No locale.** First-party panels inject `['slots', 'locale']` and register
message keys (their packages ship `README.i18n.yaml`). Ours injects
`['slots','sessions','workspaces','uiWorkspace','conversation']` and hardcodes
English. It is the only English-only surface in a localised shell.

**F3 — Placement.** A top-level sidebar entry, with configuration (recipes, add app)
living in the same surface as the runtime view. The shell exposes
`settings.section`, `settings.plugins` and `settings.plugins.tab` slots for exactly
this split.

**F4 — Invented status chrome.** `RUNNING`/`NEW` badges and a bespoke error block
instead of the shell's vocabulary (`StateDot`, `Pill`, `Tag`, `ConnectionIndicator`),
plus the `SAME ORIGIN` badge in the app header.

**F5 — Destructive actions without the shell's confirmation.** `rm`, `uninstall` and
`forget` are plain buttons; `RiskConfirmation` and `Modal` exist for this.

**F6 — App frame chrome invented locally.** Our own back button and header for the
embedded app; the shell ships `dsh-client-ui-open-in-app` and
`dsh-client-ui-sidebar-documentpreview`.

**F7 — No persistence or deep link.** Verified earlier: a reload drops the open-app
view and returns to the list. An app cannot be bookmarked or shared by URL.

**F8 — Invisible to the shell's own plugin surfaces.** The market/menu is
npm-registry-derived, so a `github:`/`link:` install never appears there. A
first-party feature is visible in the product's own inventory UI; this one is not.

## Plan

| Phase | Change | Acceptance |
|---|---|---|
| **P0** | Adopt primitives + theme tokens; delete the `dsha-*` CSS | no `dsha-*` classes remain; panel matches shell in light **and** dark; focus/keyboard matches |
| **P1** | Locale: inject `['slots','locale']`, register keys, ship `README.i18n.yaml` | no hardcoded user-facing strings; language follows the shell |
| **P2** | Placement: keep the operational surface in the sidebar, move configuration to a `settings.section` | configuration reachable from Settings; runtime panel unchanged in purpose |
| **P3** | State and UX: persist the open app, deep-link route, `ConnectionIndicator` for reachability, `RiskConfirmation` on destructive actions, `TextShimmer`/`DisclosureRow` for install progress | reload keeps the open app; a URL opens a specific app; destructive actions confirm |
| **P4** | Distribution: decide npm publication (F8) or accept invisibility | decision recorded in the runbook |

Client-only work: no server changes, no harness restart, one version bump (v0.3.0)
and a page reload per phase.

## What I would not do

- **Not** reimplement the shell's document/preview chrome — use the existing
  primitives; a second navigation model is how this became a bolt-on.
- **Not** split the feature into two applications for purity's sake. One surface,
  two slots.
- **Not** gate destructive actions behind the approval system: approvals here are a
  session policy (`danger-full-access` → `never`, auto-denied), which is why the
  confirmation primitive is the correct gate and the `--write` convention stays.

## Recommendation

Do **P0 alone first**, then verify visually on Director (live 0.2.6) in both themes
before anything else. It removes the largest share of "tacked on" for one
client-only pass with no server or packaging risk. P1 follows immediately after,
because localisation is cheap once the strings are being touched anyway.

## Decisions (owner, 2026-10-13)

1. **Placement** — sidebar **plus** a `settings.section` for configuration. **P2
   confirmed.**
2. **Locale** — English is fine. **P1 dropped.** No string table, no
   `README.i18n.yaml`; if a deployment ever needs another language it is a
   translation of literals, not an architecture change.
3. **Distribution** — no npm; stay on pinned GitHub tags. Relevant context found
   while answering: the repository is **already public** (`github.com/…` → 200,
   raw files readable anonymously) and no instance holds a git/npm credential, so
   the tag installs depend on that visibility. A scan of the publishable file set
   found **no key material**; what a public repo does expose is the implementation
   and a few internal identifiers (`director.bluepointdigital.com` in the rollout
   docs, the box tailnet IP in `SKILL.md`). Making it private is possible but needs
   a credentialed install path on every instance first — a separate decision.

## Mechanism worth not rediscovering

A client plugin gets the shell's component library through its **manifest inject
list**, not by bundling it. `package.json` → `dsh.client.inject` must name
`@deepseek-ai/dsh-client-ui-primitives`; the shell bundle registers that id in its
platform module table (`{"…dsh-client-ui-slots":hh, "…dsh-client-ui-primitives":sE,
…}`), which is what a bundle's `require(id)` resolves against. A hand-written
bundle — this one has no bundler — can therefore use the primitives exactly like a
first-party package.

## Status after pass 1 (commit `dc74fa4`)

- **Landed:** `dsh-client-ui-primitives` declared in the manifest; the state badge
  and the "same origin" badge are the shell's `Tag`; every colour is a
  `--dsw-alias-*` token (the only literal left is the intentional VNC black);
  no class is referenced without a rule.
- **Deliberately not yet:** the `Button` swap. `dsha-btn` has 17 call sites across
  the installer and viewer; converting them while the CSS is deleted piecemeal
  leaves unstyled buttons, and a half-migrated button set looks worse than either
  end state. It is one pass: all 17 sites, CSS deleted in the same commit, with the
  panel open for a visual check.
- Suites: client 6/6, `npm test` 49/49, proxy 41, password 12 — all green.

## Next

Deploy to Director and restart it (the manifest change needs a host restart), look
at the panel in light and dark, then release and roll out. After that: the button
pass, then P2.

## Original open questions

1. Placement — sidebar **plus** a settings section (recommended), or settings only?
2. Locale scope for P1 — which languages matter for the deployments being sold?
3. Distribution — publish to npm so it appears in the shell's plugin UI, or stay a
   pinned GitHub tag and accept invisibility there?
