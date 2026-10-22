# Shared application hostname / assigned ports

> **Superseded on Olympus — 2026-10-22 02:54 UTC:** owner requires Harness-gated
> access. Public range ingress is stopped with restart=no. Isolated authenticated
> gateway restored through ConfigEditor without restarting the harness. All five
> web/viewer launch descriptors use isolated origins again. Two live apps each
> passed anonymous HTTP401, authorized session HTTP200, reused-ticket401 and
> anonymous WebSocket401 checks. Anonymous public control launch is401; cookie is
> Secure/HttpOnly/SameSite=None/Partitioned. Temporary restore bundle removed.
> CLI saved launch policy also restored. DNS/cert renewal route is active again.
> Evidence below documents the historical port experiment, not current access.

Release 0.7.1 adds optional `appOrigin` / `DSH_APPS_ORIGIN` for port mode.
Control authentication remains at `controlOrigin`; app URLs, noVNC fields and
range-ingress hostname use `appOrigin` when supplied. Missing option preserves
existing behavior. HTTPS control cannot embed HTTP apps. Exact origins only:
no credentials/path/query/fragment or nondefault base port.

Olympus target:
- Harness: https://dev.bluepointdigital.com
- Shared app hostname: https://apps.dev.bluepointdigital.com:20000–20099
- DNS resolves directly to 104.225.218.209, not a CDN.
- Dedicated host container `dsh-olympus-app-ports`, pinned nginx image, publishes
  the range and forwards port-for-port to private 172.18.0.4.
- Existing NPM and control authentication are unchanged.
- TLS uses read-only existing certificate directory npm-33; its existing owner
  renews the wildcard certificate. A digest watcher validates/reloads nginx on change.
- Config persists in volume `dsh-olympus-app-ports-config`; read-only root, tmpfs
  temp paths, all capabilities dropped. App authentication remains app-owned.
- Apps share cookies by hostname despite distinct origins by port; this is the
  trusted-app model, not the isolated ticket/session gateway.

## Live verification — 2026-10-22 02:23 UTC

Olympus is running 0.7.1 with the saved shared app origin. All five web/viewer
launch descriptors use ports; none uses isolated subdomains. Public trusted HTTPS
File Browser :20001 and nested Portainer :20004 return 200. Control root still
returns 401 anonymously. All six original container IDs remain; the same two apps
that were running before activation were restored. Temporary cutover bundle removed.

The old private isolated listener on :3099 is no longer running; obsolete wildcard
addresses return 502 and cannot reach applications. NPM route 23 and certificate 33
are deliberately retained as certificate-renewal ownership records: the existing
TLS worker audits that exact route before renewing the certificate also serving
the new ports. Deleting/disabling it without migrating renewal would strand HTTPS
at expiry. This dormant route is not used by Applications. A future cleanup must
separate certificate renewal from wildcard route ownership before deleting it.

Source and deterministic transport tests cover WebSockets; a live authenticated
browser/WS session was not exercised during this cutover. No desktop was started
just for verification.

Configuration changes should use Harness ConfigEditor through its owner lifecycle,
not edit the live profile as a shortcut. Back up pin/config/state before activation.
