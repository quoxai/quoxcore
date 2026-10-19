'use strict';

/**
 * pinnedHttp.js: DNS-pinned HTTP transport shared by web_fetch_allowlisted, web_read and web_search.
 * The caller resolves and checks the host ONCE, then passes init.lookup = pinnedLookup(host, checkedIp) so the
 * socket goes to the address that was checked (a name cannot resolve safe at check time and internal at connect
 * time: DNS rebinding). Host header and TLS servername stay the URL's hostname.
 */

const http = require('http');
const https = require('https');
const net = require('net');

/**
 * fetch-shaped transport. Supports init.method, init.headers (plain object or Headers), init.body (string/Buffer),
 * init.signal and init.lookup. With no init.headers the legacy allowlisted-fetch defaults apply. Returns a real Response.
 */
function pinnedFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    let headers = { 'user-agent': 'quox-agent-fetch/1', accept: '*/*' };
    if (init.headers) {
      headers = {};
      const entries = typeof init.headers.entries === 'function' ? [...init.headers.entries()] : Object.entries(init.headers);
      for (const [k, v] of entries) headers[String(k).toLowerCase()] = String(v);
    }
    const hasBody = init.body !== undefined && init.body !== null;
    if (hasBody && !headers['content-length']) headers['content-length'] = String(Buffer.byteLength(init.body));
    const req = mod.request(u, {
      method: init.method || 'GET',
      lookup: init.lookup,
      // own socket per request: a keep-alive pooled socket would skip this request's pinned lookup
      agent: false,
      headers,
      signal: init.signal,
    }, (res) => {
      const rh = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) v.forEach((x) => rh.append(k, x)); else if (v !== undefined) rh.set(k, String(v));
      }
      const noBody = [101, 204, 205, 304].includes(res.statusCode);
      if (noBody) { res.resume(); return resolve(new Response(null, { status: res.statusCode, headers: rh })); }
      const stream = new ReadableStream({
        start(controller) {
          res.on('data', (c) => controller.enqueue(new Uint8Array(c)));
          res.on('end', () => controller.close());
          res.on('error', (e) => controller.error(e));
        },
        cancel() { res.destroy(); },
      });
      resolve(new Response(stream, { status: res.statusCode, headers: rh }));
    });
    req.on('error', reject);
    if (hasBody) req.write(init.body);
    req.end();
  });
}

function pinnedLookup(hostname, address) {
  const want = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  const family = net.isIP(address) === 6 ? 6 : 4;
  return (host, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    if (String(host).replace(/^\[|\]$/g, '').toLowerCase() !== want) return cb(new Error(`pinned lookup refused unexpected host ${host}`));
    if (options && options.all) return cb(null, [{ address, family }]);
    return cb(null, address, family);
  };
}

module.exports = { pinnedFetch, pinnedLookup };
