/**
 * QuoxSound for the terminal: pure event -> earcon mapping, profiles and the
 * rate limiter. Mirrors the dashboard's design (src/services/quoxSound.js):
 * sound is STATE, not personality; the more common the event, the quieter;
 * `hitl` is reserved for "a human must act". No sound for typing, text,
 * routine tool rows or anything the human just did themselves.
 *
 * Pure: no I/O, no clocks (time comes in on ctx.now / the action).
 */

export const SOUND_IDS = ['hitl', 'notify', 'success', 'denied', 'critical'];

/** Higher wins when several sounds land in one burst. */
export const PRIORITY = { critical: 5, hitl: 4, denied: 3, success: 2, notify: 1 };

/** Same layer split as the dashboard, so its per-layer toggles apply here too. */
export const SOUND_LAYERS = { hitl: 'notifications', notify: 'notifications', success: 'agents', denied: 'security', critical: 'security' };
export const LAYER_IDS = ['ui', 'agents', 'notifications', 'security'];

/**
 * Terminal profiles. Same names and setting as the dashboard. Minimal here
 * also carries failures (owner brief 2026-10-12: "hitl + critical + failure"),
 * because a failed turn in a terminal you are not watching is otherwise silent.
 */
export const PROFILES = {
  silent: [],
  minimal: ['hitl', 'critical', 'denied'],
  operational: ['hitl', 'critical', 'denied', 'success', 'notify'],
  full: ['hitl', 'critical', 'denied', 'success', 'notify']
};
export const PROFILE_IDS = ['silent', 'minimal', 'operational', 'full'];
export const PROFILE_LABELS = {
  silent: 'nothing',
  minimal: 'approvals, critical alerts, failures',
  operational: 'approvals, critical alerts, failures, long turns finishing',
  full: 'approvals, critical alerts, failures, long turns finishing'
};
export const DEFAULT_PROFILE = 'minimal';

export const LONG_TURN_MS = 20000;
export const RATE_LIMIT_MS = 2000;
/** Sounds this close together are one burst: only a more urgent one may follow. */
export const BURST_MS = 300;

const DEFAULT_LAYERS = Object.freeze({ ui: true, agents: true, notifications: true, security: true });

/** Same shape as the dashboard's soundProfile preference: { profile, volume, layers }. */
export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const profile = PROFILE_IDS.includes(src.profile) ? src.profile : DEFAULT_PROFILE;
  const v = Number(src.volume);
  const volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.6;
  const layers = { ...DEFAULT_LAYERS };
  if (src.layers && typeof src.layers === 'object') {
    for (const id of LAYER_IDS) if (typeof src.layers[id] === 'boolean') layers[id] = src.layers[id];
  }
  return { profile, volume, layers };
}

/** May `id` play under these settings? */
export function allowed(id, settings) {
  const s = normalizeSettings(settings);
  if (!SOUND_IDS.includes(id) || s.volume <= 0) return false;
  if (!PROFILES[s.profile].includes(id)) return false;
  return s.layers[SOUND_LAYERS[id]] !== false;
}

const FAILED_TURN = new Set(['failed', 'unconfirmed']);

/**
 * prevState + the dispatched action (+ ctx.next, the reduced state) -> sound id or null.
 * ctx: { next, now, focused } where focused is true | false | null (unknown = treated as looking).
 * Only state CHANGES the reducer accepted make sound: a duplicate approval or a repeated tool
 * finish leaves the state alone and stays silent.
 */
export function soundForEvent(prev, action, ctx = {}) {
  const next = ctx.next || prev;
  const now = ctx.now ?? action?.now ?? 0;
  if (!prev || !action) return null;
  // An approval card appeared (stream event or inbox poll).
  if (next.approvals?.length > (prev.approvals?.length || 0) || next.waiting?.length > (prev.waiting?.length || 0)) return 'hitl'; // a card, or another session's notice
  if (action.type === 'approval.result') return action.outcome === 'failed' ? 'denied' : null;
  if (action.type !== 'event' || !action.ev) return null;
  const ev = action.ev;
  switch (ev.type) {
    case 'alert':
      return ev.severity === 'critical' ? 'critical' : null;
    case 'tool.finished': {
      if (ev.status !== 'failed' && ev.status !== 'denied') return null;
      return prev.doneCalls?.[ev.call_id] ? null : 'denied';
    }
    case 'turn.finished': {
      if (!prev.turn) return null; // dedupe: no running turn
      const status = ev.status || 'completed';
      if (FAILED_TURN.has(status)) return 'denied';
      if (status !== 'completed') return null; // interrupted: the human pressed Esc
      const took = prev.turn.startedAt != null ? now - prev.turn.startedAt : 0;
      return took > LONG_TURN_MS || ctx.focused === false ? 'success' : null;
    }
    default:
      return null;
  }
}

/** At most one sound per type per RATE_LIMIT_MS; inside a burst only a more urgent sound plays. */
export function createLimiter({ windowMs = RATE_LIMIT_MS, burstMs = BURST_MS } = {}) {
  const last = new Map();
  let lastAny = null;
  return {
    take(id, now) {
      const t = last.get(id);
      if (t != null && now - t < windowMs) return false;
      if (lastAny && now - lastAny.at < burstMs && PRIORITY[id] <= PRIORITY[lastAny.id]) return false;
      last.set(id, now);
      lastAny = { id, at: now };
      return true;
    }
  };
}
