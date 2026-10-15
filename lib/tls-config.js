/** Operator-only certificate configuration. Never accept API endpoints from app input. */
import { isIP } from 'node:net'
export const check = (ok, message) => { if (!ok) throw Object.assign(new Error(message), { tlsCode: 'VALIDATION_FAILED' }) }
export function dnsName(value) {
  return typeof value === 'string' && value.length <= 190 && value.includes('.') && !isIP(value) && value.split('.').every(p => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))
}
export function endpoint(value, privateHttp = false) {
  const u = new URL(value)
  check(!u.username && !u.password && !u.search && !u.hash && u.pathname === '/' && (u.protocol === 'https:' || (privateHttp && u.protocol === 'http:')), 'API endpoint must be an HTTPS origin (private NPM HTTP requires explicit acknowledgement)')
  return u.origin
}
export function tlsConfig(input) {
  check(input && typeof input === 'object', 'TLS setup needs an object')
  const { domain, ingressAddress, email, acmeDns, npm } = input
  check(dnsName(domain), 'Invalid application DNS domain')
  check(isIP(ingressAddress) === 4, 'ingressAddress must be the public IPv4 address for the wildcard A record')
  check(typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'A certificate contact email is required')
  check(input.termsAgreed === true, 'Explicit ACME terms agreement required')
  check(acmeDns && dnsName(acmeDns.zone), 'Validation DNS zone required')
  const dnsApi = endpoint(acmeDns.url)
  check(npm && typeof npm.identity === 'string' && npm.identity.length > 0 && typeof npm.secret === 'string' && npm.secret.length > 0, 'Private NPM operator credentials required')
  const npmApi = endpoint(npm.url, npm.allowPrivateHttp === true)
  check(typeof npm.forwardHost === 'string' && /^(?:[a-z0-9][a-z0-9.-]*|[0-9a-f:]+)$/.test(npm.forwardHost) && !npm.forwardHost.includes('..'), 'Invalid private gateway upstream host')
  check(Number.isInteger(npm.forwardPort) && npm.forwardPort > 0 && npm.forwardPort <= 65535, 'Private gateway upstream port required')
  // These attestations cannot be inferred from DNS or a successful TLS handshake.
  check(input.privateIngressConfirmed === true && input.cacheBypassConfirmed === true, 'Confirm private ingress/peer isolation and wildcard cache bypass before provisioning')
  return { version: 1, domain, ingressAddress, email, termsAgreed: true,
    staging: input.staging !== false, privateIngressConfirmed: true, cacheBypassConfirmed: true,
    acmeDns: { url: dnsApi, zone: acmeDns.zone },
    npm: { url: npmApi, allowPrivateHttp: npm.allowPrivateHttp === true, identity: npm.identity, secret: npm.secret, forwardHost: npm.forwardHost, forwardPort: npm.forwardPort } }
}
export function onboarding(config, account) {
  return [
    { type: 'A', name: `*.${config.domain}`, value: config.ingressAddress, proxy: 'DNS only' },
    { type: 'CNAME', name: `_acme-challenge.${config.domain}`, value: account.fulldomain, proxy: 'DNS only' },
  ]
}
