'use strict';

/**
 * ContactsQ CardDAV client (RFC 6352 + RFC 6578), zero dependencies, READ ONLY.
 *
 * Only ever issues PROPFIND and REPORT. There is no PUT, DELETE or any other write verb in this file by
 * construction: ContactsQ is a one-way pull and the governed copy.
 *
 *   discover()                       principal -> addressbook-home-set -> address books
 *   listEtags(book)                  PROPFIND Depth 1 getetag listing (+ collection sync-token)
 *   syncCollection(book, token)      REPORT sync-collection; throws code 'invalid_sync_token' when the server forgot the token
 *   multiget(book, hrefs)            REPORT addressbook-multiget in one request (the caller batches by 50)
 *
 * Safety: Basic auth over HTTPS only (http:// needs the explicit test flag), manual redirects (max 3) with every
 * hop re-checked, every host (including the different pNN-contacts.icloud.com host iCloud hands back) must be https
 * and resolve only to public addresses, a timeout on every request and a hard cap on response size.
 * Credentials are used to build one Authorization header and are never logged or put in an error.
 */

const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_XML_DEPTH = 60;
const MULTIGET_BATCH = 50;

class CardDavError extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}

// ---------------------------------------------------------------------------
// Egress guard (ported from services/ward/lib/egressGuard.js; no collector helper exists for hostnames)
// ---------------------------------------------------------------------------

function ipv4Blocked(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && p[2] === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function mappedV4(lower) {
  if (lower.includes('.')) {
    const v4 = lower.slice(lower.lastIndexOf(':') + 1);
    return net.isIP(v4) === 4 ? v4 : null;
  }
  const m = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function ipv6Blocked(ip) {
  const lower = ip.toLowerCase();
  const v4 = mappedV4(lower);
  if (v4) return ipv4Blocked(v4);
  if (lower === '::1' || lower === '::') return true;
  if (/^fe[89ab]/.test(lower)) return true;
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('ff')) return true;
  return false;
}

function isBlockedIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return ipv4Blocked(ip);
  if (fam === 6) return ipv6Blocked(ip);
  return true;
}

// ---------------------------------------------------------------------------
// Tolerant XML (namespace prefixes d: / D: / none are all reduced to a lower-case local name)
// ---------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
  });
}

const localName = (n) => n.slice(n.indexOf(':') + 1).toLowerCase();

/** -> root node { name, children: [], text }. Never throws on sloppy markup; throws CardDavError('malformed_xml') on nothing usable. */
function parseXml(src) {
  const root = { name: '#root', children: [], text: '' };
  const stack = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { stack[stack.length - 1].text += decodeEntities(src.slice(i)); break; }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const stop = end === -1 ? n : end;
      stack[stack.length - 1].text += src.slice(lt + 9, stop);
      i = end === -1 ? n : end + 3;
    } else if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end === -1 ? n : end + 2;
    } else if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt + 2);
      i = end === -1 ? n : end + 1;
    } else {
      // A tag: find its closing '>' outside of quoted attribute values.
      let j = lt + 1;
      let q = null;
      while (j < n) {
        const c = src[j];
        if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break;
        j += 1;
      }
      const inner = src.slice(lt + 1, j);
      i = j + 1;
      if (inner[0] === '/') {
        const name = localName(inner.slice(1).trim());
        // Pop to the matching open element (tolerates a missing close tag).
        for (let k = stack.length - 1; k > 0; k -= 1) if (stack[k].name === name) { stack.length = k; break; }
      } else {
        const selfClose = inner.endsWith('/');
        const m = (selfClose ? inner.slice(0, -1) : inner).match(/^\s*([^\s/>]+)/);
        if (!m) continue;
        const node = { name: localName(m[1]), children: [], text: '' };
        stack[stack.length - 1].children.push(node);
        if (!selfClose) {
          if (stack.length > MAX_XML_DEPTH) throw new CardDavError('malformed_xml');
          stack.push(node);
        }
      }
    }
  }
  if (!root.children.length) throw new CardDavError('malformed_xml');
  return root;
}

const kids = (node, name) => (node ? node.children.filter((c) => c.name === name) : []);
const kid = (node, name) => (node ? node.children.find((c) => c.name === name) || null : null);
function descend(node, ...path) { let cur = node; for (const p of path) { cur = kid(cur, p); if (!cur) return null; } return cur; }
const textOf = (node) => (node ? node.text.trim() : '');

/** One <response> -> { href, status, props: { [lowercase prop name]: node } } for 2xx propstats (and the response-level status). */
function readResponses(root) {
  const ms = root.children.find((c) => c.name === 'multistatus') || root;
  const out = [];
  for (const r of kids(ms, 'response')) {
    const hrefs = kids(r, 'href').map(textOf).filter(Boolean);
    const respStatus = textOf(kid(r, 'status'));
    const props = {};
    for (const ps of kids(r, 'propstat')) {
      const st = textOf(kid(ps, 'status'));
      if (st && !/\s2\d\d\b/.test(st)) continue;
      const prop = kid(ps, 'prop');
      if (prop) for (const p of prop.children) props[p.name] = p;
    }
    for (const href of hrefs) out.push({ href, status: respStatus ? parseInt((respStatus.match(/\s(\d{3})\b/) || [])[1], 10) || null : null, props });
  }
  return { responses: out, token: textOf(kid(ms, 'sync-token')) || null };
}

const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const NS = 'xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/"';
const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>';

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * @param {{ serverUrl: string, username: string, password: string, fetchImpl?: Function, resolver?: { lookup: Function },
 *           allowInsecureHttp?: boolean, timeoutMs?: number, maxBytes?: number }} o
 */
function createClient({ serverUrl, username, password, fetchImpl = fetch, resolver = dns, allowInsecureHttp = false, timeoutMs = REQUEST_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES }) {
  if (!username || !password) throw new CardDavError('credential_incomplete');
  const auth = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
  const hostOk = new Map();
  const stats = { requests: 0 };

  async function guard(urlStr) {
    let u;
    try { u = new URL(urlStr); } catch { throw new CardDavError('invalid_url'); }
    if (u.protocol !== 'https:' && !(allowInsecureHttp && u.protocol === 'http:')) throw new CardDavError('https_required');
    if (u.username || u.password) throw new CardDavError('invalid_url');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (hostOk.get(host)) return u;
    let ips;
    if (net.isIP(host)) ips = [host];
    else {
      try { ips = (await resolver.lookup(host, { all: true })).map((r) => r.address); } catch { throw new CardDavError('dns_failed'); }
    }
    if (!ips.length || ips.some(isBlockedIp)) throw new CardDavError('blocked_egress');
    hostOk.set(host, true);
    return u;
  }

  async function readCapped(res) {
    const declared = parseInt(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : '', 10);
    if (Number.isFinite(declared) && declared > maxBytes) throw new CardDavError('response_too_large');
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) { try { await reader.cancel(); } catch { /* already closing */ } throw new CardDavError('response_too_large'); }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks).toString('utf8');
    }
    const t = await res.text();
    if (Buffer.byteLength(t) > maxBytes) throw new CardDavError('response_too_large');
    return t;
  }

  /** -> { status, text, url } (the FINAL url after redirects). Method and body are preserved across redirects. */
  async function request(method, urlStr, { depth, body } = {}) {
    let cur = urlStr;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const u = await guard(cur);
      stats.requests += 1;
      let res;
      try {
        res = await fetchImpl(u.toString(), {
          method,
          redirect: 'manual',
          headers: {
            Authorization: auth,
            'Content-Type': 'application/xml; charset=utf-8',
            Accept: 'application/xml, text/xml, */*',
            ...(depth !== undefined ? { Depth: String(depth) } : {}),
            'User-Agent': 'QuoxContactsQ-Sync/1',
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        if (e instanceof CardDavError) throw e;
        throw new CardDavError(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'network_error');
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers && res.headers.get ? res.headers.get('location') : null;
        if (!loc) throw new CardDavError('bad_redirect', res.status);
        try { await res.arrayBuffer(); } catch { /* drain */ }
        cur = new URL(loc, u).toString();
        continue;
      }
      const text = await readCapped(res);
      return { status: res.status, text, url: u.toString() };
    }
    throw new CardDavError('too_many_redirects');
  }

  function fail(res) {
    if (res.status === 401 || res.status === 403) return new CardDavError('auth_failed', res.status);
    if (res.status === 429) return new CardDavError('rate_limited', res.status);
    if (res.status >= 500) return new CardDavError('server_error', res.status);
    return new CardDavError('http_error', res.status);
  }

  async function propfind(url, depth, props, extraNs = '') {
    const body = `${XML_HEAD}<d:propfind ${NS}${extraNs}><d:prop>${props}</d:prop></d:propfind>`;
    const res = await request('PROPFIND', url, { depth, body });
    if (res.status !== 207) throw fail(res);
    return { ...readResponses(parseXml(res.text)), url: res.url };
  }

  const hrefIn = (props, ...path) => {
    const n = descend(props[path[0]], ...path.slice(1));
    const h = textOf(n && n.name === 'href' ? n : kid(n, 'href'));
    return h || null;
  };

  async function discover() {
    const start = await guard(serverUrl);
    const candidates = [start.toString()];
    const wk = new URL('/.well-known/carddav', start).toString();
    if (wk !== start.toString()) candidates.push(wk);
    let principal = null;
    let lastErr = null;
    for (const c of candidates) {
      try {
        const r = await propfind(c, 0, '<d:current-user-principal/>');
        const hit = r.responses.find((x) => x.props['current-user-principal']);
        const h = hit && textOf(kid(hit.props['current-user-principal'], 'href'));
        if (h) { principal = new URL(h, r.url).toString(); break; }
      } catch (e) { lastErr = e; if (e.code === 'auth_failed') throw e; }
    }
    if (!principal) throw lastErr instanceof CardDavError && lastErr.code !== 'http_error' ? lastErr : new CardDavError('principal_not_found');

    const home = await propfind(principal, 0, '<card:addressbook-home-set/>');
    const hh = home.responses.map((x) => x.props['addressbook-home-set']).find(Boolean);
    const homeHref = hh && textOf(kid(hh, 'href'));
    if (!homeHref) throw new CardDavError('addressbook_home_not_found');
    const homeUrl = new URL(homeHref, home.url).toString();

    const list = await propfind(homeUrl, 1, '<d:resourcetype/><d:displayname/><d:sync-token/><cs:getctag/>');
    const books = [];
    for (const r of list.responses) {
      const rt = r.props.resourcetype;
      if (!rt || !kid(rt, 'addressbook')) continue;
      books.push({
        url: new URL(r.href, list.url).toString(),
        name: textOf(r.props.displayname).slice(0, 120) || null,
        sync_token: textOf(r.props['sync-token']) || null,
        ctag: textOf(r.props.getctag) || null,
      });
    }
    return { principal, home: homeUrl, addressbooks: books };
  }

  /** Full listing: every card href with its etag, plus the collection's current sync-token when the server exposes one. */
  async function listEtags(bookUrl) {
    const r = await propfind(bookUrl, 1, '<d:getetag/><d:resourcetype/><d:sync-token/>');
    const items = [];
    let token = null;
    const bookPath = new URL(bookUrl).pathname.replace(/\/+$/, '');
    for (const x of r.responses) {
      const isColl = x.props.resourcetype && kid(x.props.resourcetype, 'collection');
      const abs = new URL(x.href, r.url);
      if (isColl || abs.pathname.replace(/\/+$/, '') === bookPath) { token = token || textOf(x.props['sync-token']) || null; continue; }
      const etag = textOf(x.props.getetag);
      if (etag) items.push({ href: x.href, etag });
    }
    return { items, token: token || r.token };
  }

  /** REPORT sync-collection. -> { changed: [{href, etag}], removed: [href], token, truncated } */
  async function syncCollection(bookUrl, token) {
    const body = `${XML_HEAD}<d:sync-collection ${NS}><d:sync-token>${xmlEsc(token || '')}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`;
    const res = await request('REPORT', bookUrl, { depth: 0, body });
    if (res.status === 403 || res.status === 409 || res.status === 412) throw new CardDavError('invalid_sync_token', res.status);
    if (res.status === 400 && /sync-token/i.test(res.text)) throw new CardDavError('invalid_sync_token', res.status);
    if (res.status !== 207) throw fail(res);
    const { responses, token: next } = readResponses(parseXml(res.text));
    const bookPath = new URL(bookUrl).pathname.replace(/\/+$/, '');
    const changed = [];
    const removed = [];
    let truncated = false;
    for (const x of responses) {
      const path = new URL(x.href, res.url).pathname.replace(/\/+$/, '');
      if (path === bookPath) { if (x.status === 507) truncated = true; continue; }
      if (x.status === 404) { removed.push(x.href); continue; }
      const etag = textOf(x.props.getetag);
      if (etag) changed.push({ href: x.href, etag });
    }
    return { changed, removed, token: next, truncated };
  }

  /** REPORT addressbook-multiget for ONE batch (callers chunk by MULTIGET_BATCH). -> [{ href, etag, vcard }] */
  async function multiget(bookUrl, hrefs) {
    if (!hrefs.length) return [];
    if (hrefs.length > MULTIGET_BATCH) throw new CardDavError('batch_too_large');
    const body = `${XML_HEAD}<card:addressbook-multiget ${NS}><d:prop><d:getetag/><card:address-data/></d:prop>${hrefs.map((h) => `<d:href>${xmlEsc(h)}</d:href>`).join('')}</card:addressbook-multiget>`;
    const res = await request('REPORT', bookUrl, { depth: 1, body });
    if (res.status !== 207) throw fail(res);
    const out = [];
    for (const x of readResponses(parseXml(res.text)).responses) {
      const data = x.props['address-data'];
      if (data && data.text.trim()) out.push({ href: x.href, etag: textOf(x.props.getetag), vcard: data.text });
    }
    return out;
  }

  return { discover, listEtags, syncCollection, multiget, stats, request };
}

module.exports = { createClient, CardDavError, parseXml, readResponses, isBlockedIp, MULTIGET_BATCH, MAX_REDIRECTS };
