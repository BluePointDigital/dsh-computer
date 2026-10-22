#!/usr/bin/env python3
"""Prepare one private-backend TLS ingress for Olympus' shared app port range."""
import io,json,pathlib,sys,tarfile,urllib.request,subprocess
sys.path.insert(0,'/workspace/Olympus Server/tools');import pt,dkexec
NAME='dsh-olympus-app-ports';IMAGE='sha256:892bb2152464f0c5d8972593a5f5afaf8054552580b699d95f8ff4af08c2d33d'
HOST='apps.dev.bluepointdigital.com';START=20000;END=20099
s,target=pt.dk('GET','/containers/dsh-olympus/json');assert s==200
ip=target['NetworkSettings']['Networks']['proxy']['IPAddress'];assert ip=='172.18.0.4'
s,npm=pt.dk('GET','/containers/nginx-proxy-manager/json');assert s==200
mount=next(m for m in npm['Mounts']if m['Destination']=='/data');assert mount['Name']=='npm_data'
s,old=pt.dk('GET','/containers/'+NAME+'/json');assert s==404,'Inspect existing ingress instead of replacing it'
s,rows=pt.dk('GET','/containers/json?all=1');assert s==200
assert not any(START<=p.get('PublicPort',0)<=END for c in rows for p in c.get('Ports',[])),'Port range already owned'
text=subprocess.check_output(['node','deploy/port-ingress.mjs','https://dev.bluepointdigital.com',ip,'/tls/fullchain.pem','/tls/privkey.pem',str(START),str(END),'https://'+HOST],text=True)
# App cookies/auth remain app-owned. Unknown hosts fail; no DSH token/Basic login is injected.
conf=pathlib.Path('deploy/shared-app-ports.conf').read_text().replace('  # APP_RANGE_SERVER',text)
health=['CMD-SHELL',f"wget -q -O /dev/null --header='Host: {HOST}:20000' http://127.0.0.1:20199/ 2>/dev/null || test -s /tls/fullchain.pem"]
spec={'Image':IMAGE,'Entrypoint':['/bin/sh','/etc/nginx/app-entrypoint.sh'],'Cmd':[], 'Labels':{'dsh.applications.role':'shared-host-port-ingress','dsh.applications.host':HOST},'ExposedPorts':{f'{p}/tcp':{}for p in range(START,END+1)},'HostConfig':{'NetworkMode':'proxy','ReadonlyRootfs':True,'Tmpfs':{'/tmp':'rw,noexec,nosuid,size=64m'},'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true'],'Memory':134217728,'PidsLimit':64,'RestartPolicy':{'Name':'unless-stopped'},'LogConfig':{'Type':'json-file','Config':{'max-size':'5m','max-file':'2'}},'PortBindings':{f'{p}/tcp':[{'HostIp':'0.0.0.0','HostPort':str(p)}]for p in range(START,END+1)},'Mounts':[{'Type':'bind','Source':mount['Source']+'/custom_ssl/npm-33','Target':'/tls','ReadOnly':True}]}}
s,volume=pt.dk('GET','/volumes/dsh-olympus-app-ports-config');assert s==200 and volume['Labels']['dsh.applications.role']=='shared-host-port-config'
spec['HostConfig']['Mounts'].append({'Type':'volume','Source':volume['Name'],'Target':'/config','ReadOnly':True,'VolumeOptions':{'NoCopy':True}})
spec['Entrypoint']=['/bin/sh','/config/app-entrypoint.sh']
seedname=NAME+'-config-seed';s,_=pt.dk('GET','/containers/'+seedname+'/json');assert s==404
s,res=pt.dk('POST','/containers/create?name='+seedname,{'Image':IMAGE,'Cmd':['true'],'HostConfig':{'NetworkMode':'none','Mounts':[{'Type':'volume','Source':volume['Name'],'Target':'/config','VolumeOptions':{'NoCopy':True}}]}});assert s==201;seed=res['Id'];buf=io.BytesIO()
with tarfile.open(fileobj=buf,mode='w')as tar:
 for leaf,data in [('nginx.conf',conf.encode()),('app-entrypoint.sh',pathlib.Path('deploy/shared-app-ports-entrypoint.sh').read_bytes())]:
  e=tarfile.TarInfo(leaf);e.mode=0o644;e.size=len(data);tar.addfile(e,io.BytesIO(data))
req=urllib.request.Request(pt.PORT+f'/api/endpoints/1/docker/containers/{seed}/archive?path=/config',method='PUT',data=buf.getvalue(),headers={'Authorization':'Bearer '+pt.token(),'Content-Type':'application/x-tar'})
with urllib.request.urlopen(req,context=pt.CTX,timeout=30)as r:assert r.status==200
s,check=pt.dk('GET','/containers/'+seed+'/json');assert s==200 and check['State']['Status']=='created' and check['Name']=='/'+seedname
s,_=pt.dk('DELETE','/containers/'+seed);assert s==204
s,res=pt.dk('POST','/containers/create?name='+NAME,spec);assert s==201;cid=res['Id']
s,_=pt.dk('POST','/containers/'+cid+'/start');assert s==204
print(json.dumps({'created':NAME,'id':cid,'ports':[START,END],'appHost':HOST,'upstream':ip,'existingNpmUntouched':True,'tlsRotation':'read-only existing cert directory plus digest watcher'}))
