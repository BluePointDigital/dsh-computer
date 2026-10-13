# v0.2.0 local release candidate — Add app

## Delivered

- My apps + Add app, preserving embedded-only launch and fixed All apps callback.
- Three supported recipes (HTTP Echo, Nginx, locally built Linux Desktop).
- Advanced single-container configuration and explicit image/resource/storage/
  environment/publisher-trust review. Preparation may download but never execute.
- Install something else opens a fresh ordinary DSH session with a draft in a
  selected workspace; it does not send automatically or use Agent Teams.
- Agent-prepared plans appear in Add app and can receive private environment
  values there; edits rotate approval and require trust re-confirmation.
- GUI/CLI share durable AppManager registry/jobs outside package and sync roots.
- Image content pinned before approval; no host port publication for managed apps.
- Real progress/events, redacted logs, explicit interrupted recovery, safe uninstall.
- Cross-process flock, ownership labels + immutable container actions, atomic
  journal writes, uncertain-daemon failure retention and operation-scoped volumes.
- Existing legacy catalog remains compatible; cannot be silently overridden.

## Verification — 2026-10-12

`npm test`: **40 Node tests, 35 proxy checks, 12 password checks passed**.
Syntax and whitespace checks passed.

`RUN_INSTALLER_SMOKE=1 node test/installer-browser.test.mjs`: real Chromium/React
advanced form → review/trust → Docker container → progress → embedded nginx →
All apps navigation → setup draft handoff passed. Uses a private temporary
registry and random owned container id; uninstall cleans the container. Existing
live app containers are not replaced. React is reused only from the installed
bundle through a scratch server; no DeepSeek core file is changed.

`RUN_DESKTOP_SMOKE=1 node test/desktop.test.mjs`: existing real desktop connected
through the checkout's HTTP and exact WebSocket routes. This was not an installed
GUI update.

Session service calls are mocked in the isolated UI smoke and separately unit
tested; exact methods were checked against installed DSH public contracts. Real
new-thread navigation with the installed host UI requires a canary after publish.
Likewise stock recipe tags need available registry/network access in the target
instance; private/multi-service/unsupported apps require explicit agent research.

## Deliberate first-version limits

This is not Portainer/Compose or universal install-anything. Single container,
trusted publisher, explicit web entry, named volumes; no host mounts/devices/
capabilities/raw Docker flags. Environment values readable by app/Docker admins;
literal log redaction is not defense against a malicious publisher.

The readiness check proves running container + web entry, not every SPA feature.
User/agent still verifies actual UI. Same-origin embeds are trusted code, not a
hostile-app isolation boundary. No data restoration, volume deletion, update/
recreate or automatic rollback across multi-service migrations. Uninstall keeps
image/volume data; reinstall uses fresh volume names, never silently adopts it.
Approved workers are process-owned and finish/rollback on plugin disable; no new
worker starts after disposal. Recovery after process interruption is explicit.

## Deployment boundary

v0.2.0 is a locally committed source candidate, not a pushed tag or live upgrade.
Olympus remains on its prior pin and Director remains on accepted v0.1.10.
No install.sh production conversion, live profile edit, harness restart or core
patch was done for this build. Recommended next stage is immutable publish and
Director canary with real session draft + Add app tests, before Olympus upgrade.
See INSTALLATION.md for complete contract and SKILL.md for agent instructions.
