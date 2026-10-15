#!/usr/bin/env python3
"""Operator-only enrollment via host Portainer; never emits credentials.

Run from repository root. Short private registration window; public NPM /register
must already be blocked. Registration is persisted in the named private canary
volume. Use once per new deployment; do not register in retry loops.
"""
import json
import pathlib
import sys
sys.path.insert(0, '/workspace/Olympus Server/tools')
import pt

SERVICE = 'dsh-acme-dns'
OWNER = 'shared-validation'
STATE = 'dsh-acme-dns-canary-state'
CONFIG = 'dsh-acme-dns-config'
IMAGE = 'python:3.13-alpine'


def api(method, route, body=None, statuses=(200, 201, 204)):
    status, result = pt.dk(method, route, body)
    if status not in statuses:
        raise RuntimeError(f'Host API {method} {route}: HTTP {status}; body suppressed')
    return result


def helper(name, code, mounts, args=(), network='none', user=None):
    api('GET', f'/containers/{name}/json', statuses=(404,))
    spec = {'Image': IMAGE, 'Cmd': ['python3', '-c', code, *args],
            'Labels': {'dsh.acmedns.helper': name},
            'HostConfig': {'NetworkMode': network, 'ReadonlyRootfs': True,
                           'Binds': mounts, 'Memory': 67108864, 'PidsLimit': 32,
                           'SecurityOpt': ['no-new-privileges:true'],
                           'LogConfig': {'Type': 'json-file', 'Config': {'max-size': '1m', 'max-file': '1'}}}}
    if user:
        spec['User'] = user
    cid = api('POST', f'/containers/create?name={name}', spec)['Id']
    api('POST', f'/containers/{cid}/start')
    result = api('POST', f'/containers/{cid}/wait?condition=not-running')
    # Never fetch enrollment logs: they must not carry credentials even on error.
    info = api('GET', f'/containers/{cid}/json')
    assert info['Name'] == '/' + name and info['Config']['Labels']['dsh.acmedns.helper'] == name
    api('DELETE', f'/containers/{cid}')
    if result['StatusCode']:
        raise RuntimeError(f'{name} failed; credentials and response body suppressed')


def configure(enabled):
    expected = pathlib.Path('deploy/acme-dns/olympus.config.cfg').read_text()
    desired = expected.replace('disable_registration = true', f'disable_registration = {str(not enabled).lower()}')
    code = '''import pathlib,os,sys
p=pathlib.Path('/config/config.cfg'); assert p.is_file() and not p.is_symlink()
current=p.read_text()
assert current.replace('disable_registration = false','disable_registration = true')==sys.argv[1]
fd=os.open('/config/enroll.tmp',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:f.write(sys.argv[2]);f.flush();os.fsync(f.fileno())
os.chown('/config/enroll.tmp',1000,1000);os.replace('/config/enroll.tmp',p)
'''
    helper('dsh-acmedns-enroll-config', code, [CONFIG + ':/config'], [expected, desired])
    api('POST', f'/containers/{SERVICE}/restart?t=10')


def main(state=STATE, purpose='isolated-canary'):
    global STATE
    assert state in ('dsh-acme-dns-canary-state', 'dsh-olympus-tls-state')
    STATE = state
    assert pt.PORT == 'https://portainer:9443' and pt.ENDPOINT == 1
    service = api('GET', f'/containers/{SERVICE}/json')
    assert service['Config']['Labels']['dsh.acmedns.owner'] == OWNER
    # Verify the public registration fence before opening a private window.
    import urllib.request, urllib.error
    try:
        urllib.request.urlopen(urllib.request.Request('https://auth.bluepointdigital.com/register', data=b'{}', headers={'Content-Type':'application/json'}), timeout=15)
        raise RuntimeError('Public registration fence is missing')
    except urllib.error.HTTPError as error:
        assert error.code == 403
    # No automatic reuse of a foreign named volume.
    status, volume = pt.dk('GET', f'/volumes/{STATE}')
    if status == 404:
        volume = api('POST', '/volumes/create', {'Name': STATE, 'Labels': {'dsh.acmedns.owner': OWNER, 'dsh.acmedns.purpose': purpose}})
    elif status != 200:
        raise RuntimeError('Cannot inspect canary state volume')
    assert volume['Labels']['dsh.acmedns.owner'] == OWNER
    helper('dsh-acmedns-enroll-prepare', "import os;os.chown('/state',1000,1000);os.chmod('/state',0o700)", [STATE + ':/state'])
    # Preflight before opening registration window. Re-running preserves identity.
    helper('dsh-acmedns-enroll-preflight', "import pathlib;assert not pathlib.Path('/state/registration.json').exists()", [STATE + ':/state:ro'], user='1000:1000')
    try:
        configure(True)
        code = '''import os,json,urllib.request,pathlib,time
p=pathlib.Path('/state/registration.json');assert not p.exists()
for attempt in range(10):
 try:
  urllib.request.urlopen('http://dsh-acme-dns:8080/health',timeout=3).close();break
 except OSError:
  if attempt==9:raise
  time.sleep(1)
req=urllib.request.Request('http://dsh-acme-dns:8080/register',data=b'{}',headers={'Content-Type':'application/json'})
with urllib.request.urlopen(req,timeout=15) as r:
 assert r.status==201;a=json.load(r)
assert a['fulldomain']==a['subdomain']+'.auth.bluepointdigital.com'
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:json.dump(a,f);f.flush();os.fsync(f.fileno())
'''
        helper('dsh-acmedns-enroll-register', code, [STATE + ':/state'], network='proxy', user='1000:1000')
    finally:
        configure(False)
    print(json.dumps({'enrolled': True, 'private_state_volume': STATE, 'registration_disabled_again': True}))


if __name__ == '__main__':
    if sys.argv[1:] == ['--production-olympus']:
        main('dsh-olympus-tls-state', 'production-olympus')
    elif not sys.argv[1:]:
        main()
    else:
        raise SystemExit('Only --production-olympus is supported')
