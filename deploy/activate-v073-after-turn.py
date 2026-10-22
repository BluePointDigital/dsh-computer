#!/usr/bin/env python3
"""Host-side turn-boundary activation, exact target, original nested IDs retained."""
import json,pathlib,ssl,time,urllib.request
ROOT=pathlib.Path('/private'); CONFIG=json.loads((ROOT/'config.json').read_text()); CTX=ssl._create_unverified_context()
def call(method,path,body=None):
 req=urllib.request.Request(CONFIG['portainer']+'/api/endpoints/1/docker'+path,method=method,data=json.dumps(body).encode() if body is not None else None,headers={'Authorization':'Bearer '+CONFIG['token'],'Content-Type':'application/json'})
 with urllib.request.urlopen(req,context=CTX,timeout=180)as r:
  raw=r.read()
  try:return json.loads(raw)if raw else None
  except(ValueError,UnicodeDecodeError):return raw
def execute(code):
 e=call('POST','/containers/'+CONFIG['containerId']+'/exec',{'AttachStdout':True,'AttachStderr':True,'User':'1000:1000','Cmd':['node','--input-type=module','-e',code]})
 raw=call('POST','/exec/'+e['Id']+'/start',{'Detach':False,'Tty':False});s=call('GET','/exec/'+e['Id']+'/json');buf=bytearray()
 while isinstance(raw,bytes)and len(raw)>=8:
  n=int.from_bytes(raw[4:8],'big');buf.extend(raw[8:8+n]);raw=raw[8+n:]
 if s.get('ExitCode')!=0:raise RuntimeError('Activation probe failed')
 return json.loads(buf.decode())
def idle():
 files=list(pathlib.Path('/home-volume/storages/session_projcache/sessions').glob('*.json'))
 if not files:raise RuntimeError('Missing turn projection directory')
 for f in files:
  try:b=json.loads(f.read_text())['record']['rows']['turnBoundary']['val']
  except(ValueError,KeyError):raise RuntimeError('Uncertain turn boundary')
  if b.get('openTurnStartSeq')is not None:return False
 return True
SNAP="import{DockerEngine}from'/data/profiles/web/node_modules/dsh-applications/lib/docker-engine.js';const e=new DockerEngine();try{console.log(JSON.stringify((await e.listContainers()).map(x=>({id:x.Id,running:x.State==='running'}))))}finally{e.close()}"
VERIFY="""import http from 'node:http';import fs from 'node:fs';import{DockerEngine}from'/data/profiles/web/node_modules/dsh-applications/lib/docker-engine.js';const before=BASELINE;const e=new DockerEngine();try{for(const old of before){const c=await e.inspectContainer(old.id);if(!c)throw Error('Original container missing');if(old.running&&!c.State.Running)await e.start(old.id)}const get=path=>new Promise((resolve,reject)=>{const r=http.get('http://127.0.0.1:8080'+path,{headers:{host:process.env.DSH_CONTROL_INGRESS_PEERS?'127.0.0.1:8080':new URL(process.env.DSH_PUBLIC_URL).host}},s=>{let b='';s.on('data',x=>b+=x);s.on('end',()=>resolve({status:s.statusCode,body:JSON.parse(b)}))});r.on('error',reject)});const h=await get('/apps/api/access-health');const i=await get('/apps/api/runtime/inventory?refresh=1');if(h.status!==200||h.body.health.mode!=='isolated'||!i.body.inventory.dockerAvailable)throw Error('New runtime not ready');console.log(JSON.stringify({version:JSON.parse(fs.readFileSync('/data/profiles/web/node_modules/dsh-applications/package.json')).version,apps:i.body.apps.length,health:h.body.health,originalIdsPreserved:before.length}))}finally{e.close()}"""
try:
 print(json.dumps({'waitingForIdle':CONFIG['name'],'version':'0.7.3'}),flush=True)
 deadline=time.monotonic()+86400
 while not idle():
  if time.monotonic()>deadline:raise RuntimeError('Idle deadline; no restart performed')
  time.sleep(.25)
 c=call('GET','/containers/'+CONFIG['containerId']+'/json');assert c['Name']=='/'+CONFIG['name']and c['Id']==CONFIG['containerId']
 baseline=execute(SNAP);assert idle()
 (ROOT/'containers-before.json').write_text(json.dumps(baseline))
 call('POST','/containers/'+c['Id']+'/restart?t=30')
 deadline=time.monotonic()+480
 while time.monotonic()<deadline:
  try:
   result=execute(VERIFY.replace('BASELINE',json.dumps(baseline)));assert result['version']=='0.7.3';print(json.dumps({'activated':True,**result}),flush=True);break
  except Exception:time.sleep(3)
 else:raise RuntimeError('Activation acceptance did not pass')
finally:(ROOT/'config.json').unlink(missing_ok=True)
