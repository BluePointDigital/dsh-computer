# v0.7.3 rollout — 2026-10-22

## Feature verification

- Nine diagnostics tests plus TLS API auth and runtime UI tests pass.
- Final v0.7.3 full suite: 263 Node / 39 proxy / 12 password / 3 retry checks pass.
- Production Director now serves access-health with isolated mode and the real
  missing-wildcard, unprovisioned TLS and missing expected-IP diagnostics.
- Added sanitized public onboarding A record for Director and Wilson using measured
  same-host ingress 104.225.218.209. No validation target or certificate was invented.
- Installed Director shell Chromium acceptance passed: record/instructions visible,
  Recheck issues POST and clears warning, zero page errors. DNS responses were
  intercepted in this browser only; actual public DNS was not changed. Screenshot
  inspected in light theme. Dark-theme attribute manipulation did not actually
  change the shell theme, so dark visual acceptance is NOT claimed.
- Anonymous public access-health returns 401 on Director, Wilson and Reference.

## Current deployment state

| Instance | On disk | Active | State |
|---|---|---|---|
| Olympus | 0.7.3 GitHub pin | Previous module still loaded | External idle-boundary worker armed; activation/acceptance logs must be checked next turn |
| Director | 0.7.3 GitHub pin | 0.7.3 verified | All 7 original nested IDs retained; previously running desktop restored; wildcard DNS/TLS still required |
| Wilson | 0.7.3 GitHub pin | Not claimed | Two persisted open turns prevent restart; isolated config saved; public range stopped/restart=no; external idle worker armed |
| Reference | Managed baseline 0.1.0-apps.073 / Applications 0.7.3 | 0.7.3 verified | Managed-image promotion succeeded; 3 nested IDs preserved/stopped; ownership preflight passed; public diagnostics anonymous401 |

Private per-instance backups are under /data/backups/applications. Director and
Wilson public app-port gateways are stopped and restart=no. Exact control routes
and authentication were not changed. No app volume deletion or recreation.

## Reference correction / recovery

Reference's user profile had no Applications dependency because its managed base
image already owns Applications 0.6.3 at /opt/dsh-environment/applications. Installing
it as a user bundle shadowed the managed provider. The ownership preflight correctly
blocked the restart. Stopped the exact Reference container, used its existing single
volume to back up the failed profile and restore the pre-install package/lock/patch,
then started it. Reference is healthy again. Do not repeat the profile upgrade.
The managed-image path was subsequently inspected and used correctly. Built from
Applications commit f2bb362c13235a80c9b5d110236163ecf2dbb689, image
sha256:4c919bbd1a5b0a56d70a65a2908482c77f2e2abbbd992ab97df1a7f4225f912a.
Quiesced full-volume archive: 865423360 bytes / 34268 entries, SHA256
3049cda77ff33f7e4b3886322db0594c952d4dccfd39dcb1e5772d676923dd5e.
Backup is HOST LOCAL, not off-host. Candidate ownership preflight ran read-only,
network-none against the stopped volume without booting copied schedules/services.
Promoted stack12 to exact image, preserved all 3 nested IDs/stopped states, healthy
and access-health isolated200 locally / anonymous401 publicly. Exact public A
onboarding prepared; wildcard DNS/TLS still requires provisioning. Private journal:
/data/reference-single-volume/apps073-20261022T033642Z.

## Immutable release correction

v0.7.2 remains published but is superseded by v0.7.3. Inspection caught historical
isolated gatewayConfig lacks a mode field; classification now recognizes its domain.
No tags were rewritten.
