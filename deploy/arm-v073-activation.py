#!/usr/bin/env python3
"""Arm external idle activation. Secrets only in owner-only host Docker volume."""
import io,json,pathlib,sys,tarfile,urllib.request
sys.path.insert(0,'/workspace/Olympus Server/tools');import pt
for name in sys.argv[1:]:
 assert name in ['dsh-olympus','dsh-wilson']
 s,c=pt.dk('GET','/containers/'+name+'/json');assert s==200 and c['Name']=='/'+name
 home=next(m['Name']for m in c['Mounts']if m['Destination']=='/data');worker=name+'-v073-idle-activation';volume=worker+'-private'
 s,v=pt.dk('POST','/volumes/create',{'Name':volume});assert s in [200,201]
 s,w=pt.dk('POST','/containers/create?name='+worker,{'Image':'python:3.13-alpine','User':'0:0','Cmd':['python3','/private/worker.py'],'HostConfig':{'NetworkMode':'proxy','RestartPolicy':{'Name':'no'},'Mounts':[{'Type':'volume','Source':volume,'Target':'/private'},{'Type':'volume','Source':home,'Target':'/home-volume','ReadOnly':True}]}});assert s==201
 data=io.BytesIO()
 with tarfile.open(fileobj=data,mode='w')as t:
  files={'worker.py':pathlib.Path('deploy/activate-v073-after-turn.py').read_bytes(),'config.json':json.dumps({'name':name,'containerId':c['Id'],'portainer':pt.PORT,'token':pt.token()}).encode()}
  for n,b in files.items():
   i=tarfile.TarInfo(n);i.size=len(b);i.mode=0o600;t.addfile(i,io.BytesIO(b))
 req=urllib.request.Request(pt.PORT+f'/api/endpoints/1/docker/containers/{w["Id"]}/archive?path=/private',method='PUT',data=data.getvalue(),headers={'Authorization':'Bearer '+pt.token(),'Content-Type':'application/x-tar'})
 with urllib.request.urlopen(req,context=pt.CTX,timeout=20)as r:assert r.status==200
 s,_=pt.dk('POST','/containers/'+w['Id']+'/start');assert s==204
 print(json.dumps({'armed':worker,'target':c['Id'],'requires':'all persisted turns idle; never a fixed-delay restart'}))
