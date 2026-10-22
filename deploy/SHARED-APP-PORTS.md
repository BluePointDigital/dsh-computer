# Shared application hostname / assigned ports

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

Before cutover the TLS range returns 502 because the harness has not switched its
listeners. Do not call this live app acceptance. Existing wildcard remains until
new mode is verified; retire its route only after acceptance. Restart after turn end.

Configuration changes should use Harness ConfigEditor through its owner lifecycle,
not edit the live profile as a shortcut. Back up pin/config/state before activation.
