'use strict';

/**
 * InboxQ credential resolver.
 *
 * Resolves an `email_account` vault credential to its plaintext IMAP/SMTP
 * fields, JUST IN TIME, via the SAME auth internal decrypt endpoint every
 * other credentialed collector tool uses (email_read/email_send/browser_login).
 * The lease/approval gate on the auth side (VAULT-P5.G) decides whether the
 * decrypt is allowed for this org (+ optional agent). The plaintext is used
 * only to open the IMAP connection and is NEVER logged, returned to a client,
 * or written to the InboxQ store.
 */

const { buildInternalServiceHeaders } = require('../internalServiceHeaders');

const AUTH_BASE_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}/api`;

/**
 * @param {string} orgId
 * @param {string} credentialId
 * @param {object} [opts] { agentId, fetchImpl }
 * @returns {Promise<{imap_host,imap_port,username,password,smtp_host,smtp_port,smtp_secure,from}>}
 * @throws Error('credential_resolve_failed' | 'lease_required' | 'credential_incomplete')
 */
async function resolveEmailCredential(orgId, credentialId, { agentId = null, fetchImpl = fetch } = {}) {
  if (!orgId || !credentialId) throw new Error('credential_resolve_failed');

  const url = `${AUTH_BASE_URL}/setup/internal/credential-decrypt/${encodeURIComponent(credentialId)}`
    + `?org_id=${encodeURIComponent(orgId)}${agentId ? `&agent_id=${encodeURIComponent(agentId)}` : ''}`;

  let resp;
  try {
    resp = await fetchImpl(url, {
      headers: buildInternalServiceHeaders(),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('credential_resolve_failed');
  }

  if (resp.status === 403) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data?.reason || 'lease_required');
  }
  if (!resp.ok) throw new Error('credential_resolve_failed');

  const data = await resp.json().catch(() => ({}));
  const c = data?.credentials || data?.credential || null;
  if (!c) throw new Error('credential_resolve_failed');

  const out = {
    imap_host: c.imap_host || null,
    imap_port: c.imap_port || 993,
    username: c.username || null,
    password: c.password || null,
    smtp_host: c.smtp_host || null,
    smtp_port: c.smtp_port || 465,
    smtp_secure: c.smtp_secure !== false,
    from: c.from || c.username || null,
  };
  return out;
}

module.exports = { resolveEmailCredential, AUTH_BASE_URL };
