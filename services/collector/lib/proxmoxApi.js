/**
 * Proxmox REST read client (DEVFLEET-A2)
 *
 * HYPERION ('atlas') used to read the cluster with `pvesh get` over a raw
 * Bastion exec, which always 403s (approval_required). The collector already
 * holds a vault-scoped Proxmox API token (lib/proxmoxCredentials.js), so reads
 * go over the REST API instead.
 *
 * Hard rules, all enforced here and covered by test/proxmoxApi.test.js:
 *  - GET only. Any other method is refused before a connection is opened.
 *  - Path allowlist (read-only set). Anything else is refused.
 *  - An error is never data: not-configured, HTTP status, TLS mismatch,
 *    timeout and bad JSON are distinct PveError codes, never a parsed body.
 *  - Optional TLS pin: vault field `tls_fingerprint` (SHA-256 of the PVE cert,
 *    colon hex). When set a mismatch is refused BEFORE the request (and the
 *    token) is written to the socket. When unset the old behaviour is kept
 *    (rejectUnauthorized:false) and a one-time warning is logged.
 *  - Secrets (token, secret) are never logged or put in error messages.
 */

const https = require('https');
const { resolveProxmoxConnection } = require('./proxmoxCredentials.js');

const REQUEST_TIMEOUT_MS = 15000;

class PveError extends Error {
  /**
   * @param {string} code not_configured | lease_blocked | method_not_allowed |
   *   path_not_allowed | query_not_allowed | http_error | tls_fingerprint_mismatch | timeout |
   *   network_error | bad_response
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'PveError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// Path allowlist (read-only). Segments are strictly [A-Za-z0-9_.-] and may not
// be '.' or '..'.
// ---------------------------------------------------------------------------
const SEG = '[A-Za-z0-9][A-Za-z0-9_.-]*';
const ALLOWED_PATHS = [
  /^\/version$/,
  /^\/access\/permissions$/,
  /^\/cluster\/resources$/,
  /^\/cluster\/status$/,
  /^\/cluster\/ha\/status\/current$/,
  /^\/nodes$/,
  new RegExp(`^/nodes/${SEG}/(status|storage|qemu|lxc|tasks)$`),
  new RegExp(`^/nodes/${SEG}/(qemu|lxc)/[0-9]+/(config|status/current|snapshot)$`),
  new RegExp(
    `^/nodes/${SEG}/qemu/[0-9]+/agent/` +
    '(get-osinfo|get-host-name|network-get-interfaces|get-fsinfo|get-users|get-time|get-timezone|get-vcpus|get-memory-blocks|info)$'
  ),
  new RegExp(`^/nodes/${SEG}/storage/${SEG}/content$`),
  // VM Doctor (DEVFLEET-DOCTOR): performance history. Query is validated by validateQuery().
  new RegExp(`^/nodes/${SEG}/rrddata$`),
  new RegExp(`^/nodes/${SEG}/qemu/[0-9]+/rrddata$`),
];

function isAllowedPath(path) {
  if (typeof path !== 'string' || path.length > 256) return false;
  if (path.includes('..') || path.includes('//')) return false;
  return ALLOWED_PATHS.some((re) => re.test(path));
}

/**
 * Query allowlist for the paths whose query string carries meaning beyond a filter.
 * rrddata: timeframe (hour|day|week, required) and cf (AVERAGE|MAX). tasks: vmid (digits),
 * limit (1..200), typefilter (lowercase word). Returns null when fine, else a reason.
 * Other paths are unchanged (their existing callers pass `type`).
 */
const RRD_TIMEFRAMES = new Set(['hour', 'day', 'week']);
const RRD_CF = new Set(['AVERAGE', 'MAX']);
function validateQuery(path, query) {
  const q = query || {};
  const keys = Object.keys(q).filter((k) => q[k] !== undefined && q[k] !== null);
  if (/\/rrddata$/.test(path)) {
    if (keys.some((k) => k !== 'timeframe' && k !== 'cf')) return 'rrddata accepts only timeframe and cf';
    if (!RRD_TIMEFRAMES.has(String(q.timeframe))) return 'rrddata timeframe must be hour, day or week';
    if (q.cf !== undefined && q.cf !== null && !RRD_CF.has(String(q.cf))) return 'rrddata cf must be AVERAGE or MAX';
    return null;
  }
  if (/^\/nodes\/[^/]+\/tasks$/.test(path)) {
    if (keys.some((k) => k !== 'vmid' && k !== 'limit' && k !== 'typefilter')) return 'tasks accepts only vmid, limit and typefilter';
    if (q.vmid !== undefined && q.vmid !== null && !/^[0-9]{1,10}$/.test(String(q.vmid))) return 'tasks vmid must be digits';
    if (q.limit !== undefined && q.limit !== null) {
      if (!/^[0-9]{1,4}$/.test(String(q.limit))) return 'tasks limit must be a number';
      const n = Number(q.limit);
      if (n < 1 || n > 200) return 'tasks limit must be 1..200';
    }
    if (q.typefilter !== undefined && q.typefilter !== null && !/^[a-z]{1,32}$/.test(String(q.typefilter))) return 'tasks typefilter must be a lowercase word';
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// TLS pinning
// ---------------------------------------------------------------------------
function normalizeFingerprint(fp) {
  return String(fp || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

function fingerprintMatches(expected, actual) {
  const e = normalizeFingerprint(expected);
  const a = normalizeFingerprint(actual);
  return e.length === 64 && a.length === 64 && e === a;
}

let _warnedUnpinned = false;
function warnUnpinnedOnce() {
  if (_warnedUnpinned) return;
  _warnedUnpinned = true;
  console.warn('[ProxmoxApi] no tls_fingerprint set on the proxmox vault credential: TLS certificate is NOT verified (rejectUnauthorized=false). Set tls_fingerprint (SHA-256, colon hex) to pin it.');
}
function _resetWarnForTest() { _warnedUnpinned = false; }

const _agentCache = new Map();

/**
 * Shared https agent for every Proxmox REST call.
 * With a fingerprint the agent corks the socket on creation and only
 * uncorks after the peer certificate fingerprint matches, so the
 * Authorization header cannot be written to an unpinned peer. (Node skips
 * checkServerIdentity when the chain already failed, which is always the case
 * for a self-signed PVE cert, hence the secureConnect check.)
 */
function getPveAgent(fingerprint) {
  const fp = fingerprint ? normalizeFingerprint(fingerprint) : '';
  if (!fp) warnUnpinnedOnce();
  const key = fp || 'unpinned';
  if (_agentCache.has(key)) return _agentCache.get(key);

  let agent;
  if (!fp) {
    agent = new https.Agent({ rejectUnauthorized: false });
  } else {
    agent = new https.Agent({
      rejectUnauthorized: false,
      checkServerIdentity: (_host, cert) => (
        fingerprintMatches(fp, cert && cert.fingerprint256)
          ? undefined
          : new PveError('tls_fingerprint_mismatch', 'Proxmox TLS certificate fingerprint does not match the pinned tls_fingerprint')
      ),
    });
    const origCreate = agent.createConnection.bind(agent);
    agent.createConnection = function createPinnedConnection(options, cb) {
      // Never resume a TLS session: a resumed handshake carries no certificate, so
      // getPeerCertificate() is empty and a correct pin would be reported as a mismatch
      // on every second request. A full handshake is also the only way the pin is
      // actually re-checked on each connection.
      const socket = origCreate({ ...options, session: undefined }, cb);
      if (socket && typeof socket.cork === 'function') {
        socket.cork();
        socket.once('secureConnect', () => {
          let cert = null;
          try { cert = socket.getPeerCertificate(); } catch { cert = null; }
          if (fingerprintMatches(fp, cert && cert.fingerprint256)) {
            socket.uncork();
          } else {
            socket.destroy(new PveError('tls_fingerprint_mismatch', 'Proxmox TLS certificate fingerprint does not match the pinned tls_fingerprint'));
          }
        });
      }
      return socket;
    };
  }
  _agentCache.set(key, agent);
  return agent;
}

// ---------------------------------------------------------------------------
// Connection resolution (same vault lease path server.js uses)
// ---------------------------------------------------------------------------
async function defaultResolveCredential(orgId) {
  // resolveCredentialForAgent returns null without an org anyway; skip the
  // heavy agentTools load (and its side effects) in that case.
  if (!orgId) return null;
  // Lazy require: agentTools requires toolExecutors/proxmox which requires us.
  const { resolveCredentialForAgent } = require('./agentTools.js');
  return resolveCredentialForAgent(orgId, 'atlas', 'proxmox');
}

/**
 * @returns {Promise<{url:string, token:string, tlsFingerprint?:string}>}
 * @throws {PveError} not_configured | lease_blocked
 */
async function resolveConnection(orgId, opts = {}) {
  // Onboarding (lib/proxmoxOnboard.js): credentials the user is still typing in
  // are INJECTED here so they can be tested before anything reaches the vault.
  if (opts.connection) {
    const c = opts.connection;
    if (!c.url || !c.token) throw new PveError('not_configured', 'Proxmox connection is incomplete');
    return c;
  }
  const resolver = opts.resolveCredential || defaultResolveCredential;
  let conn;
  try {
    const resolved = await resolver(orgId);
    conn = resolveProxmoxConnection(resolved, opts.env || process.env);
  } catch (err) {
    if (err && err.leaseBlocked) {
      throw new PveError('lease_blocked', err.message, { leaseReason: err.leaseReason });
    }
    throw err;
  }
  if (!conn.url || !conn.token) {
    throw new PveError('not_configured', 'Proxmox API is not configured (no vault credential or env fallback)');
  }
  return conn;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------
/**
 * Single choke point. Refuses anything but GET on an allowlisted path.
 * @returns {Promise<any>} parsed `.data`
 */
async function pveRequest(method, path, query, opts = {}) {
  if (String(method).toUpperCase() !== 'GET') {
    throw new PveError('method_not_allowed', `Proxmox REST client is GET-only (refused ${String(method).toUpperCase()})`);
  }
  if (!isAllowedPath(path)) {
    throw new PveError('path_not_allowed', 'Proxmox path is not on the read allowlist');
  }
  const badQuery = validateQuery(path, query);
  if (badQuery) throw new PveError('query_not_allowed', `Proxmox query refused: ${badQuery}`);

  const conn = await resolveConnection(opts.orgId, opts);

  let base;
  try { base = new URL(conn.url); } catch {
    throw new PveError('not_configured', 'Proxmox base URL is not a valid URL');
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const target = new URL(`/api2/json${path}${qs.toString() ? `?${qs.toString()}` : ''}`, base);

  const isHttps = target.protocol === 'https:';
  const requestImpl = opts.requestImpl || (isHttps ? https.request : require('http').request);
  const reqOpts = {
    method: 'GET',
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    headers: { Accept: 'application/json', Authorization: `PVEAPIToken=${conn.token}` },
    timeout: opts.timeoutMs || REQUEST_TIMEOUT_MS,
  };
  if (isHttps) reqOpts.agent = getPveAgent(conn.tlsFingerprint);

  const { status, body } = await new Promise((resolve, reject) => {
    const req = requestImpl(reqOpts, (resp) => {
      let buf = '';
      resp.setEncoding('utf8');
      resp.on('data', (c) => { buf += c; if (buf.length > 20 * 1024 * 1024) req.destroy(new PveError('bad_response', 'Proxmox response too large')); });
      resp.on('end', () => resolve({ status: resp.statusCode, body: buf }));
      resp.on('error', (e) => reject(e));
    });
    req.on('timeout', () => req.destroy(new PveError('timeout', `Proxmox request timed out after ${reqOpts.timeout}ms`)));
    req.on('error', (e) => {
      if (e instanceof PveError) return reject(e);
      reject(new PveError('network_error', `Proxmox request failed: ${e.code || e.message}`));
    });
    req.end();
  });

  if (status < 200 || status >= 300) {
    // Do not echo the body (may contain detail); status is what matters.
    throw new PveError('http_error', `Proxmox API returned HTTP ${status}`, { status });
  }
  let parsed;
  try { parsed = JSON.parse(body); } catch {
    throw new PveError('bad_response', 'Proxmox API returned a non-JSON body');
  }
  if (!parsed || typeof parsed !== 'object' || !('data' in parsed)) {
    throw new PveError('bad_response', 'Proxmox API response has no data field');
  }
  return parsed.data;
}

/** GET a Proxmox REST path. See pveRequest. */
function pveGet(path, query, opts = {}) {
  return pveRequest('GET', path, query, opts);
}

/**
 * Should a REST-first reader answer over Bastion instead of failing? True when nothing is
 * configured, when the stored token is refused (HTTP 401/403: a broken credential must not be
 * worse than none) or when the lease is blocked. NEVER true for tls_fingerprint_mismatch (a
 * security signal: hard error, never routed around) or any other failure.
 */
function restFallsBack(err) {
  if (!err) return false;
  if (err.code === 'not_configured' || err.code === 'lease_blocked') return true;
  return err.code === 'http_error' && (err.status === 401 || err.status === 403);
}

/** The honest note for a fallback caused by a refused token, else null (not_configured etc: no note). */
function restFallbackNote(err) {
  if (err && err.code === 'http_error' && (err.status === 401 || err.status === 403)) {
    return `Proxmox API refused the stored token (HTTP ${err.status}); answered via Bastion`;
  }
  return null;
}

module.exports = {
  PveError,
  restFallsBack,
  restFallbackNote,
  pveGet,
  pveRequest,
  isAllowedPath,
  validateQuery,
  getPveAgent,
  fingerprintMatches,
  normalizeFingerprint,
  resolveConnection,
  _resetWarnForTest,
};
