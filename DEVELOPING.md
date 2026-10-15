# Developing this repo

Development, release installation and activation are separate operations. The
isolated-origin gateway described here is **implemented/tested source, not deployed**.
Deterministic tests and scratch Chromium acceptance passed; production GUI/ingress
verification is still separate. See [verification evidence](<GATEWAY-VERIFICATION.md>).

## Where this lives

This repo root **is** a DSH workspace: `/workspace/dsh-computer`, with a `.dsh/`
marker at the root. A session started here resolves its own box identity
(`computer status` reports `dsh-computer-f78d205b`, distinct from the box belonging
to `Docker Testing`). The `docker-computer` skill is available system-wide at
`/data/skills/docker-computer`.

The repo root doubling as the workspace root means workspace-local state
(`.dsh-computer/`, `.dsh/`) lands beside the source, and both are gitignored.
This folder is in the Syncthing tree: source replicates to the Windows peer,
while dependencies and the box home are excluded by
[the workspace ignore rules](/workspace/.stignore). Do not put private state here.

## The two shapes

| | Production | Development |
|---|---|---|
| Profile specifier | `github:BluePointDigital/dsh-computer#<release-tag>` | `link:/path/to/checkout` |
| `node_modules/dsh-applications` | a fetched release | a **symlink** to your checkout |
| Edits take effect | only after installing the new release, then activation below | files change immediately; loaded server modules still need a restart |
| Reproducible | pinned release + lockfile | whatever is on disk |
| How you get it | edit profile dependency, `pnpm install` | [bin/install.sh](bin/install.sh) from the checkout |

**[bin/install.sh](bin/install.sh) always produces the `link:` shape**
(`WANT_LINK="link:$REL_PATH"`) and refuses a profile declaring a `github:` specifier.
Do not remove that guard to update production. Deliberately changing the profile
to `link:` converts production into development; that belongs on a scratch instance,
not an instance that should stay release-pinned.

## Releasing (the production path)

```bash
# 1. In the checkout: review the intended diff, test, bump and commit.
$EDITOR package.json
# Stage only the intended release changes, then commit/tag/push that release.
git add <reviewed-files>
git commit -m "<version>: <release summary>"
git tag -a v<version> -m "<release summary>"
git push origin main v<version>

# 2. On each instance, separately: point the profile at the released tag.
$EDITOR /data/profiles/web/package.json
# Run in the profile directory:
pnpm install --no-frozen-lockfile

# 3. Activate as appropriate below; then verify the installed package and GUI.
/data/skills/docker-computer/bin/computer apps list --json
```

A checkout edit or documentation update does not perform any of these deployment
steps. Prefer a pinned release over `link:` for anything intended to remain in
production. Installing dependencies may replace package directories; durable state
must not live inside them.

## What needs a restart, and what does not

- **[lib/index.js](lib/index.js) and imported server modules — restart.** This
  includes [lib/app-launch.js](lib/app-launch.js),
  [lib/app-sessions.js](lib/app-sessions.js) and
  [lib/host-listen.js](lib/host-listen.js): they are loaded at mount.
- **[lib/client.js](lib/client.js) — page reload** after the intended installed
  file/bundle is available. Bundle revisions derive from mtime/size; checkout edits
  do not reach a production pin. Do not promise HMR without its active watcher.
- **[bin/computer](bin/computer) — no harness restart.** Executed per invocation.
- **[SKILL.md](SKILL.md) — no harness restart.** The filesystem skill watches roots.
- **[cordis.patch.yml](cordis.patch.yml) / instance patch layer — restart.**
  `patchReload: "live"` is inert on 0.2.0-rc.2; `hmr` has `root: []`. Gateway
  settings and environment are consumed at server startup, not on page refresh.

Never restart the harness mid-turn. A restart invalidates memory-only gateway
sessions/tickets; users reopen apps from Applications. Verify the existing GUI
URL after activation and refresh, not a replacement server.

## Runtime Applications manager

See [APPLICATIONS-MANAGER.md](APPLICATIONS-MANAGER.md) for the new user/operator
contract: automatic all-container nested-Docker discovery, Compose grouping,
owner-click template/image/Compose deployment, details/logs/TTY, private saved
configuration and revisions, redeploy/rollback and retained-data removal.
Discovery is not adoption and does not reconstruct an original deployment source.
The older catalog/import/prepare APIs remain compatibility paths, not inventory
registration requirements.

- [runtime-inventory.js](lib/runtime-inventory.js) reads Docker state and supplies
  grouped, sanitized inventory/details; endpoint selection remains separate from
  deployment ownership.
- [deployments.js](lib/deployments.js) saves private definitions/environment,
  revision documents and job journals, then runs prebuilt images through Compose
  v2. Builds/Git contexts are not V1. Interrupted execution is failed for explicit
  redeploy rather than silently replayed; durable queued owner submissions can run.
- [runtime-console.js](lib/runtime-console.js) owns SSE logs and interactive Docker
  exec TTY/WebSocket sessions; a local Unix Docker endpoint is required for TTY.
- [runtime-ui.js](lib/runtime-ui.js) is loaded through the same plugin at
  `/apps/assets/runtime-ui.js`, alongside terminal assets. [index.js](lib/index.js)
  owns the runtime APIs/routes; it is not a second app/server/sidebar registration.

Provision Compose with `node bin/install-compose.mjs`: pinned v2.40.3,
release-checksum verification, private persistent `$DSH_HOME/tools/docker/cli-plugins/`
storage, rather than a package-directory or ephemeral-container install. It has
been provisioned on this instance. The executor selects that Docker config unless
the operator supplies DOCKER_CONFIG.

```bash
npm run test:runtime-browser  # Chromium + fixture backend; no installed-GUI claim
npm run test:runtime-live     # opt-in real Compose smoke creating scratch projects/data
```

Supplied Chromium fixture acceptance succeeded for inventory/details, SSE logs,
xterm typing, no automatic private-config loading and one-click deployment
submission. **Real Compose smoke also passed deployment, retained-data redeploy,
stop/start and scratch cleanup.** No production
acceptance are inferred. Server modules still need release installation and a
coordinated restart; serve the intended UI asset and verify the existing GUI after
refresh. No release/install/restart was performed as part of these source changes.

## Shared-host ports

The default with a known public origin and no wildcard config is now **harness
hostname/IP plus a durable assigned app port**. Existing wildcard deployments
explicitly switch with `appAccess: ports`; do not silently repurpose their TLS worker.
See [INSTALLATION.md](INSTALLATION.md#shared-host-application-ports-default) for
range forwarding, TLS and saved CLI configuration. No cookie rewriting or extra app
DNS is required. `npm test` includes port allocation, HTTP/WS, direct HTTPS, apply
lifetime and separate-process CLI regressions. `npm run test:ports-browser` uses an
isolated headless Chromium in the already-running desktop against private scratch
ports, not the production GUI. Server activation still requires a release and
coordinated restart; do not deploy a checkout link.

## Gateway architecture and configuration

[INSTALLATION.md](INSTALLATION.md#isolated-origin-gateway-opt-in) is the operator
contract, including all six instance-wide settings and environment alternatives:
`appDomain`, `controlOrigin`, `appIngressPeers`, `appListenHost`, `appListenPort`,
`appPublicPort`. Explicit `appAccess: legacy` retains shared-origin path mounts;
setting `appDomain` opts existing configurations into isolated origins. With a public
origin and no wildcard domain, the default is shared-host ports.

- [lib/app-launch.js](lib/app-launch.js): validates policy and emits
  `https://<id>-<identity hash>.<domain>`. Immutable container identity plus install
  owner where present determines the hash. Stopping/restarting the same container
  preserves its origin; replacement changes it, even if the app/container name is
  reused. Never reuse an origin for a replacement trust identity.
- [lib/app-sessions.js](lib/app-sessions.js): 60-second single-use DSH-issued launch
  tickets, then 8-hour Secure/HttpOnly/host-only `Partitioned` app-session cookies.
  Credentials from the control origin never become app credentials. Sessions are
  memory-only and bound to the app origin and identity.
- [lib/host-listen.js](lib/host-listen.js): private listener, exact ingress socket
  peer allowlist, exact generated-host routing, authenticated HTTP and WebSockets.
  Uses **`httpxy` pinned to `0.5.5`** in [package.json](package.json), not
  [lib/proxy.js](lib/proxy.js) with an empty mount. The latter is a transforming
  legacy proxy, not a transparent transport. Gateway preserves app paths, bodies,
  redirects, cookies (except reserved gateway/control cookies), CSP and XFO.
  It preserves application `Authorization`, strips private/control credentials
  and untrusted forwarding assertions, then sets verified public Host/proto/port.
- [lib/index.js](lib/index.js): DSH-authenticated control launch and lifecycle.
  Gateway mode disables **both** same-origin HTTP app access and legacy WS routes.
  Bad configuration, an unavailable listener, session failure or upstream failure
  is an error, **never** a reason to fall back to the shared origin or raw app port.

Isolated traffic needs no per-app `webHost`, `webRewrite` or `webSockets` entry.
The entry port/path are still real application facts; do not guess them. Serving
an app at `/` does not configure its public URL, OAuth callbacks or trusted-proxy
policy. Retain upstream frame protection and offer an authenticated top-level
launch when an iframe or partitioned-cookie flow is incompatible.

### Ingress is part of the security boundary

The standard layout is `*.<exact-harness-hostname>`: set `appDomain` to the
hostname in `controlOrigin`, including every subdomain label. Configure wildcard
DNS and TLS **once** there; keep the exact harness host routed to DSH and the
wildcard routed to the private gateway. These are distinct origins, not distinct
sites; host-only control cookies and exact-Origin checks remain necessary.
**TLS-only browser access and BYPASS ALL shared ingress/CDN caching for the entire
app wildcard are mandatory.** Cacheable upstream assets may still be private: a cache ahead of the
gateway can serve them without its session check. Browser-local caching is
separate and remains governed by app response headers.

Use a private gateway interface with firewall/network reachability limited to the
trusted ingress and an exact socket-peer IP allowlist. Do not infer trust from
`X-Forwarded-For`, CIDR ranges or a caller-supplied proxy header. In the NPM setup,
NPM and DSH are separate containers connected through a bridge: `127.0.0.1:3099`
inside NPM is **not** the DSH listener. Discover the actual bridge-facing DSH
address and the NPM source address as observed by DSH; defaults of loopback bind
and peers only suit a same-network-namespace ingress. Never expose the listener
publicly to compensate for a bad upstream address.

Do not copy control-host Basic auth, login middleware or credential injection to
the wildcard app hosts. Keep app `Authorization` intact, including app-owned Basic
or Bearer auth. DSH itself **does** have browser authentication; the control APIs
must continue using `ctx.connection.requestRejection(req)`. App data-plane access
uses the separate gateway session, not a second forwarded DSH login.

## Where state lives

Per-app VNC passwords live at **`$DSH_HOME/.dsh-applications`**, overridable with
`COMPUTER_APPS_STATE`. This is deliberately outside the skill symlink and managed
package directory, where a dependency reinstall once deleted every password.
Resolution falls back to the running container's `VNC_PASSWORD`, so a lost cache
self-heals. Installed registries, import metadata, jobs and private env files share
that private root; see [INSTALLATION.md](INSTALLATION.md). Gateway sessions are not
persisted there and expire on process restart.

## Delegated wildcard TLS

[DELEGATED-TLS.md](DELEGATED-TLS.md) describes the separate operator certificate
worker and customer two-record onboarding. `lib/tls-manager.js` persists private
registration/pending certificate state; `lib/tls-services.js` implements acme-dns,
NPM and public TLS adapters. Certbot handles ACME. `bin/tls-cli.mjs` is operator
provisioning/recovery; `bin/tls-worker.mjs` is supervised independently of DSH.
The GUI can display/check DNS but cannot submit NPM credentials or issue/reload
certificates. Source tests do not establish live service/public ACME readiness.

Run `npm run test:tls` for lifecycle, certificate, route auth and UI regressions.

## Tests (commands, not results)

Install checkout dependencies reproducibly with
[npm's lockfile](package-lock.json); `--legacy-peer-deps` avoids trying to resolve
the DSH host peer packages as standalone npm dependencies. This is separate from
a production profile's `pnpm install`.

```bash
npm ci --legacy-peer-deps
bash test/apps-password.test.sh     # password resolution order
node test/proxy.test.mjs            # legacy rewrites, gzip guard, SSE, real WS frames
npm test                           # deterministic installer + existing regressions
node --test test/host-router.test.mjs test/host-mount-apply.test.mjs
RUN_INSTALLER_SMOKE=1 node test/installer-browser.test.mjs
RUN_DESKTOP_SMOKE=1 node test/desktop.test.mjs
npm run test:gateway                # opt-in; requires existing running desktop
```

The deterministic [host-router test](<test/host-router.test.mjs>) and
[host-mount-apply test](<test/host-mount-apply.test.mjs>) cover the authenticated
gateway. The [browser fixture](<test/gateway-browser.test.mjs>) passed in Chromium
154 against scratch HTTPS ingress and a synthetic control page in both nested
same-site and separate-site layouts, including the production iframe sandbox flags.
Same-site iframe HTML downloads pass; see [measured results](<GATEWAY-VERIFICATION.md>)
for the cross-site download-attribute limitation and verified top-level fallback.
The previous [host-mount-live.mjs](<test/host-mount-live.mjs>) is retired.
Actual production DNS/TLS, cache bypass, socket peers and installed DSH shell/auth
still require verification after a separately authorized release/install/restart.

`bin/install.sh verify` is a diagnostic of mount/patch/catalog/daemon wiring, not a
gateway or browser acceptance test. Do not run the installing form on production.
Source test results do not imply a production installation or restart. A green
check is a claim about what was checked, not about what works.
