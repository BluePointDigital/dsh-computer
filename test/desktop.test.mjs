/** Optional real-browser smoke against an already-running desktop, no harness restart.
 * RUN_DESKTOP_SMOKE=1 node test/desktop.test.mjs
 * Uses isolated headless Chromium inside dsh-app-desktop (not its live browser).
 */
import http from 'node:http'
import assert from 'node:assert/strict'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { networkInterfaces } from 'node:os'
import { randomBytes } from 'node:crypto'
import { apply } from '../lib/index.js'
const exec = promisify(execFile)
if (process.env.RUN_DESKTOP_SMOKE !== '1') {
  console.log('SKIP desktop browser smoke (set RUN_DESKTOP_SMOKE=1; requires running dsh-app-desktop)')
} else {
  const desktop = 'dsh-app-desktop'
  assert.equal(execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', desktop], { encoding: 'utf8' }).trim(), 'true')
  const gateway = Object.values(networkInterfaces()).flat().find((n) => n.family === 'IPv4' && n.address.startsWith('10.201.') && !n.internal)?.address
  assert.ok(gateway, 'No reachable nested Docker bridge address')
  const routes = new Map(), upgrades = new Map(), disposers = []
  const ctx = {
    logger: { info() {} }, connection: { requestRejection: () => undefined },
    effect(fn) { const disposer = fn(); if (disposer) disposers.push(disposer) },
    webServer: {
      register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
      registerUpgrade(route) { upgrades.set(route.path, route); return () => upgrades.delete(route.path) },
    },
  }
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<!doctype html><p id="result">WAITING</p><iframe id="viewer" width="900" height="600"></iframe>
<script type="module">
const {apps}=await (await fetch('/apps/api/list')).json();
const app=apps.find(a=>a.id==='desktop');
const src=new URL(app.web.path+'vnc.html',location.href);
for(const [k,v] of Object.entries({autoconnect:'1',resize:'scale',encrypt:'0',host:location.hostname,port:location.port,path:'apps/web/desktop/websockify',password:app.viewer.password})) src.searchParams.set(k,v);
const frame=document.getElementById('viewer');frame.src=src;
setInterval(()=>{try {
const doc=frame.contentDocument;
if(doc?.documentElement.classList.contains('noVNC_connected')) document.getElementById('result').textContent='CONNECTED';
} catch(e){document.getElementById('result').textContent='ERROR'}},100);
</script>`)
      return
    }
    const route = routes.get(req.url.startsWith('/apps/api') ? '/apps/api' : '/apps/web')
    if (!route) { res.writeHead(404).end(); return }
    Promise.resolve(route.handler(req, res)).catch((error) => res.destroy(error))
  })
  let wsCount = 0
  server.on('upgrade', (req, socket, head) => {
    const route = upgrades.get(new URL(req.url, 'http://x').pathname)
    if (!route) { socket.destroy(); return }
    wsCount++
    Promise.resolve(route.handler(req, socket, head)).catch(() => socket.destroy())
  })
  const profile = `/tmp/dsh-embed-smoke-${randomBytes(8).toString('hex')}`
  apply(ctx, { computerBin: new URL('../bin/computer', import.meta.url).pathname })
  try {
    const port = await new Promise((resolve) => server.listen(0, gateway, () => resolve(server.address().port)))
    // Real wall-clock CDP over a private pipe: virtual time races VNC handshakes.
    // No debugging listener or second application server is published.
    const driver = `
const {spawn}=require('child_process');
const chrome=spawn('chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--user-data-dir=${profile}','--no-first-run','--remote-debugging-pipe'],{stdio:['ignore','ignore','ignore','pipe','pipe']});
let id=0, buffer='', pending=new Map();
chrome.stdio[4].on('data',data=>{buffer+=data;let at;while((at=buffer.indexOf('\\0'))>=0){const text=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!text)continue;const msg=JSON.parse(text);if(pending.has(msg.id)){pending.get(msg.id)(msg);pending.delete(msg.id)}}});
const call=(method,params={},sessionId)=>new Promise(resolve=>{const key=++id;pending.set(key,resolve);chrome.stdio[3].write(JSON.stringify({id:key,method,params,...(sessionId?{sessionId}:{})})+'\\0')});
(async()=>{
const target=await call('Target.createTarget',{url:'http://${gateway}:${port}/'});
const attach=await call('Target.attachToTarget',{targetId:target.result.targetId,flatten:true});
const session=attach.result.sessionId;
const deadline=Date.now()+25000;let result;
do{await new Promise(r=>setTimeout(r,250));result=await call('Runtime.evaluate',{expression:'document.getElementById("result")?.textContent',returnByValue:true},session);if(result.result?.result?.value==='CONNECTED')break}while(Date.now()<deadline);
const diagnostics=await call('Runtime.evaluate',{expression:'JSON.stringify({state:document.getElementById("result")?.textContent,frame:document.getElementById("viewer")?.contentDocument?.body?.innerText?.slice(0,500)})',returnByValue:true},session);
console.log(diagnostics.result?.result?.value);
chrome.kill();process.exit(result.result?.result?.value==='CONNECTED'?0:1);
})().catch(e=>{console.error(e);chrome.kill();process.exit(1)});
setTimeout(()=>{chrome.kill();process.exit(2)},35000);
`
    const { stdout } = await exec('docker', ['exec', desktop, 'node', '-e', driver], { timeout: 45000, maxBuffer: 4 * 1024 * 1024 })
    assert.ok(stdout.includes('"state":"CONNECTED"'), `noVNC did not connect (upgrades=${wsCount})`)
    assert.ok(wsCount > 0, 'no WebSocket upgrade passed through the registered mount')
    console.log('PASS real Chromium: mounted noVNC connected to the existing desktop through plugin HTTP + exact WebSocket routes')
  } finally {
    disposers.reverse().forEach((dispose) => dispose())
    server.closeAllConnections(); server.close()
    // Fixed absolute prefix + random leaf, never derived from user/catalog data.
    assert.match(profile, /^\/tmp\/dsh-embed-smoke-[a-f0-9]{16}$/)
    await exec('docker', ['exec', desktop, 'rm', '-rf', '--', profile])
  }
}
