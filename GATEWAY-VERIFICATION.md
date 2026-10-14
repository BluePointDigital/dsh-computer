# Isolated application gateway — verification record

Verified in this checkout on **2026-10-14**. This is source acceptance, **not a
production deployment**. The running DSH GUI, profile release pin, DNS/TLS and
production ingress were not changed; no harness or existing app was restarted.
This is the acceptance record for the `0.5.0` source release. Publication and
installation are separate steps; the running profile at verification remains
pinned to `v0.4.5`.

## What was implemented

One instance-wide app domain and wildcard HTTPS ingress replace per-app path
rewrites for isolated launches. The standard layout is
**`*.<exact-harness-hostname>`**, including when the harness is on a subdomain:
`dev.bluepointdigital.com` uses `*.dev.bluepointdigital.com` and
`otherdsh.bluepointdigital.com` uses `*.otherdsh.bluepointdigital.com`. Set
`appDomain` to that full hostname, without `*.`. The harness stays at the suffix
apex; a control host beneath the app suffix is rejected to prevent routing overlap.
Each app gets a root-hosted origin derived from its ID, immutable container ID and
installation owner. Container replacement changes the origin. No per-app
`webHost`, `webRewrite` or `webSockets` declarations are needed on this path.

- [Launch policy](<lib/app-launch.js>) is shared by the server and CLI.
- [Sessions](<lib/app-sessions.js>) use 60-second, one-use launch tickets and
  memory-only, eight-hour, app-bound sessions. Tickets travel in a fragment,
  which the bootstrap removes before loading app content. The browser receives a
  Secure, HttpOnly, host-only `Partitioned` cookie, not a DSH credential.
- [Gateway transport](<lib/host-listen.js>) uses exact-pinned `httpxy@0.5.5` to
  proxy HTTP and arbitrary WebSocket paths without rewriting app bodies, URLs,
  authentication, cache validators or framing policy. It validates the ingress
  socket peer, public Host/port, session and request Origin.
- [Plugin integration](<lib/index.js>) authenticates launch with DSH's existing
  request gate, inspects immutable container IDs, owns listener disposal and
  periodically revokes removed/replaced catalog identities.
- [Client integration](<lib/client.js>) provides the isolated iframe and a fresh
  authenticated new-tab launch. Gateway failures never fall back to the legacy
  same-origin proxy or published container ports.

Leaving the app domain unset preserves explicit legacy mode for trusted app
publishers. Enabling the gateway disables both legacy HTTP and WebSocket access.
See the [operator contract](<INSTALLATION.md#isolated-origin-gateway-opt-in>).

## Deterministic checks — passed

`npm test` completed successfully against the final server/client source:

| Check | Result |
|---|---|
| Node regression suite, including gateway and client integration | 115 passed; 0 failed |
| Legacy proxy regressions | 39 passed; 0 failed |
| Password recovery shell regressions | 12 passed; 0 failed |
| Catalog retry shell regressions | 3 passed; 0 failed |

The optional real-whoami probe in the legacy proxy runner was **skipped** because
that container was not running; synthetic transport checks passed. The optional
installer and desktop browser suites were not rerun for this change.

[Gateway tests](<test/host-router.test.mjs>) cover strict configuration and host
identity, ticket replay/expiry/capacity, wrong Host/peer/Origin rejection,
bootstrap/session exchange, reserved-cookie stripping, app Authorization,
unmodified compressed bytes/query strings/redirects/cache/CSP/X-Frame-Options,
uploads, range responses, 304s, SSE expiry, actual WS frames and
catalog/session/stream revocation. Syntax checks, `git diff --check` and
`npm pack --dry-run` also passed; the package includes the new gateway modules
and this verification record.

[Four raw TCP cancellation regressions](<test/gateway-cancellation.test.mjs>) also
passed 12 consecutive fresh-process runs (48/48). Node's upgraded sockets permit
half-open connections: a client FIN can leave `readableEnded=true` while
`destroyed=false`. The gateway now cancels at upgrade entry, checks cancellation
after both asynchronous lookups, and cancels an outgoing pre-101 handshake on
client closure. Tests hold catalog/endpoint resolution until FIN is observed,
assert exact backend/endpoint counts after a fresh authenticated WS barrier,
require pending-handshake cancellation within two seconds rather than the ten-second
timeout, and assert both TCP legs drain before cleanup. Real client frames are
masked and echoed server frames unmasked. In-memory mutations removing the
post-catalog guard or pending-request coupling fail the intended assertions;
restoring the old implementation fails all three cancellation cases while the
established-WS control still passes. Both scratch Chromium topologies were rerun
successfully after this fix; production GUI/ingress acceptance is still separate.

[Plugin apply tests](<test/host-mount-apply.test.mjs>) exercise the actual route
handlers with real HTTP and mocked CLI/Docker responses: authenticated launch,
immutable-ID inspection, rejection of stopped/replaced containers, same-origin
bypass prevention, disabled-mode behavior, disposal during startup and port reuse.
[Client tests](<test/client.test.mjs>) cover launch destination validation,
no-probe/no-fallback behavior, sandbox and fresh new-tab links.

## Real Chromium acceptance — passed

Run: `npm run test:gateway`.

The [browser fixture](<test/gateway-browser.test.mjs>) uses the real gateway
transport and scratch HTTPS ingress in **two passing layouts**: the standard
nested same-site layout (`dev.control-<run>.test` and its app children), plus
separate `.test` control/application sites for compatibility regression coverage.
It runs isolated headless **Chromium 154** inside the already-running desktop,
using a private temporary profile and certificate-specific TLS exception. It
neither changes DNS nor touches the live browser, harness profile or production
proxy. The synthetic control page applies the same iframe sandbox and referrer
policy as the client.

Verified in the browser:

- HTTPS bootstrap accepts the partitioned gateway cookie; its value is HttpOnly
  and absent from app-visible cookies. The launch fragment is cleared.
- An anonymous app visit before launch is rejected; replaying a ticket returns 401.
- Root-relative JS/CSS load without URL rewriting.
- The app's own login remains required: POST login, 303 redirect and its own
  partitioned login cookie work. App Authorization and a 401 challenge survive.
- WebSocket text and binary frames pass in both the iframe and top-level tab.
- App attempts to read control-page DOM/localStorage throw `SecurityError`.
- CSP and X-Frame-Options survive, and Chromium actually blocks disallowed frames.
- An iframe navigation to an attachment response downloads exact expected bytes.
- In the nested same-site layout, iframe and top-level app visits share the browser
  cookie partition and app login. Fresh launch still rotates the session value.
  In the separate-site layout, a direct top-level visit cannot reuse the iframe's
  partition: a fresh launch and app login are required.
- HTML `<a download>` works in the **nested same-site iframe** and in authenticated
  top-level tabs for both layouts. Completed download events and exact saved bytes
  are checked (three downloads in the nested run, two in the separate-site run).
- Upstream requests contain neither the gateway cookie nor the synthetic control
  cookie, and receive the verified HTTPS authority rather than spoofed forwarding
  headers.

The fixture checks cleanup of its listeners, browser processes/profile/downloads
and private TLS directory, including failure paths. No real credentials are used
or written into this workspace.

### Separate-site browser limitation — not a nested-layout failure

A separate probe of HTML `<a download>` **inside the cross-site iframe** failed in
Chromium 154: that request omitted all cookies, so the gateway correctly returned
401. Normal attachment navigation in the iframe passed. The fresh authenticated
**Open in new tab** action is the verified generic escape for the HTML download
case. The gateway does not weaken authentication or rewrite app HTML to mask this
browser behavior. The standard nested same-site layout passes the iframe HTML
download check directly; this historical limitation is not assumed to apply there.

A browser that refuses embedding or third-party cookies may likewise need the
top-level action. This is not a claim of cross-browser compatibility.

## Live deployment preflight — 2026-10-14 16:48 EDT

Read-only control-plane inspection and a temporary private HTTP probe verified:

- The saved Olympus Portainer endpoint reaches `dsh-olympus` and its NPM container;
  it is not the separately saved remote Damon endpoint. NPM credentials work.
- NPM's existing exact `dev.bluepointdigital.com` route remains untouched. No app
  wildcard route or wildcard certificate exists in its current inventory.
- Public `dev.bluepointdigital.com` resolves to `104.225.218.209`; its trusted
  certificate covers only that exact hostname, expiring 2026-12-17.
- `gateway-preflight.dev.bluepointdigital.com` returns NXDOMAIN from the system
  resolver, `1.1.1.1`, and a Cloudflare authoritative nameserver. Direct-origin TLS
  with that SNI fails with `ERR_SSL_TLSV1_UNRECOGNIZED_NAME`.
- NPM successfully reached a temporary listener bound to `172.18.0.4`; the actual
  socket peer observed by DSH was `172.18.0.2`. The probe listener is closed. These
  are measured current bridge addresses, not a guarantee after container recreation.
- No reusable Cloudflare credential was found in the inspected private credential
  locations, control-client configuration or NPM certificate metadata. Wildcard
  DNS-01 issuance/renewal needs scoped DNS access or operator completion in NPM.

No public routing, certificate, production package or server configuration changed.

## Remaining production acceptance

The browser test uses a **synthetic control page**, not the installed DSH shell or
its real authentication session. DSH route-gate wiring is tested separately with
mocks. The following still require an authorized release/install and a canary on
the intended instance:

1. Verify actual DNS, wildcard certificate and HTTPS-only ingress for
   `*.<exact-harness-hostname>`. Here that is `*.dev.bluepointdigital.com`, not
   `*.bluepointdigital.com`. Keep the exact harness hostname on its DSH route and
   the app wildcard on the private gateway. Do not expose the listener publicly.
2. Measure the actual ingress socket peer/interface across container networks and
   configure its exact allowlist; do not assume either container's loopback reaches
   the other. Forward the original app authority and WS upgrades, never control
   Basic auth or DSH authentication headers.
3. **Bypass all shared ingress/CDN caching**, including assets. The gateway keeps
   app cache headers intact for browsers; an edge cache must not serve an
   authenticated response without running the gateway authorization check.
   Verify anonymous requests before and after an authenticated cache warm-up.
4. Install the intended pinned release, restart DSH only after the active turn,
   and verify authenticated embedded and new-tab launches in the existing GUI.
   Recheck upload/download, app login, WS and framing behavior for the chosen app.
5. Verify browser storage/service-worker behavior across container replacement.
   Deterministic tests prove the new hostname and old-grant revocation; actual
   service-worker replacement lifecycle is **not browser-tested** here.

Root hosting removes a class of proxy recipes; it does not eliminate app-specific
public-URL, OAuth callback or trusted-proxy configuration, nor override browser or
application security policy. Container/outbound-network trust is separate from
browser-origin isolation.

## Independent review follow-up (2026-10-14)

The initial green suites missed two transport defects. Both are now fixed in
source: active grants are tracked per overlapping request (including pipelined
requests for different apps), and healthy streaming uploads have no whole-body
30-second deadline. Header receipt remains bounded to 30 seconds; ticket JSON
retains its five-second bound. A grant is held until request **and** response finish
or transport aborts. Ingress idle/resource limits remain required.

Post-fix `npm test`: **111 Node tests, 39 legacy proxy assertions, 12 password
assertions and 3 catalog retry assertions passed**, no failures or cancellations.
This includes pipelined expiry/revocation, completed-grant connection reuse, early
upstream response with unfinished upload, and a continuously progressing **31-second
upload**. The latter verifies direct gateway transport, not NPM ingress. Both
existing real Chromium 154 scratch transport cases (nested same-site and separate-site)
were rerun after these fixes: **2 passed, 0 failed/skipped**, 31.6 seconds; no live
container/profile/ingress was changed and the scratch cleanup passed.

**Additional live integration blocker found:** Olympus's container-side control
proxy currently rewrites Host and Origin to loopback and injects its own DSH
cookie. This both erases the sibling-origin fence and breaks the new exact public
launch-Origin check. The canonical image proxy now validates exact configured
origin/authority and actual ingress peer **before** authentication, preserves public
Host/Origin, and uses per-authority server-owned sessions. Its **19 deterministic
HTTP/WS tests passed**, including installed rc.2 trust/auth sections evaluated
offline with synthetic credentials, cookie isolation, authority cache concurrency,
streaming uploads and bounded safe retries. Final transport review reproduced
abandoned half-open WS handshakes and obsolete 401 responses breaking successful
retries. The proxy now cancels client FIN while awaiting authentication/upgrade,
avoids post-abort dials, and retires both response AND ClientRequest failure paths
before retry. Seven focused regressions cover delayed exchange, stalled handshake,
late FIN/RST of discarded HTTP/WS responses and normal frame/FIN cleanup; real
masked/unmasked frames and zero remaining fixture sockets are asserted. The
installed Commander parser also
preserves the repeated `--trusted-host` flags. Image COPY/build verification and
both stack environment branches include the policy module/configuration. An
SHA-256-verified official standalone Compose v5.6.0 binary validated all four
combinations of selfnet/sharednet and dynamic/static proxy IP, including exact
control variables. This is Compose model validation, not a deployment or live
network reservation. The actual NPM Compose owner was captured read-only and the
staged model validated: image, ports, volumes and environment are unchanged; its
static proxy .2 endpoint and previously omitted live agent_gateway network are
now declared. The live Portainer model differs from source only in the intended
six endpoint/control-environment paths. Watchdog preservation passed 12 pure tests
and two real nested Docker 20.10 create/recreate cycles with two static networks;
the canary uses connect-before-start for compatibility and all scratch resources
were removed. **Nothing is installed yet.** This is separate from the app gateway
listener.

Stock rc.2 browser authentication also uses first-match, non-`__Host-` cookies;
a child app can plant a longer-path parent-domain cookie to deny a directly
exposed control cookie gate. Olympus's existing proxy replaces browser Cookie
with its own session, so that specific browser-cookie attack is **not evidence
of a live Olympus failure**. For this deployment the hardened proxy must discard
browser cookies and prevent server-owned cookie leakage. A standalone core-cookie
patch was staged for review but is not required merely to fix this proxy path.
The older browser fixture's synthetic `__Host-control-auth` is not proof of either
real deployment boundary. A new isolated **Chromium 154 control-proxy smoke passed**
(1/1, approximately 8 seconds on the final rerun), executing captured installed `BrowserAuth`, trust
predicate and `requestRejection` with synthetic credentials through the actual new
proxy. Seven sibling form/fetch/preflight/WS/iframe/navigation attacks returned 403
with **zero backend requests or token exchanges** before legitimate access. Normal
root/assets, exact-Origin launch POST semantics, browser-acknowledged streaming SSE,
integrity-checked 131,073-byte upload and real text/binary WS frames passed. A browser
accepted a poisoned parent-domain cookie using the real DSH cookie name; the edge
received it, the proxy discarded it and legitimate control POST still succeeded.
No server-owned auth cookie escaped. Chromium WS supplied Origin but no Fetch
Metadata; the Origin fence handled it. The fixture blocked automatic favicon
requests to isolate the denied-navigation phase, not as a proxy security setting.
All three scratch listeners and the exact-profile Chromium/TLS state were verified
cleaned up. This is **source/auth integration, not installed GUI/NPM acceptance**;
its fixture aliases POST `/apps/api/open` to launch semantics while the real route
is POST `/apps/api/launch` and GET `/apps/api/open`.

NPM 2.15.1's installed dereferenced request schemas accepted both the disabled
wildcard-route draft and the DNS-01 certificate shape (synthetic placeholder token;
no API mutation). Cloudflare access, durable private addressing, release installation,
restart, real GUI/ingress and service-worker replacement checks remain outstanding.

## Reproduce without deploying

```bash
npm ci --legacy-peer-deps
npm test
npm run test:gateway
```

The browser command requires Docker access, `openssl` and an already-running
`dsh-app-desktop` with Chromium and Node. It deliberately does not create/start an
app. [The old hostname fixture](<test/host-mount-live.mjs>) is retired and exits
with an explanation rather than exercising the obsolete unauthenticated contract.
