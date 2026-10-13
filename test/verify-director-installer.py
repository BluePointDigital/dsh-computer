"""Installed Director v0.2.x canary: real recipe lifecycle + actual session draft.
Uses the existing internal front door, no Basic credential and no prompt send.
Leaves one explicitly unsent setup draft; owned HTTP Echo test app is uninstalled.
"""
import sys
import base64
sys.path.insert(0, '/workspace/Olympus Server/tools')
import dkexec
from pathlib import Path
# Reuse the prior installed-browser driver's CDP, timeout and private profile cleanup.
namespace = {'__name__': 'reused_driver'}
source = Path(__file__).with_name('verify-director-rollout.py').read_text()
exec(source[:source.index("public = '--public'")], namespace)
driver = namespace['DRIVER']
start = driver.index('(async()=>{')
finish = driver.index('await cleanup();process.exit(0);', start)
body = r'''(async()=>{
const target=await call('Target.createTarget',{url:'about:blank'});
const attach=await call('Target.attachToTarget',{targetId:target.result.targetId,flatten:true});session=attach.result.sessionId;
await call('Network.enable',{},session);
await call('Page.navigate',{url:base},session);
const click=async text=>{console.log('CHECK '+text);await until(`Array.from(document.querySelectorAll('button')).some(b=>!b.disabled&&(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)}||b.getAttribute('title')===${JSON.stringify(text)}))`);return evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)}||b.getAttribute('title')===${JSON.stringify(text)});if(!b)throw Error('Button not found');b.click()})()`)};
await until(`Array.from(document.querySelectorAll('button')).some(b=>b.getAttribute('aria-label')==='Applications'||b.textContent.trim()==='Applications')`);
await click('Applications');await until(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='+ Add app')`);
const before=await evaluate(`fetch('/apps/api/list').then(r=>r.json()).then(d=>({managed:d.apps.filter(a=>a.managed).map(a=>a.id)}))`);
if(before.managed.includes('web-echo'))throw Error('Refusing test: recipe id already installed');
const reviews=await evaluate(`fetch('/apps/api/jobs').then(r=>r.json()).then(d=>d.jobs.filter(j=>j.plan.id==='web-echo'&&j.state==='review'&&j.createdAt>='2026-10-13T02:20:00.000Z').map(j=>j.id))`);
for(const id of reviews)await evaluate(`fetch('/apps/api/cancel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:${JSON.stringify(id)}})}).then(r=>r.json()).then(d=>{if(!d.ok)throw Error('Cannot cancel previous canary review');return true})`);
await click('+ Add app');await until(`document.body.textContent.includes('HTTP Echo')&&document.body.textContent.includes('Linux Desktop')`);
await evaluate(`(()=>{const c=Array.from(document.querySelectorAll('.dsha-card')).find(c=>(c.querySelector('.dsha-name')||c.querySelector('strong'))?.textContent==='HTTP Echo');Array.from(c.querySelectorAll('button')).find(b=>b.textContent==='Review install').click()})()`);
await until(`!!document.querySelector('section[aria-label="Review installation"]')`);
await until(`Array.from(document.querySelectorAll('button')).filter(b=>b.textContent==='Review install').every(b=>!b.disabled)`);
await evaluate(`new Promise(r=>setTimeout(r,1200))`);
await click('Add / replace environment values');
await evaluate(`(()=>{const l=Array.from(document.querySelectorAll('label')).find(l=>l.textContent.startsWith('Complete environment values'));const e=l.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'CANARY_CHECK=ephemeral');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
await evaluate(`window.canaryApiErrors=[];const prior=window.fetch;window.fetch=async(...args)=>{const r=await prior(...args);if(String(args[0]).includes('/apps/api/credentials')){const d=await r.clone().json();if(!d.ok)window.canaryApiErrors.push(d.error||'save failed')}return r}`);
await click('Save privately & re-review');
await evaluate(`new Promise(r=>setTimeout(r,1500))`);console.log(await evaluate(`JSON.stringify({apiErrors:window.canaryApiErrors,reviewErrors:Array.from(document.querySelectorAll('section[aria-label] .dsha-msg')).map(e=>e.textContent)})`));
await until(`Array.from(document.querySelectorAll('.dsha-desc')).some(e=>e.textContent.includes('Environment keys: CANARY_CHECK'))`);
await until(`!Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Save privately & re-review')`);
await evaluate(`document.querySelector('section[aria-label="Review installation"] input[type=checkbox]').click()`);
await click('Approve & install');
await until(`document.body.textContent.includes('HTTP Echo: ready')`);
await click('← My apps');await until(`Array.from(document.querySelectorAll('.dsha-card')).some(c=>(c.querySelector('.dsha-name')||c.querySelector('strong'))?.textContent==='HTTP Echo')`);
const action=async text=>evaluate(`(()=>{const c=Array.from(document.querySelectorAll('.dsha-card')).find(c=>(c.querySelector('.dsha-name')||c.querySelector('strong'))?.textContent==='HTTP Echo');const b=Array.from(c.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)});if(!b)throw Error('App action missing');b.click()})()`);
await action('Open');await until(`document.querySelector('iframe')?.contentDocument?.body?.textContent.includes('Hostname:')`);
const embedded=await evaluate(`new URL(document.querySelector('iframe').src).origin===location.origin&&new URL(document.querySelector('iframe').src).pathname==='/apps/web/web-echo/'`);if(!embedded)throw Error('App not same-origin embedded');
await click('← All apps');await action('Logs');await until(`!!document.querySelector('.dsha-msg.dsha-ok')`);
await action('Stop');await until(`Array.from(document.querySelectorAll('.dsha-card')).find(c=>(c.querySelector('.dsha-name')||c.querySelector('strong'))?.textContent==='HTTP Echo')?.textContent.includes('stopped')`);
await action('Launch');await until(`Array.from(document.querySelectorAll('.dsha-card')).find(c=>(c.querySelector('.dsha-name')||c.querySelector('strong'))?.textContent==='HTTP Echo')?.textContent.includes('running')`);
await evaluate(`window.confirm=()=>true`);await action('Uninstall');await until(`!Array.from(document.querySelectorAll('.dsha-card')).some(c=>(c.querySelector('.dsha-name')||c.querySelector('strong'))?.textContent==='HTTP Echo')`);
console.log('PASS installed Add app: recipe pull, credential re-review, trust/approval, progress, same-origin whoami, back, Logs, Stop/Launch, Uninstall');
await click('+ Add app');
await evaluate(`(()=>{const e=Array.from(document.querySelectorAll('label')).find(l=>l.textContent.startsWith('App name, container image')).querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Canary verification only — leave this setup request unsent');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
const workspace=await evaluate(`(()=>{const e=Array.from(document.querySelectorAll('label')).find(l=>l.textContent.startsWith('Setup workspace')).querySelector('select');return{value:e.value,title:e.selectedOptions[0]?.textContent}})()`);if(!workspace.value)throw Error('No real workspace selected');
await click('Open setup conversation');
await until(`Array.from(document.querySelectorAll('[contenteditable="true"]')).some(e=>e.textContent.includes('Help me install an application inside this DSH instance.')&&e.textContent.includes('Do not approve or execute'))`);
const draft=await evaluate(`(()=>{const e=Array.from(document.querySelectorAll('[contenteditable="true"]')).find(e=>e.textContent.includes('Canary verification only'));return{present:!!e,visible:!!e?.getBoundingClientRect().height,canary:e?.textContent.includes('leave this setup request unsent'),path:location.pathname}})()`);if(!draft.present||!draft.visible||!draft.canary)throw Error('Fresh actual session draft did not render');
console.log('PASS real installed session-controller/conversation handoff: selected workspace, visible unsent setup draft; no Send action performed');
'''
driver = driver[:start] + body + driver[finish:]
driver = driver.replace('25000', '90000').replace('65000', '210000')
remote = 'set -e; docker exec dsh-app-desktop node -e "$(printf %s ' + base64.b64encode(driver.encode()).decode() + ' | base64 -d)"'
out = dkexec.exec_in('dsh-director', ['sh', '-lc', remote], user='node', timeout_s=240)
print(out)
if any(marker in out for marker in ['[exit=', '[still running]', 'failed', 'timed out', 'not found', 'missing']):
    sys.exit(1)
