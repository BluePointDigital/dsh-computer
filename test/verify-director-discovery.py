"""Installed Director recovery UI: discover and review, never approve publisher trust."""
import sys, base64
from pathlib import Path
sys.path.insert(0, '/workspace/Olympus Server/tools')
import dkexec
namespace={'__name__':'reused_driver'}
source=Path(__file__).with_name('verify-director-rollout.py').read_text()
exec(source[:source.index("public = '--public'")],namespace)
driver=namespace['DRIVER'];start=driver.index('(async()=>{');finish=driver.index('await cleanup();process.exit(0);',start)
body=r'''(async()=>{
const target=await call('Target.createTarget',{url:base});const attach=await call('Target.attachToTarget',{targetId:target.result.targetId,flatten:true});session=attach.result.sessionId;
const click=async text=>evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)});if(!b)throw Error('Button missing');b.click()})()`);
await until(`Array.from(document.querySelectorAll('button')).some(b=>b.getAttribute('aria-label')==='Applications')`);await click('Applications');
console.log(await evaluate(`Promise.all(['list','discovery'].map(x=>fetch('/apps/api/'+x).then(r=>r.json()))).then(v=>JSON.stringify(v))`));
await until(`document.body.textContent.includes('dsh-app-hyperframes')`);
await evaluate(`(()=>{const d=Array.from(document.querySelectorAll('.dsha-desc')).find(d=>d.textContent.startsWith('dsh-app-hyperframes'));d.querySelector('button').click()})()`);
await click('Review connection');await until(`document.body.textContent.includes('Registration only:')`);
const review=await evaluate(`(()=>{const label=Array.from(document.querySelectorAll('label')).find(l=>l.textContent.includes('I trust this app'));const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Add to My apps');return {unchecked:!label.querySelector('input').checked,disabled:b.disabled,port:document.body.textContent.includes('port 3002')}})()`);
if(!review.unchecked||!review.disabled||!review.port)throw Error('Review/trust gate incorrect');
console.log('PASS installed My apps discovers stopped HyperFrames, port 3002 review, explicit trust gate; no approval or launch performed');
await click('+ Add app');await until(`Array.from(document.querySelectorAll('summary')).some(s=>s.textContent==='Installation history')`);
if(!await evaluate(`Array.from(document.querySelectorAll('summary')).find(s=>s.textContent==='Installation history').parentElement.open===false`))throw Error('History not collapsed');
console.log('PASS installed Add app history collapsed by default');
'''
driver=driver[:start]+body+driver[finish:]
remote='set -e; docker exec dsh-app-desktop node -e "$(printf %s '+base64.b64encode(driver.encode()).decode()+' | base64 -d)"'
out=dkexec.exec_in('dsh-director',['sh','-lc',remote],user='node',timeout_s=120);print(out)
if any(m in out for m in ['[exit=','[still running]','timed out','failed']):sys.exit(1)
