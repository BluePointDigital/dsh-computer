# v0.1.9 — embedded applications release candidate

## Contract

Applications open inside the DSH Applications panel through `/apps/web/<id>/`.
The browser needs access to DSH only; it does not need tailnet access to the app,
a per-app public hostname, or a new tab. No DeepSeek core patch is required.
The plugin uses the existing public `webServer.registerUpgrade({ path, handler })`
API to own exact WebSocket paths, rather than depending on future prefix support.

## Changes

- `webSockets: /websockify` declares exact socket paths. Routes reconcile on
  catalog reads; registered handlers run the DSH gate before any daemon lookup.
  Removed paths are disposed; plugin disposal cancels pending registration and
  closes HTTP/SSE upstreams and active socket tunnels.
- The client requires the matching app proxy marker and any needed `ws`/`js`
  capability before embedding. Missing mounts/capabilities show an error.
  Published-origin fallback and New tab are removed. Legacy direct entries show
  migration guidance rather than attempting an external frame.
- Desktop launch explicitly sets noVNC's host, port, encrypt and mounted socket
  path. noVNC does not infer a socket prefix from its page URL. Legacy viewer-only
  catalogs receive a default mount and `/websockify` route automatically.
- `webRewrite: /api/ /rpc/` opts into narrowly scoped JS literal rewriting.
  HTML/JS transformation skips encoded bodies; JSON remains untouched. Rewritten
  representations have upstream validators removed and no-store cache policy.
- Matching viewer/web port publications deduplicate; conflicting container ports
  fail validation. Paths/ids are validated before JSON or launch arguments.
- Harness `dsh-auth-*` cookies and front-door Authorization are stripped after
  authentication, before forwarding requests to apps.

## Compatibility limits

This is not a universal base-path solution. Computed/escaped JS URLs, service
workers, WebSockets built with undeclared paths, SRI hashes on rewritten assets,
and applications that cannot run under a prefix still need app-specific setup.
Prefer an application's native base-path setting when available. An upstream
that sends compressed JS despite `Accept-Encoding: identity` passes through
unrewritten; the capability header describes configured proxy support, not a
proof that every resource is mount-compatible.

Same-origin apps must be trusted. Removing the harness cookie from upstream
headers does not sandbox JavaScript or prevent a same-origin app from interacting
with the surrounding harness. This release is not a boundary for hostile apps.

Existing catalog edits live wherever COMPUTER_APPS_FILE points. Package-shipped
catalog changes can be replaced during a dependency upgrade; operator custom
catalogs should live outside node_modules and be selected with that override.
Existing published ports are kept for backwards-compatible CLI diagnostics;
the panel never uses them as fallback routes.

## Verification

```bash
bash -n bin/computer
node --check lib/index.js
node --check lib/client.js
node --check lib/proxy.js
node test/proxy.test.mjs
node --test test/client.test.mjs test/catalog.test.mjs test/upgrade-route.test.mjs
bash test/apps-password.test.sh
RUN_DESKTOP_SMOKE=1 node test/desktop.test.mjs
```

The deterministic route integration mocks only CLI/daemon responses and uses
real HTTP/WebSocket connections. It deletes no containers. The optional browser
smoke connects real Chromium/noVNC to an already-running desktop through this
checkout's HTTP and upgrade handlers, using an isolated temporary browser
profile and a scratch front. It does not exercise the installed GUI or its
production TLS/auth front door; those require a post-deployment verification.

Measured locally on 2026-10-12: 35 proxy checks, 20 Node client/catalog/route
tests, 12 password checks, and the real Chromium desktop connection smoke all
passed. Syntax and diff-whitespace checks passed. HyperFrames itself was not
installed here or exercised in this run; its per-app `/api/` configuration remains
a deployment verification item.

## Release/deploy boundary

This checkout is the release source; editing it does not alter the installed
GitHub-tag-pinned plugin. Do not edit a hardlinked node_modules copy and do not
run install.sh against a production profile to deploy this change.

1. Commit verified source; publish an immutable v0.1.9 tag.
2. Per instance, change the pinned dependency from v0.1.8 to v0.1.9 and reinstall
   via the documented release loop, preserving any operator catalog/state.
3. Restart dsh web after the agent turn has ended; reload the existing GUI.
4. Verify desktop connection, an ordinary dashboard, a rewrite-configured SPA,
   unauthenticated socket rejection, and the public HTTPS origin from an
   off-tailnet browser. Roll back to the prior pin if those fail.

No live profile update, tag push, harness restart, or production rollout is part
of preparing this local candidate. The pre-existing plugin-patch directory is
historical reference, not the new implementation or a deployment prerequisite.
