/** Scratch Chromium acceptance through the real port transport; no live GUI mutation. */
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import { AppManager } from '../lib/app-manager.js'
import { AppPorts } from '../lib/app-ports.js'
import { gatewayConfig, describeApps } from '../lib/app-launch.js'
import { PortListeners } from '../lib/port-listen.js'
const exec = promisify(execFile)
if (process.env.RUN_PORTS_BROWSER !== '1') {
  console.log('SKIP ports browser acceptance (RUN_PORTS_BROWSER=1; requires running dsh-app-desktop)')
} else {
  const gateway = os.networkInterfaces().docker0?.find(n => n.family === 'IPv4')?.address
  assert.ok(gateway)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ports-browser-'))
  const sockets = new Set(), seen = []
  const upstream = http.createServer((req, res) => {
    seen.push(req.url)
    if (req.url === '/asset.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end("document.body.dataset.asset='loaded'")
    if (req.url === '/api') return res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'ports-demo=ok; Path=/' }).end('{"ok":true}')
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><body><script src="/asset.js"></script><script>fetch('/api').then(r=>r.json()).then(r=>{document.body.dataset.api=String(r.ok);document.body.dataset.cookie=String(document.cookie.includes('ports-demo=ok'));parent.postMessage({portApp:location.port,asset:document.body.dataset.asset,api:document.body.dataset.api,cookie:document.body.dataset.cookie},'*')})</script></body>`)
  })
  upstream.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const control = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><p id="result">WAITING</p><script>const results=[];addEventListener('message',e=>{if(e.data.portApp){results.push(e.data);if(results.length===2)document.getElementById('result').textContent=JSON.stringify(results)}})</script>${apps.map(app => `<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups allow-popups-to-escape-sandbox" src="${app.launch.origin}/"></iframe>`).join('')}`))
  let pool, apps
  try {
    await new Promise(resolve => control.listen(0, gateway, resolve))
    const origin = `http://${gateway}:${control.address().port}`
    // Use a private scratch range, never the installed gateway's live app range.
    const config = gatewayConfig({ controlOrigin: origin, appListenHost: gateway, appPortStart: 29170, appPortEnd: 29179 }, {})
    const allocator = new AppPorts(new AppManager({ root }))
    apps = describeApps(await allocator.assign(['one', 'two'].map(id => ({ id, containerId: id.repeat(30), web: { containerPort: upstream.address().port, path: `/apps/web/${id}/` } })), config), config)
    pool = new PortListeners({ config, endpointFor: async () => ({ hostAddress: '127.0.0.1', port: upstream.address().port }) })
    const active = await pool.reconcile(apps); assert.ok(active.every(app => app.launch.mode === 'ports'))
    const driver = `const {spawn}=require('child_process');const c=spawn('chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--remote-debugging-pipe'],{stdio:['ignore','ignore','ignore','pipe','pipe']});let id=0,buf='',p=new Map();c.stdio[4].on('data',d=>{buf+=d;let n;while((n=buf.indexOf('\\0'))>=0){const text=buf.slice(0,n);buf=buf.slice(n+1);if(!text)continue;const m=JSON.parse(text);if(p.has(m.id)){p.get(m.id)(m);p.delete(m.id)}}});const call=(method,params={},sessionId)=>new Promise(r=>{const i=++id;p.set(i,r);c.stdio[3].write(JSON.stringify({id:i,method,params,...(sessionId?{sessionId}:{})})+'\\0')});(async()=>{const t=await call('Target.createTarget',{url:${JSON.stringify(origin)}});const a=await call('Target.attachToTarget',{targetId:t.result.targetId,flatten:true});const end=Date.now()+20000;let value;do{await new Promise(r=>setTimeout(r,200));const v=await call('Runtime.evaluate',{expression:'document.getElementById("result")?.textContent',returnByValue:true},a.result.sessionId);value=v.result?.result?.value;if(value?.startsWith('['))break}while(Date.now()<end);console.log(value);c.kill();process.exit(value?.startsWith('[')?0:1)})().catch(e=>{console.error(e);c.kill();process.exit(1)});setTimeout(()=>{c.kill();process.exit(2)},25000);`
    const { stdout } = await exec('docker', ['exec', 'dsh-app-desktop', 'node', '-e', driver], { timeout: 30000 })
    const results = JSON.parse(stdout.trim())
    assert.equal(results.length, 2)
    for (const result of results) assert.deepEqual({ asset: result.asset, api: result.api, cookie: result.cookie }, { asset: 'loaded', api: 'true', cookie: 'true' })
    assert.deepEqual(results.map(r => Number(r.portApp)).sort(), apps.map(a => a.launch.port).sort())
    assert.ok(seen.includes('/asset.js') && seen.includes('/api'))
    console.log('PASS Chromium: two app ports embedded under one harness IP, root assets/API and app cookies work', stdout.trim())
  } finally {
    await pool?.close()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => upstream.close(resolve)); control.closeAllConnections(); await new Promise(resolve => control.close(resolve))
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'dsh-ports-browser-'))); await fs.rm(root, { recursive: true, force: true })
  }
}
