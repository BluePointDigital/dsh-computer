import sys,base64
from pathlib import Path
sys.path.insert(0,'/workspace/Olympus Server/tools');import dkexec
ns={'__name__':'driver'};s=Path(__file__).with_name('verify-director-rollout.py').read_text();exec(s[:s.index("public = '--public'")],ns)
d=ns['DRIVER'];a=d.index('(async()=>{');b=d.index('await cleanup();process.exit(0);',a)
body=r'''(async()=>{
const target=await call('Target.createTarget',{url:base});session=(await call('Target.attachToTarget',{targetId:target.result.targetId,flatten:true})).result.sessionId;
await until(`Array.from(document.querySelectorAll('button')).some(b=>b.getAttribute('aria-label')==='Applications')`);
await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')==='Applications').click()`);
await until(`Array.from(document.querySelectorAll('.dsha-name')).some(n=>n.textContent==='hyperframes')`);
await evaluate(`(()=>{const c=Array.from(document.querySelectorAll('.dsha-card')).find(c=>c.querySelector('.dsha-name')?.textContent==='hyperframes');Array.from(c.querySelectorAll('button')).find(b=>b.textContent==='Open').click()})()`);
await until(`document.querySelector('iframe')?.contentDocument?.body?.innerText.includes('Inspector')`);
console.log('PASS actual Applications iframe renders HyperFrames editor');
await evaluate('new Promise(r=>setTimeout(r,6000))');
console.log(await evaluate(`(()=>{const f=document.querySelector('iframe');return JSON.stringify({text:f.contentDocument.body.innerText.slice(0,1500),resources:f.contentWindow.performance.getEntriesByType('resource').filter(r=>r.name.includes('/api/')).map(r=>({url:r.name,status:r.responseStatus}))})})()`));
'''
d=d[:a]+body+d[b:]
out=dkexec.exec_in('dsh-director',['sh','-lc','docker exec dsh-app-desktop node -e "$(printf %s '+base64.b64encode(d.encode()).decode()+' | base64 -d)"'],user='node',timeout_s=90);print(out)
if '[exit=' in out:sys.exit(1)
