#!/usr/bin/env python3
"""Exercise built worker as UID 1000 without network, credentials or CA orders."""
import json
import sys
sys.path.insert(0, '/workspace/Olympus Server/tools')
import pt
import dkexec


def main():
    assert len(sys.argv) == 2 and sys.argv[1].startswith('sha256:')
    assert pt.PORT == 'https://portainer:9443' and pt.ENDPOINT == 1
    image = sys.argv[1]
    status, info = pt.dk('GET', '/images/' + image + '/json')
    assert status == 200 and info['Id'] == image
    name = 'dsh-tls-worker-buildcheck'
    status, _ = pt.dk('GET', '/containers/' + name + '/json')
    assert status == 404
    code = '''
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { TlsManager } from './lib/tls-manager.js';
const version = execFileSync('certbot', ['--version'], { encoding: 'utf8' }).trim();
const manager = new TlsManager();
const status = await manager.status();
if (status.configured || process.getuid() !== 1000) throw Error('Bad isolated worker identity');
await manager.store.locked(async () => {});
const mode = (await fs.stat(manager.root)).mode & 0o777;
if (mode !== 0o700) throw Error('Unsafe state permissions');
console.log(JSON.stringify({ uid: process.getuid(), node: process.version, certbot: version, privateState: true, lock: true, configured: false }));
'''
    body = {'Image': image, 'Cmd': ['node', '--input-type=module', '-e', code],
        'Labels': {'dsh.acmedns.purpose': 'temporary-worker-buildcheck'},
        'Env': ['DSH_HOME=/tmp/check'],
        'HostConfig': {'NetworkMode': 'none', 'ReadonlyRootfs': True, 'CapDrop': ['ALL'],
            'SecurityOpt': ['no-new-privileges:true'], 'Memory': 268435456, 'PidsLimit': 64,
            'Tmpfs': {'/tmp': 'rw,nosuid,nodev,noexec,size=16m,mode=1777'}}}
    status, created = pt.dk('POST', '/containers/create?name=' + name, body)
    assert status == 201
    cid = created['Id']
    status, _ = pt.dk('POST', '/containers/' + cid + '/start')
    assert status == 204
    status, result = pt.dk('POST', '/containers/' + cid + '/wait?condition=not-running')
    assert status == 200
    status, output = dkexec.raw('GET', '/containers/' + cid + '/logs?stdout=1&stderr=1')
    assert status == 200
    print(dkexec.demux(output))
    status, info = pt.dk('GET', '/containers/' + cid + '/json')
    assert status == 200 and info['Id'] == cid and info['Name'] == '/' + name
    assert info['Config']['Labels']['dsh.acmedns.purpose'] == 'temporary-worker-buildcheck'
    status, _ = pt.dk('DELETE', '/containers/' + cid)
    assert status == 204
    assert result['StatusCode'] == 0, 'Worker image smoke failed'


if __name__ == '__main__':
    main()
