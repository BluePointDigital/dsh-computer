# dsh-computer — working notes for agents

This repo root is also a DSH workspace (`/workspace/dsh-computer`, `.dsh/` marker).
The `docker-computer` skill is installed system-wide at `/data/skills/docker-computer`,
so it is available here without being copied. Full detail in [DEVELOPING.md](DEVELOPING.md),
[SKILL.md](SKILL.md) and [INSTALLATION.md](INSTALLATION.md); this is the short version.

## Release is not development

[bin/install.sh](bin/install.sh) **always** writes a `link:` dependency
(`WANT_LINK="link:$REL_PATH"`) and **refuses** a `github:` specifier. Its purpose is
checkout installation, not updating a production release pin. Switching a live
profile to that shape converts production into development.

Production uses a pinned GitHub release, not this checkout:

```text
"dsh-applications": "github:BluePointDigital/dsh-computer#<release-tag>"
```

To deploy a change, use the release loop in [DEVELOPING.md](DEVELOPING.md): bump,
review, commit, tag, push; then repoint each instance's profile dependency and run
`pnpm install --no-frozen-lockfile`. Never use the checkout installer as a shortcut
on a live instance. **The isolated-origin gateway is source work, not a deployed
feature.** Deterministic regressions and scratch Chromium gateway acceptance passed;
the production GUI/ingress remains unverified. See [verification evidence](<GATEWAY-VERIFICATION.md>).

## What needs a restart

| Changed | Effect after installing the intended release |
|---|---|
| [lib/index.js](lib/index.js) or server modules it imports, including gateway/session code | needs a `dsh web` restart |
| [lib/client.js](lib/client.js) | picked up on a **page reload** |
| [bin/computer](bin/computer) | read from disk per invocation |
| [SKILL.md](SKILL.md), this [AGENTS.md](AGENTS.md) | filesystem instruction/skill roots are watched |
| [cordis.patch.yml](cordis.patch.yml) / instance patch configuration | **restart, always** — `patchReload: "live"` is inert on 0.2.0-rc.2 |

Never restart mid-turn. A development edit does not update a production-pinned
package; installing a server change does not reload an already-running server.

## State and approval

App state (per-app VNC passwords) lives at `$DSH_HOME/.dsh-applications`, overridable
with `COMPUTER_APPS_STATE`, never under the skill directory. That directory resolves
through a symlink into a pnpm-managed package, which an install replaces; this once
silently deleted every password. Resolution falls back to the running container's
`VNC_PASSWORD`, so a lost cache self-heals.

Installed applications use the same private root for versioned registry, progress
journals and private env files. CLI and server share AppManager; agents may prepare
plans but must never approve/execute on the human's behalf. Do not put credentials
or the registry in a synced workspace/package directory. Read
[INSTALLATION.md](INSTALLATION.md) before altering installation/recovery behavior.

## Isolated-origin gateway — opt in once per instance

Read the [configuration and ingress contract](INSTALLATION.md#isolated-origin-gateway-opt-in)
first. [lib/app-launch.js](lib/app-launch.js) defines instance-wide `appDomain`,
`controlOrigin`, `appIngressPeers`, `appListenHost`, `appListenPort` and
`appPublicPort`, with environment alternatives documented there. An unset
`appDomain` keeps the **explicit legacy default** at `/apps/web/<id>/`; those apps
share DSH's browser origin and must be trusted. DSH has browser authentication:
control routes use `ctx.connection.requestRejection(req)`, not a Host-only fence.

With gateway mode enabled:

- Hosts are automatic: `https://<id>-<identity hash>.<domain>`. The identity includes
  the immutable container ID (and installation owner where present), not just its
  reusable name. Replacement gets a **new origin**; old storage/service workers
  must not inherit the replacement. Unknown hosts and missing identities fail closed.
- **Same-origin app HTTP and WebSocket access are disabled.** Listener, launch,
  cookie or ingress failures must not fall back to the legacy proxy or a published
  container port. There is no per-app `webHost`, `webRewrite` or `webSockets` recipe
  needed for isolated traffic.
- Configure one wildcard DNS/TLS ingress. **TLS-only and BYPASS ALL shared
  ingress/CDN cache are mandatory**, including app assets. Keep the gateway private
  and allow only exact ingress **socket peer** IPs, never forwarded identity headers.
  NPM runs across a container bridge here: its loopback is not DSH's loopback.
  Confirm the actual private interface and peer addresses before configuring them.
- Standard layout: **`*.<exact-harness-hostname>`**, even when DSH is already on a
  subdomain. Set `appDomain` to that exact hostname, without `*.`; keep the harness
  apex on its existing route. Distinct origins are not distinct sites; retain
  host-only control cookies and exact-Origin checks. Do not inject Basic auth or
  DSH/control authentication on app hosts;
  preserve application `Authorization`. DSH authenticates launch on the control
  origin, then issues a 60-second single-use ticket. App sessions use an 8-hour,
  Secure, HttpOnly, host-only `Partitioned` cookie, never a DSH credential.
- [lib/host-listen.js](lib/host-listen.js) uses pinned `httpxy`, **not** the legacy
  empty-mount rewriting proxy. Preserve upstream CSP/X-Frame-Options. Root hosting
  removes path rewriting, not every app setting: public URL, OAuth callbacks or
  trusted proxies can still need configuration. Use the authenticated top-level
  launch when framing/cookies are incompatible; never weaken protections to embed.

[lib/app-sessions.js](lib/app-sessions.js) owns memory-only tickets and sessions;
server restart/disposal invalidates them, so reopen from Applications.
[lib/index.js](lib/index.js) gates control requests and owns gateway lifetime.

## Before you claim something works

Dependencies include exact-pinned `httpxy` in [package.json](package.json). In a
checkout, use the lockfile install before running the intended tests:

```bash
npm ci --legacy-peer-deps
bash test/apps-password.test.sh     # password resolution order
node test/proxy.test.mjs            # legacy rewrites, gzip guard, SSE, real WS frames
npm test                           # deterministic installer/proxy/CLI regressions
node --test test/host-router.test.mjs test/host-mount-apply.test.mjs
RUN_INSTALLER_SMOKE=1 node test/installer-browser.test.mjs
RUN_DESKTOP_SMOKE=1 node test/desktop.test.mjs
npm run test:gateway                # opt-in; requires existing running desktop
```

The deterministic [host-router test](<test/host-router.test.mjs>) and
[host-mount-apply test](<test/host-mount-apply.test.mjs>) cover the authenticated
gateway. [Chromium acceptance](<test/gateway-browser.test.mjs>) passed against
scratch HTTPS ingress, a synthetic control page and the real gateway transport;
this is not production DNS/TLS/CDN or installed-DSH-shell acceptance.
See [measured results and limitations](<GATEWAY-VERIFICATION.md>).
[upgrade-route.test.mjs](test/upgrade-route.test.mjs) uses mocked CLI/daemon responses
and real HTTP/WebSockets, without creating containers.
[desktop.test.mjs](test/desktop.test.mjs) uses isolated headless Chromium inside an
already-running desktop, without touching its live browser or the harness.
The old [host-mount-live.mjs](test/host-mount-live.mjs) fixture targets the previous
hostname listener; do not use it to certify the new authentication/ingress contract.

A green check is a claim about what was checked, not about what works. Source test
results do not imply a production installation, restart or live deployment.
