# Direct Docker refactor — verification and activation handoff

## Status — 2026-10-21

The checkout is preparing **0.7.0**. This refactor is **not installed, released or
restarted**. The proposed production release-pin move is **0.6.3 → 0.7.0**;
publication, approved installation, coordinated activation and installed-GUI
verification are separate future steps. Older deployment/test notes elsewhere are
historical evidence, not proof that an older deployment runs this checkout.

**Source verification passed:** the full suite passed **250 Node tests**, **39 proxy
checks**, **12 password checks**, and **3 legacy catalog retry checks**. A clean
lockfile dependency installation completed with **0 vulnerabilities**, followed
by another full-suite run (see results below). Current-source scratch Chromium
and real nested-Docker Compose acceptance also passed. These are source/fixture
results, not evidence that the installed production GUI has changed.

## Read-only source benchmark

The lead supplied the following measurement from current source against the
current **6-application** inventory. This documents a read-only source benchmark,
not installed-plugin, browser-render or live-GUI verification:

| Measurement | Recorded result |
|---|---|
| Forced fresh reads, 10 samples | `[211, 71, 50, 29, 51, 34, 33, 28, 45, 33]` ms |
| Warm cached reads | **<0.1 ms** |
| Data set | Current 6 applications; not a scale/load benchmark |
| Browser/live installed GUI | **Not established by these measurements** |

Fresh reads include direct Engine snapshot/metadata work; warm reads reuse the
in-process snapshot. These timings are not end-to-end GUI latency, a guarantee
for another daemon/workload, or a test of public ingress. Documentation work did
not rerun this benchmark or operate containers.

## Implementation contract checked against source

- [ApplicationRuntime](<lib/application-runtime.js>) owns one shared server Engine
  snapshot; [RuntimeInventory](<lib/runtime-inventory.js>) groups/sanitizes its
  full-ID inspections. Runtime inventory/details, compatibility listing and
  gateway discovery share that work. Concurrent refreshes coalesce.
- [DockerEngine](<lib/docker-engine.js>) uses native Node HTTP over a local Unix
  socket, default `/var/run/docker.sock` or an absolute `unix://` `DOCKER_HOST`.
  It negotiates the daemon overlap within **API 1.41–1.47**; explicit
  `DOCKER_API_VERSION` must fit the overlap. Nondefault contexts, remote endpoints
  and TLS settings fail explicitly; no public Docker socket/API is needed or
  permitted as a workaround. Retained Compose/provisioning commands receive the
  same selected Unix target in their execution environment.
- [Catalog](<lib/catalog.js>) reads the existing durable flat catalog directly,
  retains its string-valued dialect and validates metadata without spawning
  Docker or starting apps. Existing durable metadata remains in place.
- The server fresh window is **3 seconds**. Expired ordinary reads return the last
  snapshot while refreshing; explicit fresh reads wait. A cold Docker failure is
  **503**, not empty success. Warm failure preserves apps with `updatedAt`,
  `stale`, `refreshing` and `dockerAvailable` flags/warnings.
- [Runtime UI](<lib/runtime-ui.js>) keeps a sanitized **memory-only** last snapshot
  across panel remounts, polls every **5 seconds while visible**, and immediately
  revalidates when visible again. Authentication rejection clears that cache.
  Resource stats use a separate endpoint/Overview poll, not the inventory critical
  path. Server cache/metrics are also memory-only.
- [Server routes](<lib/index.js>) share runtime discovery with the gateway. Cached
  display state is not authority: lifecycle/log/TTY operations freshly resolve
  membership and inspect the selected immutable full ID, with owner/project
  checks. Gateway dispatch uses a targeted fresh full-ID inspection plus current
  ownership/endpoint metadata/running-state checks before dialing. It does not
  rescan the entire daemon per asset. Missing/replaced/uncertain targets fail
  closed rather than using a stale address or same-name replacement.
- [CLI](<bin/app-cli.mjs>) shares the inventory/grouping implementation and durable
  metadata, not the server's in-memory cache. Remaining exceptions include
  Compose deploy/redeploy/rollback and saved-project lifecycle, image/create
  provisioning, missing-container catalog launch, workspace-box/CDP, interactive
  CLI exec and specialized diagnostics. They are not inventory fallbacks.
- [Console](<lib/runtime-console.js>) logs/exec use the same Engine transport.
  Cancellation/timeouts/disposal close transport and local resources; **they do
  not guarantee the in-container exec process or descendants were killed**.
- No durable state/container schema migration, catalog adoption, container
  recreation or app-data rewrite is required by this refactor. Catalog,
  installed/registered metadata, saved definitions/jobs, secrets, endpoint/port
  settings and application data retain their existing formats and locations.

## Completed source verification

The full suite includes the direct transport/catalog/snapshot/cache tests and
updated runtime API, console, UI, CLI and gateway regressions. Native-process traps
verify that runtime routes do not invoke Docker or the catalog CLI (the existing
kernel-lock carrier remains permitted). Added review regressions cover recovery
from failed negotiation, start/stop HTTP 304, failed-worker drainage, bounded stats,
obsolete metric pruning, registered-container replacement, entry queries and
legacy WebSocket route reconciliation.

```bash
node --test test/docker-engine.test.mjs test/catalog-reader.test.mjs test/application-runtime.test.mjs test/runtime-cache.test.mjs
node --test test/runtime-api.test.mjs test/runtime-console.test.mjs test/runtime-ui.test.mjs test/ports-cli.test.mjs test/catalog.test.mjs test/host-mount-apply.test.mjs test/upgrade-route.test.mjs
npm test
```

| Verification | Final result |
|---|---|
| Direct Engine/catalog/runtime/cache scoped tests | Included in passing 250-test Node suite; 100-container concurrency fixture included |
| Runtime API/console/UI/CLI/gateway compatibility regressions | Included in passing full suite; fake Unix daemon + real HTTP/WebSocket transports |
| Full suite, including auxiliary shell/proxy checks | Exit 0: 250 Node + 39 proxy + 12 password + 3 catalog retry checks |
| `npm ci --legacy-peer-deps` | Exit 0; 0 vulnerabilities; esbuild install script reported pending approval, not approved here |
| `npm run test:runtime-browser` | Exit 0; current UI in isolated headless Chromium, fixture backend; light/dark screenshots inspected. One clean-install rerun timed out opening a mobile menu during viewport resize; an immediate rerun passed. The fixture now waits two animation frames after resize; its final rerun passed. This is not production UI acceptance. |
| `npm run test:runtime-live` | Exit 0; scratch two-service Compose deployment, discovery, frontend, redeploy, retained data and lifecycle |
| Installed GUI / public ingress / real browser latency | NOT VERIFIED for 0.7.0; requires release installation and coordinated activation |
| Release/install/restart | NOT PERFORMED for this refactor |

Before activation, specifically confirm cold failure versus warm stale responses,
refresh coalescing/invalidation, UI last-snapshot retention/auth clearing,
independent stats, same-target Compose environment, unsupported endpoint rejection,
immutable-ID/ownership replacement rejection and log/exec cancellation cleanup.
Browser checks must use the actual intended installed GUI after activation; no
replacement server can establish that the existing DSH URL updated.

## Deferred rollout and rollback

1. Finish verification and review the complete intended source/release diff.
   Publish the reviewed **0.7.0** release separately; this document does not do so.
2. Before rollout, back up private app state **outside the synced workspace**,
   preserving permissions and credentials privately. Preserve the current
   production **pin/lockfile** and relevant instance configuration for rollback.
   Do not copy private definitions, environment values or credentials into source.
3. Use the **approved plugin-manager path**: list installed bundles for exact
   identifiers, then obtain the required owner approval to install the reviewed
   release pin. Honor compatibility/build-script checks. Do not directly edit live
   profiles/pins/locks, use a manual install shortcut, or run the checkout/link
   installer against production.
4. Coordinate server activation **after the active turn**, never mid-turn. Refresh
   the existing GUI and verify inventory/freshness/error behavior, details/stats,
   lifecycle, logs/TTY, app launches and the intended HTTP/WS ingress boundary.
   A source edit, dependency install or page reload alone does not replace loaded
   server modules.
5. If rollback is needed, reinstall the prior reviewed pin through the same
   approved plugin-manager path, coordinate activation and verify it. **Do not
   overwrite app data or restore an older state backup over live data to roll back
   code.** No state/container schema migration requires reversal here.

See [development/release guidance](<DEVELOPING.md>),
[installation prerequisites](<INSTALLATION.md>) and
[the Applications manager contract](<APPLICATIONS-MANAGER.md>).
