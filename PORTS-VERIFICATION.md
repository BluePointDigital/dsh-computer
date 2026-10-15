# Shared-host app ports — implementation and verification

## Scope

Implements the requested conventional trusted-app layout:
`<harness hostname or IP>:<durable assigned app port>`. Range defaults to
20000–20099. No separate app domains, cookie rewriting or per-app gateway session
cookies. Existing wildcard mode remains available, explicitly selected by its
existing configuration; switch to ports with `appAccess: ports`.

The source checkout was changed and scratch-tested. **No production release,
profile dependency change, production ingress mutation or harness restart was
performed for these port-mode changes.** Existing production wildcard infrastructure
was not removed or repurposed. Activation needs the release/install procedure and
one range ingress setup described in [INSTALLATION.md](INSTALLATION.md).

## Measured checks

- Exact lockfile dependencies installed with `npm ci --legacy-peer-deps`.
- Full `npm test` passed: **152 Node tests, 41 proxy checks, 12 password checks
  and 3 catalog-retry checks**, covering port config/allocation/HTTP/WebSocket/TLS
  plus existing installer, catalog, control auth, isolated gateway and legacy
  transport regressions.
- Separate-process CLI fixture proves saved server range takes precedence over
  DSH_PUBLIC_URL defaults and catalog web/viewer URL commands agree with listing.
- Root HTTP request/response bytes and headers checked, including app-owned Bearer
  auth, cookies, root-relative redirects, callback Origin, CSP and X-Frame-Options.
- Real masked WebSocket frames traverse an arbitrary root socket URL; removing
  app listeners drains connections and releases ports.
- Direct HTTPS with a scratch certificate works. HTTPS without direct TLS files
  or explicit external ingress termination is rejected at plugin startup.
- Actual IPv6 HTTP routing is checked, not just generated IPv6 URL text.
- Occupied ports report unavailable without silently changing the assignment;
  retry reuses the assigned port. Range exhaustion leaves existing apps available.
- New assignments work while an unrelated install holds the manager lock.
- `npm run test:ports-browser`: isolated headless Chromium inside the already-running
  desktop loaded **two applications embedded under the same harness IP on ports
  29170 and 29171**. Both root `/asset.js` scripts loaded, `/api` fetches completed,
  and application cookies were set/read. Production iframe sandbox flags were used.
  No live desktop browser/profile was manipulated. Scratch listeners were closed.
- `git diff --check` passed.

The Chromium check uses a synthetic control page and real port transport. It does
not establish installed-DSH-shell acceptance, public firewall/NAT, production TLS
on the app range, or every application's framing/public-URL compatibility. Those
remain deployment acceptance, not source-test claims.

## Main implementation

- [app-ports.js](lib/app-ports.js): private durable port assignments.
- [port-listen.js](lib/port-listen.js): serialized listener reconciliation/disposal.
- [app-launch.js](lib/app-launch.js): public routing policy and descriptors.
- [host-listen.js](lib/host-listen.js): shared transparent HTTP/WS/TLS transport.
- [index.js](lib/index.js): catalog, panel launch API and lifecycle integration.
- [app-cli.mjs](bin/app-cli.mjs): saved settings and consistent port URL reporting.
- [port-ingress.mjs](deploy/port-ingress.mjs): static nginx range configuration
  generator; does not modify services.
