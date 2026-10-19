'use strict';
/**
 * PRESENCE (owner 2026-10-16): "/afk and /sleep should actually mean something. It's just an
 * indication that an LLM might actually find useful to know."
 *
 * A human says they are not at their terminal (quox /afk [note], /sleep, `quox presence set`).
 * Stored per (org, user) in aee.db (migrations/aee/048). Read by:
 *   - slot say / broadcast / page to a human slot (hitl, triage-q, or the slot the human's window
 *     holds) -> `human_presence` { away, humans, notice } in the response,
 *   - GET /api/v1/slots -> `humans`,
 *   - GET /api/v1/presence[/:who] (quox presence) and the presence_get agent tool,
 *   - chat turn context -> [OWNER PRESENCE] block,
 *   - approval requests (quox ask, create_inbox_item) -> owner_away / owner_away_since.
 * Approvals still queue exactly as before. Nothing here approves, denies or skips anything.
 * Human slots: hitl and triage-q, plus each human's own window slots (set with their presence).
 * Auto-away (idle N minutes reads as away) is a per-user setting, off by default.
 */

const STATES = ['present', 'away', 'sleeping'];
const DEFAULT_HUMAN_SLOTS = ['hitl', 'triage-q'];
const NOTE_MAX = 200;
// An away flag older than this, with the human active since, is never reported as current (owner 2026-10-19).
const STALE_AWAY_MS = 12 * 3600 * 1000;
// Actions that must NOT clear presence: they are how a human goes away.
const NON_CLEARING = new Set(['afk', 'sleep', 'away']);
const MAX_SLOTS = 8;

function cleanText(s, max) {
  // A note is the human's own text, but it must never be able to open or close a prompt section.
  const t = String(s == null ? '' : s).replace(/[[\]]/g, '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function whoFor(user) {
  if (user && user.dashboardRole === 'owner') return 'owner';
  const e = String((user && user.email) || '');
  return cleanText(e.includes('@') ? e.split('@')[0] : (e || (user && user.id) || 'someone'), 40) || 'someone';
}

function pad2(n) { return String(n).padStart(2, '0'); }
function whenText(iso, now) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'earlier';
  const n = now instanceof Date ? now : new Date(now || Date.now());
  const hm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
  if (d.toISOString().slice(0, 10) === n.toISOString().slice(0, 10)) return hm;
  return `${d.toISOString().slice(0, 10)} ${hm}`;
}

function createUserPresenceStore({ getDb, now = () => new Date().toISOString() } = {}) {
  if (typeof getDb !== 'function') throw new Error('createUserPresenceStore: getDb required');
  const db = () => { const h = getDb(); if (!h) throw new Error('userPresence: db not available'); return h; };

  function effective(row) {
    if (!row) return null;
    let slots = [];
    try { slots = JSON.parse(row.slots || '[]'); } catch { slots = []; }
    const base = {
      user_id: row.user_id, email: row.email || null, who: row.who, state: row.state, since: row.since,
      note: row.note || null, slots, auto_away_minutes: row.auto_away_minutes || null,
      last_active_at: row.last_active_at || null, updated_at: row.updated_at, back_at: row.back_at || null, back_via: row.back_via || null, away: row.state !== 'present', auto: false,
    };
    if (base.away && !base.auto) {
      // SAFETY NET: an old away flag with activity after it is a flag that never cleared. Not current.
      const since = Date.parse(base.since); const act = Date.parse(base.last_active_at || '');
      if (Number.isFinite(since) && Number.isFinite(act) && act > since && Date.parse(now()) - since > STALE_AWAY_MS) {
        return { ...base, state: 'present', away: false, note: null, stale_cleared: true };
      }
    }
    if (base.away || !base.auto_away_minutes || !base.last_active_at) return base;
    const idleFrom = Date.parse(base.last_active_at) + base.auto_away_minutes * 60000;
    if (Number.isFinite(idleFrom) && Date.parse(now()) >= idleFrom) {
      return { ...base, state: 'away', away: true, auto: true, since: new Date(idleFrom).toISOString() };
    }
    return base;
  }

  function present(userId) {
    return { user_id: userId || null, who: null, state: 'present', away: false, since: null, note: null, slots: [], auto: false };
  }

  /** Set a human's presence. Only a human login may: agents and service callers get 403. */
  function set({ orgId, user, state, note, slots, autoAwayMinutes } = {}) {
    if (!orgId) return { ok: false, status: 400, error: 'org could not be resolved' };
    if (!user || !user.id || user.agent_id || user.actor_type === 'plugin') {
      return { ok: false, status: 403, error: 'presence is set by a human login only' };
    }
    if (!STATES.includes(state)) return { ok: false, status: 400, error: `state must be one of ${STATES.join(', ')}` };
    let auto;
    if (autoAwayMinutes !== undefined) {
      if (autoAwayMinutes === null || autoAwayMinutes === 0 || autoAwayMinutes === 'off') auto = null;
      else {
        const n = Number(autoAwayMinutes);
        if (!Number.isInteger(n) || n < 1 || n > 1440) return { ok: false, status: 400, error: 'auto_away_minutes must be 1 to 1440, or 0 for off' };
        auto = n;
      }
    }
    const t = now();
    const prev = db().prepare('SELECT * FROM user_presence WHERE org_id = ? AND user_id = ?').get(orgId, user.id);
    const sinceKeep = prev && prev.state === state ? prev.since : t;
    const noteVal = state === 'present' ? null : (note !== undefined ? (cleanText(note, NOTE_MAX) || null) : (prev && prev.state === state ? prev.note : null));
    const slotList = Array.isArray(slots)
      ? [...new Set(slots.map((s) => String(s).trim().toLowerCase()).filter((s) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(s)))].slice(0, MAX_SLOTS)
      : null;
    const slotsVal = slotList !== null ? JSON.stringify(slotList) : (prev ? prev.slots : '[]');
    const autoVal = auto !== undefined ? auto : (prev ? prev.auto_away_minutes : null);
    const lastActive = state === 'present' ? t : (prev ? prev.last_active_at : null);
    db().prepare(`INSERT INTO user_presence (org_id, user_id, email, who, state, since, note, slots, auto_away_minutes, last_active_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id, user_id) DO UPDATE SET email = excluded.email, who = excluded.who, state = excluded.state, since = excluded.since,
        note = excluded.note, slots = excluded.slots, auto_away_minutes = excluded.auto_away_minutes, last_active_at = excluded.last_active_at,
        updated_at = excluded.updated_at`)
      .run(orgId, user.id, user.email || null, whoFor(user), state, sinceKeep, noteVal, slotsVal, autoVal, lastActive, t);
    return { ok: true, presence: get({ orgId, userId: user.id }), changed: !prev || prev.state !== state };
  }

  function fmtAway(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    const d = Math.floor(m / 1440); const h = Math.floor((m % 1440) / 60); const mi = m % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${mi}m`;
    return `${mi}m`;
  }
  function welcomeOf(row) {
    const ms = Date.parse(row.back_at) - Date.parse(row.away_since_prev);
    return { away_since: row.away_since_prev, back_at: row.back_at, via: row.back_via, away_ms: Number.isFinite(ms) ? ms : 0,
      away_text: fmtAway(Number.isFinite(ms) ? ms : 0), record: `back at ${pad2(new Date(row.back_at).getUTCHours())}:${pad2(new Date(row.back_at).getUTCMinutes())} (auto: ${row.back_via})` };
  }

  /**
   * The human's own first REAL action (a sent chat message, an answer or approval, a PIN step-up, any slash command
   * except /afk and /sleep) clears away/sleeping at the source of truth and records "back at HH:MM (auto: <action>)".
   * clear:false only notes activity (the 12 h safety net reads it). wantWelcome: hand back the one-time welcome.
   * -> { ok, cleared, welcome|null }. Humans only; a missing row or a present human changes nothing but last_active_at.
   */
  function touch({ orgId, user, action, clear = true, wantWelcome = false } = {}) {
    if (!orgId) return { ok: false, status: 400, error: 'org could not be resolved' };
    if (!user || !user.id || user.agent_id || user.actor_type === 'plugin') return { ok: false, status: 403, error: 'presence is touched by a human login only' };
    const act = cleanText(action || 'activity', 40) || 'activity';
    const t = now();
    const row = db().prepare('SELECT * FROM user_presence WHERE org_id = ? AND user_id = ?').get(orgId, user.id);
    if (!row) return { ok: true, cleared: false, welcome: null };
    const raw = row.state !== 'present';
    if (raw && clear && !NON_CLEARING.has(act.toLowerCase())) {
      db().prepare(`UPDATE user_presence SET state = 'present', since = ?, note = NULL, last_active_at = ?, updated_at = ?,
        back_at = ?, back_via = ?, away_since_prev = ?, welcomed = ? WHERE org_id = ? AND user_id = ?`)
        .run(t, t, t, t, act, row.since, wantWelcome ? 1 : 0, orgId, user.id);
      return { ok: true, cleared: true, welcome: wantWelcome ? welcomeOf({ ...row, back_at: t, back_via: act, away_since_prev: row.since }) : null };
    }
    db().prepare('UPDATE user_presence SET last_active_at = ? WHERE org_id = ? AND user_id = ?').run(t, orgId, user.id);
    if (!raw && wantWelcome && row.welcomed === 0 && row.back_at) {
      db().prepare('UPDATE user_presence SET welcomed = 1 WHERE org_id = ? AND user_id = ?').run(orgId, user.id);
      return { ok: true, cleared: false, welcome: welcomeOf(row) };
    }
    return { ok: true, cleared: false, welcome: null };
  }

  function get({ orgId, userId } = {}) {
    if (!orgId || !userId) return present(userId);
    const row = db().prepare('SELECT * FROM user_presence WHERE org_id = ? AND user_id = ?').get(orgId, userId);
    return effective(row) || present(userId);
  }

  function list({ orgId } = {}) {
    if (!orgId) return [];
    return db().prepare('SELECT * FROM user_presence WHERE org_id = ? ORDER BY who = \'owner\' DESC, updated_at DESC').all(orgId).map(effective);
  }

  /** By user id, email, email name, or "owner". null when nobody matches. */
  function find({ orgId, who } = {}) {
    const q = String(who || '').trim().toLowerCase();
    if (!q) return null;
    return list({ orgId }).find((p) => p.user_id.toLowerCase() === q || (p.email || '').toLowerCase() === q
      || (p.email || '').toLowerCase().split('@')[0] === q || p.who.toLowerCase() === q) || null;
  }

  function awayHumans({ orgId } = {}) { return list({ orgId }).filter((p) => p.away); }

  /** The away humans a slot belongs to: their own window's slot, or a human slot (hitl, triage-q). */
  function forSlot({ orgId, slot } = {}) {
    const name = String(slot || '').trim().toLowerCase();
    if (!name) return [];
    const away = awayHumans({ orgId });
    const own = away.filter((p) => (p.slots || []).includes(name));
    if (own.length) return own;
    return DEFAULT_HUMAN_SLOTS.includes(name) ? away : [];
  }

  return { set, touch, get, list, find, awayHumans, forSlot, humanSlots: () => [...DEFAULT_HUMAN_SLOTS], nowDate: () => new Date(now()) };
}

function reason(p) { return p.note || (p.auto ? 'idle' : p.state); }

/** "owner away since 15:54 UTC (sleeping): approvals will queue". null when nobody is away. */
function slotNotice(away, now = new Date()) {
  if (!Array.isArray(away) || !away.length) return null;
  const parts = away.map((p) => `${p.who} away since ${whenText(p.since, now)} (${reason(p)})`);
  return `${parts.join('; ')}: approvals will queue`;
}

function slotPresenceField(away, now = new Date()) {
  if (!Array.isArray(away) || !away.length) return null;
  return { away: true, humans: away.map((p) => ({ who: p.who, state: p.state, since: p.since, note: p.note || null })), notice: slotNotice(away, now) };
}

/** [OWNER PRESENCE] for a chat turn's context. '' when nobody is away. */
function contextBlock(away, now = new Date()) {
  if (!Array.isArray(away) || !away.length) return '';
  const lines = away.map((p) => `The ${p.who === 'owner' ? 'owner' : `user ${p.who}`} is away since ${whenText(p.since, now)} (${cleanText(reason(p), NOTE_MAX)}).`);
  return `[OWNER PRESENCE] ${lines.join(' ')} They said they are not at their terminal: do not wait on approvals or answers from them. You can still request approvals; queue them and work on something else, or pursue another avenue, until they are back. Nothing is approved while they are away.`;
}

/** Fields for an approval-request response, so the asking session knows it will wait. */
function approvalFields(away, now = new Date()) {
  if (!Array.isArray(away) || !away.length) return { owner_away: false };
  const p = away[0];
  return { owner_away: true, owner_away_since: p.since, owner_presence: p.state, owner_away_notice: slotNotice(away, now) };
}

// One store per collector process, set at boot (server.js), so lib modules (agentTools) can read it.
let defaultStore = null;
function setDefaultStore(s) { defaultStore = s; }
function getDefaultStore() { return defaultStore; }

module.exports = {
  createUserPresenceStore, slotNotice, slotPresenceField, contextBlock, approvalFields,
  setDefaultStore, getDefaultStore, STATES, DEFAULT_HUMAN_SLOTS, STALE_AWAY_MS,
};
