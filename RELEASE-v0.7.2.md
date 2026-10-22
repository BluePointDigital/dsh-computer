# v0.7.2 / v0.7.3 — Applications access setup diagnostics

**Use v0.7.3:** installation inspection caught that the historical isolated-policy
object omits a mode property. v0.7.3 infers isolated policy from its domain and
has a regression test using that real shape. v0.7.2 is superseded; tags are immutable.

Adds a warning at the top of Applications when DNS, certificate provisioning,
private listener availability or access-mode configuration needs attention.

- Authenticated `GET /apps/api/access-health`; exact-control-Origin JSON
  `POST /apps/api/access-check` for Recheck. No DNS writes or certificate issuance.
- Fresh random child hostname tests wildcard coverage, rather than mistakenly
  accepting the Harness apex or one explicit app record.
- Expected wildcard A and delegated-validation CNAME come only from the sanitized
  instance TLS snapshot. A missing snapshot never invents a public IP or unique
  delegation target. An operator action is explicitly shown instead.
- Missing records, wrong ingress/AAAA, resolver uncertainty, unprovisioned or
  expired/staging TLS, domain mismatch and unavailable listener are distinguished.
- Bounded DNS resolver, coalesced requests, 30-second cache and 5-second minimum
  forced refresh; checks run independently of Docker inventory.
- Banner uses theme tokens and escaped selectable record text, includes exact
  provider instructions and Recheck, and disappears on a clean observation.
- Healthy observations do NOT certify public certificate serving, CDN cache
  bypass, global DNS propagation, browser DNS or end-to-end authentication.

## Deployment contract

This is additive to v0.7.1. It does not switch access modes by itself. Olympus
uses authenticated isolated origins. Public app ports are not Harness-gated;
Wilson and Director port ingresses were stopped with restart=no before rollout.
Those instances need their own wildcard DNS/TLS provisioning. Reference had no
Applications bundle at the beginning of this rollout. Preserve per-instance
control authentication and app containers/data. Use pinned GitHub install through
PluginManager, not a live checkout dependency. Activation and verification remain
separate from publication/installation; never restart an active turn.

## Verification

Focused diagnostics, authentication-route and runtime-UI tests: 21 passed before
release. Existing full suite: 254 Node tests plus 39 proxy, 12 password and 3 catalog
checks passed. Nine new diagnostics tests passed separately (and are now in npm test).
The optional real whoami upstream check skipped because that app is stopped.
Installed-browser results are recorded separately after execution. Tests cover no DNS vs timeout, incorrect IP/AAAA, CNAME, missing/mismatched
snapshot, port-mode warning, cache/coalescing, safe HTML rendering and authenticated
API boundaries. No new package dependencies or state/container schema migrations.
