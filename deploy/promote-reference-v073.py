#!/usr/bin/env python3
"""Reference-only image update. Consistent stopped-volume backup, preflight, rollback."""
import copy,datetime,json,pathlib,sys,time
sys.path.insert(0,'/workspace/Olympus Server/harness/reference')
import operate,verify,dkexec
ROOT=pathlib.Path('/data/reference-single-volume')/('apps073-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
def save(name,value):
 p=ROOT/name;p.write_text(json.dumps(value,indent=2));p.chmod(0o600)
def execute(name,cmd):
 out=dkexec.exec_in(name,cmd,user='root',timeout_s=1200)
 if any(x in out for x in ['[exit=','[still running]','[exec create failed']):raise RuntimeError('Remote check failed: '+out[:300])
 return out.strip()
def deploy(definition,env):return operate.checked('pt','PUT','/stacks/12?endpointId=1',{'StackFileContent':definition,'Env':env,'Prune':False,'PullImage':False})
def ready(image):
 deadline=time.monotonic()+240
 while time.monotonic()<deadline:
  c=operate.checked('dk','GET','/containers/dsh-reference/json')
  if c['Image']==image and c['State'].get('Health',{}).get('Status')=='healthy':return c
  time.sleep(3)
 raise RuntimeError('Reference did not become healthy')
def main():
 operate.guard_host();ROOT.mkdir(mode=0o700)
 c=operate.checked('dk','GET','/containers/dsh-reference/json');assert c['Image']=='sha256:c1dd74b29a39732f50523db5303be2e5f031bd1cd5205e22e3670da1654e4835'
 assert c['Name']=='/dsh-reference'and len(c['Mounts'])==1 and c['Mounts'][0]['Name']=='dsh-reference-instance'
 idle="const fs=require('fs');for(const n of fs.readdirSync('/data/storages/session_projcache/sessions')){const b=JSON.parse(fs.readFileSync('/data/storages/session_projcache/sessions/'+n)).record.rows.turnBoundary.val;if(b.openTurnStartSeq!=null)throw Error('Active turn')}console.log('idle')"
 assert execute(c['Id'],['node','-e',idle])=='idle'
 assert not execute(c['Id'],['docker','ps','-q']),'Reference nested apps must stay stopped'
 ids=execute(c['Id'],['docker','ps','-aq']).splitlines()
 image,source=operate.image_name();meta=operate.checked('dk','GET','/images/'+image+'/json');assert meta['Config']['Labels']['com.bluepoint.dsh.source-sha256']==source
 stack=operate.checked('pt','GET','/stacks/12');assert stack['Name']=='dsh-reference';definition=operate.checked('pt','GET','/stacks/12/file')['StackFileContent']
 assert json.loads(definition)==json.loads((operate.HERE/'compose.json').read_text())
 save('before.json',{'stack':stack,'definition':definition,'reference':c['Id'],'image':c['Image'],'nestedIds':ids,'candidate':meta['Id']})
 backup='dsh-reference-apps073-backup-'+str(time.time_ns());operate.checked('dk','POST','/volumes/create',{'Name':backup},accepted=(200,201))
 h=operate.checked('dk','POST','/containers/create?name='+backup,{'Image':c['Image'],'Entrypoint':['sleep'],'Cmd':['infinity'],'User':'0','Healthcheck':{'Test':['NONE']},'HostConfig':{'NetworkMode':'none','ReadonlyRootfs':True,'Mounts':[{'Type':'volume','Source':'dsh-reference-instance','Target':'/source','ReadOnly':True},{'Type':'volume','Source':backup,'Target':'/backup'}]}},accepted=(201,))['Id']
 operate.checked('dk','POST','/containers/'+h+'/start',accepted=(204,));assert execute(c['Id'],['node','-e',idle])=='idle'
 operate.checked('dk','POST','/containers/'+c['Id']+'/stop?t=45',accepted=(204,))
 try:
  assert not operate.checked('dk','GET','/containers/'+c['Id']+'/json')['State']['Running']
  print('Reference quiesced; backing up its full single volume',flush=True)
  execute(h,['sh','-c','tar --xattrs --acls --numeric-owner --sparse -cpf /backup/instance.tar -C /source . && sync'])
  report=json.loads(execute(h,['python3','-c',"import pathlib,tarfile,hashlib,json;p=pathlib.Path('/backup/instance.tar');size=0;n=0\nwith tarfile.open(p,'r|')as t:\n for m in t:\n  n+=1\n  if m.isfile():\n   f=t.extractfile(m)\n   while b:=f.read(1024*1024):size+=len(b)\nwith p.open('rb')as f:sha=hashlib.file_digest(f,'sha256').hexdigest()\nprint(json.dumps({'bytes':p.stat().st_size,'members':n,'payloadRead':size,'sha256':sha}))"]))
  assert report['bytes']>0 and report['members']>100 and report['payloadRead']>0;save('backup.json',{'volume':backup,'offHostCopy':False,**report});print(json.dumps({'backupVerified':report}),flush=True)
  # Run ONLY the ownership inspector, not a copied user's supervisor/jobs. Read-only
  # source mount and no network; candidate modules and real personal profile compose.
  pre=operate.checked('dk','POST','/containers/create?name=dsh-reference-apps073-preflight',{'Image':meta['Id'],'Entrypoint':['node'],'Cmd':['/opt/dsh-environment/managed-preflight.mjs'],'Env':['DSH_HOME=/source/.dsh-instance/harness','DSH_PROFILE=web'],'User':'1000:1000','Healthcheck':{'Test':['NONE']},'HostConfig':{'NetworkMode':'none','ReadonlyRootfs':True,'Mounts':[{'Type':'volume','Source':'dsh-reference-instance','Target':'/source','ReadOnly':True}]}},accepted=(201,))['Id']
  operate.checked('dk','POST','/containers/'+pre+'/start',accepted=(204,));result=operate.checked('dk','POST','/containers/'+pre+'/wait');assert result['StatusCode']==0,'Candidate ownership preflight failed'
  env=copy.deepcopy(stack['Env']);assert sum(x['name']=='DSH_REFERENCE_IMAGE'for x in env)==1
  for x in env:
   if x['name']=='DSH_REFERENCE_IMAGE':x['value']=meta['Id']
  deploy(definition,env);after=ready(meta['Id'])
  got=execute(after['Id'],['docker','ps','-aq']).splitlines();assert sorted(got)==sorted(ids)and not execute(after['Id'],['docker','ps','-q'])
  code="fetch('http://127.0.0.1:8080/apps/api/access-health').then(async r=>{const x=await r.json();if(r.status!==200||x.health.mode!=='isolated')throw Error('bad health');console.log(JSON.stringify(x))}).catch(e=>{console.error(e);process.exit(1)})"
  health=json.loads(execute(after['Id'],['node','-e',code]));save('accepted.json',{'reference':after['Id'],'image':after['Image'],'health':health,'nestedIdsPreserved':len(ids)})
  print(json.dumps({'activated':True,'version':'0.7.3','nestedIdsPreserved':len(ids),'appsRemainStopped':True,'records':str(ROOT)}),flush=True)
 except Exception:
  deploy(definition,stack['Env']);ready(c['Image']);save('rollback.json',{'restoredImage':c['Image']});raise
 finally:
  operate.checked('dk','POST','/containers/'+h+'/stop?t=10',accepted=(204,304))
if __name__=='__main__':main()
