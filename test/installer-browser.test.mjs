/** Optional real Add app browser/daemon test; isolated scratch front, no GUI deployment.
 * RUN_INSTALLER_SMOKE=1 node test/installer-browser.test.mjs
 */
import http from 'node:http'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { networkInterfaces } from 'node:os'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { apply } from '../lib/index.js'
import { AppManager } from '../lib/app-manager.js'
const exec=promisify(execFile)
if(process.env.RUN_INSTALLER_SMOKE!=='1')console.log('SKIP installer browser smoke (RUN_INSTALLER_SMOKE=1)')
else {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-installer-smoke-'))
  const root=path.join(home,'private-apps')
  const before=process.env.COMPUTER_APPS_STATE
  process.env.COMPUTER_APPS_STATE=root
  const id='smoke-'+randomBytes(6).toString('hex')
  const profile='/tmp/dsh-install-browser-'+randomBytes(8).toString('hex')
  const frontend='/opt/dsh/node_modules/.pnpm/@deepseek-ai+dsh-web-frontend@0.2.0-rc.2/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets'
  const index=(await fs.readdir(frontend)).find(name=>/^index-.*\.js$/.test(name))
  const shell=await fs.readFile(path.join(frontend,index),'utf8')
  assert.ok(shell.includes('function rM()')&&shell.includes('const fo=globalThis.dshDesktopBoot'))
  // Scratch-only export of the installed platform modules. No DSH file is edited.
  const platform=shell.slice(0,shell.indexOf('const fo=globalThis.dshDesktopBoot'))+'\nwindow.testModules=rM();'
  const client=await fs.readFile(new URL('../lib/client.js',import.meta.url),'utf8')
  const routes=new Map(),upgrades=new Map(),disposers=[]
  const ctx={logger:{info(){}},connection:{requestRejection:()=>undefined},effect(fn){const d=fn();if(d)disposers.push(d)},webServer:{register(r){routes.set(r.path,r);return()=>routes.delete(r.path)},registerUpgrade(r){upgrades.set(r.path,r);return()=>upgrades.delete(r.path)}}}
  const mock=`
window.testContext={slots:{inject(_name,fn){fn()},register(info,component){if(info.name==='main')window.testPanel=component;return()=>{}}},
workspaces:{list:{getSnapshot:()=>({items:[{workspaceId:'scratch',title:'Scratch test'}]}),subscribe:()=>()=>{}}},
sessions:{create:async()=>{window.testSessionCreated=true;return 'new'},using:async(_id,_why,fn)=>fn({binding:{ctx:{}}}),retainInfo:()=>({getSnapshot:()=>({retainedBy:{mainView:1}})})},
conversation:{input:{for:()=>({setDraft:text=>window.testDraft=text,focus(){}})}},uiWorkspace:{openSession:()=>window.testOpened=true}};
window.__ModuleLoader__={load({factory}){window.testPlugin=factory(name=>window.testModules[name]);window.testPlugin.apply(window.testContext)}};
`
  const server=http.createServer(async(req,res)=>{
    try {
      if(req.url==='/'){res.writeHead(200,{'content-type':'text/html'}).end(`<div id="root"></div><script type="module" src="/platform.js"></script><script type="module">while(!window.testModules)await new Promise(r=>setTimeout(r,10));${mock}await import('/client.js');window.testModules['react-dom/client'].createRoot(document.getElementById('root')).render(window.testModules.react.createElement(window.testPanel));</script>`);return}
      if(req.url==='/platform.js'){res.writeHead(200,{'content-type':'application/javascript'}).end(platform);return}
      if(req.url==='/client.js'){res.writeHead(200,{'content-type':'application/javascript'}).end(client);return}
      if(/^\/(vendor-|langs\/)/.test(req.url)){
        const filename=path.resolve(frontend,'.'+req.url.split('?')[0]);assert.ok(filename.startsWith(frontend+'/'))
        res.writeHead(200,{'content-type':'application/javascript'}).end(await fs.readFile(filename));return
      }
      const route=routes.get(req.url.startsWith('/apps/api')?'/apps/api':'/apps/web');if(!route){res.writeHead(404).end();return}
      await route.handler(req,res)
    }catch(error){res.destroy(error)}
  })
  server.on('upgrade',(req,socket,head)=>{const r=upgrades.get(new URL(req.url,'http://x').pathname);if(r)Promise.resolve(r.handler(req,socket,head)).catch(()=>socket.destroy());else socket.destroy()})
  const gateway=Object.values(networkInterfaces()).flat().find(n=>n.family==='IPv4'&&n.address.startsWith('10.201.')&&!n.internal)?.address
  assert.ok(gateway,'Docker bridge unavailable')
  apply(ctx,{computerBin:new URL('../bin/computer',import.meta.url).pathname})
  const port=await new Promise(resolve=>server.listen(0,gateway,()=>resolve(server.address().port)))
  const driver=`
const {spawn}=require('child_process');const fs=require('fs');
const chrome=spawn('chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--user-data-dir=${profile}','--remote-debugging-pipe'],{stdio:['ignore','ignore','ignore','pipe','pipe']});
let serial=0,buffer='',pending=new Map(),session;
chrome.stdio[4].on('data',b=>{buffer+=b;let at;while((at=buffer.indexOf('\\0'))>=0){const text=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!text)continue;const msg=JSON.parse(text);if(pending.has(msg.id)){pending.get(msg.id)(msg);pending.delete(msg.id)}}});
const call=(method,params={},sid)=>new Promise(r=>{const id=++serial;pending.set(id,r);chrome.stdio[3].write(JSON.stringify({id,method,params,...(sid?{sessionId:sid}:{})})+'\\0')});
const evaluate=async(expression)=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);if(r.result?.exceptionDetails)throw Error(r.result.exceptionDetails.exception?.description?.split('\\n')[0]||'evaluation failure');return r.result?.result?.value};
const until=async(expression)=>{const deadline=Date.now()+25000;while(Date.now()<deadline){try{if(await evaluate(expression))return}catch{}await new Promise(r=>setTimeout(r,100))}console.error(await evaluate('JSON.stringify({errors:Array.from(document.querySelectorAll(".dsha-msg")).map(e=>e.textContent),sections:Array.from(document.querySelectorAll("section")).map(e=>[e.getAttribute("aria-label"),e.textContent.slice(0,120)]),inputs:Array.from(document.querySelectorAll("input")).map(e=>e.value)})'));throw Error('Condition timeout: '+expression)};
const click=async(text)=>evaluate('(()=>{const b=Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(text)+');if(!b)throw Error("button missing");b.click()})()');
(async()=>{
const target=await call('Target.createTarget',{url:'http://${gateway}:${port}/'});const attach=await call('Target.attachToTarget',{targetId:target.result.targetId,flatten:true});session=attach.result.sessionId;
await until('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="Review listing")');
await evaluate('(()=>{const d=Array.from(document.querySelectorAll(".dsha-desc")).find(d=>d.textContent.startsWith("${id}-existing"));d.querySelector("button").click()})()');
await click('Review connection');await until('document.body.textContent.includes("Registration only:")');
await evaluate('Array.from(document.querySelectorAll("label")).find(l=>l.textContent.includes("I trust this app")).querySelector("input").click()');await click('Add to My apps');
await until('!!Array.from(document.querySelectorAll(".dsha-card")).find(c=>c.querySelector(".dsha-name")?.textContent==="${id}-old")');
await evaluate('(()=>{const c=Array.from(document.querySelectorAll(".dsha-card")).find(c=>c.querySelector(".dsha-name")?.textContent==="${id}-old");Array.from(c.querySelectorAll("button")).find(b=>b.textContent==="Launch").click()})()');
await until('Array.from(document.querySelectorAll(".dsha-card")).find(c=>c.querySelector(".dsha-name")?.textContent==="${id}-old")?.textContent.includes("Open")');
await evaluate('(()=>{const c=Array.from(document.querySelectorAll(".dsha-card")).find(c=>c.querySelector(".dsha-name")?.textContent==="${id}-old");Array.from(c.querySelectorAll("button")).find(b=>b.textContent==="Open").click()})()');
await until('document.querySelector("iframe")?.contentDocument?.body?.textContent.includes("Welcome to nginx!")');await click('← All apps');
console.log('PASS discovered existing container: review/trust, register without recreation, Launch and embedded nginx');
await click('+ Add app');await click('Advanced container install');
await evaluate('(()=>{const values={"App id":"${id}","Display name":"Installer smoke","Image with explicit tag or digest":"nginx:alpine"};for(const [label,value]of Object.entries(values)){const el=Array.from(document.querySelectorAll("label")).find(l=>l.textContent.startsWith(label)).querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,value);el.dispatchEvent(new Event("input",{bubbles:true}))}})()');
await click('Prepare review');await until('!!document.querySelector("section[aria-label]")');
await evaluate('document.querySelector("section[aria-label] input[type=checkbox]").click()');await click('Approve & install');
await until('document.body.textContent.includes("Installer smoke: ready")');await click('← My apps');
await until('Array.from(document.querySelectorAll(".dsha-card")).some(c=>c.textContent.includes("Installer smoke"))');
await evaluate('(()=>{const c=Array.from(document.querySelectorAll(".dsha-card")).find(c=>c.textContent.includes("Installer smoke"));Array.from(c.querySelectorAll("button")).find(b=>b.textContent==="Open").click()})()');
await until('document.querySelector("iframe")?.contentDocument?.body?.textContent.includes("Welcome to nginx!")');await click('← All apps');
await click('+ Add app');await evaluate('(()=>{const l=Array.from(document.querySelectorAll("label")).find(l=>l.textContent.startsWith("App name, container image"));const el=l.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"Example app");el.dispatchEvent(new Event("input",{bubbles:true}))})()');await click('Open setup conversation');await until('window.testSessionCreated && window.testOpened && window.testDraft.includes("Do not approve or execute")');
console.log('PASS real Chromium/React: advanced plan, trust review, install progress, embedded nginx, All apps navigation and setup draft handoff');
await Promise.race([call('Browser.close'),new Promise(r=>setTimeout(r,1500))]);if(chrome.exitCode===null)chrome.kill();process.exit(0);
})().catch(e=>{console.error(e.message);chrome.kill();process.exit(1)});setTimeout(()=>{chrome.kill();process.exit(2)},90000);
`
  try {
    await exec('docker',['image','inspect','nginx:alpine'])
    await exec('docker',['create','--name',`${id}-existing`,'--label',`dsh.apps.id=${id}-old`,'nginx:alpine'])
    const result=await exec('docker',['exec','dsh-app-desktop','node','-e',driver],{timeout:110000,maxBuffer:2*1024*1024})
    console.log(result.stdout)
  }finally {
    const owned=JSON.parse((await exec('docker',['inspect',`${id}-existing`])).stdout)[0]
    assert.equal(owned.Config.Labels['dsh.apps.id'],`${id}-old`)
    await exec('docker',['rm','-f',owned.Id])
    const manager=new AppManager({root})
    if((await manager.registry()).apps[id])await manager.action('uninstall',id)
    disposers.reverse().forEach(d=>d());server.closeAllConnections();server.close()
    assert.match(profile,/^\/tmp\/dsh-install-browser-[a-f0-9]{16}$/)
    await exec('docker',['exec','dsh-app-desktop','rm','-rf','--',profile])
    assert.ok(home.startsWith(path.join(os.tmpdir(),'dsh-installer-smoke-')));await fs.rm(home,{recursive:true,force:true})
    if(before===undefined)delete process.env.COMPUTER_APPS_STATE;else process.env.COMPUTER_APPS_STATE=before
  }
}
