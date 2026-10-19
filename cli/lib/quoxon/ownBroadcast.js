/**
 * Your own broadcast is not news to you: the fan-out reaches every held slot in the org, including this window's, and
 * the "BROADCAST sent" card already told the sender. Match by the sender's identity, never by text.
 */
import { parseBroadcastText } from './slash/broadcast.js';

const norm = (s) => String(s || '').toLowerCase().replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * @param {object} m           the slot message
 * @param {object} me          { label: this window's sender label, display: the signed-in display name, userId }
 */
export function isOwnBroadcast(m, me = {}) {
  const bc = parseBroadcastText(m?.text);
  if (!bc) return false;
  const uid = me.userId ? String(me.userId) : null;
  if (uid && [m.user_id, m.from_user_id, m.author_user_id, m.author_id].some((x) => x != null && String(x) === uid)) return true;
  const sender = norm(bc.sender), from = norm(m.from);
  const mine = [me.label, me.display].map(norm).filter(Boolean);
  if (!mine.length) return false;
  return mine.some((x) => x === sender || x === from) || (me.label && m.from === me.label) || false;
}
