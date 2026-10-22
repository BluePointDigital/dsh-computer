# Applications installation and gateway contract

> **Direct Docker update — 0.7.0 preparation, 2026-10-21:** this checkout is
> preparing **0.7.0**, **not installed, released or restarted**. Older deployment
> and test notes below are historical scope, not a claim that this source is live.
> See [Direct Docker verification](<DIRECT-DOCKER-VERIFICATION.md>) for the current
> source benchmark, pending test count and deferred activation handoff.

The isolated-origin gateway is **implemented/tested source, not deployed**. This
document specifies deployment prerequisites, not live success. Deterministic tests
and scratch Chromium gateway acceptance passed; see [verification evidence](<GATEWAY-VERIFICATION.md>)
for scope and the iframe download limitation. Keep publication, dependency
installation, server restart and installed-GUI verification separate, as described
in [DEVELOPING.md](<DEVELOPING.md>). No production installation/restart was performed.

## Runtime Applications manager

The new Applications page discovers all containers from this instance's nested
Docker daemon and groups Compose projects automatically. Listing, inspection,
logs, terminal and supported lifecycle control need **no registration or
migration/acceptance step**. Existing catalog/import metadata remains compatible;
it is no longer the condition for visibility. Discovery does not reconstruct a
saved deployment definition for an externally created container/project.

The owner deploys a template, container image or pasted/uploaded self-contained
Compose document with one **Deploy** submission. Saved applications have private
source/environment, revision history, configuration-driven redeploy and rollback.
Removal retains data by default; deleting data is explicit. Interrupted workers
retain containers/data and become failed for deliberate redeploy after inspection;
durable queued owner submissions may still be scheduled. See the full
[Applications manager contract](APPLICATIONS-MANAGER.md), including V1 Compose
restrictions and the difference between configuration rollback and data restore.

Docker Compose v2 is required. `node bin/install-compose.mjs` provisions pinned
v2.40.3 with SHA-256 verification into `$DSH_HOME/tools/docker/cli-plugins/`, not
node_modules or the synced workspace. It has been provisioned here; this is not
activation of the manager. Git deployment/builds are not V1. The UI is served by
the same plugin at `/apps/assets/runtime-ui.js`.

**Verification scope:** supplied Chromium fixture acceptance passed
inventory/details/SSE/xterm typing/private-config no-auto-load/one-click submit.
Real Compose smoke (`npm run test:runtime-live`) passed deployment, retained-data redeploy and lifecycle. The browser command
is `npm run test:runtime-browser`. No release, dependency installation or harness
restart for this feature is claimed. Hosting and shared-host port setup below
remain unchanged; release/activation still follows [DEVELOPING.md](DEVELOPING.md).

## Direct Engine prerequisites and rollout

The approved refactor uses one shared [ApplicationRuntime](<lib/application-runtime.js>)
Engine snapshot for server inventory/details and gateway discovery, backed by
[native Unix-socket HTTP](<lib/docker-engine.js>). It does not need a new public
service, socket publication, per-app registration or state/container migration.

| Target input | Supported behavior |
|---|---|
| Unset `DOCKER_HOST` | Local `/var/run/docker.sock` |
| `DOCKER_HOST=unix:///absolute/socket/path` | That exact local Unix socket, reachable by the DSH process |
| `DOCKER_API_VERSION` | Optional explicit version within daemon overlap and supported **1.41–1.47** range; otherwise negotiate the highest overlap |
| `DOCKER_CONTEXT` | Unset or `default`; nondefault values fail explicitly |
| TCP/SSH/other remote endpoint or Docker TLS settings | Explicitly unsupported; no fallback to another target |

Do not expose Docker over a public TCP socket/API or proxy it through the app
listeners. The remaining provisioning/Compose CLI executor receives the same
selected Unix `DOCKER_HOST` and cleared context, while retaining its controlled
Compose environment/private Docker config. Compose v2 remains required for
saved deployments and project lifecycle; image/create provisioning and
specialized workspace-box/interactive CLI commands remain CLI exceptions. Engine
unavailability is not permission to fall back to a shell inventory or remote daemon.

The shared server cache has a **3-second** fresh window and coalesces refreshes.
Ordinary expired reads return the last snapshot while refreshing; explicit Refresh
waits for fresh inventory. **Cold failure returns 503**; warm failure serves
last-known apps marked with `updatedAt`, `stale`, `refreshing` and
`dockerAvailable`, not an apparently successful empty list. The UI retains its
sanitized last snapshot across panel remounts, polls every **5 seconds while
visible**, and revalidates immediately when visible again. Server/client caches
are **memory-only**; authentication rejection clears the client cache. Overview
stats are fetched separately and cannot block app inventory/details.

The CLI shares the inventory implementation and durable metadata, not the server's
in-memory cache. Existing catalog, registry, registrations, deployment definitions,
jobs, secrets, endpoint/port settings and container data remain durable and
unchanged in format/location. No migration script, adoption, container recreation
or volume rewrite is needed for this refactor. State backup still matters.

Cached display data never authorizes actions: lifecycle/log/TTY operations freshly
resolve membership and inspect the selected immutable full container ID. Gateway
dispatch freshly inspects its targeted full ID and rechecks current
ownership/project/endpoint metadata and running state before dialing, failing
closed on absence, replacement or uncertainty. It shares inventory without
repeating all-daemon discovery for each app asset. Cancelling an exec or closing
a terminal closes its transport; **it does not guarantee the in-container process
or descendants were killed**.

### Deferred production activation and rollback

The proposed pin change is **0.6.3 → 0.7.0**, after verification and publication.
Use the **approved plugin-manager installation path**: first list installed
bundles for their exact identifiers, then obtain the required owner approval for
the reviewed release. Do not directly edit production profiles, manually change
pins/locks, or run the checkout/link installer as an upgrade shortcut.

Before rollout, back up private app state **outside the synced workspace**, and
preserve the current production pin/lockfile and relevant instance configuration.
Keep private definitions, environment values and credentials out of this checkout.
Coordinate activation **after the active turn**, then refresh and verify the
existing DSH GUI/URL and intended ingress; never restart mid-turn. Rollback
reinstalls the prior reviewed release pin using the same approved path and
coordinates activation. It is a code rollback, **not permission to overwrite app
data or restore stale app-data backups**. See the
[release procedure](<DEVELOPING.md#releasing-the-production-path>) and
[verification handoff](<DIRECT-DOCKER-VERIFICATION.md>).

## Shared-host application ports (default)

Apps use the harness's existing hostname or IP and an automatically assigned port:
`https://dev.example.com:20000/` or `http://192.168.1.50:20000/`. No app DNS records,
subdomains, path adapters or cookie rewriting are required. Applications opens the
app inside the panel and offers a new-tab link.

Set `controlOrigin` to the existing exact public harness origin (or supply
`DSH_APPS_CONTROL_ORIGIN` / `DSH_PUBLIC_URL`). With no `appDomain`, this selects
ports mode. Existing wildcard configurations remain compatible; set
`appAccess: ports` to switch them explicitly. `appAccess: legacy` retains old path
mounts. When no public origin is known, old installations retain legacy behavior.

| Plugin setting | Environment alternative | Default |
|---|---|---|
| `appAccess` | `DSH_APPS_ACCESS` | `ports` when a public origin is known, `isolated` when `appDomain` is set, otherwise `legacy` |
| `controlOrigin` | `DSH_APPS_CONTROL_ORIGIN`, then `DSH_PUBLIC_URL` | Exact HTTP(S) harness origin, hostname or IP, including harness port if needed |
| `appOrigin` | `DSH_APPS_ORIGIN` | Optional shared app origin; defaults to control origin. Use `https://apps.dev.bluepointdigital.com` to separate app traffic/cookies from the harness. Assigned ports replace its port; nondefault base ports are rejected. |
| `appPortStart` / `appPortEnd` | `DSH_APPS_PORT_START` / `DSH_APPS_PORT_END` | `20000` / `20099`, inclusive |
| `appListenHost` | `DSH_APPS_HOST_BIND` | `0.0.0.0`, or `::` for an IPv6 harness origin; set the private interface when using ingress |
| `appTlsCert` / `appTlsKey` | `DSH_APPS_TLS_CERT` / `DSH_APPS_TLS_KEY` | Optional certificate/key paths for direct HTTPS listeners |
| `appTlsTermination` | `DSH_APPS_TLS_TERMINATION` | Set to `ingress` when an external proxy terminates TLS on **every app port** |

Example behind existing TLS ingress:

```yaml
appAccess: ports
controlOrigin: https://dev.bluepointdigital.com
appOrigin: https://apps.dev.bluepointdigital.com
appListenHost: 172.18.0.4
appPortStart: 20000
appPortEnd: 20099
appTlsTermination: ingress
```

**One-time networking:** publish/forward the configured TCP range into the DSH
container, or into a TLS ingress which forwards each port to the same private DSH
port. Generate an nginx HTTP-context server with
`node deploy/port-ingress.mjs https://dev.example.com 172.18.0.4 /cert/fullchain.pem /cert/privkey.pem`.
For a separate shared app hostname, append the range and app origin:
`node deploy/port-ingress.mjs https://dev.bluepointdigital.com 172.18.0.4 /cert/fullchain.pem /cert/privkey.pem 20000 20099 https://apps.dev.bluepointdigital.com`.
It reuses a certificate valid for the **selected app hostname** across the whole range; install it in
an HTTP-context include, not a single proxy-host Advanced location. Publish
`20000-20099:20000-20099/tcp` on that ingress container and persist the change in
its deployment owner. A CDN must support these ports or this route must be direct.
Do not route app traffic through the harness's credential-injecting control proxy.
For direct HTTP/IP installations only the range forwarding is needed. HTTPS/IP
installations need a certificate valid for that IP. HTTPS without direct TLS files
or explicit ingress termination is rejected instead of advertising broken URLs.

Assignments live in private app state as `ports.json`, separately locked from long
installation transactions, atomically persisted, and shared by GUI and CLI. The
server saves its nonsecret resolved public launch policy for CLI invocations which
do not inherit Cordis settings. Stops, reorderings, package upgrades and container
replacement preserve each app's port; absent apps' reservations are not silently
recycled. Exhaustion only makes the new app unavailable. A busy OS port reports
unavailable and retries the **same** port on refresh, never moving its URL.

This is the conventional **trusted-app, URL-plus-port model**. Apps retain their own
login and cookies; harness login is not a login wall for directly published app
ports. Browser origins/storage differ by port; cookies remain shared by hostname.
No gateway ticket/session cookie is added in this mode. HTTP bodies, root URLs,
application Authorization, redirects, CSP/X-Frame-Options and arbitrary WebSockets
pass through without content rewriting. Use the new-tab action for apps that block
framing. The control APIs retain DSH authentication and exact-Origin checks.

Source implementation and scratch tests do not deploy the port range on an
existing installation. Install the intended release, configure ingress and activate
it with a coordinated server restart; never restart mid-turn.

## Isolated-origin gateway (opt-in)

With `appAccess: legacy`, or without any public origin or `appDomain`, this instance remains in **explicit legacy mode**:
`/apps/web/<id>/` shares the DSH browser origin. That is compatibility behavior,
not isolation; only trusted application JavaScript should run there. DSH has
browser authentication, and its control routes use
`ctx.connection.requestRejection(req)` for the Host/Origin and login checks.

Set the gateway policy **once per instance**, not once per app. The current source
of configuration truth is [lib/app-launch.js](lib/app-launch.js), consumed by
[lib/index.js](lib/index.js). Explicit plugin values take precedence over the
environment alternative:

| Plugin setting | Environment alternative | Meaning / default |
|---|---|---|
| `appDomain` | `DSH_APPS_DOMAIN` | Set to the exact harness hostname (e.g. `dev.bluepointdigital.com`), without `*.`, scheme, port or trailing dot; lowercase. Unset disables the gateway. |
| `controlOrigin` | `DSH_APPS_CONTROL_ORIGIN` | Required exact public HTTPS DSH origin when enabled, with no path or trailing slash; include its port if nonstandard. |
| `appIngressPeers` | `DSH_APPS_INGRESS_PEERS` | Array of exact trusted private ingress socket-peer IPs; env is comma-separated. Default `127.0.0.1,::1` only fits same-namespace ingress. No CIDRs or forwarded-header trust. |
| `appListenHost` | `DSH_APPS_HOST_BIND` | Private listener bind address; default `127.0.0.1`. Must be reachable from the actual ingress topology, not from the public Internet. |
| `appListenPort` | `DSH_APPS_HOST_PORT` | Private gateway HTTP listener port, default `3099`; `0` is for ephemeral tests only. |
| `appPublicPort` | `DSH_APPS_PUBLIC_PORT` | Browser-facing HTTPS port, default `443`; this is not the private listener port. |

Example **plugin configuration values**, not an instruction to apply them to a live
profile; replace both private IP placeholders with verified topology values:

```yaml
appDomain: dev.bluepointdigital.com
controlOrigin: https://dev.bluepointdigital.com
appIngressPeers:
  - <exact-NPM-socket-peer-IP-seen-by-DSH>
appListenHost: <private-DSH-interface-reachable-from-NPM>
appListenPort: 3099
appPublicPort: 443
```

Use either the plugin configuration or the environment consistently. In particular,
a separately invoked CLI sees its own environment, not the server's plugin config.
Do not assume changing settings or environment is live: activation requires the
intended package to be installed and the server restarted, not just a page reload.

### Automatic hosts and immutable identity

A web app gets `https://<id>-<identity hash>.<domain>` (plus `appPublicPort` when it
is not 443). The hash is derived from the app id, **immutable container ID**, and
installation owner where present. It is not a hash of a reusable container name.
A stop/start of the same container keeps the origin; replacement/reinstallation
with a new identity gets a **new origin**, preventing old service workers and
origin storage from silently becoming the replacement's state. Missing identity
makes launch unavailable rather than falling back to a name-based route.

Wildcard DNS is discovery infrastructure, not a wildcard backend route. Only
exact generated hosts in the current app map route to a container; unknown hosts
are rejected. Endpoint lookup rechecks container identity/ownership before dialing.
Old bookmarks are not stable aliases after replacement; reopen through Applications.

Isolated traffic needs **no per-app `webHost`, `webRewrite` or `webSockets`**.
The app's container web port and entry path still have to be correct. The listener
owns HTTP and arbitrary app WebSocket paths on that app's origin, without path
rewriting. It uses the exact-pinned `httpxy` dependency, not the legacy
[lib/proxy.js](lib/proxy.js) at an empty mount: that legacy proxy transforms content
and headers even in cases where the old hostname documentation claimed transparency.

Opting in **disables same-origin app HTTP and WebSocket access instance-wide**.
The old `/apps/web/<id>/` HTTP mount refuses access and legacy app WS routes are not
registered. Invalid configuration, a failed listener, missing ingress, an expired
session or an unavailable backend never triggers a shared-origin or raw-port
fallback. Fix the prerequisite or report failure; do not silently remove isolation.

### Delegated DNS onboarding and automated wildcard TLS

For provider-neutral two-record onboarding without customer DNS API tokens, use
[the delegated TLS operator contract](DELEGATED-TLS.md). A separate Certbot worker
updates a restricted acme-dns registration and deploys/renews one custom NPM
wildcard certificate. The authenticated Applications panel displays DNS records,
Check DNS and certificate status using a sanitized snapshot volume, never the
worker's private credential/key volume. Shared validation service and real staging
acceptance are recorded in [the live evidence](deploy/acme-dns/OLYMPUS-DEPLOYMENT.md);
production gateway activation remains separate. Complete the ingress requirements
below independently; a certificate is not proof of gateway/auth/cache readiness.

### Mandatory one-time ingress setup

1. **Use `*.<exact-harness-hostname>` on every instance.** Set `appDomain` to the
   hostname in `controlOrigin`, without `*.`. This applies to both a bare domain
   (`thisharnessdomain.com` → `*.thisharnessdomain.com`) and a subdomain
   (`dev.bluepointdigital.com` → `*.dev.bluepointdigital.com`,
   `otherdsh.bluepointdigital.com` → `*.otherdsh.bluepointdigital.com`). Do not
   shorten the hostname to its registrable parent. The control host may equal the
   suffix, but must not be beneath it, where it could collide with an app host.
   Apps remain distinct origins, not distinct sites. Control authentication must
   resist child-domain cookie injection: use Secure `__Host-` cookies (Path=/, no
   Domain), or an independently verified equivalent. **Stock DSH 0.2.0-rc.2 uses
   non-prefixed `dsh-auth-*` cookies and first-match verification; host-only alone
   does not prevent a child app from planting a longer-path parent-domain cookie
   that denies control authentication.** Verify/harden the actual control path
   before treating child apps as untrusted. A deployment proxy that owns the DSH
   session, discards browser cookies and never exposes its session cookies can be
   an equivalent boundary; verify that path rather than assuming the stock cookie
   behavior is exposed. Such a proxy must validate exact public Host, full Origin,
   fetch metadata and actual ingress peer **before** injecting authentication,
   preserve genuine Host/Origin to DSH, and exchange only configured authority-bound
   sessions. Rewriting all origins to loopback silently defeats the browser fence
   and breaks launch authorization. Cookie `SameSite` behavior is not a substitute
   for exact-Origin checks.
2. Configure one wildcard DNS record and wildcard TLS certificate/ingress for
   `*.<appDomain>`. A certificate for `*.bluepointdigital.com` does **not** cover
   `*.dev.bluepointdigital.com`. Keep the exact harness hostname on its existing
   DSH route; send only app hosts to the private gateway. All generated hosts use
   this ingress; no per-app DNS, certificate or NPM proxy-host recipe is required.
   Preserve the incoming public Host authority and support HTTP/WS upgrades.
3. **TLS-only is mandatory on the browser-facing app hosts.** Do not serve app
   content over plain HTTP; reject HTTP or redirect it at the edge before any
   proxying. Keep the TLS-to-private-HTTP hop inside the trusted ingress network.
   The gateway's private HTTP listener relies on that boundary; it cannot prove
   that an allowed peer used TLS externally by trusting `X-Forwarded-Proto`.
4. **BYPASS ALL shared ingress/CDN cache for the entire app wildcard.** This includes
   HTML, APIs, assets and launch/session paths, even if an app emits `public` or
   `immutable`. A cache in front of the gateway can answer without the session
   check. Disable shared caching at every hop (including NPM if enabled and any
   CDN/cache rules); purge previously cached app content before enabling access.
   Browser-local caching may still follow upstream headers. `no-store` on launch
   responses alone is not sufficient.
5. Keep the listener **private** and limit network reachability to the ingress.
   Set `appIngressPeers` to exact actual socket peers. Do not use a subnet allowlist,
   trust caller-supplied forwarding headers, or expose the listener publicly to
   solve connectivity. In the NPM deployment, NPM and DSH are separate containers
   across a bridge: NPM's `127.0.0.1` is not DSH's `127.0.0.1`. Inspect the actual
   bridge-facing DSH address and source IP observed by DSH (including any NAT), then
   configure the bind/upstream and allowlist accordingly. Loopback defaults apply
   only when ingress really shares DSH's network namespace.
6. **Do not inject Basic/control authentication on app hosts.** Keep the DSH login
   or control-host access list on the control origin, not on the wildcard app
   ingress. Do not overwrite/strip app `Authorization`: app-owned Bearer or Basic
   credentials must reach that app. Do not forward a DSH credential instead.
   The gateway filters its own and DSH auth cookies and untrusted proxy headers;
   app cookies and authorization are separate from control authentication.
7. Enforce sensible **idle** timeouts and resource limits at the private ingress.
   The gateway bounds header receipt to 30 seconds and ticket JSON to five seconds,
   but does not impose a whole-body deadline on authenticated uploads. Active
   uploads/responses/WS are still bounded by grant expiry and revocation. Disable
   ingress response buffering for SSE/streaming and choose request buffering/body
   limits deliberately; a healthy large upload must not fail merely at 30 seconds.

These are deployment requirements, not verified live settings. Do not publish a
success claim until the actual DNS/TLS path, peer boundary, cache bypass, rejection
paths and browser flow are checked on the intended instance.

### Launch/session and compatibility contract

The authenticated DSH control origin issues a **60-second single-use launch ticket**.
The browser receives it in a URL fragment, not a query parameter or cookie shared
with the control host. The app-host bootstrap removes the fragment and exchanges
the ticket for `__Host-dsh-app-session`: **Secure, HttpOnly, host-only** (no Domain),
`Path=/`, `SameSite=None`, **Partitioned**, with an **8-hour** lifetime. It is bound
to the exact app origin and identity. HTTP and WebSockets require the session;
mutating HTTP requests and WebSocket upgrades also require the app's own Origin.
The bootstrap exchange is not an application login and does not replace one.

Tickets and sessions are memory-only in [lib/app-sessions.js](lib/app-sessions.js).
Expiry, process restart or gateway disposal requires reopening from Applications.
Do not paste/share launch tickets as reusable links. Top-level launch through DSH's
authenticated `/apps/api/open?id=<id>` is available for frame/cookie incompatibility;
it gets a fresh ticket rather than bypassing authentication or using a raw app URL.
Partitioning is by **site**, not origin: in the standard nested-host layout the
iframe and top-level app share a cookie partition. A separate-site app deployment
can instead have different partitions. The new-tab action always issues a fresh
ticket either way. Browser support and policy differ, so embedding is not
universally guaranteed.

Measured in Chromium 154: in the **standard nested same-site layout**, both
ordinary iframe attachment navigation and HTML `<a download>` work. Top-level
HTML downloads also pass. In the separate-site compatibility fixture, attachment
navigation works, but a separate probe of iframe `<a download>` omitted all cookies
and was correctly rejected with 401. The authenticated new-tab action fixes that
cross-site case. No cookie/auth bypass or HTML rewrite is used.
See [verification evidence](<GATEWAY-VERIFICATION.md>).

The gateway preserves upstream **CSP and X-Frame-Options**, app response bodies,
redirects, compression and ordinary cookies/validators. Do not remove an app's
framing policy to force embedding. A top-level launch may solve framing or cookie
limitations, but is not a promise that every application works without setup.
Public URL/base URL, OAuth redirect registrations, trusted-proxy settings and
application authentication may still need configuration; origin changes on
replacement can require updating those app settings. Root hosting removes DSH
path rewriting, not all reverse-proxy or application requirements.

## Legacy embed configuration (gateway disabled)

Editing an app's embed settings (adding `webRewrite`, changing the port or path)
versions its script/style URLs with a `?dsha=` token derived from that
configuration. Without it a browser keeps the app bundle it cached while the
previous configuration was live — apps serve bundles `immutable` — so the app
would keep using the old URLs and appear broken after an otherwise correct
change. The proxy also stamps **every document it serves** with a fresh per-load salt, so
opening an app always fetches current files even when nothing about the
configuration changed and even when the panel client asking for it is itself out
of date. A salt supplied by the client is used as-is; the salt is consumed by the
proxy and never forwarded, so apps see an unmodified query string.

A response that needed rewriting but could not be rewritten — the app compressed
it despite the proxy asking for `identity` — is served `no-store` with its
validators stripped. Unrewritten scripts and documents are never cacheable: an
`immutable` unmounted bundle lives for a year in a browser and leaves the app
calling the host root, which no server-side fix can reach.

Every embedded document is also opted out of translation (`translate="no"` on
`<html>` plus a `notranslate` meta, and `translate="no"` on the frame). A page
translator rewrites text nodes into elements of its own; React then removes nodes
whose parent it no longer owns and the app dies with `removeChild`. A translator
works per document, so this opt-out has to be written into the app's own HTML by
the proxy — an attribute on the embedding iframe would not cover the app.

## Legacy durable listings and existing-container registration

This section describes the compatibility catalog/registration workflow. The
[runtime manager](APPLICATIONS-MANAGER.md) discovers containers automatically;
these registration steps are not prerequisites for its inventory or controls.

The legacy catalog is seeded once into private `catalog.yaml` under the app state
root using atomic no-clobber creation. Subsequent package upgrades cannot replace
it. An explicit COMPUTER_APPS_FILE remains supported and operator-owned; back up
that location separately. Migrate existing package customizations **before**
installing the new package. A missing/corrupt catalog is not repaired by guessing.

Existing-container registrations live in private `existing.json`, separate from
installer-owned containers. Startup/refresh discovery exposes labelled orphans in
My apps and other unlisted TCP containers under Add existing container. Discovery
never starts, adopts or embeds anything. Human review confirms port, entry path,
optional legacy exact sockets/JS prefixes and publisher trust. Gateway mode derives
the origin from the immutable identity; legacy mode additionally requires accepting
the shared-origin risk. Registration binds to immutable container identity and
current configuration; no create, rm, volume,
network or port-publication command is issued. Auto-remove and unsupported
host/none/shared network containers are rejected. Imported app lifecycle permits
Launch/Stop and Forget listing only. Missing originals remain visible and are not
recreated or replaced by a same-name container. Forget changes only the registry.

This is metadata recovery, not a sandbox: existing container privileges remain
unchanged and are disclosed in review. Discovery is limited to this instance's
Docker daemon, not remote host containers. Completed/cancelled/failed installer
journals are retained under collapsed Installation history.


## Legacy installer surface

The following prepare/review surface remains a compatibility API. The new runtime
page uses the owner-click flow in [APPLICATIONS-MANAGER.md](APPLICATIONS-MANAGER.md).

- My apps: Open, Launch/Stop, Logs, Uninstall for managed apps; legacy catalog
  actions remain compatible. All apps navigation uses the fixed viewer callback.
- Add app: three stock recipes, dedicated setup-conversation draft, Advanced form.
- Review: image/tag + immutable content id, entry/socket paths, JS adaptation,
  resource caps, data targets, environment key names, container command and trust.
- Progress: durable per-operation state/events. Credentials and raw Docker errors
  are not in review/job output. Logs redact saved literal environment values.
- Recovery: explicit cleanup of interrupted owned work, no silent restart/retry.

New agent sessions use the installed public sessions.create/using,
conversation.input.for().setDraft(), and uiWorkspace.openSession APIs. Selecting
Open setup conversation does not send a model prompt or approve anything.
The setup prompt constrains agents to the same prepare/review installer workflow.
The user reviews the draft, sends it, then approves the plan from Add app.
This is not a permission boundary against an operator-level agent with shell
access; normal operator tools remain available. No Agent Teams/new Bot required.

## Durable private storage

`COMPUTER_APPS_STATE` or `$DSH_HOME/.dsh-applications` owns version-1 registry JSON,
job journals and private credential files. GUI and CLI use the same environment
root. No config-only override that silently splits their registries is supported.
Owner-only real directories (0700), files (0600), and atomic fsync/rename writes;
symlink roots and paths inside /workspace/node_modules are refused.
A kernel flock coordinates cross-process mutations and releases on process death.
Only one mutation/install executes at a time; a second operation receives retry
instructions rather than racing. Reads can still report progress while work runs.
Linux/util-linux flock, Node >=20 and a reachable Docker daemon are required.

Existing operator apps.yaml is retained as the legacy catalog. New registry ids
must not collide; GUI/CLI fail closed on malformed registry instead of replacing
or hiding it. Installed definitions survive package dependency reinstall.

## Side effects and approval

Preparing a review may pull image layers: these are not execution, but consume
network and disk. That is explained beside Prepare/Review install. Local Desktop
never substitutes a similarly named public image for the built image.
Preparation resolves exact image content and declared VOLUME paths; every image
volume must have a reviewed target, avoiding surprise anonymous volumes.
Approval is bound to job UUID, normalized plan, environment key names, image
content and a 24h review expiry; credential values are stored only privately.
Execution uses the content id, never re-follows the mutable tag. Repeated approval
of a queued job is idempotent; other repeated approval/execution is refused.
Preflight rechecks legacy ids and container existence before reserving intent.

Create: fixed argv, no-new-privileges, CPU/memory/shm caps, PID cap, bounded Docker
logs, on-demand restart by default, optional named volume mounts, private env file.
No host binds, Docker socket, device/capability additions, host networking, raw
Docker flags/build contexts, arbitrary upstream URLs or host port publication.
Docker default capabilities and outbound networking remain; no claim of hostile
code containment. Legacy-mode apps share the DSH browser origin. Opt-in gateway
mode separates app origins but is not a container/network sandbox; approval still
acknowledges publisher trust. Custom unknown images are not inherently safe.
Environment values are readable by the app and daemon administrators; literal
redaction cannot prevent an app encoding/transmitting its own secret.

## Recovery/removal

Job journal records before effects. Install reserves registry ownership before
creating. Containers carry operation UUID + app id labels; start/log/destructive
actions use inspected container IDs and recheck ownership. Proxy lookup refuses
foreign replacements, even if they reuse the same container name.
A Docker inspect failure does not mean absent: uncertain rollback retains its
registry ownership and prompts explicit recovery. Failed/timeout create still
checks for operation-owned side effects. Cleanup never removes foreign containers,
images or persistent volumes. Downloaded/shared image layers are kept.

Interrupted approvals not yet executing become failed through explicit Recover;
an installed-registry/nonterminal-job crash window is reconciled to ready rather
than deleting the completed app. Active workers hold flock so Recover cannot
remove an in-progress container. Queued jobs have an explicit retry control.
Cancelled/failed/removed installs clear environment secret files after proven
owned-container cleanup. Registry/job metadata remains for diagnostics.

Removing only a managed container through CLI keeps its installed definition;
Launch restores that same reviewed image content and operation-owned volumes.
Uninstall unregisters it and clears its secrets; a fresh Install never adopts data.
Volume names include an install UUID, not just app id. Reusing an app id does not
adopt a previous install's retained data. Named data volumes are never deleted
by rollback or uninstall. This legacy installer does not provide data restoration,
volume deletion, upgrade/recreate or multi-service Compose management; the separate
[runtime manager](APPLICATIONS-MANAGER.md) adds saved-definition redeploy/rollback
and multi-service Compose deployment. Back up
important data separately; uninstall is not a disk-cleanup promise.

## Readiness and boundaries

The installer proves the selected web entry responds with success/redirect and
that the owned container runs. It does not universally prove SPA routing, every
socket, worker, SRI or app authentication. In legacy mode, prefer native base-path
settings; literal `webRewrite` and exact socket routes have documented limits.
In gateway mode, use the authenticated top-level launch for incompatible framing
or cookie policies; never fall back to shared-origin or a raw published app port.
If the app still needs public-URL/OAuth/trusted-proxy configuration, explain that
requirement instead of claiming readiness. Desktop starts X and its viewer through
existing image tools.

Tests use Docker mocks for deterministic schema/ownership/failure/secret cases
and real HTTP/WS for proxy/lifecycle. Optional installer-browser test reuses the
installed React platform module code in an isolated test server; it edits no
DeepSeek files and starts no replacement GUI. Setup session services are mocked
in that scratch test; exact public APIs were verified against installed contracts.
Live installed-GUI/session integration still needs a canary after publication.

Checkout dependencies include `httpxy` pinned to `0.5.5` in
[package.json](package.json). Use `npm ci --legacy-peer-deps` before checkout tests;
production dependency installation still follows the separate pinned-release
process in [DEVELOPING.md](<DEVELOPING.md>). Verification commands (recorded
results and scope are in [verification evidence](<GATEWAY-VERIFICATION.md>)):

```bash
npm ci --legacy-peer-deps
npm test
node --test test/host-router.test.mjs test/host-mount-apply.test.mjs
npm run test:gateway                # opt-in; requires existing running desktop
```

The deterministic [host-router test](<test/host-router.test.mjs>) and
[host-mount-apply test](<test/host-mount-apply.test.mjs>) cover the authenticated
gateway. The [browser fixture](<test/gateway-browser.test.mjs>) passed in Chromium
154 using scratch HTTPS ingress and a synthetic control page. See
[verification evidence](<GATEWAY-VERIFICATION.md>) for exact scope. The production
DNS/TLS/CDN path, peer addresses and installed GUI/auth are not yet verified.

## CLI example (no credentials in source/chat)

```bash
printf '%s' '{"plan":{"id":"my-web","image":"nginx:1.28-alpine","webPort":80}}' | bin/computer apps prepare
bin/computer apps jobs
# Human reviews/approves from Add app. Operator-only alternative:
bin/computer apps approve JOB_UUID APPROVAL_HASH --trust-publisher
bin/computer apps run JOB_UUID
bin/computer apps recover
bin/computer apps uninstall my-web
```

Agent setup must stop after prepare; it must not interpret user prose or broad
project permission as approval of the exact install review. Secrets are entered
in Advanced or the existing review’s Add / replace environment values input, not
prefilled conversation text. Saving values on a review rotates its approval token
and resets the trust checkbox; the user reviews the environment key names again.

Already-approved workers are process-owned and finish/rollback if the plugin is
disabled while they run; route disposal is not an install cancellation button.
No new worker starts after that plugin lifetime has been disposed. Process restart
still requires explicit recovery/retry from its journals; no silent replay.
