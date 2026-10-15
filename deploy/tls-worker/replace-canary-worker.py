#!/usr/bin/env python3
"""Replace only the owned, idle scratch worker; preserve its private state volume."""
import re
import sys
sys.path.insert(0, '/workspace/Olympus Server/tools')
import pt
import dkexec


def main():
    assert len(sys.argv)==2 and re.fullmatch(r'sha256:[a-f0-9]{64}',sys.argv[1])
    assert pt.PORT=='https://portainer:9443' and pt.ENDPOINT==1
    status,image=pt.dk('GET','/images/'+sys.argv[1]+'/json');assert status==200
    name='dsh-tls-canary-worker'
    status,old=pt.dk('GET','/containers/'+name+'/json');assert status==200
    assert old['Name']=='/'+name and old['Config']['Labels']['dsh.tls.owner']=='delegated-tls-canary'
    code="import {TlsManager} from './lib/tls-manager.js';const m=new TlsManager();await m.store.locked(async()=>{});console.log('idle-lock-ok')"
    result=dkexec.exec_in(old['Id'],['node','--input-type=module','-e',code]);assert 'idle-lock-ok' in result and '[exit=' not in result
    status,_=pt.dk('POST','/containers/'+old['Id']+'/stop?t=10');assert status in (204,304)
    # Verified exact immutable ID, owner label and scratch name before removal.
    status,_=pt.dk('DELETE','/containers/'+old['Id']);assert status==204
    body={'Image':sys.argv[1],'User':'1000:1000','Env':['DSH_HOME=/data','COMPUTER_APPS_STATE=/data/apps'],
        'Cmd':['node','-e','setInterval(()=>{},3600000)'],'Labels':{'dsh.tls.owner':'delegated-tls-canary'},
        'HostConfig':{'NetworkMode':'proxy','ReadonlyRootfs':True,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true'],
          'Memory':536870912,'PidsLimit':64,'Tmpfs':{'/tmp':'rw,nosuid,nodev,noexec,size=32m,mode=1777'},
          'Mounts':[{'Type':'volume','Source':'dsh-acme-dns-canary-state','Target':'/data','VolumeOptions':{'NoCopy':True}}],
          'LogConfig':{'Type':'json-file','Config':{'max-size':'1m','max-file':'2'}}}}
    status,new=pt.dk('POST','/containers/create?name='+name,body);assert status==201
    status,_=pt.dk('POST','/containers/'+new['Id']+'/start');assert status==204
    print('Replaced owned idle scratch worker; private state preserved; no harness restarted')


if __name__=='__main__':main()
