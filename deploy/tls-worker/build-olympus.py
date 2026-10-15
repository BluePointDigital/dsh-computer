#!/usr/bin/env python3
"""Build TLS worker on verified Olympus daemon from an explicit source allowlist.

Never sends workspace profiles, private state, credentials or the whole repository
as a Docker build context. Host access uses the existing operator control plane.
"""
import hashlib
import io
import json
import pathlib
import sys
import tarfile
import urllib.request
import urllib.parse

sys.path.insert(0, '/workspace/Olympus Server/tools')
import pt

ROOT = pathlib.Path(__file__).resolve().parents[2]


def main():
    assert pt.PORT == 'https://portainer:9443' and pt.ENDPOINT == 1
    status, info = pt.dk('GET', '/info')
    assert status == 200 and info['Name'] == 'olympus'
    files = ['package.json', 'package-lock.json', 'bin/tls-cli.mjs', 'bin/tls-worker.mjs']
    files += [str(p.relative_to(ROOT)) for p in sorted((ROOT / 'lib').glob('*.js'))]
    files += [str(p.relative_to(ROOT)) for p in sorted((ROOT / 'lib').glob('*.mjs'))]
    context = io.BytesIO()
    digest = hashlib.sha256()
    with tarfile.open(fileobj=context, mode='w') as tar:
        for relative in ['deploy/tls-worker/Dockerfile', *files]:
            source = ROOT / relative
            assert source.is_file() and not source.is_symlink()
            data = source.read_bytes()
            digest.update(relative.encode() + b'\0' + data)
            entry = tarfile.TarInfo('Dockerfile' if relative.endswith('/Dockerfile') else relative)
            entry.size = len(data)
            entry.mode = 0o644
            tar.addfile(entry, io.BytesIO(data))
    tag = 'local/dsh-tls-worker:canary-' + digest.hexdigest()[:16]
    parameters = urllib.parse.urlencode({'t': tag, 'dockerfile': 'Dockerfile', 'rm': 1, 'pull': 1})
    url = pt.PORT + f'/api/endpoints/{pt.ENDPOINT}/docker/build?' + parameters
    request = urllib.request.Request(url, method='POST', data=context.getvalue(),
        headers={'Authorization': 'Bearer ' + pt.token(), 'Content-Type': 'application/x-tar'})
    with urllib.request.urlopen(request, context=pt.CTX, timeout=600) as response:
        for raw in response:
            if not raw.strip():
                continue
            line = json.loads(raw)
            if 'error' in line:
                raise RuntimeError(line['error'])
            if 'stream' in line:
                print(line['stream'], end='', flush=True)
    status, image = pt.dk('GET', '/images/' + urllib.parse.quote(tag, safe='/:') + '/json')
    assert status == 200
    print(json.dumps({'tag': tag, 'image': image['Id'], 'architecture': image['Architecture'], 'source_hash': digest.hexdigest()}))


if __name__ == '__main__':
    main()
