# v0.2.0 rollout — 2026-10-12 America/New_York

## Published immutable release

- Annotated tag v0.2.0: tag object `d856f341c98bc0088e7b233fa32b228cab9a8084`.
- Peeled commit / main: `ed9030f48b6562bf04e0b6744a53a43be40e325e`.
- Pushed to github.com/BluePointDigital/dsh-computer and independently verified
  with git ls-remote. No old release tag was moved.

## Director: installed, restarted, canary passed

- Original dependency v0.1.10; new pinned dependency v0.2.0.
- Private backup inside Director: `/data/backups/director-apps-v020-20261012-2219`,
  mode 0700; manifest, lockfile, patch, operator catalog and credential state.
- Dependency installed through pnpm, not install.sh/development link.
- Operator apps.yaml restored after install and byte-compared with the backup.
- Only Director restarted. Carrier health returned healthy; nested Docker remained
  available (no stale-runtime repair needed this time).
- Existing desktop/nginx were deliberately relaunched on demand, not recreated.
  HyperFrames and other stopped containers were left untouched.

### Installed browser evidence

Existing `verify-director-rollout.py`: real embedded noVNC connected and existing
nginx rendered; All apps worked.

New `verify-director-installer.py`: actual installed Add app, not scratch mock:

1. HTTP Echo recipe image download/immutable review.
2. Private environment entry saved and re-reviewed; no credential value printed.
3. Publisher trust + approval; progress reached ready.
4. whoami content rendered under same-origin `/apps/web/web-echo/`.
5. All apps navigation; Logs, Stop, Launch and Uninstall.
6. Real workspace selection/session-controller/conversation draft handoff:
   new visible editor contained setup instructions and canary request; no Send
   action performed. One explicitly unsent setup draft remains in Director.

Final check: Director healthy at installed 0.2.0, test app removed from registry,
zero private installer secret files. Earlier interrupted test reviews were
explicitly cancelled; diagnostic journals remain. Shared image layers kept as
installer policy. No existing application data removed.

Test-driver corrections: live app cards use `.dsha-name`, log feedback is a message
rather than a pre block, and asynchronous Prepare must finish before the next
mutation. Clicking through the review before preparation released its flock gave
the documented active-operation/retry error; the complete settled UI flow passed.
These were canary driver/ordering fixes, not a moved tag or live source patch.

Automated evidence uses Director's existing internal 8080 origin, equivalent
loaded host/plugin but **not** authenticated public HTTPS/wss. Public gate was
not changed. Earlier v0.1.10 public user verification does not establish this
new install/session workflow on the public route.

## Olympus: staged on disk, NOT loaded

- Original dependency v0.1.8; profile now pins v0.2.0 and pnpm installed it.
- Private backup: `/data/backups/olympus-apps-v020-20261012-2241`, mode 0700;
  manifest, lockfile, patch, operator catalog and private credential state.
- Operator apps.yaml restored byte-for-byte after dependency install.
- Staged CLI list passed: legacy desktop/whoami running, shell/nginx stopped;
  no apps were recreated, stopped, or started on Olympus.
- Olympus running carrier continues to answer with its normal 401 gate.
- **No Olympus restart occurred in the active turn.** Its running server half is
  still the pre-upgrade lifetime; a page refresh is not a substitute for restart.
  Avoid using the newly staged Add app client until restart loads the matching
  server half. Do not call it live yet.

### Next safe activation

Finish this turn, then restart Olympus from the external host control plane or
UI. After reconnecting, verify health + nested Docker, restore desktop on demand
if necessary, page-refresh, and exercise installed My apps/Add app/session draft.
Never restart this harness from inside a still-running agent turn. Keep immutable
pinning; do not use install.sh on production. Other instances not upgraded.
