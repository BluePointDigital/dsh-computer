# Durable listings rollout — 2026-10-12

Release v0.2.2, commit `5fa8995` (immutable GitHub tag). v0.2.1 remains immutable
but was superseded: installed GUI verification caught symlink-sensitive CLI entry
detection. v0.2.2 resolves real paths and adds an installed-directory-symlink test.

## Implemented

- Private durable legacy catalog seeded once, plus separate existing-app registry.
- Docker inventory discovers labelled orphan apps in My apps; other unlisted web
  containers appear under Add existing container. No automatic adoption/embed.
- Reviewed port/path/socket/rewrite and explicit same-origin publisher trust.
- Immutable container identity for imported lifecycle and HTTP/WebSocket proxy.
  Forget only removes metadata; missing containers are never recreated.
- Reject auto-remove and host/none/shared-network containers. Existing privileges
  disclosed; no privileged container creation, volume changes or port publishing.
- Finished installer journals collapsed under Installation history.

## Verification

- 48 Node tests, 35 proxy checks, 12 password checks passed on final code.
- Real scratch Chromium: discover existing nginx, review/trust/register, Launch,
  embedded page; then full advanced installer, iframe and unsent draft flow.
- Installed Director Chromium: HyperFrames discovered in My apps, stopped, port
  3002; review visible, trust unchecked and Add disabled. No approval/launch.
- Installed Director Add app: Installation history closed by default.
- HyperFrames immutable ID and complete mount metadata compared to pre-upgrade
  snapshot: unchanged; container remains stopped. Volume contents not inspected.

## Deployment

Director installed pinned v0.2.2 and restarted. Desktop/nginx restored on demand.
Current legacy catalog was copied into private state **before** package replacement.
Backup: `/data/backups/director-apps-v021-20261012-2342` inside Director.
Includes previous package/lock/catalog, private state and HyperFrames identity.

Olympus pinned v0.2.2 installed on disk; current catalog durably seeded first.
Backup: `/data/backups/olympus-apps-v022-20261012-2354`.
**Olympus was not restarted; staged does not mean the live server loaded it.**
Activate only after the active turn ends, with an external restart, then refresh.

## Human step

In Director Applications → Found existing apps → HyperFrames → Review listing →
Review connection, inspect and confirm publisher trust, then Add to My apps.
Launch is separate. We did not grant publisher trust on the user's behalf.
This restores its listing without recreating its retained container/storage.

## Follow-up — 2026-10-13 HyperFrames embedded routing

User registered/launched HyperFrames and reported a waiting-for-preview screen.
The server was running; registration had empty webRewrite. Browser calls to
`/api/projects` escaped the mount and returned harness 404s. Backed up existing
registry inside private state and set HyperFrames `webRewrite: ["/api/"]` under
the manager lock, preserving immutable identity and all other settings. No
container recreation, restart or volume changes were needed. Actual installed
Applications iframe now renders welcome/Inspector/Timeline/Export; project and
ffmpeg endpoints return 200 through the app mount. Reproducible canary is
`test/diagnose-hyperframes.py`.

Separate limitation: project history endpoint returns 404 and app logs report
HistoryBusyError referencing pid 1. Editor loads, but project history is not
verified/healthy. No lock files were removed and no editing/render operation
was performed. The prior recovery review test did not establish app usability;
this follow-up verifies the actual embedded editor, not merely port readiness.

## Follow-up 2 — 2026-10-13 stale immutable bundle (v0.2.3, commit 5435744)

The user reported the app **still** stuck after the routing fix. The server was
correct; the browser was not. HyperFrames serves its bundle
`cache-control: public, max-age=31536000, immutable`. While `webRewrite` was
empty, `proxyHttp` passed that bundle through untouched
(`isJs` requires non-empty prefixes), so the browser cached the un-rewritten
bundle for a year and a later config change could never reach it.

Reproduced and verified in a persistent Chromium profile inside Director's
desktop container (method: temporarily set `webRewrite: []`, load the app to
cache the bundle, restore `["/api/"]`, reload):

| Phase | Result |
|---|---|
| cached with empty prefixes | stalled; bundle `transfer: 0`; `/api/projects` 404s |
| prefixes restored, old code | **still stalled** — the user's report, reproduced |
| after v0.2.3 | loads; bundle fetched over the network as `?dsha=017e5e03bd` |

In the fixed run the poisoned URL still appears with `transfer: 0` — it remains
cached but is never used again. All app API calls returned 200.

Fix: `rewriteHtml` appends `?dsha=<token>` to script/style URLs, where
`embedToken` hashes the app's container, port, path, sockets and rewrite
prefixes, so any mount change yields a URL no browser has cached. Director and
Olympus both pin v0.2.3. Director restarted and verified; HyperFrames identity
and mounts re-checked unchanged after the temporary flips. Olympus staged only,
not restarted. Backup: `/data/backups/olympus-apps-v023-20261013-0032`.

Generalisation worth keeping: never fix an embed configuration by editing the
stored settings alone. A cached immutable app bundle can hold the old behaviour
indefinitely, and the server will look correct while the user sees the fault.


## Follow-up 3 — 2026-10-13 every app load is fresh (v0.2.4, commit 6d63d42)

Reported after v0.2.3: a private tab loaded the studio but a **hard refresh in the
normal window did not**. Measured, in order:

- The harness shell and the app bundle register **no service worker** (0 references
  each), so a hard reload is not defeated by one.
- The app keeps only telemetry/feedback flags in `localStorage` and opens **no
  IndexedDB database**, so corrupt app storage is an unlikely cause.
- Remaining difference between a private tab and the normal window: the profile
  itself (extensions/auto-translate are the classic producers of a `removeChild`
  inside a React tree, and Chrome disables extensions in private tabs). Not
  reproducible from this side: a clean browser pass through the panel showed zero
  console errors, and 11 studio panels, a resize and leaving the app produced no
  error card — only benign `ResizeObserver` warnings. The "Something went wrong"
  card is HyperFrames' **own** error boundary (found in its bundle; it prints
  `error.message`), so the failure is app-internal.

Decision (the user's, and the simpler design): instead of a manual reload button,
**give every app load a fresh URL salt**, so a stale bundle cannot survive *any*
open — not just a configuration change. `resolveView` appends `?dsha=<salt>` to
the document URL; `embedToken` folds the salt into the asset token; `appSearch`
consumes `dsha` and strips it, so the app sees an unmodified query string.

Verified on Director (live v0.2.4):

| Check | Result |
|---|---|
| Two consecutive opens | salts `mv67lvmiw9r`, `mv67lxh6rrv`; editor loaded both times |
| Same CSS asset | re-fetched from network both times (46,932 bytes, no cache reuse) |
| Salt reaches the app? | nginx saw `GET /?keep=1` — salt consumed, `keep=1` preserved |
| VNC viewer regression | noVNC connected with `dsha` beside `path`/`password` |

Cost, measured not guessed: every open re-downloads the app's own assets (studio
CSS 46,932 bytes and its ~1.7 MB JS bundle over the LAN). Accepted deliberately in
exchange for an app that can never come up from an older load.

Both instances pin v0.2.4; Director restarted and verified, Olympus staged on disk
only. Backup: `/data/backups/olympus-apps-v024-20261013-0058`.
