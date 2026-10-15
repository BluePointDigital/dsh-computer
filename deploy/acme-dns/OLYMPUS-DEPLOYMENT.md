# Olympus shared validation service — live deployment record

Measured 2026-10-14 (America/New_York). This file contains **public configuration
and operational evidence only**, not private enrollment credentials.

## Live now

- Host: Olympus, public IPv4 **104.225.218.209**. Host Docker accessed through
  `https://portainer:9443`, endpoint **1 / primary**, not the harness nested daemon.
- Portainer stack **13 / dsh-acme-dns**, container **dsh-acme-dns**.
- Upstream acme-dns **v2.0.2**, revision
  `4e5a69e5fb742dde4f755b7f56aee2aea76e19bf`, image pinned in
  [the Compose definition](olympus.compose.yaml).
- DNS: **104.225.218.209:53 TCP and UDP**, mapped to container port 5353.
  Existing host resolver remains on **127.0.0.53/54:53**, untouched.
- Zone: **auth.bluepointdigital.com**; nameserver **ns-acme.bluepointdigital.com**.
- API: **https://auth.bluepointdigital.com**, NPM host **21**, independently
  HTTP-01-issued NPM certificate **31**, expires **2027-01-13 01:23:58 UTC**.
  Its renewal does not depend on this delegated validation zone's TXT API.
- API backend port 8080 has **no host publication**. TLS terminates at NPM;
  the backend is on the existing private `proxy` Docker network.
- Public `/register` is denied in NPM with 403. Registration is also disabled in
  acme-dns configuration except an explicit private operator enrollment window.
- Process UID/GID **1000:1000**, no capabilities, no-new-privileges, read-only root,
  128 MiB memory / 0.5 CPU / 64 PID limits, bounded logs, unless-stopped restart.

Private host Docker volumes (not under the synced workspace):

| Name | Purpose |
|---|---|
| `dsh-acme-dns-config` | Owner-only config, mounted read-only by service |
| `dsh-acme-dns-data` | Owner-only SQLite registration/TXT database |
| `dsh-acme-dns-canary-state` | Staging enrollment credential, 0600 file in 0700 root |

The service stores password hashes; the deployment stores its private enrollment
credential. None was printed, embedded in Compose, or copied to source.

## Verified

- Direct DNS SOA answers authoritative over both TCP and UDP at the public IP.
  Initial direct checks originated from this host/container. After owner DNS edits,
  independent Cloudflare/Google recursive delegation and TXT checks also passed;
  the real staging CA subsequently validated a changing challenge.
- Queries for unrelated domains receive no recursive answers; recursion flag off.
- Trusted public HTTPS handshake and correct hostname SAN.
- `GET /health` → 200; public `POST /register` → 403; unauthenticated
  `POST /update` → 401; plain HTTP redirects to HTTPS.
- One private canary registration created, registration disabled again, its
  restricted credential successfully used through the public HTTPS update API.
- NPM installed version **2.15.1**: current certificate schema does **not** accept
  `letsencrypt_email` metadata. API leaf issuance succeeded with
  `meta: {dns_challenge: false}`. Do not copy older API examples without inspection.
- acme-dns v2.0.2 uses `engine="sqlite"` and log level `"warn"`, not the old
  v1 `sqlite3` / template `warning` spelling. Updated generic template accordingly.
- Docker image volume copy-up reset empty data-volume root ownership on first
  create. Repaired ownership and added explicit `volume.nocopy=true` to both
  service mounts; actual authenticated registration/update now succeeds. A health
  200 alone was insufficient evidence of a usable DB.

Recheck without credentials:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 deploy/acme-dns/verify-olympus.py
```

Operator enrollment helper is [enroll-olympus.py](enroll-olympus.py). Do not rerun
it for the existing canary: its preflight deliberately refuses duplicate enrollment.
It briefly enables registration privately, persists the response in the private
volume, and disables registration again in `finally`. No public self-enrollment
is supported; future customers receive operator-provisioned credentials privately.

## Cloudflare records — owner applied, publicly verified

Zone: **bluepointdigital.com**. TTL Auto is fine. All A/CNAME records here must
be **DNS only**, not proxied. Do **not** replace the domain's root nameservers.

| Type | Name in Cloudflare | Content / target | Purpose |
|---|---|---|---|
| A | `ns-acme` | `104.225.218.209` | Explicit nameserver address, even if wildcard DNS currently resolves it |
| NS | `auth` | `ns-acme.bluepointdigital.com` | Delegate only the validation subdomain |
| A | `*.tls-canary` | `104.225.218.209` | Isolated wildcard ingress for staging tests |
| CNAME | `_acme-challenge.tls-canary` | `247b088d-d279-488a-9e97-8c65be79cdb3.auth.bluepointdigital.com` | Existing canary's scoped validation target |

The delegated service itself answers the zone-apex `auth` A record, so the API
hostname continues resolving after the NS delegation. If an explicit conflicting
record already occupies one of these names, inspect it before replacement. Do not
alter `dev`, its wildcard, or any existing production certificate to run staging.
There are no saved Cloudflare credentials in the inspected private secret store;
DNS changes require the owner or a securely supplied scoped operator token.

## Worker build preparation verified during continuation

While waiting for parent DNS changes, built the worker on the verified host daemon
using [a source-allowlist build client](../tls-worker/build-olympus.py); no profiles,
workspace state or credentials were included in the build context.

- Tag: `local/dsh-tls-worker:canary-7107146053d47e5b`
- Immutable image: `sha256:d02a47b26631aacc9ca124527ecce6a45ebf2b96b41123adb282e6e414b62f75`
- Node base digest: `sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5`
- Actual versions: Node **24.22.0**, Certbot **2.1.0** from Debian maintained package.
- [Worker smoke](../tls-worker/verify-olympus.py) passed as UID 1000, no network,
  read-only root, no capabilities and temporary private state. Real Certbot binary
  invocation, AppManager/TLS imports, 0700 state root and kernel flock all passed.
- Smoke container was removed. No automatic worker was started and no CA order
  was placed. This is build/runtime readiness, **not DNS/ACME/NPM acceptance**.
- Both Cloudflare and Google public resolvers still returned no `auth` NS
  delegation; Google also returned no staging challenge CNAME during this round.

## Public delegation gate

[check-delegation.py](check-delegation.py) checks Cloudflare and Google recursive
resolvers for exact NS/CNAME/ingress targets and the canary TXT. It exits **2**
when prerequisites are missing rather than placing speculative CA orders. Fixture
checks passed for correct, empty, SERVFAIL, misrouted and multiple-address answers.

Earlier continuation rounds correctly stopped at missing delegation. After the
owner reported DNS done on 2026-10-14 at 23:18 America/New_York, both Cloudflare and
Google passed **all five checks**, including exact NS/CNAME, ingress IPv4 and real
canary TXT visibility. Real staging issuance then proceeded.

## Real staging acceptance — 2026-10-14 late evening

- Cloudflare and Google public DNS gate passed all records after owner DNS edits.
- Isolated upstream `dsh-tls-canary-upstream` returns only 401/no-store and a test
  message, not app or harness data. No published host port.
- Private scratch worker `dsh-tls-canary-worker` uses the existing private canary
  volume, UID 1000, no capabilities, read-only root, no Docker socket. Infrastructure
  credentials were transferred via in-memory tar to a 0600 volume file, imported
  into private deployment state and the input file deleted. No secrets in argv,
  environment, logs or source.
- First real Certbot run found a hook-parser compatibility defect: Certbot 2.1
  takes the first whitespace-delimited hook word literally, so a quoted Node
  executable was rejected. Fixed source to use unquoted `/bin/sh` followed by a
  safely quoted complete inner command, added regression, rebuilt scratch worker.
- Corrected worker image:
  `sha256:a996a8b1a9df3528bf14604edce90fa00f17a0c246f09f982f80414bb11f3bec`
  (`local/dsh-tls-worker:canary-5c8971b2d21dfe6f`). Earlier image remains historical.
- **Real Let's Encrypt staging issuance succeeded** for
  `*.tls-canary.bluepointdigital.com`, through the existing restricted registration.
- Real custom certificate upload and managed NPM wildcard route creation passed:
  certificate **32**, proxy host **22**, exact staging wildcard → private test
  upstream, TLS forced, access list 0, caching disabled, nginx online.
- Fresh served certificate matched persisted fingerprint:
  `BE:A4:8D:A8:B1:2E:39:D3:27:91:29:57:94:C3:D0:5D:3A:11:62:41:D6:40:1B:03:9F:A8:17:87:E3:C8:F7:D1`.
- An ordinary public trust-store client correctly **rejects** the staging
  certificate. A staging-only unverified probe returned the expected 401 fixture
  response. This is not a browser-trusted production certificate.
- Production NPM hosts **2** (`dev`, certificate 30, access list 1) and **20**
  (`*.dev`, certificate 0) retained their original upstream/ports/settings.
  Validation API host **21**, certificate 31, also unchanged.
- Full `npm test` after hook fix: **135 Node tests**, **39 proxy checks**, **12
  password checks**, **3 catalog retry checks** passed. Optional live whoami
  upstream skipped because container not running.
- Real pending state was retained through a controlled **pre-upload** fault.
  The real adapter restored/reloaded the currently valid staging bundle; durable
  phase became `pending-deployment-rolled-back`. A fresh manager retried the real
  upload/reload without issuance, preserving certificate 32 and host 22. This
  simulates a failure before upload, not a mid-write NPM filesystem crash.
- Cross-registration update using the canary credential returned **401**, as
  required. Private state ownership/mode is UID 1000 / 0600; Certbot log directory
  0700; temporary operator-input file was deleted.
- **Real Certbot renewal dry run passed**, including new staging CA validation:
  log reports `Congratulations, all simulated renewals succeeded` at
  **2026-10-15 03:28:31 UTC**. Original acceptance exec
  `72e442eb9193b3de7781e66bd50ab4721b0e1b4c7ddf78a2b4a2f958c86ee087`
  finished **exit 0**. The dry run did not replace deployed certificate material.
- Certbot inserted its normal ~332-second randomized delay; initial control-plane
  stream timed out at 180 seconds. Inspected the still-running remote exec and
  collected that **same** process's exit/result through a process-exit watcher;
  no duplicate order was started. Future explicit canary simulation disables
  randomized sleep to keep test turnaround bounded.

## Final scratch disposition

After acceptance completed, disabled only NPM canary host **22** and stopped the
owned scratch worker/upstream (on-demand, no automatic renewal of staging certs).
Certificate **32**, both stopped containers and private state volume are retained
for inspection/retest. Stored canary phase `ready` describes the last successful
test, **not a currently active route** after deliberate shutdown. Shared service
stack 13 and API host 21 remain running. Harness container remained running since
**2026-10-14 05:05:51 UTC**, restart count 0; no harness restart performed.

## Still pending

1. Supervised **production** renewal worker and publicly trusted app wildcard
   activation are separate from this scratch staging fixture. The generic worker
   intentionally refuses automatic staging deployment; canary runs are explicit.
2. Scheduled encrypted/off-host DB backup, restore drill and liveness/expiry/API
   rate-limit alert integration. Persistent volume/restart policy is not a backup
   or monitoring system. No claim those operational integrations are complete.
3. Pinned release/install and separate coordinated harness activation/acceptance.
   Existing production wildcard host **20 / *.dev.bluepointdigital.com** is foreign
   to this adapter and must not be silently adopted. It is untouched.

No active harness restart, existing app-route change, package release, production
wildcard certificate replacement or customer DNS mutation was performed.
