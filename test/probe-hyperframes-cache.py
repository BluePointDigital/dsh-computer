"""Probe live Director app responses: rewrite state and cache headers (read-only)."""
import sys, base64
from pathlib import Path
sys.path.insert(0,'/workspace/Olympus Server/tools');import dkexec
ns={'__name__':'driver'};s=Path(__file__).with_name('verify-director-rollout.py').read_text();exec(s[:s.index("public = '--public'")],ns)
d=ns['DRIVER'];a=d.index('(async()=>{');b=d.index('await cleanup();process.exit(0);',a)
body=r'''(async()=>{
session=(await call('Target.attachToTarget',{targetId:(await call('Target.createTarget',{url:base})).result.targetId,flatten:true})).result.sessionId;
await until(`Array.from(document.querySelectorAll('button')).some(b=>b.getAttribute('aria-label')==='Applications')`);
console.log(await evaluate(`fetch('/apps/web/hyperframes/').then(async r=>{const t=await r.text();const assets=[...t.matchAll(/(?:src|href)="([^"]*\\.(?:js|css))"/g)].map(m=>m[1]);return JSON.stringify({status:r.status,cc:r.headers.get('cache-control'),etag:r.headers.get('etag'),lm:r.headers.get('last-modified'),assets,rewritten:t.includes('/apps/web/hyperframes/')})})`));
console.log(await evaluate(`(async()=>{const h=await (await fetch('/apps/web/hyperframes/')).text();const u=(h.match(/(?:src|href)="([^"]*index-[^"]*\\.js)"/)||[])[1];const r=await fetch(u);const t=await r.text();return JSON.stringify({url:u,status:r.status,cc:r.headers.get('cache-control'),etag:r.headers.get('etag'),lm:r.headers.get('last-modified'),age:r.headers.get('age'),bodyHasMountApi:t.includes('/apps/web/hyperframes/api/'),bodyHasBareApi:/["'\`]\\/api\\//.test(t)})})()`));
'''
d=d[:a]+body+d[b:]
out=dkexec.exec_in('dsh-director',['sh','-lc','docker exec dsh-app-desktop node -e "$(printf %s '+base64.b64encode(d.encode()).decode()+' | base64 -d)"'],user='node',timeout_s=90);print(out)
if '[exit=' in out:sys.exit(1)
