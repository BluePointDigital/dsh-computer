# Olympus production gateway activation — in progress

## Current measured state (2026-10-15 morning, America/New_York)

- Running profile still pinned to **v0.4.5**; gateway release v0.5.0 source exists,
  delegated TLS follow-up is being prepared as v0.5.1.
- Live control proxy is the old loopback Host/Origin rewriting implementation.
  Canonical hardened proxy and transport tests passed **20/20** this turn. A
  derived image built but not deployed:
  `local/deepseek-harness:olympus-gateway-2069fc459643109e`, immutable
  `sha256:fa4b140b91013dc86172d8a8e443c58e6eb6f8c92136325a13d75d0ed13ee966`,
  based on exact live image `sha256:bf331069f748f7769120ea5af1eec8e1d751d306c056022b629e2b66669323c8`.
  No active harness restart.
- Host NPM source **172.18.0.2** and DSH private interface **172.18.0.4** are dynamic
  endpoints today. Static reservation in owners/watchdog and actual socket-peer
  proof remain cutover prerequisites. Do not assume these IPs survive recreation.
- Existing NPM wildcard **20** (`*.dev.bluepointdigital.com`) points to the normal
  control proxy 8080 with certificate 0. It is not adapter-owned and must be
  explicitly snapshotted/migrated, never silently adopted.
- Exact control NPM host **2** uses certificate 30 and access list 1. Preserve that
  authentication policy; enable HTTPS-only control during coordinated migration.
- Wildcard DNS lookup currently points at **104.255.218.209** (typo); correct host
  IP is **104.225.218.209**. Control host A is correct.
- Separate production registration created privately in host Docker volume
  **dsh-olympus-tls-state**; not the canary registration. Public registration stayed
  blocked. Service registration disabled again after private enrollment.

## Required owner DNS action

In Cloudflare bluepointdigital.com, DNS only / Auto TTL:

| Type | Name | Value |
|---|---|---|
| A | `*.dev` | **104.225.218.209**, replacing 104.255.218.209 |
| CNAME | `_acme-challenge.dev` | `293c6e0d-b61b-4f27-a50d-a242973a7b61.auth.bluepointdigital.com` |

Leave `dev` A and `auth` NS delegation unchanged. Production must use its own
registration even though staging already worked.

## Release safety additions

- GUI never opens worker private state: public status snapshots are separately
  allowlisted. Production worker secret volume must **not** be mounted into DSH.
  Only sanitized status directory is shared, read-only into DSH.
- NPM ownership/collision check now runs before first CA order; managed renewal
  audits route drift before any mutation. Renewal must not silently remove a
  manually added access policy/upstream/cache restriction.
- Same-ID upload refuses any foreign proxy/redirect/dead host using the certificate.
- Deterministic TLS suite passed after changes. Full suite passed **138 Node**,
  **39 proxy**, **12 password**, **3 catalog retry** checks. `npm pack --dry-run`
  inventory passed with temporary npm cache (default cache is not writable).

## Cutover sequence — not yet executed

1. Review and publish pinned v0.5.1; install through profile dependency, never link.
2. Build/review hardened control image based on exact live image.
3. Snapshot live stack/profile/NPM route privately, stage exact peer/interface
   reservation and worker/status mounts, provision worker config from private
   production registration with operator credentials never written to source.
4. Verify corrected production DNS. Prepare issued/pending production bundle if
   appropriate, without premature routing or skipping trust checks.
5. Migrate foreign wildcard explicitly with rollback snapshot. Keep host 2 auth.
6. Finish turn before any harness recreate/restart. Owner executes/reviews managed
   maintenance handoff between turns; no time-delayed mid-turn restart.
7. After restart, verify existing GUI URL after refresh, control Origin/peer fences,
   launch/session cookie exchange, private gateway transport/rejections, no legacy
   bypass and actual app view. Enable independently supervised production renewal.

Backups/expiry/failure monitoring must have a real destination, not an invented
notification service. Private snapshots do not equal encrypted off-host backups.
