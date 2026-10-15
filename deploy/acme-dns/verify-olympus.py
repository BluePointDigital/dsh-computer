#!/usr/bin/env python3
"""Read-only public DNS/TLS smoke. No credentials or registration mutation."""
import json
import secrets
import socket
import ssl
import struct
import urllib.error
import urllib.request

IP = '104.225.218.209'
ZONE = 'auth.bluepointdigital.com'


def dns_query(name, qtype, protocol):
    ident = secrets.randbelow(65536)
    qname = b''.join(bytes([len(label)]) + label.encode() for label in name.split('.')) + b'\0'
    packet = struct.pack('!6H', ident, 0, 1, 0, 0, 0) + qname + struct.pack('!HH', qtype, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM if protocol == 'udp' else socket.SOCK_STREAM) as s:
        s.settimeout(10)
        if protocol == 'udp':
            s.sendto(packet, (IP, 53))
            response, _ = s.recvfrom(8192)
        else:
            s.connect((IP, 53))
            s.sendall(struct.pack('!H', len(packet)) + packet)
            def receive(n):
                data = b''
                while len(data) < n:
                    chunk = s.recv(n - len(data))
                    if not chunk:
                        raise RuntimeError('Truncated DNS TCP response')
                    data += chunk
                return data
            response = receive(struct.unpack('!H', receive(2))[0])
    header = struct.unpack('!6H', response[:12])
    assert header[0] == ident
    return {'authoritative': bool(header[1] & 1024), 'recursive': bool(header[1] & 128), 'rcode': header[1] & 15, 'answers': header[3]}


def main():
    for protocol in ('tcp', 'udp'):
        result = dns_query(ZONE, 6, protocol)
        assert result['authoritative'] and result['rcode'] == 0 and result['answers'] > 0
        print(json.dumps({'check': 'authoritative-soa', 'protocol': protocol, **result}))
        result = dns_query('247b088d-d279-488a-9e97-8c65be79cdb3.' + ZONE, 16, protocol)
        assert result['authoritative'] and result['rcode'] == 0 and result['answers'] > 0
        print(json.dumps({'check': 'registered-canary-txt-answer', 'protocol': protocol, **result}))
        result = dns_query('example.net', 1, protocol)
        assert not result['recursive'] and result['answers'] == 0
        print(json.dumps({'check': 'not-an-open-recursive-resolver', 'protocol': protocol, **result}))
    for path, method, expected in [('/health','GET',200),('/register','POST',403),('/update','POST',401)]:
        request = urllib.request.Request('https://' + ZONE + path, method=method,
            data=b'{}' if method == 'POST' else None, headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                actual = response.status
        except urllib.error.HTTPError as error:
            actual = error.code
        assert actual == expected, (path, actual)
        print(json.dumps({'check': 'public-api', 'path': path, 'status': actual}))
    with socket.create_connection((IP,443), timeout=15) as raw:
        with ssl.create_default_context().wrap_socket(raw, server_hostname=ZONE) as sock:
            cert = sock.getpeercert()
            print(json.dumps({'check':'public-tls-trust', 'san':cert['subjectAltName'], 'expires':cert['notAfter']}))
    for qtype in ('NS', 'A'):
        url = f'https://cloudflare-dns.com/dns-query?name={ZONE}&type={qtype}'
        with urllib.request.urlopen(urllib.request.Request(url, headers={'Accept':'application/dns-json'}), timeout=15) as r:
            result = json.load(r)
        print(json.dumps({'check': 'recursive-public-delegation', 'type':qtype, 'answers':result.get('Answer', [])}))


if __name__ == '__main__':
    main()
