#!/usr/bin/env node
// box-cdp — drive the box's Chromium over the DevTools Protocol.
//
// Why this exists: `computer click <x> <y>` is pixel-based. It has no idea what
// it is clicking, so a layout shift or a late paint makes it hit the wrong
// element and the failure is SILENT — you just get a plausible screenshot.
//
// This talks to the same browser the human watches over VNC, but addresses
// elements by role/name/text instead of coordinates, and Playwright's auto-wait
// means "click the button" waits for the button instead of sleeping and hoping.
//
// Runs inside the box against the CDP endpoint on loopback. No published port.
//
//   node cdp.mjs goto https://example.com
//   node cdp.mjs snapshot                      # ARIA tree: roles + names
//   node cdp.mjs click "role=button[name='Sign in']"
//   node cdp.mjs fill  "role=textbox[name='Email']" "me@example.com"
//   node cdp.mjs text | links | tabs | new <url> | eval <js> | wait <sel>

import { chromium } from 'playwright-core';

const ENDPOINT = process.env.BOX_CDP_ENDPOINT || 'http://127.0.0.1:9222';
const TIMEOUT = Number(process.env.BOX_CDP_TIMEOUT || 15000);
const MAX_LINES = Number(process.env.BOX_CDP_MAX_LINES || 400);

const argv = process.argv.slice(2);
const cmd = argv.shift();
const rawArgs = argv;
const ALLOW_WRITE =
  process.env.BOX_CDP_ALLOW_WRITE === '1' || rawArgs.includes('--allow-write');
const args = rawArgs.filter((a) => a !== '--allow-write');

// Mutating commands are refused unless writes are explicitly enabled. Pointed at
// a live account, this turns "click the wrong thing" from a silent action into a
// deliberate opt-in. It is a speed bump, not a sandbox: `eval` runs arbitrary
// page JS and can still mutate, so treat it as a write too.
const WRITE_CMDS = new Set(['click', 'fill', 'press', 'eval']);
if (WRITE_CMDS.has(cmd) && !ALLOW_WRITE) {
  console.error(`cdp: '${cmd}' can change the page and writes are not enabled.`);
  console.error(`  Re-run with BOX_CDP_ALLOW_WRITE=1 (or --allow-write) once you are sure.`);
  console.error(`  Read-only: snapshot, rows, text, links, net, url, tabs, wait, goto, back.`);
  process.exit(2);
}

function die(msg) {
  console.error(`cdp: ${msg}`);
  process.exit(1);
}
function cap(text) {
  const lines = String(text).split('\n');
  if (lines.length <= MAX_LINES) return text;
  return lines.slice(0, MAX_LINES).join('\n') + `\n... (+${lines.length - MAX_LINES} more lines)`;
}

if (cmd === undefined || cmd === 'help' || cmd === '--help') {
  console.log(`cdp <command>
READ-ONLY (no flag needed)
  snapshot [selector]        ARIA tree (roles + accessible names) — use for targeting
  rows [selector]            table rows as pipe-delimited text (default [role=row])
  text [selector]            innerText
  links                      visible link text -> href
  net [substring]            XHR/fetch the page has made (status, ms, url)
  wait <selector>            wait for an element to appear
  goto <url> | url | back | tabs | new [url]

MUTATING (needs BOX_CDP_ALLOW_WRITE=1 or --allow-write)
  click <selector>           element-level click, auto-waits for visibility
  fill <selector> <text>     clear + type into a field
  press <key>                e.g. Enter, Control+A
  eval <js>                  run JS in the page (arbitrary — treat as a write)`);
  process.exit(cmd === undefined ? 0 : 0);
}

const browser = await chromium.connectOverCDP(ENDPOINT).catch((e) => {
  die(`cannot reach CDP at ${ENDPOINT} — is Chromium running with ` +
      `--remote-debugging-port? (${e.message})`);
});
const ctx = browser.contexts()[0];
if (!ctx) die('connected, but the browser exposed no context');
const page = ctx.pages()[0] ?? (await ctx.newPage());

try {
  switch (cmd) {
    case 'goto': {
      const url = args[0] ?? die('goto needs <url>');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      // Best-effort settle; SPAs keep sockets open so don't fail on this.
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      console.log(`url:   ${page.url()}\ntitle: ${await page.title()}`);
      break;
    }
    case 'url':
      console.log(`url:   ${page.url()}\ntitle: ${await page.title()}`);
      break;
    case 'snapshot': {
      const target = args[0] ? page.locator(args[0]).first() : page.locator('body');
      await target.waitFor({ state: 'attached', timeout: TIMEOUT });
      console.log(cap(await target.ariaSnapshot({ timeout: TIMEOUT })));
      break;
    }
    case 'click': {
      const sel = args[0] ?? die('click needs <selector>');
      const el = page.locator(sel).first();
      await el.waitFor({ state: 'visible', timeout: TIMEOUT });
      await el.scrollIntoViewIfNeeded();
      await el.click({ timeout: TIMEOUT });
      console.log(`clicked: ${sel}`);
      break;
    }
    case 'fill': {
      const [sel, ...rest] = args;
      if (!sel || rest.length === 0) die('fill needs <selector> <text>');
      const el = page.locator(sel).first();
      await el.waitFor({ state: 'visible', timeout: TIMEOUT });
      await el.fill(rest.join(' '), { timeout: TIMEOUT });
      console.log(`filled: ${sel}`);
      break;
    }
    case 'press': {
      const key = args[0] ?? die('press needs <key>');
      await page.keyboard.press(key);
      console.log(`pressed: ${key}`);
      break;
    }
    case 'text': {
      const sel = args[0] || 'body';
      console.log(cap(await page.locator(sel).first().innerText({ timeout: TIMEOUT })));
      break;
    }
    case 'links': {
      // Emit the RAW href attribute, not `a.href`. The property resolves to an
      // absolute URL, which then does NOT match `a[href="..."]` in a CSS
      // selector — so the tool's own output would be unusable for targeting.
      const items = await page.locator('a').evaluateAll((as) =>
        as.map((a) => ({
          t: (a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 90),
          h: a.getAttribute('href') || '',
        })).filter((i) => i.t && i.h && !i.h.startsWith('#')));
      for (const i of items.slice(0, 150)) console.log(`${i.t}\t${i.h}`);
      console.log(`(${items.length} links)`);
      break;
    }
    case 'wait': {
      const sel = args[0] ?? die('wait needs <selector>');
      await page.locator(sel).first().waitFor({ state: 'visible', timeout: TIMEOUT });
      console.log(`visible: ${sel}`);
      break;
    }
    case 'eval': {
      const js = args.join(' ');
      if (!js) die('eval needs <js>');
      console.log(cap(JSON.stringify(await page.evaluate(js), null, 2)));
      break;
    }
    case 'tabs': {
      ctx.pages().forEach((p, i) => console.log(`${i}\t${p.url()}`));
      break;
    }
    case 'new': {
      const p = await ctx.newPage();
      if (args[0]) await p.goto(args[0], { waitUntil: 'domcontentloaded', timeout: 45000 });
      ctx.pages().forEach((q, i) => console.log(`${i}\t${q.url()}`));
      break;
    }
    case 'rows': {
      // The most common read. Extracting a table as text is far more reliable
      // than reading it out of a screenshot, and it costs no vision tokens.
      const sel = args[0] || '[role=row]';
      const rows = await page.locator(sel).evaluateAll((els) =>
        els.map((e) => (e.innerText || '').replace(/\s*\n\s*/g, ' | ').trim()).filter(Boolean));
      const cap = Number(process.env.BOX_CDP_MAX_ROWS || 60);
      rows.slice(0, cap).forEach((r, i) => console.log(`${i}\t${r.slice(0, 320)}`));
      console.log(`(${rows.length} rows${rows.length > cap ? `, showing ${cap}` : ''})`);
      break;
    }
    case 'net': {
      // Retroactive from the Resource Timing buffer, so it sees calls that were
      // made BEFORE this command ran. Use it to confirm an action actually hit
      // the server instead of trusting that the UI looked right.
      const filter = args[0] || '';
      const entries = await page.evaluate(() =>
        performance.getEntriesByType('resource').map((e) => ({
          url: e.name,
          type: e.initiatorType,
          status: e.responseStatus || 0,
          ms: Math.round(e.duration),
          bytes: e.transferSize || 0,
        })));
      const xhr = entries.filter((e) => /xmlhttprequest|fetch|beacon/i.test(e.type));
      const hits = filter ? xhr.filter((e) => e.url.includes(filter)) : xhr;
      console.log(
        `XHR/fetch: ${xhr.length}${filter ? `  matching "${filter}": ${hits.length}` : ''}`,
      );
      for (const h of hits.slice(-40)) {
        console.log(
          `  ${String(h.status || '---').padStart(3)}  ${String(h.ms).padStart(6)}ms  ` +
          `${String(h.bytes).padStart(7)}B  ${h.url.replace(/\?.*$/, '?…').slice(0, 140)}`,
        );
      }
      const failed = xhr.filter((e) => e.status >= 400);
      if (failed.length) console.log(`  !! ${failed.length} request(s) >= 400`);
      break;
    }
    case 'back': {
      await page.goBack({ timeout: 20000 });
      console.log(`url: ${page.url()}`);
      break;
    }
    default:
      die(`unknown command '${cmd}' — run: cdp help`);
  }
} catch (err) {
  die(err.message.split('\n')[0]);
} finally {
  // Detach only. `browser.close()` would take the human's window down with it.
  await browser.close().catch(() => {});
}
