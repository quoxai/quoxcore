#!/usr/bin/env python3
"""Exchange Claude OAuth authorization code for access token.

Reads JSON payload from stdin, posts to Claude's token endpoint.
Python's urllib bypasses Cloudflare TLS fingerprinting that blocks curl/Node fetch.
"""
import urllib.request, json, sys

payload = sys.stdin.read()
req = urllib.request.Request(
    'https://console.anthropic.com/v1/oauth/token',
    data=payload.encode(),
    headers={'Content-Type': 'application/json', 'User-Agent': 'claude-cli/2.1'},
    method='POST'
)
try:
    resp = urllib.request.urlopen(req, timeout=15)
    print(json.dumps({'status': resp.status, 'body': resp.read().decode()}))
except urllib.error.HTTPError as e:
    print(json.dumps({'status': e.code, 'body': e.read().decode()}))
except Exception as e:
    print(json.dumps({'status': 0, 'body': str(e)}))
