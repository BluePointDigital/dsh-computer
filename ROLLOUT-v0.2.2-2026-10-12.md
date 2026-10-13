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

## Follow-up 4 — 2026-10-13 translation opt-out (v0.2.5, commit on main)

Reported after v0.2.4: the app **still** only works in a private window, with fresh
asset URLs in place — so the failure is not cache. The user's hypothesis was page
translation. What was measured:

- **App cookies: none.** `GET /`, `/api/projects` and `/healthz` on the app
  container return no `Set-Cookie`, so a stale session cookie cannot explain a
  profile-only failure.
- **No service worker** in the shell or the app bundle (0 references each).
- **Translation simulation did not reproduce it.** Wrapping 80 React-owned text
  nodes inside the studio's `#root` in `<font class="translated-ltr">` (what a page
  translator does) and then clicking through four panels left the app running with
  no error card. So translation is plausible but **unconfirmed** as the cause.

Shipped anyway, because it is the standard opt-out and costs nothing: the proxy now
writes `translate="no"` on `<html>` and a `<meta name="google" content="notranslate">`
into every embedded document, and the client marks the frame `translate="no"`. A
translator works per document, so the opt-out must live in the app's own HTML — an
attribute on the embedding iframe would not cover the app. Verified live: the frame
and the app's `<html>` both report `translate="no"`, the meta is present, and the
studio still loads.

Whatever this turns out to be, note the failure boundary: a private window differs
from a normal one in **extensions (disabled in private by default)**, cookies/storage
and translation settings. Nothing in DSH differs. The decisive isolation test is a
**new normal Chrome profile**, not another incognito tab.

## Follow-up 5 — 2026-10-13 the console settles it (v0.2.6)

The user's console, from the failing normal window, contained the decisive line:

```
index-ByJU5J6n.js:49  GET https://director.bluepointdigital.com/api/projects 404
```

The app was calling the **host root**, not its mount — i.e. it was executing JS whose
`/api/...` literals had never been rewritten. Measured against the live server:

- The same bundle, fetched today, is **fully rewritten**: 43 `/apps/web/hyperframes/api/`
  occurrences, **0** raw `"/api/"` literals, served `no-store`.
- The app's own bundle builds API paths from absolute literals
  (`"/api/projects"`, 3 hits; 0 slash-less variants) and there is no `<base>` tag, so
  a browser executing a **freshly served** bundle cannot produce a root call.
- Conclusion: the failing window was running a **cached bundle from before the
  rewrite was configured**. That era's JS was streamed unrewritten *and kept the
  app's `immutable, max-age=1y` headers*, so it survives a year and no server-side
  fix can reach it. A private window has an empty cache, which is why it works.
- Translation is exonerated: the app's text is English and unmodified in the crash
  frame; the earlier `<font>` simulation had already failed to reproduce it.
- `/api/changes.summary?sessionId=…` 404s too, but that string is **not** in the app
  bundle nor in the harness frontend — another stale-client artifact, unrelated to
  the crash.

Two server-side changes, because freshness must not depend on the client being
current:

1. **Every document response is stamped with a fresh salt server-side** (the
   client's `dsha` is honoured if present). Freshness no longer requires the panel
   client half to be up to date, and a stale frame that is merely reloaded gets
   fresh asset URLs and recovers.
2. **A response that needed rewriting but could not be rewritten** (the app
   compressed it despite our `identity` request) is served `no-store` with
   validators stripped. An unrewritten `immutable` bundle can never be cached again.

Verified live on Director (v0.2.6): two identical document requests returned
different tokens (`ca037e2921`, `e91821dd60`); the URL carrying the user's failing
salt `a078c73291` returned a fresh token (`1f41048e9e`); the served JS showed 43
mounted / 0 raw calls with `no-store`; the panel opened the studio with no crash
card. Both instances pin v0.2.6. Backup:
`/data/backups/olympus-apps-v026-20261013-1455`.
