#!/usr/bin/env python3
"""Fail-closed gate before staging CA orders; check independent public resolvers.

Exit 0: both resolvers observe required records and the registered canary TXT.
Exit 2: pending DNS or resolver failure. Does not change DNS or contact any CA.
"""
import json
import sys
import urllib.parse
import urllib.request

ZONE = 'auth.bluepointdigital.com'
TARGET = '247b088d-d279-488a-9e97-8c65be79cdb3.' + ZONE
CANARY = 'tls-canary.bluepointdigital.com'
RECORDS = [
    (ZONE, 'NS', 2, 'ns-acme.bluepointdigital.com'),
    ('ns-acme.bluepointdigital.com', 'A', 1, '104.225.218.209'),
    ('_acme-challenge.' + CANARY, 'CNAME', 5, TARGET),
    ('dsh-tls-check.' + CANARY, 'A', 1, '104.225.218.209'),
    (TARGET, 'TXT', 16, None),
]


def matches(answer, kind, expected):
    values = [r.get('data', '') for r in answer if r.get('type') == kind]
    if expected is None:
        # TXT can later contain a real CA digest rather than the bootstrap value.
        return any(len(v.strip('"')) == 43 for v in values)
    return len(values) == 1 and values[0].lower().rstrip('.') == expected


def check_resolver(name, base, query=None):
    if query is None:
        def query(domain, qtype):
            url = base + '?' + urllib.parse.urlencode({'name': domain, 'type': qtype})
            request = urllib.request.Request(url, headers={'Accept': 'application/dns-json'})
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.load(response)
    checks = []
    for domain, qtype, kind, expected in RECORDS:
        try:
            result = query(domain, qtype)
            ready = result.get('Status') == 0 and matches(result.get('Answer', []), kind, expected)
            checks.append({'name': domain, 'type': qtype, 'ready': ready})
        except Exception:
            checks.append({'name': domain, 'type': qtype, 'ready': False, 'error': 'resolver unavailable'})
    return {'resolver': name, 'ready': all(c['ready'] for c in checks), 'checks': checks}


def main():
    results = [check_resolver('Cloudflare', 'https://cloudflare-dns.com/dns-query'),
               check_resolver('Google', 'https://dns.google/resolve')]
    ready = all(r['ready'] for r in results)
    print(json.dumps({'ready_for_staging_order': ready, 'resolvers': results}, indent=2))
    return 0 if ready else 2


if __name__ == '__main__':
    sys.exit(main())
