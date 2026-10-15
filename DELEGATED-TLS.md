# Delegated wildcard TLS — operator contract

**Integration source implemented; application wildcard automation not activated.**
A shared validation service is now running on Olympus; see the
[live deployment record](deploy/acme-dns/OLYMPUS-DEPLOYMENT.md) for measured scope,
exact pending DNS records and remaining real staging acceptance. Its HTTPS API
certificate/route and parent DNS delegation are live; real isolated wildcard
staging issuance/upload/reload has passed. Production application wildcard
activation remains separate. No package release or harness restart was
performed. Do not confuse deterministic fixtures with public ACME or installed
browser acceptance.

## Architecture

```text
Customer DNS:
  *.harness.customer.tld                  A       <ingress IPv4>
  _acme-challenge.harness.customer.tld     CNAME   <unique registration>.auth.<operator-zone>

Browser -> NPM TLS -> private isolated-origin gateway -> container
                       ^ no validation service in app traffic path

Separate per-deployment worker:
  Certbot -> restricted acme-dns TXT update -> CA validation
          -> persist pending bundle -> NPM custom certificate upload
          -> managed proxy-host reload -> fresh public TLS fingerprint check
```

The existing gateway generates `https://<id>-<immutable identity hash>.<appDomain>`.
One wildcard certificate and proxy host cover all those names. No per-container
certificate or DNS mutations are needed. The harness apex route is untouched.
Customer DNS provider APIs/tokens are not needed. Operator NPM credentials and a
restricted acme-dns registration **are** needed and remain private.

Use an existing maintained [acme-dns service](https://github.com/acme-dns/acme-dns),
not a new bespoke DNS server. Certbot performs ACME; the adapter does not implement
ACME account/order/signature machinery. Certificate private keys and ACME accounts
are generated and retained on each deployment, not centrally at the DNS service.
NPM terminates TLS but does **not** own renewal of these `other` certificates.

**Delegation authority is broader than a single wildcard certificate:**
`_acme-challenge.H` can validate **both H and *.H**. The implementation requests
only `*.H`; a compromised validation service/credential could request H too.
Removing/repointing the CNAME stops future validation; it does not revoke already
issued certificates. Retained TXT values are not reusable perpetual verification.

## Operator service prerequisites

Before onboarding a customer, establish an operator-owned authoritative validation
zone and acme-dns service. [Configuration template](deploy/acme-dns/config.cfg.example)
uses documentation-only names/addresses; it is not ready to apply.

1. Choose a validation zone under a domain you control. Delegate its NS records
   in the parent zone; publish correct NS-host A/AAAA/glue records as required.
2. Run reviewed/pinned acme-dns with persistent private database and API TLS state.
   Publish authoritative **TCP and UDP port 53**. Use a dedicated IP/host if the
   intended host already has DNS listeners. Do not assume the nested daemon is
   the Olympus host daemon.
3. Expose a **publicly trusted HTTPS API**. Bootstrap/renew that API certificate
   independently (e.g. acme-dns's HTTP-01 automation with port 80 reachable), not
   through the DNS service whose expired API certificate would block its renewal.
4. Restrict registration to operators using network/edge policy, rate-limit
   registration and updates, and monitor abuse. The client enrolls once; updates
   require per-registration credentials. After enrollment, server registration
   may be disabled. Stock acme-dns lacks public rotation/delete/revoke APIs.
5. Keep `use_header=false` unless a verified private edge is the only API ingress
   and overwrites forwarding headers. Never trust an arbitrary client XFF list.
6. Back up the database and API identity securely. Test restored TXT authority.
   Monitor external DNS, API trust/availability and every deployment's expiry.

The generic integration never buys a service, opens host ports or creates
customer DNS automatically. The separately approved Olympus deployment uses
`auth.bluepointdigital.com`; its live service and pending owner DNS actions are
recorded in the [deployment record](deploy/acme-dns/OLYMPUS-DEPLOYMENT.md).

## Deployment worker

Requirements: Linux, Node >=20, util-linux `flock`, maintained **Certbot >=2**, CA
trust store, outbound HTTPS/DNS, and access to the private NPM API and public app
TLS ingress. [Worker image](deploy/tls-worker/Dockerfile) is an optional build
recipe, not an installed program. Build from the repository root. Pin a reviewed
base digest and inventory installed Certbot/OS versions for release deployments.
The host also needs supervision, backups, persistent owner-only state and alerts.

Use a separate process/container, with **no Docker socket**, and network access
only to required services. NPM credentials can affect other NPM resources; use
operator-controlled credentials with the least permissions your NPM version
supports. Never expose those credentials to app containers or accept NPM endpoint
URLs from app/ordinary HTTP input.

### 1. Prepare private operator configuration

Feed JSON to `node bin/tls-cli.mjs setup` on stdin, from a secure provisioning
channel. Do not store real credentials in this repository or chat. Example shape
(placeholders only):

```json
{
  "domain": "harness.customer.example",
  "ingressAddress": "192.0.2.10",
  "email": "ops@customer.example",
  "termsAgreed": true,
  "staging": false,
  "privateIngressConfirmed": true,
  "cacheBypassConfirmed": true,
  "acmeDns": {
    "url": "https://validation-api.operator.example",
    "zone": "auth.operator.example"
  },
  "npm": {
    "url": "http://nginx-proxy-manager:81",
    "allowPrivateHttp": true,
    "identity": "<private operator identity>",
    "secret": "<private operator credential>",
    "forwardHost": "<verified private gateway DNS name or address>",
    "forwardPort": 3099
  }
}
```

Set `DSH_HOME`/`COMPUTER_APPS_STATE` identically for the **worker and operator CLI**.
Keep their private TLS volume **out of the DSH GUI container**. Default worker TLS
state is `$DSH_HOME/.dsh-applications/tls`; the parent variable overrides it as for
app state. It cannot be inside `/workspace` or a managed package.

For GUI status, set worker `DSH_TLS_STATUS_ROOT` to a separate mounted public-status
directory. Every durable save publishes an allowlisted `public-status.json` there.
Mount only that directory into DSH at its own `DSH_TLS_STATUS_ROOT` (default:
`$COMPUTER_APPS_STATE/tls-status`). GUI Check DNS uses only the public A/CNAME
records and never reads enrollment credentials, NPM credentials or private keys.
The GUI container must not mount the private worker volume, even read-only. Directories are 0700 and
state files 0600, atomic fsync/rename writes; a kernel flock serializes all orders
and deployments for one registration. Back up this state encrypted. The pending
and previous bundles include **private keys**. Stock NPM may log uploaded custom
certificate objects; treat NPM logs/backups as sensitive and disable debug logs.

`staging` defaults **true** when omitted. Production requires explicit false.
CA mode/domain/upstream config cannot be silently changed after registration;
use an explicit operator migration/new isolated state for a new configuration.
Do not aim staging at a live production wildcard route. Staging deployment needs
`--isolated-staging-ingress` and a separate isolated DNS/NPM environment.

The private-ingress and cache-bypass confirmations are **operator attestations**,
not automatically proven settings. Complete the [gateway ingress contract](INSTALLATION.md#mandatory-one-time-ingress-setup):
private listener, exact actual peer allowlist, control auth hardening, TLS-only,
cache bypass at every shared hop, no shared app-host Basic auth, preserve app
Authorization and upstream CSP/XFO. Configure the active gateway domain to the
same exact harness hostname. This adapter does not rewrite a live profile or
restart the harness.

### 2. Customer adds the two records

Setup registers one unique acme-dns account and returns only public records.
Repeating identical setup reuses saved registration; it does not enroll a new
account on every retry. If the remote registration succeeds but the process dies
before saving its response, an unused orphan registration can remain server-side;
no customer delegation has yet been displayed. Service operators can audit it.

The authenticated Applications panel displays both records, delegation authority,
expiry, pending-deployment/errors and **Check DNS**. It accepts no infrastructure
credentials and offers no HTTP issuance/reload endpoint. CLI equivalents:

```bash
node bin/tls-cli.mjs status
node bin/tls-cli.mjs check
```

Both records must be DNS-only, not proxied/CDN cached. The checker tests an exact
CNAME and a fresh child hostname's A record; unexpected IPv6 or multiple IPv4
answers fail closed. This first implementation supports **one ingress IPv4**,
not multi-edge, load-balanced or IPv6 onboarding. The DNS check is a resolver
observation, not proof of worldwide propagation, CAA/DNSSEC correctness or cache
policy. The Certbot auth hook polls both permanent CNAME and changing TXT visibility
before allowing the CA challenge to proceed. acme-dns retains its rolling pair of
TXT values; there is no delete API. Never remove the permanent CNAME on cleanup.

### 3. Activate and supervise renewal

After DNS and private ingress are ready, the operator activates:

```bash
node bin/tls-cli.mjs activate
node bin/tls-worker.mjs
```

Run the worker under the deployment's actual supervisor with restart policy and
startup persistence. It reconciles every 12 hours, retries failures hourly, and
continues independently of the harness. This is **not** a reminder or an agent
session. Hook credentials are read from private state, not passed in argv. The
hook is restricted to the configured namespace and validates the 43-character
ACME DNS digest. Certbot handles ACME account reuse and due decisions. The adapter
also audits managed NPM route ownership/upstream/auth/cache settings on every
not-due reconciliation, reporting drift without takeover. It
checks remaining lifetime (renew before final third, capped at 30 days) and keeps
pending certificates until deployed, without requesting another cert per retry.
Expired pending certificates are replaced on an issuance-enabled retry.

NPM integration was checked against public v2.12.6/v2.16.0 source contracts:
- custom `other` record with deployment-owned name;
- multipart leaf, private key, and intermediate chain, **same cert ID on renewal**;
- managed wildcard proxy host, no app access list, caching off, HTTP redirect to
  HTTPS, WebSockets on, response/request buffering off;
- a proxy-host PUT triggers reload (certificate upload alone does not);
- read back nginx-online state and verify a **fresh public TLS connection**, exact
  wildcard identity, fingerprint and browser trust (staging explicitly excepted).

Foreign wildcard/child/redirect/dead routes are refused. Existing control/apex
routes are not modified. A changed/missing managed record requires operator
recovery rather than takeover. If a renewed upload/reload fails, the adapter
attempts restoration of the previous valid bundle; it preserves pending material
and reports rollback failure rather than claiming atomic deployment. NPM writes
certificate files non-atomically: rollback is best effort, not a transaction.

Public TLS verification does **not** prove a working app, gateway session or CDN
policy. Verify DNS/TLS, HTTP redirect, unauthenticated app rejection, authenticated
launch, API/WS, unknown-host rejection, cache bypass, private socket-peer boundary
and installed GUI after the pinned-release installation and coordinated restart.
Keep application frame protections; offer the existing top-level launch fallback.

### Monitoring and recovery

```bash
node bin/tls-cli.mjs renew    # obtain if due, or retry pending deploy
node bin/tls-cli.mjs deploy   # deployment retry without starting a new order
node bin/tls-cli.mjs status
```

Worker output is structured, no response bodies/credentials/PEMs. Watch
`tls-reconcile-failed`, stale `lastSuccess`, pending-deployment, expiry <14 days,
and worker liveness; connect these to your real alerting system. The code emits
status/events, not an email/pager integration. Certbot details remain in its
owner-only log directory. No raw exception cause/stack is serialized to users.
An outage leaves working certificates valid until expiry; do not wait for expiry
to investigate. Respect CA rate limits and avoid forced issuance loops.

Revocation/exit: remove the validation CNAME, stop the worker, revoke compromised
certificates through the CA, rotate NPM credentials and provision a new registration
if continuing. Removing a CNAME does not revoke certificates. Operator migrations,
restore drills and CA revocation are deliberately not automated destructively.
A customer may instead manage certificates/DNS themselves; the gateway only needs
valid TLS ingress, not this service.

## Tests and remaining deployment evidence

```bash
npm ci --legacy-peer-deps
npm run test:tls
npm test
```

TLS tests use mocked DNS/acme-dns/NPM/issuance plus native OpenSSL fixtures for
certificate validation. API tests exercise the real DSH route handler, gate,
no-secret status and client component in an isolated context. They do not create
containers or call a real CA. A staging canary against an actual acme-dns service,
Certbot, NPM version and public authoritative DNS remains required before release.
No claim of production readiness follows from mock tests alone.

### Measured source verification — 2026-10-14

- `npm test`: **134 Node tests passed**, plus **39 proxy checks**, **12 password
  checks** and **3 catalog-retry checks**. Optional real whoami upstream skipped
  because its container was not running.
- Final `npm run test:tls`: **20/20 passed**, including a later fresh-TLS retry
  regression added after the full-suite run (the prior full suite included 19 TLS
  tests). Certificate chain tests use a temporary OpenSSL CA, not a public CA.
- `npm audit --omit=dev`: **0 vulnerabilities**. The investigated JS ACME client
  was removed; no new runtime JS dependency remains. Certbot is external.
- `git diff --check` and CLI/worker syntax checks passed. `npm pack --dry-run`
  includes the new CLI, worker, modules, docs and deployment templates.
- No real Certbot/CA issuance, worker image build, service deployment, actual NPM
  upload/reload, production DNS change, release publication or harness restart.

Sources: [Let's Encrypt delegation](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge),
[acme-dns protocol/security](https://github.com/acme-dns/acme-dns),
[Certbot manual hooks](https://eff-certbot.readthedocs.io/en/stable/using.html#hooks),
[NPM certificate implementation](https://github.com/NginxProxyManager/nginx-proxy-manager/blob/v2.16.0/backend/internal/certificate.js),
[NPM proxy update](https://github.com/NginxProxyManager/nginx-proxy-manager/blob/v2.16.0/backend/internal/proxy-host.js).
