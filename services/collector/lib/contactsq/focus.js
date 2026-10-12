'use strict';

/**
 * ContactsQ dashboard focus (P8B): the contact a human currently has open in the
 * dashboard, so an attached agent can resolve "this person / them". In-memory only,
 * per org, latest per user, 30 minute TTL. Ids only: never persisted, no PII, no
 * evidence. A process restart forgets everything, which is the intended behaviour.
 */

const TTL_MS = 30 * 60 * 1000;
const MAX_USERS_PER_ORG = 200;
const byOrg = new Map(); // orgId -> Map(userId -> { contact_id, at })

function prune(users, now) {
  for (const [u, f] of users) if (now - f.at > TTL_MS) users.delete(u);
}

/** Record the focus for one user. Returns false when nothing changed (same contact, so no refresh needed). */
function setFocus(orgId, userId, contactId, now = Date.now()) {
  if (!orgId || !userId || !contactId) return false;
  let users = byOrg.get(orgId);
  if (!users) { users = new Map(); byOrg.set(orgId, users); }
  prune(users, now);
  if (users.size >= MAX_USERS_PER_ORG && !users.has(userId)) return false;
  users.set(userId, { contact_id: String(contactId), at: now });
  return true;
}

/** Most recent live focus in the org: { contact_id, user_id, age_seconds } or null. */
function latestFocus(orgId, now = Date.now()) {
  const users = byOrg.get(orgId);
  if (!users) return null;
  prune(users, now);
  let best = null;
  for (const [u, f] of users) if (!best || f.at > best.at) best = { user_id: u, ...f };
  if (!users.size) byOrg.delete(orgId);
  return best ? { contact_id: best.contact_id, user_id: best.user_id, age_seconds: Math.max(0, Math.round((now - best.at) / 1000)) } : null;
}

function clearFocus(orgId, userId) {
  const users = byOrg.get(orgId);
  if (users) users.delete(userId);
}

function _reset() { byOrg.clear(); }

module.exports = { setFocus, latestFocus, clearFocus, _reset, TTL_MS };
