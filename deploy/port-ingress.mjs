#!/usr/bin/env node
/** Generate one static nginx HTTP-context server for the whole app port range.
 * Usage: node deploy/port-ingress.mjs https://harness.example 172.18.0.4 /cert/fullchain.pem /cert/privkey.pem [20000] [20099] [https://apps.example]
 * Optional appOrigin selects the app hostname; without it, controlOrigin is used.
 * Prints config only; never changes ingress, certificates or Docker.
 */
import { isIP } from 'node:net'
import { pathToFileURL } from 'node:url'
import { gatewayConfig } from '../lib/app-launch.js'

export function portIngress({ controlOrigin, appOrigin, upstream, cert, key, start = 20000, end = 20099 }) {
  const config = gatewayConfig({ appAccess: 'ports', controlOrigin, appOrigin, appPortStart: start, appPortEnd: end }, {})
  const publicURL = new URL(config.appOrigin ?? config.controlOrigin)
  if (publicURL.protocol !== 'https:') throw Error('TLS ingress requires an HTTPS appOrigin (or controlOrigin when appOrigin is absent)')
  if (!isIP(upstream)) throw Error('upstream must be the private DSH IP')
  for (const file of [cert, key]) if (typeof file !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(file)) throw Error('Certificate paths must be absolute nginx paths without spaces')
  const hostname = publicURL.hostname
  const target = isIP(upstream) === 6 ? `[${upstream}]` : upstream
  const listens = Array.from({ length: end - start + 1 }, (_, i) => `  listen ${start + i} ssl;`).join('\n')
  return `# Generated app range: publish ${start}-${end}:${start}-${end}/tcp on the ingress container.
# Include inside nginx's http context, NOT a proxy-host Advanced location.
server {
${listens}
  server_name ${hostname};
  if ($host != "${hostname.replace(/^\[|\]$/g, '')}") { return 421; }
  ssl_certificate ${cert};
  ssl_certificate_key ${key};
  client_max_body_size 0;
  location / {
    proxy_pass http://${target}:$server_port;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Port $server_port;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [controlOrigin, upstream, cert, key, start, end, appOrigin] = process.argv.slice(2)
    process.stdout.write(portIngress({ controlOrigin, appOrigin, upstream, cert, key, ...(start ? { start: Number(start) } : {}), ...(end ? { end: Number(end) } : {}) }))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
