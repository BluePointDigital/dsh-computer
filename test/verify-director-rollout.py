"""Canary installed-GUI verification over its existing internal front door.
Public HTTPS/off-tailnet verification remains separate and needs Basic Auth.
Secrets and DOM/passwords are never printed. Does not change application code.
"""
import base64
import sys
sys.path.insert(0, '/workspace/Olympus Server/tools')
import dkexec

DRIVER = r'''
const {spawn}=require('child_process');
const fs=require('fs');
const crypto=require('crypto');
const profile='/tmp/dsh-director-verify-'+crypto.randomBytes(8).toString('hex');
const chrome=spawn('chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--user-data-dir='+profile,'--no-first-run','--remote-debugging-pipe','--host-resolver-rules=MAP director.bluepointdigital.com 10.201.0.1'],{stdio:['ignore','ignore','ignore','pipe','pipe']});
let id=0, buffer='', pending=new Map();
chrome.stdio[4].on('data',data=>{buffer+=data;let at;while((at=buffer.indexOf('\0'))>=0){const text=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!text)continue;const msg=JSON.parse(text);if(msg.method==='Network.loadingFailed')console.error(JSON.stringify({networkError:msg.params.errorText,blockedReason:msg.params.blockedReason}));if(pending.has(msg.id)){pending.get(msg.id)(msg);pending.delete(msg.id)}}});
const call=(method,params={},sessionId)=>new Promise(resolve=>{const key=++id;pending.set(key,resolve);chrome.stdio[3].write(JSON.stringify({id:key,method,params,...(sessionId?{sessionId}:{})})+'\0')});
let session;
const evaluate=async(expression)=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);if(r.result?.exceptionDetails)throw Error('browser evaluation failed: '+r.result.exceptionDetails.text+' '+(r.result.exceptionDetails.exception?.description||'').split('\\n')[0]);return r.result?.result?.value};
const until=async(expression)=>{const deadline=Date.now()+25000;while(Date.now()<deadline){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,200))}const diag=await evaluate(`JSON.stringify({title:document.title,buttons:Array.from(document.querySelectorAll('button')).map(b=>({text:b.textContent.slice(0,50),title:b.title,aria:b.getAttribute('aria-label')})),cardCount:document.querySelectorAll('.dsha-card').length,framePath:document.querySelector('iframe')?new URL(document.querySelector('iframe').src).pathname:null,frameClasses:document.querySelector('iframe')?.contentDocument?.documentElement.className,frameStatus:document.querySelector('iframe')?.contentDocument?.querySelector('#noVNC_status')?.textContent,panelError:document.querySelector('.dsha-empty')?.textContent})`);console.error(diag);const frames=await call('Page.getFrameTree',{},session);console.error(JSON.stringify(frames.result, (k,v)=>(k==='url'||k==='unreachableUrl')?v.split('?')[0]:v));throw Error('browser condition timed out')};
async function cleanup(){await call('Browser.close');if(chrome.exitCode===null)await new Promise(r=>chrome.once('exit',r));if(!/^\/tmp\/dsh-director-verify-[a-f0-9]{16}$/.test(profile))throw Error('unsafe cleanup path');await new Promise(r=>setTimeout(r,300));fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
(async()=>{
const target=await call('Target.createTarget',{url:'http://director.bluepointdigital.com:8080/'});
const attach=await call('Target.attachToTarget',{targetId:target.result.targetId,flatten:true});session=attach.result.sessionId;
await call('Network.enable',{},session);
await until(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Applications'||b.getAttribute('aria-label')==='Applications'||b.getAttribute('title')==='Applications')`);
await evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Applications'||b.getAttribute('aria-label')==='Applications'||b.getAttribute('title')==='Applications');b.click()})()`);
await until(`document.querySelectorAll('.dsha-card').length>0`);
await evaluate(`(()=>{const card=Array.from(document.querySelectorAll('.dsha-card')).find(c=>c.textContent.includes('Linux Desktop'));Array.from(card.querySelectorAll('button')).find(b=>b.textContent==='Open').click()})()`);
await until(`document.querySelector('.dsha-frame')?.contentDocument?.documentElement.classList.contains('noVNC_connected')`);
const mounted=await evaluate(`(()=>{const f=document.querySelector('.dsha-frame');return new URL(f.src).pathname==='/apps/web/desktop/vnc.html'&&!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('New tab'))})()`);
if(!mounted)throw Error('desktop not embedded');console.log('PASS installed Applications panel: real noVNC desktop connected through mount');
await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('All apps')).click()`);
await until(`document.querySelectorAll('.dsha-card').length>0`);
await evaluate(`(()=>{const card=Array.from(document.querySelectorAll('.dsha-card')).find(c=>c.textContent.includes('Nginx (static)'));Array.from(card.querySelectorAll('button')).find(b=>b.textContent==='Open').click()})()`);
await until(`document.querySelector('.dsha-frame')?.contentDocument?.body.textContent.includes('Welcome to nginx!')`);
console.log('PASS installed Applications panel: nginx dashboard rendered and back navigation works');
await cleanup();process.exit(0);
})().catch(async e=>{console.error(e.message);await cleanup();process.exit(1)});
setTimeout(()=>{console.error('verification deadline');chrome.kill();process.exit(2)},65000);
'''
# Inner desktop image has Node; its CLI command is passed as argv, not shell text.
REMOTE = 'set -e; docker exec dsh-app-desktop node -e "$(printf %s ' + base64.b64encode(DRIVER.encode()).decode() + ' | base64 -d)"'
out = dkexec.exec_in('dsh-director', ['sh','-lc', REMOTE], user='node')
print(out)
if '[exit=' in out or '[still running]' in out or 'failed' in out or 'timed out' in out:
    sys.exit(1)
