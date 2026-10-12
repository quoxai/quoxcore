/**
 * Security Tool Executor
 *
 * Native executor for security_audit and ssl_certificates tools.
 * Replaces security-audit.json n8n workflow.
 * Security audit queries the auth service database.
 * SSL certificates check via bastion SSH.
 */

const { isSafeShellArg } = require('../shellSafe.js');

/**
 * security_audit — query audit_events from auth service
 */
async function securityAudit(callBastion, input) {
  const hours = Math.min(parseInt(input.hours) || 24, 168); // max 7 days
  const limit = Math.min(parseInt(input.limit) || 100, 500);
  const eventTypes = input.event_types || null;
  const orgId = input.org_id || null;

  // QUOXTRUST FND_..SHGH (shell-injection): event_types/org_id/db_path are interpolated into a
  // sqlite3 command sent to the bastion. SQL-escaping (doubling quotes) does NOT neutralise
  // shell $()/backtick inside the surrounding double quotes, so validate each against a strict
  // allowlist and REFUSE before building the command. (These are the SHELL guard; the existing
  // '' -> '' SQL escaping stays for SQL correctness.)
  if (Array.isArray(eventTypes)) {
    for (const t of eventTypes) {
      if (!isSafeShellArg('eventtype', String(t))) {
        return { success: false, error: 'invalid_event_type', detail: 'event_types entries must be dotted AEE actions (injection guard)' };
      }
    }
  }
  if (!isSafeShellArg('orgid', orgId)) {
    return { success: false, error: 'invalid_org_id', detail: 'org_id contains characters not allowed in a shell argument (injection guard)' };
  }
  if (!isSafeShellArg('path', input.db_path)) {
    return { success: false, error: 'invalid_db_path', detail: 'db_path contains characters not allowed in a shell argument (injection guard)' };
  }

  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  // Build SQL query
  let whereClause = `created_at > '${since}'`;
  if (eventTypes && Array.isArray(eventTypes)) {
    const types = eventTypes.map(t => `'${t.replace(/'/g, "''")}'`).join(',');
    whereClause += ` AND action IN (${types})`;
  }
  if (orgId) {
    whereClause += ` AND org_id = '${orgId.replace(/'/g, "''")}'`;
  }

  // Query auth service database via bastion SSH to auth host
  const authHost = input.auth_host || 'localhost';
  const dbPath = input.db_path || '/opt/quoxcore/services/auth/data/auth.db';
  const cmd = `sqlite3 -json ${dbPath} "SELECT id, action, actor_type, actor_id, target_type, target_id, status, ip_address, created_at, metadata_json FROM audit_events WHERE ${whereClause} ORDER BY created_at DESC LIMIT ${limit}"`;

  const result = await callBastion(authHost, cmd);
  if (!result.success) {
    // Honest failure regardless of whether stdout/output is non-empty — a
    // non-zero exit that still printed partial (even well-formed) output is
    // still a failure (error-body-as-data bug, the mikrotik lesson).
    return { success: false, error: 'Failed to query audit database', details: result.error };
  }

  const raw = result.output || result.stdout || '[]';
  let events;
  try {
    events = JSON.parse(raw);
  } catch {
    return { success: false, error: 'Failed to parse audit data', raw: raw.substring(0, 500) };
  }

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
    query: { hours, since, limit },
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
