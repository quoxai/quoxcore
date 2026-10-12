/**
 * voiceCallStore.js — completed voice-call summaries + transcripts.
 *
 * The telephony bridge pushes one record per call on call-end
 * (POST /api/internal/voice/calls); the QuoxVoice Console reads them back
 * org-scoped (GET /api/v1/voice/calls). Server is the source of truth.
 * Binds its db handle at ensure(db), mirroring numbersStore.js.
 */

let _db = null;

function ensure(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_calls (
      call_sid TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      direction TEXT,
      peer TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      summary TEXT,
      transcript_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_voice_calls_org_started ON voice_calls(org_id, started_at DESC);
  `);
  _db = db;
}

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function requireDb() {
  if (!_db) throw fail('store_not_initialised', 'voice call store not ensured');
  return _db;
}

function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

function rowToCall(r) {
  if (!r) return null;
  let transcript = [];
  try { transcript = JSON.parse(r.transcript_json || '[]'); } catch (_e) { transcript = []; }
  if (!Array.isArray(transcript)) transcript = [];
  return {
    call_sid: r.call_sid,
    org_id: r.org_id,
    direction: r.direction || null,
    peer: r.peer || null,
    started_at: r.started_at,
    ended_at: r.ended_at,
    summary: r.summary || '',
    transcript,
  };
}

function upsertCall(rec = {}) {
  const db = requireDb();
  const sid = typeof rec.call_sid === 'string' ? rec.call_sid.trim() : '';
  if (!sid) throw fail('call_sid_required', 'call_sid required');
  if (!rec.org_id || typeof rec.org_id !== 'string') throw fail('org_required', 'org_id required');
  if (rec.transcript !== undefined && !Array.isArray(rec.transcript)) throw fail('invalid_transcript', 'transcript must be an array');
  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT org_id FROM voice_calls WHERE call_sid = ?').get(sid);
    // A call_sid is never re-homed to another org.
    if (existing && existing.org_id !== rec.org_id) throw fail('call_owned_by_other_org', 'call belongs to another org');
    db.prepare(`
      INSERT INTO voice_calls (call_sid, org_id, direction, peer, started_at, ended_at, summary, transcript_json)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(call_sid) DO UPDATE SET
        direction = excluded.direction, peer = excluded.peer, started_at = excluded.started_at,
        ended_at = excluded.ended_at, summary = excluded.summary, transcript_json = excluded.transcript_json
    `).run(
      sid, rec.org_id,
      rec.direction == null ? null : String(rec.direction).slice(0, 40),
      rec.peer == null ? null : String(rec.peer).slice(0, 80),
      toMs(rec.started_at), toMs(rec.ended_at),
      rec.summary == null ? '' : String(rec.summary).slice(0, 2000),
      JSON.stringify(rec.transcript || [])
    );
  });
  tx();
  const saved = rowToCall(db.prepare('SELECT * FROM voice_calls WHERE call_sid = ?').get(sid));
  try { require('../lucid/emit.js').voiceCallEvent(saved); } catch { /* LUCID must never break call storage */ }
  return saved;
}

function listForOrg(orgId, limit = 50) {
  const db = requireDb();
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  return db
    .prepare('SELECT * FROM voice_calls WHERE org_id = ? ORDER BY COALESCE(started_at, ended_at, 0) DESC LIMIT ?')
    .all(orgId, n)
    .map(rowToCall);
}

const EMPTY_STATS = {
  total_calls: 0, inbound: 0, outbound: 0, total_turns: 0, avg_turns: 0,
  avg_duration_sec: null, last_call_at: null, by_day: [], top_peers: [],
};

// Aggregate the org's calls for the Console Insights tab. Reads up to 2000
// recent rows (an org's whole call history in practice) and derives counts,
// turn volume, duration (ended-started; not stored) and a 30-day day-buckets
// series + top counterparties. Days are bucketed in UTC.
function statsForOrg(orgId) {
  const db = requireDb();
  if (!orgId) return { ...EMPTY_STATS };
  const rows = db
    .prepare('SELECT direction, peer, started_at, ended_at, transcript_json FROM voice_calls WHERE org_id = ? ORDER BY COALESCE(started_at, ended_at, 0) DESC LIMIT 2000')
    .all(orgId);
  const total = rows.length;
  if (!total) return { ...EMPTY_STATS };
  let outbound = 0, turns = 0, durSum = 0, durN = 0, lastAt = null;
  const dayMap = new Map();
  const peerMap = new Map();
  const since = Date.now() - 30 * 86400000;
  for (const r of rows) {
    if (String(r.direction || '').toLowerCase().startsWith('out')) outbound++;
    let tx = [];
    try { tx = JSON.parse(r.transcript_json || '[]'); } catch (_e) { tx = []; }
    if (Array.isArray(tx)) turns += tx.length;
    if (typeof r.started_at === 'number' && typeof r.ended_at === 'number' && r.ended_at > r.started_at) {
      durSum += r.ended_at - r.started_at; durN++;
    }
    const at = r.started_at || r.ended_at || null;
    if (at && (lastAt === null || at > lastAt)) lastAt = at;
    if (at && at >= since) {
      const day = new Date(at).toISOString().slice(0, 10);
      dayMap.set(day, (dayMap.get(day) || 0) + 1);
    }
    if (r.peer) peerMap.set(r.peer, (peerMap.get(r.peer) || 0) + 1);
  }
  const by_day = [...dayMap.entries()]
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
  const top_peers = [...peerMap.entries()]
    .map(([peer, count]) => ({ peer, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  return {
    total_calls: total,
    inbound: total - outbound,
    outbound,
    total_turns: turns,
    avg_turns: Math.round((turns / total) * 10) / 10,
    avg_duration_sec: durN ? Math.round(durSum / durN / 1000) : null,
    last_call_at: lastAt,
    by_day,
    top_peers,
  };
}

module.exports = { ensure, upsertCall, listForOrg, statsForOrg };
