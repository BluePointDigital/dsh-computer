#!/usr/bin/env python3
"""Build Olympus control hardening atop the exact running image, without restarting."""
import hashlib
import io
import json
import pathlib
import sys
import tarfile
import urllib.parse
import urllib.request
sys.path.insert(0, '/workspace/Olympus Server/tools')
import pt


def main():
    assert pt.PORT=='https://portainer:9443' and pt.ENDPOINT==1
    status,current=pt.dk('GET','/containers/dsh-olympus/json');assert status==200
    base=current['Image']
    directory=pathlib.Path('/workspace/Olympus Server/harness')
    files={name:(directory/name).read_bytes() for name in ['proxy.mjs','proxy-policy.mjs']}
    dockerfile=f'''FROM {base}
COPY proxy.mjs proxy-policy.mjs /app/
RUN chmod 0644 /app/proxy.mjs /app/proxy-policy.mjs && su node -s /bin/sh -c 'node --check /app/proxy.mjs && node --check /app/proxy-policy.mjs'
ENV DSH_CONTROL_INGRESS_PEERS=172.18.0.2
'''.encode()
    files['Dockerfile']=dockerfile
    digest=hashlib.sha256(b''.join(k.encode()+b'\0'+v for k,v in sorted(files.items()))).hexdigest()
    tag='local/deepseek-harness:olympus-gateway-'+digest[:16]
    data=io.BytesIO()
    with tarfile.open(fileobj=data,mode='w') as archive:
        for name,body in files.items():
            entry=tarfile.TarInfo(name);entry.mode=0o644;entry.size=len(body);archive.addfile(entry,io.BytesIO(body))
    url=pt.PORT+'/api/endpoints/1/docker/build?'+urllib.parse.urlencode({'t':tag,'rm':1})
    req=urllib.request.Request(url,method='POST',data=data.getvalue(),headers={'Authorization':'Bearer '+pt.token(),'Content-Type':'application/x-tar'})
    with urllib.request.urlopen(req,context=pt.CTX,timeout=600) as response:
        for raw in response:
            if raw.strip():
                result=json.loads(raw)
                if 'error' in result:raise RuntimeError(result['error'])
                if 'stream' in result:print(result['stream'],end='',flush=True)
    status,image=pt.dk('GET','/images/'+tag+'/json');assert status==200
    print(json.dumps({'image':image['Id'],'tag':tag,'parent':base,'sourceHash':digest}))


if __name__=='__main__':main()
