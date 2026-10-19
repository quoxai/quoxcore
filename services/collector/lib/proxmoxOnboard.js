/**
 * Proxmox onboarding (DEVFLEET-ONBOARD)
 *
 * Connecting Proxmox through the generic Vault form failed on every stock
 * install: Proxmox ships a self-signed certificate, so a verifying fetch dies
 * with "fetch failed" before the token is even looked at. The Proxmox plugin
 * now owns onboarding, in four governed steps:
 *
 *   POST /api/v1/proxmox/onboard/cert  {base_url}
 *       Opens a TLS connection WITHOUT writing a single byte (so no credential
 *       can leak to an unconfirmed peer) and returns the certificate details
 *       the human must compare with `pvenode cert info` on the node.
 *   POST /api/v1/proxmox/onboard/test  {base_url, token_id, token_secret, tls_fingerprint}
 *       Calls GET /version, /cluster/status and /access/permissions through the
 *       pinned proxmoxApi client with the typed-in credentials INJECTED (the
 *       vault is not touched) and reports whether the token is read-only.
 *   POST /api/v1/proxmox/onboard/save  (same body, + allow_write)
 *       Re-tests, writes the vault credential through the auth service's own
 *       REST API with the CALLER's token (so org membership and the
 *       SECRETS_WRITE capability are enforced by auth, never bypassed), assigns
 *       it to agent atlas, then proves it by reading /version through the normal
 *       resolveProxmoxConnection path.
 *
 * Rules: org comes from the verified caller only; human org admin only; rate
 * limited; behind the collector default-deny gate (no allowlist entry). The
 * token secret is never logged, echoed, put in an error message or returned.
 * Egress: https only; loopback, link-local, metadata and reserved ranges are
 * always blocked; RFC1918/CGNAT LAN targets are allowed (a Proxmox host is a LAN
 * box by nature, like the vault's lanAllowed types). Residual (same as the other
 * egress guards): DNS rebinding between resolve and connect is not pinned.
 */

'use strict';

const dnsPromises = require('node:dns/promises');
const net = require('node:net');
const tls = require('node:tls');
const { classifyIp } = require('./quoxchatCompatLlm.js');
const { isLoopbackIp } = require('./ollamaProvider.js');
const proxmoxApi = require('./proxmoxApi.js');

const AGENT_ID = 'atlas';
const TOOL_TYPE = 'proxmox';
const CREDENTIAL_LABEL = 'Proxmox VE (Quox onboarding)';
const CERT_TIMEOUT_MS = 8000;

class OnboardError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'OnboardError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
/** @returns {string} the https origin (no path, no credentials). Throws OnboardError. */
function parseBaseUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) throw new OnboardError('missing_base_url', 'Enter the Proxmox URL, for example https://pve.example.com:8006');
  let u;
  try { u = new URL(s); } catch { throw new OnboardError('invalid_base_url', 'That is not a valid URL. Use the form https://host:8006'); }
  if (u.protocol !== 'https:') throw new OnboardError('unsupported_scheme', 'The Proxmox URL must start with https://');
  if (u.username || u.password) throw new OnboardError('credentials_in_url', 'Do not put a username or password in the URL');
  return u.origin;
}

const TOKEN_ID_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z0-9._-]+$/;

/** Validate the credential triple + pin. Returns the clean values. Throws OnboardError. */
function parseCredentialInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  const baseUrl = parseBaseUrl(b.base_url);
  const tokenId = typeof b.token_id === 'string' ? b.token_id.trim() : '';
  if (!TOKEN_ID_RE.test(tokenId)) {
    throw new OnboardError('invalid_token_id', 'The token id looks like user@realm!name, for example root@pam!quox-ro');
  }
  const tokenSecret = typeof b.token_secret === 'string' ? b.token_secret.trim() : '';
  if (!tokenSecret || tokenSecret.length > 200 || /\s/.test(tokenSecret)) {
    throw new OnboardError('invalid_token_secret', 'Enter the token secret Proxmox showed when you created the token');
  }
  const fp = proxmoxApi.normalizeFingerprint(b.tls_fingerprint);
  if (fp.length !== 64) {
    throw new OnboardError('tls_fingerprint_required', 'Fetch and confirm the certificate fingerprint first (step 3)');
  }
  return { baseUrl, tokenId, tokenSecret, tlsFingerprint: colonHex(fp) };
}

function colonHex(hex64) {
  return hex64.match(/.{2}/g).join(':');
}

// ---------------------------------------------------------------------------
// Egress guard
// ---------------------------------------------------------------------------
/**
 * Resolve and vet the target. https origin in, { host, port, ips } out.
 * Blocks loopback, link-local, metadata and reserved ranges; admits LAN.
 */
async function assertProxmoxEgress(origin, { resolver = dnsPromises, allowLoopbackForTest = false } = {}) {
  const u = new URL(origin);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port || 443);
  let ips;
  if (net.isIP(host)) ips = [host];
  else {
    try { ips = (await resolver.lookup(host, { all: true })).map((r) => r.address); } catch {
      throw new OnboardError('blocked_egress', `Could not resolve ${host}. Check the hostname.`);
    }
  }
  if (!ips.length) throw new OnboardError('blocked_egress', `No address found for ${host}`);
  if (!allowLoopbackForTest && ips.some((ip) => isLoopbackIp(ip))) {
    throw new OnboardError('blocked_egress', 'Loopback addresses are not allowed. Use the LAN address of the Proxmox host.');
  }
  if (ips.some((ip) => classifyIp(ip) === 'hard')) {
    throw new OnboardError('blocked_egress', 'That address is link-local or reserved and is not allowed.');
  }
  return { host, port, ips };
}

// ---------------------------------------------------------------------------
// Step 3: certificate (never writes a byte)
// ---------------------------------------------------------------------------
function nameToString(n) {
  if (!n || typeof n !== 'object') return '';
  return Object.entries(n).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : v}`).join(', ');
}

async function fetchCertificate(baseUrl, opts = {}) {
  const origin = parseBaseUrl(baseUrl);
  const { host, port, ips } = await assertProxmoxEgress(origin, opts);
  const tlsConnect = opts.tlsConnect || tls.connect;
  const timeoutMs = opts.timeoutMs || CERT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    let sock;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      try { if (sock) sock.destroy(); } catch { /* already gone */ }
      fn(v);
    };
    try {
      sock = tlsConnect({
        host: ips[0],
        port,
        servername: net.isIP(host) ? undefined : host,
        rejectUnauthorized: false,
        timeout: timeoutMs,
      });
    } catch {
      return reject(new OnboardError('connect_failed', 'Could not open a connection to that host', 502));
    }
    sock.once('secureConnect', () => {
      let cert = null;
      try { cert = sock.getPeerCertificate(); } catch { cert = null; }
      if (!cert || !cert.fingerprint256) {
        return done(reject, new OnboardError('no_certificate', 'The host did not present a certificate', 502));
      }
      const subject = nameToString(cert.subject);
      const issuer = nameToString(cert.issuer);
      return done(resolve, {
        fingerprint256: cert.fingerprint256,
        subject,
        issuer,
        valid_to: cert.valid_to || null,
        self_signed: subject === issuer,
      });
    });
    sock.once('timeout', () => done(reject, new OnboardError('timeout', `No TLS answer from the host within ${Math.round(timeoutMs / 1000)}s`, 504)));
    sock.once('error', (e) => done(reject, new OnboardError('connect_failed', `Could not connect: ${(e && e.code) || 'network error'}`, 502)));
  });
}

// ---------------------------------------------------------------------------
// Step 4: test (injected credentials, pinned client, GET only)
// ---------------------------------------------------------------------------
/**
 * PVEAuditor and friends all end in ".Audit". Anything else a token holds can
 * change something (or open a console), so it is reported as write-capable:
 * VM.PowerMgmt, VM.Allocate, VM.Config.*, Sys.Modify, Datastore.Allocate*,
 * Permissions.Modify, and so on.
 */
function summarisePermissions(perms) {
  const all = new Set();
  const paths = perms && typeof perms === 'object' ? Object.entries(perms) : [];
  for (const [, privs] of paths) {
    if (!privs || typeof privs !== 'object') continue;
    for (const [name, on] of Object.entries(privs)) if (on) all.add(name);
  }
  const sorted = [...all].sort();
  const write = sorted.filter((p) => !p.endsWith('.Audit'));
  return {
    privilege_count: sorted.length,
    paths: paths.length,
    audit_privileges: sorted.filter((p) => p.endsWith('.Audit')),
    write_privileges: write.slice(0, 60),
    read_only: write.length === 0,
  };
}

function mapPveError(err) {
  if (err instanceof OnboardError) return err;
  const code = err && err.code;
  if (code === 'http_error') {
    const st = err.status;
    if (st === 401) return new OnboardError('token_rejected', 'Proxmox rejected the token (HTTP 401). Check the token id and secret.', 422);
    if (st === 403) return new OnboardError('token_forbidden', 'The token is valid but has no permission to read the cluster (HTTP 403). Run the ACL command from step 1.', 422);
    return new OnboardError('proxmox_error', `Proxmox answered HTTP ${st}`, 502);
  }
  if (code === 'tls_fingerprint_mismatch') {
    return new OnboardError('tls_fingerprint_mismatch', 'The certificate on that host does not match the fingerprint you confirmed. Fetch it again and re-check it on the node.', 409);
  }
  if (code === 'timeout') return new OnboardError('timeout', 'The Proxmox host did not answer in time', 504);
  if (code === 'network_error') return new OnboardError('network_error', 'Could not reach the Proxmox host', 502);
  if (code === 'bad_response') return new OnboardError('bad_response', 'The host answered, but it does not look like a Proxmox API', 502);
  return new OnboardError('proxmox_error', 'The connection test failed', 502);
}

async function runTest(input, deps = {}) {
  const c = parseCredentialInput(input);
  await assertProxmoxEgress(c.baseUrl, { resolver: deps.resolver, ...(deps.egressOpts || {}) });
  const pveGet = deps.pveGet || proxmoxApi.pveGet;
  const o = { connection: { url: c.baseUrl, token: `${c.tokenId}=${c.tokenSecret}`, tlsFingerprint: c.tlsFingerprint } };
  let version; let status; let perms;
  try {
    version = await pveGet('/version', undefined, o);
    status = await pveGet('/cluster/status', undefined, o);
    perms = await pveGet('/access/permissions', undefined, o);
  } catch (e) {
    throw mapPveError(e);
  }
  const nodes = Array.isArray(status) ? status.filter((r) => r && r.type === 'node').length : 0;
  const p = summarisePermissions(perms);
  return {
    version: version && version.version ? String(version.version) : null,
    release: version && version.release ? String(version.release) : null,
    node_count: nodes,
    privileges: {
      count: p.privilege_count,
      paths: p.paths,
      audit: p.audit_privileges,
      write: p.write_privileges,
    },
    read_only: p.read_only,
  };
}

// ---------------------------------------------------------------------------
// Step 5: save (vault write through the auth service REST API)
// ---------------------------------------------------------------------------
function createVaultClient({ authBaseUrl, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  async function call(method, path, token, body) {
    let resp;
    try {
      resp = await fetchImpl(`${authBaseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new OnboardError('vault_unreachable', 'The vault service did not answer', 502);
    }
    let data = null;
    try { data = await resp.json(); } catch { data = null; }
    return { ok: resp.ok, status: resp.status, data };
  }
  const fail = (what, r) => {
    const msg = r.data && (r.data.message || r.data.error);
    const status = [400, 403, 409].includes(r.status) ? r.status : 502;
    return new OnboardError('vault_rejected', `${what}: ${typeof msg === 'string' ? msg : `HTTP ${r.status}`}`, status);
  };
  return {
    async listProxmox(orgId, token) {
      const r = await call('GET', `/orgs/${encodeURIComponent(orgId)}/integrations?type=${TOOL_TYPE}`, token);
      if (!r.ok) throw fail('Could not list vault credentials', r);
      return (r.data && r.data.credentials) || [];
    },
    async create(orgId, token, payload) {
      const r = await call('POST', `/orgs/${encodeURIComponent(orgId)}/integrations`, token, payload);
      if (!r.ok) throw fail('The vault refused the credential', r);
      return r.data;
    },
    async update(orgId, token, id, payload) {
      const r = await call('PUT', `/orgs/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(id)}`, token, payload);
      if (!r.ok) throw fail('The vault refused the credential update', r);
      return r.data;
    },
    async listAssignments(orgId, token) {
      const r = await call('GET', `/orgs/${encodeURIComponent(orgId)}/agent-credential-assignments?agent_id=${AGENT_ID}&tool_type=${TOOL_TYPE}`, token);
      if (!r.ok) throw fail('Could not read agent assignments', r);
      return (r.data && r.data.assignments) || [];
    },
    async assign(orgId, token, body) {
      const r = await call('POST', `/orgs/${encodeURIComponent(orgId)}/agent-credential-assignments`, token, body);
      if (!r.ok && r.status !== 409) throw fail('Could not assign the credential to the Proxmox agent', r);
      return r.data;
    },
  };
}

async function saveCredential({ orgId, token, actor, input, allowWrite }, deps) {
  const c = parseCredentialInput(input);
  const result = await runTest(input, deps);
  if (!result.read_only && !allowWrite) {
    throw new OnboardError('write_privileges', 'This token can change things in Proxmox. Tick "use anyway" to save it, or create the read-only token from step 1.', 409, { write_privileges: result.privileges.write });
  }
  if (!token) throw new OnboardError('token_required', 'A signed-in session is required to write to the vault', 401);

  const vault = deps.vault;
  const credentials = {
    base_url: c.baseUrl,
    token_id: c.tokenId,
    token_secret: c.tokenSecret,
    tls_fingerprint: c.tlsFingerprint,
  };
  const existing = (await vault.listProxmox(orgId, token)).find((x) => x && x.label === CREDENTIAL_LABEL && x.integration_type === TOOL_TYPE);
  let credentialId;
  if (existing) {
    await vault.update(orgId, token, existing.id, { credentials, is_default: true });
    credentialId = existing.id;
  } else {
    const created = await vault.create(orgId, token, {
      integration_type: TOOL_TYPE,
      label: CREDENTIAL_LABEL,
      credentials,
      description: 'Created by Proxmox plugin onboarding. Pinned to the confirmed TLS fingerprint.',
      is_default: true,
    });
    credentialId = created && created.id;
    if (!credentialId) throw new OnboardError('vault_rejected', 'The vault did not return a credential id', 502);
  }

  const assignments = await vault.listAssignments(orgId, token);
  if (!assignments.some((a) => a && a.credential_id === credentialId)) {
    const top = assignments.reduce((m, a) => Math.max(m, Number(a && a.priority) || 0), 0);
    await vault.assign(orgId, token, { agent_id: AGENT_ID, credential_id: credentialId, tool_type: TOOL_TYPE, priority: assignments.length ? top + 1 : 0 });
  }

  // Prove the SAVED credential works through the normal resolution path.
  const pveGet = deps.pveGet || proxmoxApi.pveGet;
  try {
    await pveGet('/version', undefined, { orgId });
  } catch (e) {
    const m = mapPveError(e);
    throw new OnboardError('verify_failed', `Saved, but the stored credential did not work when read back: ${m.message}`, 502, { credential_id: credentialId });
  }

  try {
    deps.emit && deps.emit('quox.proxmox.onboard.connected', orgId, {
      credential_id: credentialId,
      base_url: c.baseUrl,
      tls_fingerprint: c.tlsFingerprint,
      version: result.version,
      node_count: result.node_count,
      read_only: result.read_only,
      write_override: !result.read_only,
    }, actor);
  } catch { /* evidence never blocks */ }

  return { ok: true, credential_id: credentialId, read_only: result.read_only };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
function bearer(req) {
  const h = req.headers && req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  const m = /(?:^|;\s*)access_token=([^;]+)/.exec((req.headers && req.headers.cookie) || '');
  return m ? decodeURIComponent(m[1]) : '';
}

function registerProxmoxOnboardRoutes(app, { auth, requireHumanAdmin, limiter, emit, vault, pveGet, resolver, tlsConnect, egressOpts }) {
  const limit = limiter || ((_req, _res, next) => next());
  const deps = { vault, pveGet, resolver, emit, egressOpts };

  function guard(req, res) {
    if (!requireHumanAdmin(req, res, 'Only a human org admin can connect Proxmox')) return null;
    const orgId = (req.user && (req.user.org_id || req.user.orgId)) || null;
    if (!orgId) { res.status(400).json({ error: 'org_required' }); return null; }
    return orgId;
  }
  function fail(res, e) {
    if (e instanceof OnboardError) {
      return res.status(e.status).json({
        ok: false, error: e.code, message: e.message,
        ...(e.write_privileges ? { write_privileges: e.write_privileges } : {}),
        ...(e.credential_id ? { credential_id: e.credential_id } : {}),
      });
    }
    console.error('[ProxmoxOnboard] route error:', e && e.code ? e.code : 'unexpected');
    return res.status(503).json({ ok: false, error: 'onboard_unavailable', message: 'Proxmox onboarding is unavailable right now' });
  }
  const actorOf = (req) => String((req.user && (req.user.id || req.user.sub)) || 'unknown');

  app.post('/api/v1/proxmox/onboard/cert', auth(), limit, async (req, res) => {
    if (!guard(req, res)) return undefined;
    try {
      const cert = await fetchCertificate((req.body || {}).base_url, { resolver, tlsConnect, ...(egressOpts || {}) });
      return res.json(cert);
    } catch (e) { return fail(res, e); }
  });

  app.post('/api/v1/proxmox/onboard/test', auth(), limit, async (req, res) => {
    if (!guard(req, res)) return undefined;
    try {
      return res.json({ ok: true, ...(await runTest(req.body || {}, deps)) });
    } catch (e) { return fail(res, e); }
  });

  app.post('/api/v1/proxmox/onboard/save', auth(), limit, async (req, res) => {
    const orgId = guard(req, res);
    if (!orgId) return undefined;
    try {
      const body = req.body || {};
      return res.json(await saveCredential({
        orgId, token: bearer(req), actor: actorOf(req), input: body, allowWrite: body.allow_write === true,
      }, deps));
    } catch (e) { return fail(res, e); }
  });
}

module.exports = {
  OnboardError,
  AGENT_ID,
  CREDENTIAL_LABEL,
  parseBaseUrl,
  parseCredentialInput,
  assertProxmoxEgress,
  fetchCertificate,
  summarisePermissions,
  runTest,
  createVaultClient,
  saveCredential,
  registerProxmoxOnboardRoutes,
};
