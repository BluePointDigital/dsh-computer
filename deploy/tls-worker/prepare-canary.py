#!/usr/bin/env python3
"""Provision isolated test upstream/worker, with secrets delivered in-memory only."""
import io
import json
import sys
import tarfile
import urllib.request
sys.path.insert(0, '/workspace/Olympus Server/tools')
import pt
import npm
import dkexec

IMAGE = 'sha256:d02a47b26631aacc9ca124527ecce6a45ebf2b96b41123adb282e6e414b62f75'
VOLUME = 'dsh-acme-dns-canary-state'
OWNER = 'delegated-tls-canary'


def api(method, path, body=None, expected=(200,201,204)):
    status, result = pt.dk(method,path,body)
    if status not in expected:
        raise RuntimeError(f'Host API {method} {path} failed HTTP {status}; response suppressed')
    return result


def container(name, spec):
    status, old = pt.dk('GET',f'/containers/{name}/json')
    if status == 404:
        old = api('POST',f'/containers/create?name={name}',spec)
        old = api('GET',f"/containers/{old['Id']}/json")
    else:
        assert status == 200 and old['Config']['Labels'].get('dsh.tls.owner') == OWNER
        assert old['Config']['Image'] == spec['Image']
    if not old['State']['Running']:
        api('POST',f"/containers/{old['Id']}/start")
    return old['Id']


def main():
    assert pt.PORT == 'https://portainer:9443' and pt.ENDPOINT == 1
    info = api('GET','/info'); assert info['Name'] == 'olympus'
    api('GET','/images/'+IMAGE+'/json')
    upstream = '''import http.server
class Fixture(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(401);self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(b'isolated TLS canary: no application content')
 def log_message(self,*args):pass
http.server.HTTPServer(('0.0.0.0',8080),Fixture).serve_forever()
'''
    host = {'NetworkMode':'proxy','ReadonlyRootfs':True,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true'],
            'Memory':134217728,'PidsLimit':64,'RestartPolicy':{'Name':'no'},
            'LogConfig':{'Type':'json-file','Config':{'max-size':'1m','max-file':'2'}}}
    fixture = container('dsh-tls-canary-upstream', {'Image':'python:3.13-alpine','User':'1000:1000',
        'Cmd':['python3','-c',upstream],'Labels':{'dsh.tls.owner':OWNER},'HostConfig':host})
    host = {**host,'Memory':536870912,'Tmpfs':{'/tmp':'rw,nosuid,nodev,noexec,size=32m,mode=1777'},
        'Mounts':[{'Type':'volume','Source':VOLUME,'Target':'/data','VolumeOptions':{'NoCopy':True}}]}
    worker = container('dsh-tls-canary-worker', {'Image':IMAGE,'User':'1000:1000','Env':['DSH_HOME=/data','COMPUTER_APPS_STATE=/data/apps'],
        'Cmd':['node','-e','setInterval(()=>{},3600000)'],'Labels':{'dsh.tls.owner':OWNER},'HostConfig':host})
    config = {'domain':'tls-canary.bluepointdigital.com','ingressAddress':'104.225.218.209','email':npm.EMAIL,
        'termsAgreed':True,'staging':True,'privateIngressConfirmed':True,'cacheBypassConfirmed':True,
        'acmeDns':{'url':'https://auth.bluepointdigital.com','zone':'auth.bluepointdigital.com'},
        'npm':{'url':'http://nginx-proxy-manager:81','allowPrivateHttp':True,'identity':npm.EMAIL,'secret':npm.PASSWORD,
               'forwardHost':'dsh-tls-canary-upstream','forwardPort':8080}}
    # Deliver credentials via a private file in a private volume, not container
    # environment, argv, logs, synced source or stack definitions.
    payload=json.dumps(config).encode(); archive=io.BytesIO()
    with tarfile.open(fileobj=archive,mode='w') as tar:
        entry=tarfile.TarInfo('operator-input.json');entry.uid=1000;entry.gid=1000;entry.mode=0o600;entry.size=len(payload)
        tar.addfile(entry,io.BytesIO(payload))
    request=urllib.request.Request(pt.PORT+f'/api/endpoints/1/docker/containers/{worker}/archive?path=/data',
        data=archive.getvalue(),method='PUT',headers={'Authorization':'Bearer '+pt.token(),'Content-Type':'application/x-tar'})
    with urllib.request.urlopen(request,context=pt.CTX,timeout=30) as response: assert response.status==200
    code='''
import fs from 'node:fs/promises';
import { TlsManager } from './lib/tls-manager.js';
const input='/data/operator-input.json';
try {
 const config=JSON.parse(await fs.readFile(input,'utf8'));
 const account=JSON.parse(await fs.readFile('/data/registration.json','utf8'));
 const m=new TlsManager({dnsFactory:()=>({register:async()=>account})});
 const status=await m.setup(config);
 console.log(JSON.stringify({configured:status.configured,domain:status.domain,staging:status.staging,phase:status.phase}));
} catch { console.error('Private canary preparation failed; contents suppressed');process.exitCode=1 }
finally { await fs.unlink(input); }
'''
    output=dkexec.exec_in(worker,['node','--input-type=module','-e',code])
    assert '[exit=' not in output and '"configured":true' in output, 'Canary preparation failed; contents suppressed'
    print(output)
    print(json.dumps({'fixture':fixture,'worker':worker,'private_state_volume':VOLUME}))


if __name__=='__main__': main()
