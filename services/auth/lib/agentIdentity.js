/**
 * lib/agentIdentity.js — QUOXPERTICUS P2: the governed agent-identity mint.
 *
 * An agent identity is a users row typed actor_type='agent' (it can never
 * log in interactively, p2ActorTypeIdentity), an active org membership, and
 * an mcp_token BOUND to the agent id on the token row itself. Minted only
 * by an instance admin (routes/admin.js POST /agent-identities); the raw
 * token is returned exactly once to that admin, whose job is to place it in
 * the resident supervisor's root-only config. No service or agent path can
 * mint one.
 */

import { randomBytes, createHash } from 'crypto';
import { generateId } from '../utils/crypto.js';

const AGENT_EMAIL_DOMAIN = 'agents.quox.local';

// quox#576 flaw #2: a custom/org assistant's real primary key is a ULID
// (routes/assistants.js: `const id = ulid()`, always UPPERCASE Crockford
// base32 — 26 chars, alphabet 0-9A-HJKMNP-TV-Z, excludes I/L/O/U). Blindly
// lowercasing every agent id (below) corrupted that id before it was ever
// stored on an attach lease or stamped into the attach JWT's `agent_id`
// claim, so auth's case-SENSITIVE `WHERE id = ?` lookup
// (routes/internal-assistants.js) could never match — attach-by-ULID only
// ever worked by luck when the caller typed the (already-lowercase) slug
// instead. A ULID-shaped input is now canonicalized to UPPERCASE (matched
// case-insensitively) instead of lowercased; every other agent id (core
// registry ids, custom-assistant slugs — never 26-char ULID-shaped) is
// unaffected.
const ULID_RE = /^[0-9A-Z]{26}$/i;

// quox#1025: ONE agent-id rule for agent create, attach and the kit. Create used to allow only
// underscores and attach only hyphens, so a custom agent with any separator (and the core registry's
// underscore ids, e.g. recon_specialist) could never attach. Both separators are valid; the first
// character is a letter or digit; at most 64 characters.
export const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export function isValidAgentId(agentId) {
  return typeof agentId === 'string' && AGENT_ID_RE.test(agentId);
}

export function normalizeAgentId(agentId) {
  const raw = String(agentId ?? '').trim();
  if (ULID_RE.test(raw)) {
    return raw.toUpperCase();
  }
  const norm = raw.toLowerCase();
  if (!isValidAgentId(norm)) {
    throw new Error(`invalid agent_id '${agentId}': lowercase letters, digits, hyphens and underscores only (starting with a letter or digit, at most 64)`);
  }
  return norm;
}

/**
 * Find-or-create the actor_type='agent' users row for a registry agent id,
 * plus an active org membership. Shared by mintAgentIdentity (below, mints
 * an mcp_token too) and lib/agentAttachStore.js (QUOXIDENTITY P1 attach
 * lease, mints a short-TTL JWT instead, no mcp_token) — this is the "user
 * creation helper" both are told to reuse rather than fork, so the same
 * registry agent id always resolves to the same users row regardless of
 * which caller provisioned it first.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{agentId: string, orgId: string, displayName?: string, membershipRole?: string}} opts
 * @returns {{user: object, agentId: string}}
 */
export function ensureAgentUser(db, { agentId, orgId, displayName, membershipRole = 'member' } = {}) {
  const agent = normalizeAgentId(agentId);
  if (!orgId || typeof orgId !== 'string') {
    throw new Error('org_id is required');
  }
  const org = db.prepare('SELECT id FROM orgs WHERE id = ?').get(orgId);
  if (!org) {
    throw new Error(`unknown org_id '${orgId}'`);
  }

  const email = `${agent}@${AGENT_EMAIL_DOMAIN}`;

  // Find or create the agent-typed user.
  let user = db.prepare('SELECT * FROM users WHERE primary_email = ?').get(email);
  if (!user) {
    const userId = generateId();
    db.prepare(`
      INSERT INTO users (id, primary_email, display_name, status, actor_type)
      VALUES (?, ?, ?, 'active', 'agent')
    `).run(userId, email, displayName || agent);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  } else if (user.actor_type !== 'agent') {
    // A human user squatting the agent email is a configuration error, not
    // something to silently convert.
    throw new Error(`user ${email} exists with actor_type '${user.actor_type}', refusing to bind`);
  }

  // Ensure the org membership.
  const membership = db.prepare(
    'SELECT id, status FROM org_memberships WHERE org_id = ? AND user_id = ?'
  ).get(orgId, user.id);
  if (!membership) {
    db.prepare(`
      INSERT INTO org_memberships (id, org_id, user_id, role, status)
      VALUES (?, ?, ?, ?, 'active')
    `).run('MEM_' + randomBytes(8).toString('hex').toUpperCase(), orgId, user.id, membershipRole);
  }

  return { user, agentId: agent };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{agentId: string, orgId: string, rotate?: boolean}} opts
 * @returns {{user_id: string, token_id: string, raw_token: string, agent_id: string, rotated: boolean}}
 */
export function mintAgentIdentity(db, { agentId, orgId, rotate = false } = {}) {
  const { user, agentId: agent } = ensureAgentUser(db, {
    agentId,
    orgId,
    displayName: `${normalizeAgentId(agentId).toUpperCase()} (resident agent)`,
  });

  // One live token per agent identity per org: refuse a double-mint unless
  // rotating, and revoke the old token on rotate so exactly one is live.
  const live = db.prepare(`
    SELECT id FROM mcp_tokens
    WHERE user_id = ? AND org_id = ? AND agent_id = ? AND revoked_at IS NULL
  `).all(user.id, orgId, agent);
  let rotated = false;
  if (live.length > 0) {
    if (!rotate) {
      throw new Error(`agent identity '${agent}' already exists with a live token in org ${orgId}; pass rotate to reissue`);
    }
    for (const t of live) {
      // Fractional seconds: the schema CHECKs revoked_at > created_at
      // STRICTLY, and a same-second mint+rotate would tie with plain
      // datetime('now').
      db.prepare("UPDATE mcp_tokens SET revoked_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?").run(t.id);
    }
    rotated = true;
  }

  // Same token format as the user-facing mint (routes/mcp-tokens.js).
  const rawToken = `qmcp_${randomBytes(24).toString('base64url')}`;
  const tokenId = generateId();
  db.prepare(`
    INSERT INTO mcp_tokens (id, user_id, org_id, token_hash, label, agent_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(tokenId, user.id, orgId, createHash('sha256').update(rawToken).digest('hex'), `agent:${agent}`, agent);

  return { user_id: user.id, token_id: tokenId, raw_token: rawToken, agent_id: agent, rotated };
}

/**
 * QUOXMIND #1111: the agent identities that are active members of one org.
 * Returns [{ id, agent_id }] where agent_id is the registry id taken from the
 * agent email local part. Never returns human users.
 */
export function listOrgAgentUsers(db, orgId) {
  if (!orgId || typeof orgId !== 'string') return [];
  return db.prepare(`
    SELECT u.id, u.primary_email FROM users u
    JOIN org_memberships m ON m.user_id = u.id
    WHERE m.org_id = ? AND m.status = 'active' AND u.actor_type = 'agent'
    ORDER BY u.id
  `).all(orgId).map((r) => ({
    id: r.id,
    agent_id: String(r.primary_email || '').endsWith(`@${AGENT_EMAIL_DOMAIN}`) ? r.primary_email.slice(0, -(AGENT_EMAIL_DOMAIN.length + 1)) : null,
  }));
}
