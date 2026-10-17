/**
 * Security Tool Executor
 *
 * Native executor for security_audit and ssl_certificates tools.
 * Replaces security-audit.json n8n workflow.
 * Security audit reads the auth service's org audit API as the caller (quox#1106).
 * SSL certificates check via bastion SSH.
 */

const { isSafeShellArg } = require('../shellSafe.js');

/**
 * security_audit — query audit_events from auth service
 */
async function securityAudit(callBastion, input, ctx = {}, deps = {}) { // eslint-disable-line no-unused-vars
  const hours = Math.min(parseInt(input.hours) || 24, 168); // max 7 days
  const limit = Math.min(parseInt(input.limit) || 100, 500);
  const eventTypes = Array.isArray(input.event_types) && input.event_types.length ? input.event_types : null;
  // trust-c1 MED (FND_01M4Z0E2KP7KRPB6808P7KRPB6): org scope is the CALLER's org, never a client-supplied
  // one. Only an instance admin may name another org. quox#1106: auth's audit route is per org, so there
  // is no "all orgs" read any more; an admin with no org named reads their own.
  const isInstanceAdmin = ctx.isInstanceAdmin === true || ctx.role === 'instance_admin';
  const orgId = (isInstanceAdmin && input.org_id) || ctx.orgId || null;
  if (!orgId) {
    return { success: false, error: 'org_context_required', detail: 'security_audit is scoped to your organization and no org context was resolved; it will not read across orgs.' };
  }
  if (Array.isArray(eventTypes)) {
    for (const t of eventTypes) {
      if (!isSafeShellArg('eventtype', String(t))) {
        return { success: false, error: 'invalid_event_type', detail: 'event_types entries must be dotted AEE actions' };
      }
    }
  }
  if (!isSafeShellArg('orgid', orgId)) {
    return { success: false, error: 'invalid_org_id', detail: 'org_id contains characters not allowed' };
  }
  // quox#1106: read auth's own GET /api/orgs/:orgId/audit AS THE CALLER (their bearer), so auth enforces
  // membership and ORG_VIEW_AUDIT. Never a service key: it would skip the capability check.
  if (!ctx.token) {
    return { success: false, error: 'caller_token_required', detail: 'security_audit reads the audit log as the signed-in caller; no caller token was available on this turn.' };
  }
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const q = new URLSearchParams({ from_date: since, limit: String(limit) });
  if (eventTypes && eventTypes.length === 1) q.set('action', String(eventTypes[0]));
  const authUrl = deps.authUrl || process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const doFetch = deps.fetch || globalThis.fetch;
  let resp;
  try {
    resp = await doFetch(`${authUrl}/api/orgs/${encodeURIComponent(orgId)}/audit?${q}`, {
      headers: { Authorization: `Bearer ${ctx.token}` }, signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return { success: false, error: 'Failed to query audit database', details: err.message };
  }
  // An error body is not data: check the status before reading events.
  if (resp.status === 401 || resp.status === 403) {
    return { success: false, error: 'audit_access_denied', status: resp.status, detail: 'The audit log needs the org.view_audit capability (owner, admin or auditor) in this organization.' };
  }
  if (!resp.ok) return { success: false, error: 'Failed to query audit database', status: resp.status };
  let body;
  try { body = await resp.json(); } catch { return { success: false, error: 'Failed to parse audit data' }; }
  let events = (Array.isArray(body && body.events) ? body.events : []).map((e) => ({
    id: e.id, action: e.action, actor_type: e.actor_type, actor_id: e.actor_id, target_type: e.target_type,
    target_id: e.target_id, status: e.status, ip_address: e.ip_address, created_at: e.created_at, metadata_json: e.metadata_json,
  }));
  if (eventTypes && eventTypes.length > 1) events = events.filter((e) => eventTypes.includes(e.action));

  // Analyze events
  const byAction = {};
  for (const e of events) {
    byAction[e.action] = (byAction[e.action] || 0) + 1;
  }

  // Find suspicious patterns
  const failedLogins = events.filter(e => e.action === 'auth.login_failed');
  const byIp = {};
  for (const e of failedLogins) {
    if (e.ip_address) {
      byIp[e.ip_address] = (byIp[e.ip_address] || 0) + 1;
    }
  }

  const suspiciousIps = Object.entries(byIp)
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([ip, attempts]) => ({ ip, attempts }));

  return {
    success: true,
    query: { hours, since, limit, org_id: orgId },
    summary: {
      totalEvents: events.length,
      byAction,
      failedLoginAttempts: failedLogins.length,
      suspiciousIps
    },
    events: events.slice(0, 50) // Return first 50 events in response
  };
}

/**
 * ssl_certificates — check SSL certificate status via bastion SSH
 */
async function sslCertificates(callBastion, input) {
  const host = input.host || 'gw-01';
  const domain = input.domain;

  if (!domain) {
    return { success: false, error: 'Missing required field: domain' };
  }
  // QUOXTRUST FND_..SHGH (shell-injection): domain is interpolated twice into an openssl
  // command sent to the bastion; validate + REFUSE on any shell metachar before use.
  if (!isSafeShellArg('host', domain)) {
    return { success: false, error: 'invalid_domain', detail: 'domain must be a hostname (injection guard)' };
  }

  const cmd = `echo | openssl s_client -servername ${domain} -connect ${domain}:443 2>/dev/null | openssl x509 -noout -dates -subject -issuer 2>/dev/null`;

  const result = await callBastion(host, cmd);
  if (!result.success) {
    // Honest failure regardless of whether stdout/output is non-empty — see
    // systemAdmin's identical fix for the same defect class.
    return result;
  }

  const raw = result.output || result.stdout || '';
  return parseCertificate(raw, domain);
}

function parseCertificate(raw, domain) {
  const lines = raw.trim().split('\n');
  const cert = { domain };

  for (const line of lines) {
    if (line.startsWith('notBefore=')) {
      cert.notBefore = line.replace('notBefore=', '').trim();
    } else if (line.startsWith('notAfter=')) {
      cert.notAfter = line.replace('notAfter=', '').trim();
    } else if (line.startsWith('subject=')) {
      cert.subject = line.replace('subject=', '').trim();
    } else if (line.startsWith('issuer=')) {
      cert.issuer = line.replace('issuer=', '').trim();
    }
  }

  // Calculate days until expiry
  if (cert.notAfter) {
    const expiryDate = new Date(cert.notAfter);
    const now = new Date();
    cert.daysUntilExpiry = Math.floor((expiryDate - now) / (1000 * 60 * 60 * 24));
    cert.expired = cert.daysUntilExpiry < 0;
    cert.expiringSoon = cert.daysUntilExpiry >= 0 && cert.daysUntilExpiry < 30;
  }

  return {
    success: true,
    certificate: cert
  };
}

module.exports = { securityAudit, sslCertificates };
