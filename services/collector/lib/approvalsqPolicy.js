/**
 * ApprovalsQ policy (QVOICE-OUTBOUND #521): PURE decision logic, no I/O.
 *
 * ApprovalsQ phones a human when a HITL approval has been waiting too long.
 * It NEVER approves or denies anything. There is deliberately no
 * auto-approve setting and normalizePolicy() drops unknown keys, so one
 * cannot be smuggled in through stored JSON.
 *
 * The policy is stored per org by the dashboard in plugin_storage under
 * plugin_id='quox-voice', key='approvalsq.policy'.
 */

'use strict';

const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  age_threshold_minutes: 15,
  quiet_hours: Object.freeze({ start: '22:00', end: '08:00', timezone: 'Europe/London' }),
  max_retries: 3,
  gap_minutes: 2,
  destination_number: null,
  min_tier: 'tier1',
  voicemail_policy: 'leave',
});

const MIN_TIERS = ['tier1', 'tier2'];
const VOICEMAIL_POLICIES = ['leave', 'retry'];
// Risk labels per tier. Anything not listed (low, info, plain, missing) never calls.
const TIER1_RISKS = new Set(['high', 'destructive', 'critical']);
const TIER2_RISKS = new Set(['high', 'destructive', 'critical', 'medium']);
const PENDING_STATUSES = new Set(['open', 'in_progress', 'waiting']);
const BLOCKING_ROW_STATES = new Set(['resolved', 'exhausted', 'calling', 'cancelled']);

function clampInt(raw, min, max, fallback) {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function parseHHMM(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function pad(s) {
  const [h, m] = s.trim().split(':');
  return `${h.padStart(2, '0')}:${m}`;
}

function normalizeQuietHours(raw) {
  const d = DEFAULT_POLICY.quiet_hours;
  if (!raw || typeof raw !== 'object') return { ...d };
  const start = parseHHMM(raw.start) !== null ? pad(raw.start) : d.start;
  const end = parseHHMM(raw.end) !== null ? pad(raw.end) : d.end;
  const timezone = isValidTimezone(raw.timezone) ? raw.timezone : d.timezone;
  return { start, end, timezone };
}

/** Validate/clamp raw stored JSON over the defaults. Unknown keys are dropped. */
function normalizePolicy(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const dest = typeof r.destination_number === 'string' ? r.destination_number.trim() : '';
  return {
    enabled: r.enabled === true,
    age_threshold_minutes: clampInt(r.age_threshold_minutes, 1, 1440, DEFAULT_POLICY.age_threshold_minutes),
    quiet_hours: normalizeQuietHours(r.quiet_hours),
    max_retries: clampInt(r.max_retries, 1, 10, DEFAULT_POLICY.max_retries),
    gap_minutes: clampInt(r.gap_minutes, 1, 120, DEFAULT_POLICY.gap_minutes),
    destination_number: dest || null,
    min_tier: MIN_TIERS.includes(r.min_tier) ? r.min_tier : DEFAULT_POLICY.min_tier,
    voicemail_policy: VOICEMAIL_POLICIES.includes(r.voicemail_policy)
      ? r.voicemail_policy
      : DEFAULT_POLICY.voicemail_policy,
  };
}

function minutesInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

/** True when `nowDate` falls in [start, end) in the window's timezone, wrapping midnight. */
function isInQuietHours(nowDate, quietHours) {
  const qh = normalizeQuietHours(quietHours);
  const start = parseHHMM(qh.start);
  const end = parseHHMM(qh.end);
  if (start === end) return false;
  const cur = minutesInZone(nowDate, qh.timezone);
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

function readPayload(item) {
  const p = item && item.payload_json;
  if (p && typeof p === 'object') return p;
  if (typeof p !== 'string') return null;
  try {
    const parsed = JSON.parse(p);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Risk comes from payload_json (the inbox item has no tier column). */
function itemTierOk(item, minTier) {
  const payload = readPayload(item);
  if (!payload) return false;
  const risk = String(payload.risk_level || payload.risk || '').trim().toLowerCase();
  if (!risk) return false;
  return (minTier === 'tier2' ? TIER2_RISKS : TIER1_RISKS).has(risk);
}

/** SQLite datetime('now') is UTC without a zone marker; treat it as UTC. */
function parseCreatedAt(s) {
  if (typeof s !== 'string' || !s) return NaN;
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

function isDue(item, policy, escalationRow, nowDate) {
  if (!policy || policy.enabled !== true) return { due: false, reason: 'policy_disabled' };
  if (!item || item.kind !== 'approval') return { due: false, reason: 'not_approval' };
  if (!PENDING_STATUSES.has(item.status)) return { due: false, reason: 'not_pending' };
  if (escalationRow && BLOCKING_ROW_STATES.has(escalationRow.state)) {
    return { due: false, reason: `escalation_${escalationRow.state}` };
  }
  const created = parseCreatedAt(item.created_at);
  if (!Number.isFinite(created)) return { due: false, reason: 'bad_created_at' };
  const ageMin = (nowDate.getTime() - created) / 60000;
  if (ageMin < policy.age_threshold_minutes) return { due: false, reason: 'too_young' };
  if (!itemTierOk(item, policy.min_tier)) return { due: false, reason: 'below_min_tier' };
  if (isInQuietHours(nowDate, policy.quiet_hours)) return { due: false, reason: 'quiet_hours' };
  return { due: true, reason: 'due' };
}

module.exports = { DEFAULT_POLICY, normalizePolicy, isInQuietHours, itemTierOk, isDue };
