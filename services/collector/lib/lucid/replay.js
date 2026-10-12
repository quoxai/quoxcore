'use strict';

/**
 * LUCID replay: "what did you know at 21:00, and what did you tell me?"
 *
 *   situationAt(orgId, ts)      fold aware_journal rows with ts <= T into subject states (latest row per
 *                               subject; open unless its last kind is retract) and build the situation
 *                               from them with the same builders the live view uses.
 *   toldAt(orgId, from, to)     herald steps + briefings issued in a window, with their ward_entry_ids.
 *
 * Honest limits: the journal only records CHANGES, so a replayed subject's last_heard is the time of its
 * last journalled row and no feed's expected_by is known; a subject that was merely re-confirmed (an
 * unchanged update) is not in the journal. Feeds are not replayed (cannot_see feed health reflects only
 * the expected list passed in). Lessons are today's, not those of T.
 */

const journal = require('./journal.js');
const { buildSituation, renderSituation, renderSpoken } = require('./situation.js');

const TAIL = 200;
const RECENT = 300;
const MAX_ROWS = 20000;

/** Fold journal rows (oldest first) into aware_subjects-shaped records. */
function foldSubjects(orgId, rows) {
  const by = new Map();
  for (const r of rows) {
    if (r.kind === 'heartbeat') continue;
    const cur = by.get(r.subject);
    const retract = r.kind === 'retract';
    const changed = !cur || cur.status !== r.status || cur.resolved_at != null;
    const srcSince = r.state && Number(r.state.since);
    const since = Number.isFinite(srcSince) && srcSince <= r.ts ? srcSince : r.ts;
    by.set(r.subject, {
      org_id: orgId,
      subject: r.subject,
      ledger: r.ledger,
      status: r.status,
      summary: r.summary || '',
      state: r.state ? { ...(cur && cur.state ? cur.state : {}), ...r.state } : (cur ? cur.state : null),
      salience: r.salience || (cur ? cur.salience : null),
      feed: (r.source && r.source.feed) || (cur ? cur.feed : null),
      first_seen: cur ? cur.first_seen : since,
      status_since: changed ? since : cur.status_since,
      last_heard: r.ts,
      expected_by: null,
      resolved_at: retract ? r.ts : null,
      transitions_count: (cur ? cur.transitions_count : 0) + 1,
      last_seq: r.seq,
    });
  }
  return by;
}

function situationAt(orgId, ts, { expectedFeeds = [], tz = 'Europe/London' } = {}) {
  const T = Number(ts);
  if (!Number.isFinite(T)) throw Object.assign(new Error('ts must be a time'), { code: 'bad_request' });
  const rows = journal.journalUpTo(orgId, T, { limit: MAX_ROWS });
  const by = foldSubjects(orgId, rows);
  const open = [...by.values()].filter((s) => s.resolved_at == null).sort((a, b) => a.status_since - b.status_since);
  const live = rows.filter((r) => r.kind !== 'heartbeat');
  const recent = live.slice(-RECENT).reverse(); // recentJournal is newest first
  const tailRows = live.slice(-TAIL);
  const lastSeq = rows.length ? rows[rows.length - 1].seq : 0;
  const sit = buildSituation(orgId, {
    now: T, sinceSeq: 0, expectedFeeds, tz,
    injected: { open, recent, tail: { rows: tailRows, total: live.length, lastSeq }, feeds: [] },
  });
  sit.replay = { at: T, rows_folded: rows.length, subjects: by.size, open: open.length, truncated: rows.length >= MAX_ROWS };
  // Source health over time is not journaled (heartbeats are not stored), so a replay must not claim
  // sources were "not connected" then: it says honestly that their health at that moment is unknown.
  for (const a of sit.areas || []) {
    if (a.state === 'unknown') { a.state = 'replay'; a.L0 = 'Source health at that moment is not recorded'; }
  }
  if (sit.board) for (const b of sit.board) if (b.state === 'unknown') { b.state = 'replay'; b.headline = 'Source health at that moment is not recorded'; }
  sit.L0 = String(sit.L0 || '').replace(/\s*I can't see your [^.]*\.?\s*$/, ' Source health at that moment is not recorded, so I cannot say what was silent then.');
  sit.cannot_see = { ...(sit.cannot_see || {}), replay_note: 'Feed liveness is not journaled; blind spots at that moment cannot be reconstructed.' };
  return { situation: sit, text: renderSituation(sit, { now: T, tz }), spoken: renderSpoken(sit) };
}

/** What LUCID told the person in [from, to]: herald steps and briefings, each with its witness id. */
function toldAt(orgId, from, to) {
  const f = Number(from) || 0;
  const t = Number(to) || Date.now();
  const steps = journal.journalWindow(orgId, f, t, { subjectLike: 'herald:%' })
    .filter((r) => r.kind !== 'heartbeat')
    .map((r) => ({ type: 'herald_step', seq: r.seq, ts: r.ts, ref: r.subject.slice(7), status: r.status, summary: r.summary, ward_entry_id: r.ward_entry_id }));
  const briefings = journal.listBriefings(orgId, { from: f, to: t })
    .map((b) => ({ type: 'briefing', id: b.id, ts: b.ts, viewer: b.viewer, surface: b.surface, kind: b.kind, situation_hash: b.situation_hash, ward_entry_id: b.ward_entry_id }));
  const told = [...steps, ...briefings].sort((a, b) => a.ts - b.ts);
  return {
    from: f, to: t, told,
    counts: { herald_steps: steps.length, briefings: briefings.length, unwitnessed: told.filter((x) => !x.ward_entry_id).length },
  };
}

// ---- http handlers (the orchestrator wires routes and passes the authenticated org) -------------------

function bad(res, message) { return res.status(400).json({ error: message }); }

function hhmmToday(spec, now, tz) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(spec);
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  // Find the instant whose wall clock in tz is today's h:mi (today = tz date of now), stepping back a day if still in the future.
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const wall = (ms) => { const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute); };
  const nowWall = wall(now);
  const dayStart = nowWall - (nowWall % 86400000);
  let targetWall = dayStart + (h * 60 + mi) * 60000;
  if (targetWall > nowWall) targetWall -= 86400000;
  return now - (nowWall - targetWall);
}

/** at: epoch ms, ISO time, or "21:00" (most recent 21:00 in tz). */
function parseAt(at, now = Date.now(), tz = 'Europe/London') {
  if (at == null || at === '') return null;
  const s = String(at).trim();
  if (/^\d{10,13}$/.test(s)) return s.length <= 10 ? Number(s) * 1000 : Number(s);
  const hm = hhmmToday(s, now, tz);
  if (hm != null) return hm;
  const d = Date.parse(s);
  return Number.isFinite(d) ? d : null;
}

function parseWindow(spec, now) {
  const m = /^(\d+)\s*(m|h|d)$/.exec(String(spec || '').trim());
  if (!m) return null;
  return now - Number(m[1]) * { m: 60000, h: 3600000, d: 86400000 }[m[2]];
}

/** GET .../lucid/replay?at=<ts|ISO|"21:00"> (handler is called with the authenticated orgId). */
function replayHandler(req, res, orgId) {
  try {
    if (!orgId) return bad(res, 'org could not be resolved');
    if (!journal.isReady()) return res.status(503).json({ error: 'LUCID journal not ready' });
    const at = parseAt((req.query || {}).at, Date.now());
    if (at == null) return bad(res, 'at must be a time: ISO, epoch ms, or HH:MM');
    return res.json({ ok: true, ...situationAt(orgId, at) });
  } catch (err) {
    return res.status(err.code === 'bad_request' ? 400 : 500).json({ error: err.message });
  }
}

/** GET .../lucid/told?since=6h | ?from=&to= */
function toldHandler(req, res, orgId) {
  try {
    if (!orgId) return bad(res, 'org could not be resolved');
    if (!journal.isReady()) return res.status(503).json({ error: 'LUCID journal not ready' });
    const q = req.query || {};
    const now = Date.now();
    let from = q.from != null ? parseAt(q.from, now) : null;
    if (from == null) from = parseWindow(q.since || '6h', now);
    if (from == null) return bad(res, 'since must be like 6h, 30m or 2d');
    const to = q.to != null ? parseAt(q.to, now) : now;
    if (to == null) return bad(res, 'to must be a time');
    return res.json({ ok: true, ...toldAt(orgId, from, to) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { situationAt, toldAt, foldSubjects, parseAt, replayHandler, toldHandler };
