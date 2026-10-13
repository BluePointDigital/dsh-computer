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
