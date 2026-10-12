'use strict';

/**
 * ContactsQ CardDAV credential resolver.
 *
 * Resolves a `carddav_account` vault credential (integration type icloud_contacts or carddav) to its plaintext
 * username/password JUST IN TIME, via the SAME auth internal decrypt endpoint InboxQ and the email tools use
 * (lib/inboxq/credential.js). The lease/approval gate on the auth side decides whether the decrypt is allowed.
 * The plaintext is used only to build one Basic auth header and is NEVER logged, returned to a client, or
 * written to the ContactsQ store.
 */

const { buildInternalServiceHeaders } = require('../internalServiceHeaders');
const { AUTH_BASE_URL } = require('../inboxq/credential');

const ICLOUD_URL = 'https://contacts.icloud.com';
const TYPES = ['icloud_contacts', 'carddav'];

/** @throws Error('credential_resolve_failed' | 'lease_required' | 'credential_incomplete' | 'credential_wrong_kind') */
async function resolveCarddavCredential(orgId, credentialId, { agentId = null, fetchImpl = fetch } = {}) {
  if (!orgId || !credentialId) throw new Error('credential_resolve_failed');
  const url = `${AUTH_BASE_URL}/setup/internal/credential-decrypt/${encodeURIComponent(credentialId)}`
    + `?org_id=${encodeURIComponent(orgId)}${agentId ? `&agent_id=${encodeURIComponent(agentId)}` : ''}`;
  let resp;
  try {
    resp = await fetchImpl(url, { headers: buildInternalServiceHeaders(), signal: AbortSignal.timeout(15000) });
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
  const type = data?.integration_type || null;
  if (!TYPES.includes(type)) throw new Error('credential_wrong_kind');
  if (!c.username || !c.password) throw new Error('credential_incomplete');
  return {
    integration_type: type,
    username: String(c.username),
    password: String(c.password),
    server_url: c.server_url ? String(c.server_url) : (type === 'icloud_contacts' ? ICLOUD_URL : null),
  };
}

module.exports = { resolveCarddavCredential, ICLOUD_URL, TYPES };
