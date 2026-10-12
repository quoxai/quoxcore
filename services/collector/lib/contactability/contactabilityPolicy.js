/**
 * Contactability policy engine (COMMANDERQ P9 / C3).
 *
 * The one question this answers, for any PROPOSED outbound contact: may Q reach
 * this recipient, on this channel, right now? The answer is DENY-BY-DEFAULT and
 * TCPA/PECR-shaped:
 *   1. No recorded opt-in consent  -> DENY  (the legal floor: silence is not consent)
 *   2. Inside the recipient's quiet hours -> DEFER (with the next allowed time)
 *   3. Frequency cap hit (min interval between contacts, or daily max) -> DEFER
 *   4. Otherwise -> ALLOW
 *
 * This module is PURE and never throws: the caller supplies the stored policy and
 * the recent-attempt timestamps; it returns a decision object. It does NOT send
 * anything and it does NOT grant consent — granting is a human/authenticated act
 * recorded as a signed P4 `consent` artifact elsewhere. Deciding and doing are
 * deliberately separate so the rules engine can be exercised with zero outbound risk.
 */

'use strict';

const DECISION = { ALLOW: 'allow', DENY: 'deny', DEFER: 'defer' };

/** Minutes-of-day (0..1439) for an instant in a fixed UTC offset. */
function localMinutesOfDay(nowMs, tzOffsetMinutes) {
  const local = new Date(nowMs + (tzOffsetMinutes || 0) * 60000);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/** Parse "HH:MM" → minutes-of-day, or null if malformed. */
function parseHhmm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** True when `mins` falls in [start,end), handling windows that wrap midnight. */
function inWindow(mins, start, end) {
  if (start === end) return false;          // empty window
  if (start < end) return mins >= start && mins < end;
  return mins >= start || mins < end;        // wraps midnight (e.g. 21:00–08:00)
}

/**
 * @param {object} args
 * @param {object|null} args.policy  stored policy: { opt_in, basis, quiet_start, quiet_end,
 *   tz_offset_minutes, min_interval_minutes, max_per_day }
 * @param {string} args.nowIso       decision instant (ISO)
 * @param {string[]} [args.recentAttempts]  ISO timestamps of prior contacts (this channel),
 *   caller-supplied; only the last 24h matter.
 * @returns {{ decision: 'allow'|'deny'|'defer', reasons: string[], next_allowed_at: string|null }}
 */
function evaluateContactability({ policy, nowIso, recentAttempts = [] } = {}) {
  const reasons = [];
  const nowMs = Date.parse(nowIso);
  const now = Number.isFinite(nowMs) ? nowMs : Date.parse(new Date(0).toISOString());

  // 1. Deny-by-default: no policy, or opt_in not explicitly true.
  if (!policy || policy.opt_in !== true) {
    return { decision: DECISION.DENY, reasons: ['no_consent'], next_allowed_at: null };
  }

  let deferUntil = 0; // max of all defer next-allowed instants

  // 2. Quiet hours (recipient-local).
  const qs = parseHhmm(policy.quiet_start);
  const qe = parseHhmm(policy.quiet_end);
  const _nonEmpty = (v) => v != null && String(v).trim() !== '';
  const quietConfigured = _nonEmpty(policy.quiet_start) || _nonEmpty(policy.quiet_end);
  if (quietConfigured && (qs === null || qe === null)) {
    // Quiet hours configured but unparseable — FAIL SAFE (defer), never silently
    // disable the protection. A deny-by-default / TCPA module must not place a
    // contact against a broken quiet-hours window. No reliable next_allowed_at.
    reasons.push('quiet_hours_misconfigured');
  } else if (qs !== null && qe !== null) {
    const mins = localMinutesOfDay(now, policy.tz_offset_minutes);
    if (inWindow(mins, qs, qe)) {
      reasons.push('quiet_hours');
      // Next allowed = next occurrence of quiet_end (local) as UTC instant.
      const tz = (policy.tz_offset_minutes || 0) * 60000;
      const local = new Date(now + tz);
      const base = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
      let endUtc = base + qe * 60000 - tz;
      if (endUtc <= now) endUtc += 86400000; // already past today's end → tomorrow's
      deferUntil = Math.max(deferUntil, endUtc);
    }
  }

  // 3. Frequency caps (only attempts within the last 24h count).
  const dayAgo = now - 86400000;
  const recent = recentAttempts
    .map((t) => Date.parse(t))
    .filter((t) => Number.isFinite(t) && t > dayAgo)
    .sort((a, b) => a - b);

  const minInterval = Number(policy.min_interval_minutes) > 0 ? Number(policy.min_interval_minutes) * 60000 : 0;
  if (minInterval && recent.length) {
    const last = recent[recent.length - 1];
    if (now - last < minInterval) {
      reasons.push('min_interval');
      deferUntil = Math.max(deferUntil, last + minInterval);
    }
  }

  const maxPerDay = Number(policy.max_per_day) > 0 ? Number(policy.max_per_day) : 0;
  if (maxPerDay && recent.length >= maxPerDay) {
    reasons.push('daily_cap');
    // Next allowed once the oldest of the capping window rolls past 24h.
    const oldest = recent[recent.length - maxPerDay];
    deferUntil = Math.max(deferUntil, oldest + 86400000);
  }

  if (reasons.length) {
    return { decision: DECISION.DEFER, reasons, next_allowed_at: deferUntil ? new Date(deferUntil).toISOString() : null };
  }
  return { decision: DECISION.ALLOW, reasons: [], next_allowed_at: null };
}

module.exports = { evaluateContactability, DECISION, parseHhmm, inWindow };
