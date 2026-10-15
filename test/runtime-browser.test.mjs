/** Real Chromium exercises the real runtime UI; backend fixture isolates owner actions. */
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { WebSocketServer } from 'ws'
const exec = promisify(execFile), require = createRequire(import.meta.url)
if (process.env.RUN_RUNTIME_BROWSER !== '1') console.log('SKIP runtime browser acceptance (RUN_RUNTIME_BROWSER=1)')
else {
  const gateway = os.networkInterfaces().docker0?.find(n => n.family === 'IPv4')?.address
  assert.ok(gateway)
  const CID = 'a'.repeat(64), calls = [], sockets = new Set(), streams = new Set(), terminals = new Set()
  let submitted = false, privateLoads = 0
  const app = () => ({ id: 'demo', name: 'Existing Demo', state: 'running', source: 'container', containerId: CID, services: [{ containerId: CID, name: 'existing-demo', service: 'web', image: 'nginx:alpine', state: 'running', health: 'none', ports: [80] }] })
  const assetFiles = new Map([['/apps/assets/xterm.js', require.resolve('@xterm/xterm')], ['/apps/assets/fit.js', require.resolve('@xterm/addon-fit')], ['/apps/assets/xterm.css', require.resolve('@xterm/xterm/css/xterm.css')]])
  const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{createRuntimeUI}from'./lib/runtime-ui.js';const h=React.createElement;async function api(method,body){const r=await fetch('/apps/api/'+method,{credentials:'same-origin',...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const result=await r.json();if(!r.ok||!result.ok)throw Error(result.error||'failed');return result}const App=createRuntimeUI({React,h,api,resolveView:async app=>({app,src:null}),Viewer:()=>h('p',null,'Viewer')});createRoot(document.getElementById('root')).render(h(App));`
  const bundled = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, format: 'iife', platform: 'browser' })
  const source = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const css = [...source.matchAll(/^      '(.*)',?$/gm)].map(match => { try { return Function(`return '${match[1]}'`)() } catch { return '' } }).join('')
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://test')
    if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><style>body{margin:0;font:14px system-ui;background:#f6f7fa;color:#202532}button,input,textarea,select{font:inherit}#root{height:100vh}${css}</style></head><body><div id="root"></div><script src="/test.js"></script></body></html>`)
    if (url.pathname === '/test.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(bundled.outputFiles[0].contents)
    if (assetFiles.has(url.pathname)) return res.writeHead(200, { 'content-type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }).end(await fs.readFile(assetFiles.get(url.pathname)))
    if (url.pathname.endsWith('/logs')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.write('data: {"text":"runtime browser log line\\n"}\n\n'); streams.add(res); res.once('close', () => streams.delete(res)); return
    }
    let body = ''; for await (const chunk of req) body += chunk
    const input = body ? JSON.parse(body) : undefined
    calls.push({ pathname: url.pathname, input })
    let result = { ok: true }
    if (url.pathname.endsWith('/inventory')) result = { ok: true, apps: [app()], deployments: submitted ? [{ id: 'job-one', appId: 'fresh-app', name: 'Fresh App', state: 'ready', revision: 1, events: [{ message: 'Deployment ready' }] }] : [] }
    else if (url.pathname.endsWith('/details')) result = { ok: true, app: app(), stats: [{ Name: 'existing-demo', CPUPerc: '2%', MemUsage: '10MiB / 512MiB' }] }
    else if (url.pathname.endsWith('/recipes')) result = { ok: true, recipes: [{ id: 'example', name: 'Example', image: 'nginx:1.28-alpine', webPort: 80, volumes: [], notes: 'Example app' }] }
    else if (url.pathname.endsWith('/definition')) { privateLoads++; result = { ok: false, error: 'No saved definition' } }
    else if (url.pathname.endsWith('/deploy')) { submitted = true; result = { ok: true, job: { id: 'job-one', appId: input.id, state: 'queued' } } }
    res.writeHead(result.ok ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(result))
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
    terminals.add(ws); ws.once('close', () => terminals.delete(ws))
    ws.send(JSON.stringify({ type: 'ready' })); ws.send(JSON.stringify({ type: 'output', data: 'real xterm connected\r\n$ ' }))
    ws.on('message', data => { const message = JSON.parse(data); calls.push({ terminal: message }); if (message.type === 'input') ws.send(JSON.stringify({ type: 'output', data: 'typed:' + message.data })) })
  }))
  await new Promise(resolve => server.listen(0, gateway, resolve))
  const origin = `http://${gateway}:${server.address().port}`
  try {
    const driver = `const{spawn}=require('child_process');const c=spawn('chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--remote-debugging-pipe'],{stdio:['ignore','ignore','ignore','pipe','pipe']});let id=0,b='',p=new Map();c.stdio[4].on('data',d=>{b+=d;let n;while((n=b.indexOf('\\0'))>=0){const s=b.slice(0,n);b=b.slice(n+1);if(!s)continue;const m=JSON.parse(s);if(p.has(m.id)){p.get(m.id)(m);p.delete(m.id)}}});const call=(method,params={},sessionId)=>new Promise(r=>{const i=++id;p.set(i,r);c.stdio[3].write(JSON.stringify({id:i,method,params,...(sessionId?{sessionId}:{})})+'\\0')});let session;const evalx=async expression=>{const m=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},session);if(m.result?.exceptionDetails)throw Error(JSON.stringify(m.result.exceptionDetails));return m.result?.result?.value};const wait=async expression=>{const end=Date.now()+12000;do{if(await evalx(expression))return;await new Promise(r=>setTimeout(r,100))}while(Date.now()<end);throw Error('timeout '+expression)};const click=label=>evalx('(()=>{const e=[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==='+JSON.stringify(label)+');if(!e)throw Error("missing button");e.click()})()');const fill=(label,value)=>evalx('(()=>{const l=[...document.querySelectorAll("label")].find(e=>e.querySelector("span")?.textContent==='+JSON.stringify(label)+');const e=l?.querySelector("input,textarea");if(!e)throw Error("missing field "+'+JSON.stringify(label)+');Object.getOwnPropertyDescriptor(e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value").set.call(e,'+JSON.stringify(value)+');e.dispatchEvent(new Event("input",{bubbles:true}))})()');(async()=>{const t=await call('Target.createTarget',{url:${JSON.stringify(origin)}});session=(await call('Target.attachToTarget',{targetId:t.result.targetId,flatten:true})).result.sessionId;await wait('document.body?.innerText.includes("Existing Demo")');await evalx('Array.from(document.querySelectorAll("button")).find(e=>e.getAttribute("aria-label")==="Details for Existing Demo").click()');await wait('document.body?.innerText.includes("Services and live resource usage")');console.log('SCREENSHOT:'+(await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},session)).result.data);await click('Logs');await wait('document.body?.innerText.includes("runtime browser log line")');await click('Terminal');await wait('Boolean(document.querySelector(".xterm-screen"))&&document.body?.innerText.includes("Connected")');await evalx('document.querySelector(".xterm-helper-textarea").focus()');await call('Input.insertText',{text:'hello-browser'},session);await click('Configuration');await wait('document.body?.innerText.includes("No saved deployment definition")');await click('← Applications');await click('Deploy application');await wait('Boolean(document.querySelector("select"))');await evalx('(()=>{const e=document.querySelector("select");e.value="image";e.dispatchEvent(new Event("change",{bubbles:true}))})()');await fill('Application ID','fresh-app');await fill('Display name','Fresh App');await fill('Container image (tag or digest)','nginx:1.28-alpine');await fill('Web container port (optional)','80');await evalx('document.querySelector("form").requestSubmit()');await wait('document.body?.innerText.includes("Deployment ready")||document.body?.innerText.includes("queued")');console.log(JSON.stringify({state:'PASS',text:(await evalx('document.body.innerText')).slice(0,700)}));c.kill();process.exit(0)})().catch(e=>{console.error(e.stack);c.kill();process.exit(1)});setTimeout(()=>{c.kill();process.exit(2)},55000);`
    const { stdout } = await exec('docker', ['exec', 'dsh-app-desktop', 'node', '-e', driver], { timeout: 65000, maxBuffer: 4 * 1024 * 1024 })
    assert.ok(stdout.includes('"state":"PASS"'), stdout.slice(-4000))
    const screenshot = stdout.split('\n').find(line => line.startsWith('SCREENSHOT:'))?.slice('SCREENSHOT:'.length)
    if (screenshot) {
      const screenshotPath = '/tmp/dsh-applications-manager.png'
      await fs.writeFile(screenshotPath, Buffer.from(screenshot, 'base64'))
      console.log('Screenshot saved:', screenshotPath)
    }
    assert.equal(privateLoads, 0)
    const deploy = calls.find(call => call.pathname?.endsWith('/deploy'))
    assert.ok(deploy); assert.equal(deploy.input.id, 'fresh-app'); assert.equal(deploy.input.image, 'nginx:1.28-alpine')
    assert.ok(calls.some(call => call.terminal?.type === 'input' && call.terminal.data.includes('hello-browser')))
    console.log('PASS Chromium runtime UI: discovery, details, streamed logs, xterm input, no adoption/private-config fetch, one-click image deployment', stdout.split('\n').filter(line => !line.startsWith('SCREENSHOT:')).join('\n').trim())
  } finally {
    for (const stream of streams) stream.end()
    for (const ws of terminals) ws.terminate()
    wss.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve))
  }
}
