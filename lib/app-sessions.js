/** Host-bound, memory-only launch sessions. DSH credentials never cross origins. */
import { randomBytes, createHash } from 'node:crypto'
import { LAUNCH_PATH, SESSION_PATH } from './app-launch.js'

export const SESSION_COOKIE = '__Host-dsh-app-session'
const token = () => randomBytes(32).toString('base64url')
const digest = value => createHash('sha256').update(value).digest('hex')
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const SESSION_MS = 8 * 60 * 60 * 1000

export function privateCookie(name) {
  return /^(?:__Host-dsh-app-|dsh-auth-|__Host-dsh-auth-)/i.test(name)
}

export class AppSessions {
  constructor({ now = Date.now, ticketMs = 60_000, sessionMs = SESSION_MS, maxTickets = 512, maxSessions = 4096 } = {}) {
    Object.assign(this, { now, ticketMs, sessionMs, maxTickets, maxSessions })
    this.tickets = new Map()
    this.sessions = new Map()
    this.closed = false
  }
  prune() {
    for (const map of [this.tickets, this.sessions]) for (const [key, item] of map) if (item.expires <= this.now()) map.delete(key)
  }
  issue(app) {
    this.prune()
    if (this.closed || app.launch?.mode !== 'isolated') throw Error('Application gateway unavailable')
    if (this.tickets.size >= this.maxTickets) throw Error('Too many pending launches; retry shortly')
    const ticket = token()
    let entryPath = app.launch.entryPath
    if (app.viewer?.password) {
      const entry = new URL(entryPath, app.launch.origin)
      entry.searchParams.set('password', app.viewer.password)
      entryPath = entry.pathname + entry.search
    }
    this.tickets.set(digest(ticket), { origin: app.launch.origin, identity: app.launch.identity, entryPath, expires: this.now() + this.ticketMs })
    return `${app.launch.origin}${LAUNCH_PATH}#${ticket}`
  }
  exchange(ticket, app) {
    this.prune()
    if (this.closed || !TOKEN.test(ticket ?? '')) return null
    const key = digest(ticket), pending = this.tickets.get(key)
    if (!pending || pending.origin !== app.launch.origin || pending.identity !== app.launch.identity) return null
    this.tickets.delete(key) // A correctly bound ticket is single-use, even at capacity.
    if (this.sessions.size >= this.maxSessions) return null
    const value = token()
    this.sessions.set(digest(value), { origin: pending.origin, identity: pending.identity, expires: this.now() + this.sessionMs })
    return { entryPath: pending.entryPath, cookie: `${SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=${Math.floor(this.sessionMs / 1000)}` }
  }
  authorize(req, app) { return Boolean(this.grant(req, app)) }
  grant(req, app) {
    this.prune()
    if (this.closed) return null
    const values = (req.headers.cookie ?? '').split(';').map(p => p.trim()).filter(p => p.startsWith(SESSION_COOKIE + '='))
    if (values.length !== 1) return false
    const value = values[0].slice(SESSION_COOKIE.length + 1)
    if (!TOKEN.test(value)) return false
    const session = this.sessions.get(digest(value))
    return session && session.origin === app.launch.origin && session.identity === app.launch.identity ? session : null
  }
  retain(apps) {
    const identities = new Set(apps.filter(app => app.launch?.mode === 'isolated').map(app => app.launch.identity))
    for (const map of [this.tickets, this.sessions]) for (const [key, value] of map) if (!identities.has(value.identity)) map.delete(key)
  }
  close() { this.closed = true; this.tickets.clear(); this.sessions.clear() }
}

/** No ticket in HTTP URLs, access logs, Referer or generated HTML. */
export function bootstrapPage(controlOrigin) {
  const nonce = token()
  return {
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${controlOrigin}`,
      'x-content-type-options': 'nosniff',
    },
    body: `<!doctype html><meta charset="utf-8"><title>Opening application</title><p id="status">Opening application…</p><script nonce="${nonce}">
(async()=>{const ticket=location.hash.slice(1);history.replaceState(null,'',location.pathname);
try{const r=await fetch('${SESSION_PATH}',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({ticket})});
if(!r.ok)throw Error('Launch expired or unavailable. Return to Applications and open it again.');
const result=await r.json();location.replace(result.entryPath);
}catch(e){document.getElementById('status').textContent=e.message;}})();</script>`,
  }
}
