/**
 * LUCID journal: the append-only memory behind situational awareness.
 *
 * Store the stream, derive the state. Every meaningful change lands in
 * aware_journal (never updated or deleted in the hot window); aware_subjects is
 * a rebuildable projection of the current state per subject; aware_feeds tracks
 * when each source last spoke so silence is a fact, not a blank; aware_cursors
 * remembers what each viewer has already seen.
 *
 * A gatherer re-posting the same state every tick does NOT grow the journal:
 * an identical repeat only refreshes last_heard. Only changes are journaled,
 * so the journal reads as "what happened".
 *
 * Binds its db handle at ensure(db), like the other aeeDb stores.
 */

let _db = null;
// Compiled statements are reused: preparing SQL on every call was the bulk of LUCID's
// collector CPU (profile 2026-10-11). Keyed per database handle, then by SQL text.
const _stmtCache = new WeakMap();
function stmt(db, sql) {
  let m = _stmtCache.get(db);
  if (!m) { m = new Map(); _stmtCache.set(db, m); }
  let st = m.get(sql);
  if (!st) { st = db.prepare(sql); m.set(sql, st); }
  return st;
}
let _gen = 0; // bumps on every ensure(): a new database is a new world for any cache
function generation() { return _gen; }
// Bumps whenever something starts or stops needing a person (an ask, a retract, or a needs-owner
// salience is journaled): shared caches must never sit on that, even for a few seconds.
let _needsGen = 0;
function needsGeneration() { return _needsGen; }

const LEDGERS = ['vital', 'operational', 'intentional', 'social', 'security', 'epistemic'];
const KINDS = ['state', 'delta', 'ask', 'heartbeat', 'retract'];
const NEEDS = ['owner', 'any-human', 'agent', 'none'];

function ensure(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS aware_journal (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      ledger TEXT NOT NULL,
      subject TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT,
      prev_status TEXT,
      held_ms INTEGER,
      summary TEXT,
      state_json TEXT,
      salience_json TEXT,
      causes_json TEXT,
      source_json TEXT,
      ward_entry_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_aware_journal_org_seq ON aware_journal(org_id, seq);
    CREATE TABLE IF NOT EXISTS aware_briefings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      viewer TEXT NOT NULL,
      surface TEXT NOT NULL,
      kind TEXT NOT NULL,
      situation_hash TEXT,
      ward_entry_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_aware_briefings_org_ts ON aware_briefings(org_id, ts);
    CREATE INDEX IF NOT EXISTS idx_aware_journal_org_subject ON aware_journal(org_id, subject, seq);

    CREATE TABLE IF NOT EXISTS aware_subjects (
      org_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      ledger TEXT NOT NULL,
      status TEXT,
      summary TEXT,
      state_json TEXT,
      salience_json TEXT,
      source_feed TEXT,
      first_seen INTEGER NOT NULL,
      status_since INTEGER NOT NULL,
      last_heard INTEGER NOT NULL,
      expected_by INTEGER,
      resolved_at INTEGER,
      transitions_count INTEGER NOT NULL DEFAULT 0,
      last_seq INTEGER,
      PRIMARY KEY (org_id, subject)
    );
    CREATE INDEX IF NOT EXISTS idx_aware_subjects_open ON aware_subjects(org_id, resolved_at);

    CREATE TABLE IF NOT EXISTS aware_feeds (
      org_id TEXT NOT NULL,
      feed TEXT NOT NULL,
      first_heard INTEGER NOT NULL,
      last_heard INTEGER NOT NULL,
      expected_by INTEGER,
      last_error TEXT,
      last_error_at INTEGER,
      PRIMARY KEY (org_id, feed)
    );

    CREATE TABLE IF NOT EXISTS aware_cursors (
      org_id TEXT NOT NULL,
      viewer TEXT NOT NULL,
      surface TEXT NOT NULL,
      last_seen_seq INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, viewer, surface)
    );

    CREATE TABLE IF NOT EXISTS aware_lessons (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      target TEXT NOT NULL,
      field TEXT NOT NULL,
      value_json TEXT,
      reason TEXT,
      ts INTEGER NOT NULL,
      author TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_aware_lessons_org ON aware_lessons(org_id, ts);

    CREATE TABLE IF NOT EXISTS aware_expected_feeds (
      org_id TEXT NOT NULL,
      feed TEXT NOT NULL,
      declared_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, feed)
    );
    CREATE TABLE IF NOT EXISTS aware_herald_settings (
      org_id TEXT PRIMARY KEY,
      settings_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS aware_escalations (
      org_id TEXT NOT NULL,
      ref TEXT NOT NULL,
      episode_since INTEGER NOT NULL,
      urgency TEXT,
      l0 TEXT,
      item_kind TEXT,
      budget_ms INTEGER,
      level TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      filed_item_id TEXT,
      l1_at INTEGER,
      l2_issued_at INTEGER,
      l2_at INTEGER,
      l3_issued_at INTEGER,
      l3_at INTEGER,
      attempts_l2 INTEGER NOT NULL DEFAULT 0,
      attempts_l3 INTEGER NOT NULL DEFAULT 0,
      owner_said TEXT,
      last_error TEXT,
      closed_ok INTEGER,
      resolved_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, ref)
    );
    CREATE INDEX IF NOT EXISTS idx_aware_escalations_open ON aware_escalations(org_id, status);

    CREATE TABLE IF NOT EXISTS aware_herald_meta (
      org_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, key)
    );
  `);
  scrubExistingPii(db);
  _db = db;
  _gen += 1;
  _heardSubj.clear(); _heardFeed.clear(); _feedWrites.clear();
  _storm.clear();
}

/** One-off, idempotent: scrub phone numbers already written to subjects and the journal, in place. */
function scrubExistingPii(db) {
  try {
    const dirty = (t) => typeof t === 'string' && scrubPii(t) !== t;
    const subs = db.prepare('SELECT org_id, subject, summary FROM aware_subjects').all().filter((r) => dirty(r.subject) || dirty(r.summary));
    for (const r of subs) {
      db.prepare('UPDATE OR IGNORE aware_subjects SET subject = ?, summary = ? WHERE org_id = ? AND subject = ?')
        .run(scrubPii(r.subject), scrubPii(r.summary), r.org_id, r.subject);
    }
    // aware_journal is append-only and its rows may be WARD-witnessed: never rewritten in place.
    // Historic rows are scrubbed on READ (journalRow), which keeps every witness hash valid.
  } catch (err) { console.error('[LUCID/journal] pii scrub migration failed:', err && err.message); }
}

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function requireDb() {
  if (!_db) throw fail('store_not_initialised', 'lucid journal not ensured');
  return _db;
}

function isReady() {
  return !!_db;
}

function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 && v > 1e8 ? Math.round(v * 1000) : Math.round(v);
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

function str(v, max) {
  return v == null ? null : String(v).slice(0, max);
}

function json(v, max = 8000) {
  if (v == null) return null;
  const s = JSON.stringify(v);
  return s.length > max ? JSON.stringify({ truncated: true }) : s;
}

function parse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * No phone numbers in LUCID: they reach the journal, the CLI and the phone. "+44 7700 900123" and
 * "07700900123" become "number ending 123". Millisecond timestamps and ids are left alone.
 */
function scrubPii(text) {
  if (text == null) return text;
  const mask = (m) => {
    const d = m.replace(/\D/g, '');
    return d.length >= 7 ? `number ending ${d.slice(-3)}` : m;
  };
  return String(text)
    .replace(/\+\d[\d\s().-]{5,}\d/g, mask)
    .replace(/(?<![\w.])0\d[\d\s().-]{8,}\d(?![\w])/g, mask);
}

function normSalience(sal) {
  if (!sal || typeof sal !== 'object') return null;
  const out = {};
  if (NEEDS.includes(sal.needs)) out.needs = sal.needs;
  if (Array.isArray(sal.gates)) out.gates = sal.gates.filter((g) => typeof g === 'string').slice(0, 20).map((g) => g.slice(0, 120));
  const hint = Number(sal.hint);
  if (Number.isFinite(hint)) out.hint = Math.max(0, Math.min(1, hint));
  const dl = toMs(sal.deadline);
  if (dl) out.deadline = dl;
  return Object.keys(out).length ? out : null;
}

function subjectRow(r) {
  if (!r) return null;
  const lh = heardOf(_heardSubj, `${r.org_id}|${r.subject}`, r.last_heard);
  return {
    org_id: r.org_id,
    subject: scrubPii(r.subject),
    ledger: r.ledger,
    status: r.status,
    summary: scrubPii(r.summary || ''),
    state: parse(r.state_json),
    salience: parse(r.salience_json),
    feed: r.source_feed,
    first_seen: r.first_seen,
    status_since: r.status_since,
    last_heard: lh,
    expected_by: expectedOf(_heardSubj, `${r.org_id}|${r.subject}`, r.expected_by == null ? null : r.expected_by),
    resolved_at: r.resolved_at == null ? null : r.resolved_at,
    transitions_count: r.transitions_count,
    last_seq: r.last_seq,
  };
}

function journalRow(r) {
  return {
    seq: r.seq,
    ts: r.ts,
    ledger: r.ledger,
    subject: scrubPii(r.subject),
    kind: r.kind,
    status: r.status,
    prev_status: r.prev_status,
    held_ms: r.held_ms == null ? null : r.held_ms,
    summary: scrubPii(r.summary || ''),
    state: parse(r.state_json),
    salience: parse(r.salience_json),
    source: parse(r.source_json),
    ward_entry_id: r.ward_entry_id || null,
  };
}

function writeJournal(db, row) {
  const info = stmt(db, `
    INSERT INTO aware_journal (org_id, ts, ledger, subject, kind, status, prev_status, held_ms, summary, state_json, salience_json, causes_json, source_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(row.org_id, row.ts, row.ledger, row.subject, row.kind, row.status, row.prev_status, row.held_ms,
    row.summary, row.state_json, row.salience_json, row.causes_json, row.source_json);
  return Number(info.lastInsertRowid);
}

// Any event from a feed means the feed is alive. Heartbeats additionally carry
// the feed's own health: an error string marks it failing, its absence clears it.
// Writes that change nothing but a timestamp are skipped for NOOP_WINDOW_MS: liveness tolerates
// 30s of slack (ttl >= 120s), and these no-op UPDATEs were LUCID's hottest collector cost.
const NOOP_WINDOW_MS = 30000;
const _feedWrites = new Map();
// The newest "heard" time per subject/feed lives here when the DB write was skipped; every read
// folds it in, so liveness and the snapshot as_of rule stay exact.
const _heardSubj = new Map();
const _heardFeed = new Map();
function heard(map, key, ts, expectedBy) {
  const p = map.get(key);
  if (!p || ts > p.ts) { if (map.size > 20000) map.clear(); map.set(key, { ts, exp: expectedBy == null ? null : expectedBy }); }
}
function heardOf(map, key, dbTs) { const m = map.get(key); return m && m.ts > (dbTs || 0) ? m.ts : dbTs; }
function expectedOf(map, key, dbExp) { const m = map.get(key); return m && m.exp != null && (dbExp == null || m.exp > dbExp) ? m.exp : dbExp; }

function touchFeed(db, orgId, feed, ts, ttlS, kind, error) {
  const prev = stmt(db, 'SELECT * FROM aware_feeds WHERE org_id = ? AND feed = ?').get(orgId, feed);
  const ttl = Number(ttlS);
  const expectedBy = Number.isFinite(ttl) && ttl > 0 ? ts + Math.round(ttl * 1000) : (prev ? prev.expected_by : null);
  let lastError = prev ? prev.last_error : null;
  let lastErrorAt = prev ? prev.last_error_at : null;
  if (kind === 'heartbeat') {
    lastError = error ? String(error).slice(0, 500) : null;
    lastErrorAt = error ? ts : null;
  }
  const fk = `${orgId}|${feed}`;
  if (prev && (prev.last_error || null) === (lastError || null) && ts - prev.last_heard < NOOP_WINDOW_MS
      && (prev.expected_by == null || expectedBy == null || prev.expected_by >= ts)) {
    heard(_heardFeed, fk, ts, expectedBy);
    return prev; // only last_heard would move, and it is fresh enough
  }
  _feedWrites.set(fk, ts);
  if (!prev) {
    stmt(db, `INSERT INTO aware_feeds (org_id, feed, first_heard, last_heard, expected_by, last_error, last_error_at) VALUES (?,?,?,?,?,?,?)`)
      .run(orgId, feed, ts, ts, expectedBy, lastError, lastErrorAt);
  } else {
    stmt(db, `UPDATE aware_feeds SET last_heard = MAX(last_heard, ?), expected_by = ?, last_error = ?, last_error_at = ? WHERE org_id = ? AND feed = ?`)
      .run(ts, expectedBy, lastError, lastErrorAt, orgId, feed);
  }
  return prev;
}

/**
 * Append one aware.* event. Returns { seq, journaled, transition }.
 * transition is { from, to, held_ms } when the event was journaled.
 */
function appendCore(ev = {}) {
  const db = requireDb();
  const orgId = typeof ev.org_id === 'string' ? ev.org_id.trim() : '';
  if (!orgId) throw fail('bad_request', 'org_id required');
  if (!KINDS.includes(ev.kind)) throw fail('bad_request', `kind must be one of ${KINDS.join('|')}`);
  const source = ev.source && typeof ev.source === 'object' ? ev.source : {};
  const feed = typeof source.feed === 'string' && source.feed.trim() ? source.feed.trim().slice(0, 80) : '';
  if (!feed) throw fail('bad_request', 'source.feed required');
  const ts = toMs(ev.ts) || Date.now();
  const sourceJson = json({ surface: str(source.surface, 80), feed, instance: str(source.instance, 120), writer: str(source.writer, 120) });

  return db.transaction(() => {
    if (ev.kind === 'heartbeat') {
      const prev = touchFeed(db, orgId, feed, ts, ev.ttl_s, 'heartbeat', ev.error);
      // Resuming after silence is worth remembering; a routine heartbeat is not.
      if (prev && prev.expected_by != null && ts > prev.expected_by) {
        const held = ts - prev.last_heard;
        const seq = writeJournal(db, {
          org_id: orgId, ts, ledger: 'epistemic', subject: `feed:${feed}`, kind: 'heartbeat',
          status: 'speaking', prev_status: 'silent', held_ms: held,
          summary: `${feed} is speaking again`, state_json: null, salience_json: null, causes_json: null, source_json: sourceJson,
        });
        return { seq, journaled: true, transition: { from: 'silent', to: 'speaking', held_ms: held } };
      }
      return { seq: null, journaled: false, transition: null };
    }

    if (!LEDGERS.includes(ev.ledger)) throw fail('bad_request', `ledger must be one of ${LEDGERS.join('|')}`);
    const subject = typeof ev.subject === 'string' ? scrubPii(ev.subject.trim()).slice(0, 240) : '';
    if (!subject) throw fail('bad_request', 'subject required');

    touchFeed(db, orgId, feed, ts, null, ev.kind, null);

    const existing = stmt(db, 'SELECT * FROM aware_subjects WHERE org_id = ? AND subject = ?').get(orgId, subject);
    // A person speaking as user:<id> may not retract or overwrite what a system feed owns.
    if (existing && feed.startsWith('user:') && existing.source_feed && !String(existing.source_feed).startsWith('user:')) {
      throw fail('forbidden', 'system subjects are owned by their feed');
    }
    // A later event adds to what we know about the subject; it does not erase who
    // asked or what it was about. `since` is never inherited: it belongs to one status.
    const prevState = existing ? (parse(existing.state_json) || {}) : {};
    delete prevState.since;
    const incoming = ev.state && typeof ev.state === 'object' ? ev.state : null;
    const state = incoming ? { ...prevState, ...incoming } : null;
    const status = str(state && state.status != null ? state.status : (ev.kind === 'retract' ? 'resolved' : (existing ? existing.status : 'open')), 80);
    const summary = str(scrubPii(ev.summary != null ? ev.summary : (existing ? existing.summary : '')), 500);
    const salience = normSalience(ev.salience) || (existing ? parse(existing.salience_json) : null);
    const ttl = Number(ev.ttl_s);
    const expectedBy = Number.isFinite(ttl) && ttl > 0 ? ts + Math.round(ttl * 1000) : null;
    const isRetract = ev.kind === 'retract';
    const wasOpen = existing && existing.resolved_at == null;

    const unchanged = existing && (
      isRetract
        ? existing.resolved_at != null && existing.status === status
        : wasOpen && existing.status === status && (existing.summary || '') === (summary || '')
    );
    if (unchanged) {
      // The source may know the status began earlier than we first saw it.
      const srcSince = toMs(state && state.since);
      const backdate = !isRetract && srcSince != null && srcSince <= ts ? srcSince : null;
      const sameJson = json(salience) === (existing.salience_json || null) && (state == null || json(state) === existing.state_json);
      if (sameJson && (backdate == null || backdate >= existing.status_since) && ts - existing.last_heard < NOOP_WINDOW_MS
          && (existing.expected_by == null || existing.expected_by >= ts)) {
        heard(_heardSubj, `${orgId}|${subject}`, ts, expectedBy);
        return { seq: existing.last_seq, journaled: false, transition: null }; // nothing but a timestamp would move
      }
      stmt(db, `UPDATE aware_subjects SET last_heard = MAX(last_heard, ?), expected_by = ?, salience_json = ?, state_json = COALESCE(?, state_json),
          status_since = CASE WHEN ? IS NOT NULL AND ? < status_since THEN ? ELSE status_since END WHERE org_id = ? AND subject = ?`)
        .run(ts, expectedBy, json(salience), json(state), backdate, backdate, backdate, orgId, subject);
      return { seq: existing.last_seq, journaled: false, transition: null };
    }

    const from = existing ? existing.status : null;
    const statusChanged = !existing || existing.status !== status || !wasOpen;
    // ts is when we observed it; state.since is when the SOURCE says this status
    // began (a stream BLOCKED for 9 days is first observed now, but has waited 9 days).
    const srcSince = toMs(state && state.since);
    const since = srcSince != null && srcSince <= ts ? srcSince : ts;
    const held = existing && statusChanged ? Math.max(0, ts - existing.status_since) : null;
    if (ev.kind === 'ask' || isRetract || (salience && (salience.needs === 'owner' || salience.needs === 'any-human')) || (existing && wasOpen && parse(existing.salience_json) && ['owner', 'any-human'].includes((parse(existing.salience_json) || {}).needs))) _needsGen += 1;
    const seq = writeJournal(db, {
      org_id: orgId, ts, ledger: ev.ledger, subject, kind: ev.kind, status, prev_status: from, held_ms: held,
      summary, state_json: json(state), salience_json: json(salience),
      causes_json: Array.isArray(ev.causes) ? json(ev.causes.slice(0, 20)) : null, source_json: sourceJson,
    });

    if (!existing) {
      stmt(db, `
        INSERT INTO aware_subjects (org_id, subject, ledger, status, summary, state_json, salience_json, source_feed,
          first_seen, status_since, last_heard, expected_by, resolved_at, transitions_count, last_seq)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
      `).run(orgId, subject, ev.ledger, status, summary, json(state), json(salience), feed,
        since, since, ts, expectedBy, isRetract ? ts : null, seq);
    } else {
      stmt(db, `
        UPDATE aware_subjects SET ledger = ?, status = ?, summary = ?, state_json = ?, salience_json = ?, source_feed = ?,
          status_since = ?, last_heard = MAX(last_heard, ?), expected_by = ?, resolved_at = ?,
          transitions_count = transitions_count + 1, last_seq = ?
        WHERE org_id = ? AND subject = ?
      `).run(ev.ledger, status, summary, json(state), json(salience), feed,
        statusChanged ? since : existing.status_since, ts, expectedBy, isRetract ? ts : null, seq, orgId, subject);
    }
    return { seq, journaled: true, transition: { from, to: status, held_ms: held } };
  })();
}


// Per-feed storm limit: one feed shouting >STORM_LIMIT events in a minute is
// collapsed into a single epistemic fact, feed:<name>, instead of flooding the
// journal. Heartbeats and snapshot events are exempt.
const STORM_LIMIT = 200;
const _storm = new Map(); // `${org}\u0000${feed}` -> { bucket, count, dropped, active }

function stormGate(ev) {
  if (!ev || ev.kind === 'heartbeat') return false;
  const orgId = typeof ev.org_id === 'string' ? ev.org_id.trim() : '';
  const feed = ev.source && typeof ev.source.feed === 'string' ? ev.source.feed.trim().slice(0, 80) : '';
  if (!orgId || !feed || (typeof ev.subject === 'string' && ev.subject.startsWith('feed:'))) return false;
  const ts = toMs(ev.ts) || Date.now();
  const bucket = Math.floor(ts / 60000);
  const key = `${orgId}\u0000${feed}`;
  let st = _storm.get(key);
  if (!st || st.bucket !== bucket) {
    // A new minute: a storm that has stopped is resolved, and that is journaled.
    if (st && st.active && bucket > st.bucket) {
      try {
        appendInner({ org_id: orgId, ledger: 'epistemic', subject: `feed:${feed}`, kind: 'retract', state: { status: 'calmed' },
          summary: `${feed} has calmed down (${st.dropped} events were dropped)`, ts, source: { surface: 'collector', feed } });
      } catch (err) { console.error('[LUCID] storm retract failed:', err && err.message); }
    }
    st = { bucket: (st && bucket < st.bucket) ? st.bucket : bucket, count: 0, dropped: 0, active: false };
    _storm.set(key, st);
  }
  st.count += 1;
  if (st.count <= STORM_LIMIT) return false;
  st.dropped += 1;
  const summary = `storm, ${st.dropped} event${st.dropped === 1 ? '' : 's'} dropped`;
  if (!st.active) {
    st.active = true;
    appendInner({ org_id: orgId, ledger: 'epistemic', subject: `feed:${feed}`, kind: 'state', state: { status: 'storm', dropped: st.dropped, limit_per_min: STORM_LIMIT },
      summary, ts, source: { surface: 'collector', feed } });
  } else {
    stmt(requireDb(), 'UPDATE aware_subjects SET summary = ?, state_json = ?, last_heard = MAX(last_heard, ?) WHERE org_id = ? AND subject = ?')
      .run(summary, json({ status: 'storm', dropped: st.dropped, limit_per_min: STORM_LIMIT }), ts, orgId, `feed:${feed}`);
  }
  return true;
}

/** Append one aware.* event. Storm-limited per feed. */
// Witness observer: told about every row that really landed, AFTER its transaction. It must
// never block or throw into append (the witness queues and runs on a later tick).
let _observer = null;
function setObserver(fn) { _observer = typeof fn === 'function' ? fn : null; }

function appendInner(ev = {}) {
  const r = appendCore(ev);
  if (_observer && r && r.journaled && r.seq) {
    try { _observer(String(ev.org_id).trim(), r.seq); } catch { /* the witness never breaks append */ }
  }
  return r;
}

function append(ev = {}) {
  if (stormGate(ev)) return { seq: null, journaled: false, transition: null, dropped: true };
  return appendInner(ev);
}

// ---- witness write-back + briefings issued -----------------------------------------------

function getJournalRow(seq) {
  const r = stmt(requireDb(), 'SELECT * FROM aware_journal WHERE seq = ?').get(Number(seq));
  return r ? { ...journalRow(r), org_id: r.org_id } : null;
}

function setWardEntryId(seq, wardEntryId) {
  stmt(requireDb(), 'UPDATE aware_journal SET ward_entry_id = ? WHERE seq = ?').run(String(wardEntryId).slice(0, 200), Number(seq));
}

function briefingRow(r) {
  return r && { id: r.id, org_id: r.org_id, ts: r.ts, viewer: r.viewer, surface: r.surface, kind: r.kind, situation_hash: r.situation_hash || null, ward_entry_id: r.ward_entry_id || null };
}

function addBriefing(orgId, { ts, viewer, surface, kind, situation_hash } = {}) {
  const info = stmt(requireDb(), 'INSERT INTO aware_briefings (org_id, ts, viewer, surface, kind, situation_hash) VALUES (?,?,?,?,?,?)')
    .run(orgId, toMs(ts) || Date.now(), str(viewer, 80) || 'owner', str(surface, 80) || 'api', str(kind, 40) || 'view', situation_hash || null);
  return Number(info.lastInsertRowid);
}

function getBriefing(id) {
  return briefingRow(stmt(requireDb(), 'SELECT * FROM aware_briefings WHERE id = ?').get(Number(id)));
}

function setBriefingWardId(id, wardEntryId) {
  stmt(requireDb(), 'UPDATE aware_briefings SET ward_entry_id = ? WHERE id = ?').run(String(wardEntryId).slice(0, 200), Number(id));
}

function listBriefings(orgId, { from = 0, to = Number.MAX_SAFE_INTEGER, limit = 500 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 5000);
  return stmt(requireDb(), 'SELECT * FROM aware_briefings WHERE org_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC, id ASC LIMIT ?')
    .all(orgId, from, to, lim).map(briefingRow);
}

/** Journal rows with ts <= T (oldest first), for replay. */
function journalUpTo(orgId, ts, { limit = 5000 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 5000, 1), 50000);
  return stmt(requireDb(), 'SELECT * FROM (SELECT * FROM aware_journal WHERE org_id = ? AND ts <= ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC')
    .all(orgId, ts, lim).map(journalRow);
}

/** Journal rows in a time window, optionally by subject prefix (oldest first). */
function journalWindow(orgId, from, to, { subjectLike, limit = 2000 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 2000, 1), 20000);
  const args = [orgId, from, to];
  let extra = '';
  if (subjectLike) { extra = ' AND subject LIKE ?'; args.push(subjectLike); }
  args.push(lim);
  return stmt(requireDb(), `SELECT * FROM aware_journal WHERE org_id = ? AND ts >= ? AND ts <= ?${extra} ORDER BY seq ASC LIMIT ?`).all(...args).map(journalRow);
}

/**
 * Apply a gatherer's full view of one facet: append every event, then retract
 * any still-open subject from the same feed + prefix that the snapshot no longer
 * contains (an approval that vanished from the inbox has been dealt with).
 */
function applySnapshot({ org_id, feed, prefix, ts, events = [], surface, as_of } = {}) {
  const db = requireDb();
  if (!feed) throw fail('bad_request', 'feed required');
  if (typeof prefix !== 'string' || !prefix) throw fail('bad_request', 'prefix required');
  const at = toMs(ts) || Date.now();
  // as_of: when the gatherer took its view. A subject heard from AFTER that moment
  // (a live event raced the snapshot) is newer than the snapshot and must not be retracted.
  const asOf = toMs(as_of);
  return db.transaction(() => {
    const seen = new Set();
    const results = [];
    for (const ev of events) {
      if (!ev || typeof ev.subject !== 'string' || !ev.subject.startsWith(prefix)) {
        throw fail('bad_request', `snapshot subject must start with ${prefix}`);
      }
      seen.add(ev.subject.trim());
      results.push(appendInner({ ...ev, org_id, ts: ev.ts || at, source: { surface, ...(ev.source || {}), feed } }));
    }
    // Session subjects are written by the snapshot feed AND by hooks. Once a session is truly gone
    // from the snapshot, a hook-written one the hook has not mentioned for 30 minutes goes with it.
    const sessions = prefix.startsWith('session:');
    const open = sessions
      ? stmt(db, `SELECT subject, ledger, last_heard, source_feed FROM aware_subjects WHERE org_id = ? AND resolved_at IS NULL AND substr(subject, 1, ?) = ?`)
        .all(org_id, prefix.length, prefix)
      : stmt(db, `SELECT subject, ledger, last_heard, source_feed FROM aware_subjects WHERE org_id = ? AND source_feed = ? AND resolved_at IS NULL AND substr(subject, 1, ?) = ?`)
        .all(org_id, feed, prefix.length, prefix);
    let retracted = 0;
    for (const s of open) {
      if (seen.has(s.subject)) continue;
      if (sessions && s.source_feed !== feed && heardOf(_heardSubj, `${org_id}|${s.subject}`, s.last_heard) > at - 30 * 60000) continue;
      if (asOf != null && heardOf(_heardSubj, `${org_id}|${s.subject}`, s.last_heard) >= asOf) continue;
      appendInner({ org_id, ledger: s.ledger, subject: s.subject, kind: 'retract', state: { status: 'gone' }, ts: at, source: { surface, feed } });
      retracted += 1;
    }
    return { appended: results.filter((r) => r.journaled).length, retracted };
  })();
}

function getSubject(orgId, subject) {
  return subjectRow(stmt(requireDb(), 'SELECT * FROM aware_subjects WHERE org_id = ? AND subject = ?').get(orgId, subject));
}

function listOpenSubjects(orgId, { ledger } = {}) {
  const where = ['org_id = ?', 'resolved_at IS NULL'];
  const args = [orgId];
  if (ledger) { where.push('ledger = ?'); args.push(ledger); }
  return stmt(requireDb(), `SELECT * FROM aware_subjects WHERE ${where.join(' AND ')} ORDER BY status_since ASC`).all(...args).map(subjectRow);
}

function listJournal(orgId, { afterSeq = 0, limit = 500 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 5000);
  return stmt(requireDb(), 'SELECT * FROM aware_journal WHERE org_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
    .all(orgId, Number(afterSeq) || 0, lim).map(journalRow);
}

function journalSince(orgId, sinceMs, { limit = 500 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 5000);
  return stmt(requireDb(), 'SELECT * FROM aware_journal WHERE org_id = ? AND ts >= ? ORDER BY seq ASC LIMIT ?')
    .all(orgId, sinceMs, lim).map(journalRow);
}

/** Most recent journal rows, newest first (for "the last thing that happened" per area). */
function recentJournal(orgId, { limit = 400 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 400, 1), 5000);
  return stmt(requireDb(), 'SELECT * FROM aware_journal WHERE org_id = ? ORDER BY seq DESC LIMIT ?').all(orgId, lim).map(journalRow);
}

/**
 * The newest `limit` rows after a cursor, oldest first, plus how many there are in total.
 * The situation only shows the latest changes; reading and parsing the whole journal on
 * every call made LUCID 70% of the collector's CPU (profile 2026-10-10).
 */
function journalTail(orgId, { afterSeq = 0, limit = 200 } = {}) {
  const db = requireDb();
  const after = Number(afterSeq) || 0;
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 2000);
  const rows = stmt(db, 'SELECT * FROM aware_journal WHERE org_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?').all(orgId, after, lim).reverse().map(journalRow);
  const total = stmt(db, 'SELECT COUNT(*) AS n, MAX(seq) AS s FROM aware_journal WHERE org_id = ? AND seq > ?').get(orgId, after);
  return { rows, total: total.n || 0, lastSeq: total.s || after };
}

function latestSeq(orgId) {
  const r = stmt(requireDb(), 'SELECT MAX(seq) AS s FROM aware_journal WHERE org_id = ?').get(orgId);
  return (r && r.s) || 0;
}

function listFeeds(orgId) {
  return stmt(requireDb(), 'SELECT * FROM aware_feeds WHERE org_id = ? ORDER BY feed ASC').all(orgId).map((r) => ({
    feed: r.feed,
    first_heard: r.first_heard,
    last_heard: heardOf(_heardFeed, `${orgId}|${r.feed}`, r.last_heard),
    expected_by: expectedOf(_heardFeed, `${orgId}|${r.feed}`, r.expected_by == null ? null : r.expected_by),
    last_error: r.last_error || null,
    last_error_at: r.last_error_at == null ? null : r.last_error_at,
  }));
}

function getCursor(orgId, viewer, surface) {
  const r = stmt(requireDb(), 'SELECT last_seen_seq FROM aware_cursors WHERE org_id = ? AND viewer = ? AND surface = ?').get(orgId, viewer, surface);
  return r ? r.last_seen_seq : 0;
}

function advanceCursor(orgId, viewer, surface, seq) {
  const n = Number(seq) || 0;
  stmt(requireDb(), `
    INSERT INTO aware_cursors (org_id, viewer, surface, last_seen_seq, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(org_id, viewer, surface) DO UPDATE SET
      last_seen_seq = MAX(aware_cursors.last_seen_seq, excluded.last_seen_seq), updated_at = excluded.updated_at
  `).run(orgId, String(viewer).slice(0, 120), String(surface).slice(0, 40), n, Date.now());
  return getCursor(orgId, viewer, surface);
}

/**
 * Declare the feeds this org should hear from. A declared feed that has never
 * spoken is reported as never heard, so a missing integration is a visible gap
 * rather than an absence nobody notices.
 */
function declareExpected(orgId, feeds = []) {
  const db = requireDb();
  const now = Date.now();
  const ins = stmt(db, 'INSERT OR IGNORE INTO aware_expected_feeds (org_id, feed, declared_at) VALUES (?,?,?)');
  for (const f of feeds.slice(0, 100)) {
    if (typeof f === 'string' && f.trim()) ins.run(orgId, f.trim().slice(0, 80), now);
  }
  return listExpected(orgId);
}

/** Stop expecting feeds (a source the owner retired should not stay a blind spot forever). */
function undeclareExpected(orgId, feeds = []) {
  const db = requireDb();
  const del = stmt(db, 'DELETE FROM aware_expected_feeds WHERE org_id = ? AND feed = ?');
  const delFeed = stmt(db, 'DELETE FROM aware_feeds WHERE org_id = ? AND feed = ?');
  for (const f of feeds.slice(0, 100)) {
    if (typeof f === 'string' && f.trim()) { del.run(orgId, f.trim()); delFeed.run(orgId, f.trim()); }
  }
  return listExpected(orgId);
}

function listExpected(orgId) {
  return stmt(requireDb(), 'SELECT feed FROM aware_expected_feeds WHERE org_id = ? ORDER BY feed').all(orgId).map((r) => r.feed);
}


/** Every transition of one subject, oldest first (the L3 evidence trail). */
function subjectHistory(orgId, subject, { limit = 50 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  return stmt(requireDb(), 'SELECT * FROM (SELECT * FROM aware_journal WHERE org_id = ? AND subject = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC')
    .all(orgId, subject, lim).map(journalRow);
}

const LESSON_SCOPES = ['subject', 'kind', 'area'];
const LESSON_FIELDS = ['L0', 'urgency', 'mute', 'affects', 'measure', 'label', 'watched'];

function lessonRow(r) {
  return { id: r.id, org_id: r.org_id, scope: r.scope, target: r.target, field: r.field, value: parse(r.value_json), reason: r.reason || '', ts: r.ts, author: r.author || null };
}

/** Owner corrections that survive: "that is not urgent", "call it X", "I care about this". */
function addLesson(orgId, { scope, target, field, value, reason, author, ts } = {}) {
  const db = requireDb();
  if (!orgId) throw fail('bad_request', 'org_id required');
  if (!LESSON_SCOPES.includes(scope)) throw fail('bad_request', `scope must be one of ${LESSON_SCOPES.join('|')}`);
  if (!LESSON_FIELDS.includes(field)) throw fail('bad_request', `field must be one of ${LESSON_FIELDS.join('|')}`);
  const t = typeof target === 'string' ? target.trim().slice(0, 240) : '';
  if (!t) throw fail('bad_request', 'target required');
  const v = value === undefined ? (field === 'mute' || field === 'watched' ? true : undefined) : value;
  if (v === undefined) throw fail('bad_request', 'value required');
  const id = `les_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  stmt(db, 'INSERT INTO aware_lessons (id, org_id, scope, target, field, value_json, reason, ts, author) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, orgId, scope, t, field, JSON.stringify(v), str(reason, 500), toMs(ts) || Date.now(), str(author, 120));
  return lessonRow(stmt(db, 'SELECT * FROM aware_lessons WHERE id = ?').get(id));
}

function listLessons(orgId) {
  return stmt(requireDb(), 'SELECT * FROM aware_lessons WHERE org_id = ? ORDER BY ts ASC, id ASC').all(orgId).map(lessonRow);
}

function deleteLesson(orgId, id) {
  return stmt(requireDb(), 'DELETE FROM aware_lessons WHERE org_id = ? AND id = ?').run(orgId, id).changes > 0;
}

function _resetStorm() { _storm.clear(); }

// ---- Herald (P3): settings, escalations, meta -------------------------------------

const ESC_COLS = ['episode_since', 'urgency', 'l0', 'item_kind', 'budget_ms', 'level', 'status', 'filed_item_id', 'l1_at',
  'l2_issued_at', 'l2_at', 'l3_issued_at', 'l3_at', 'attempts_l2', 'attempts_l3', 'owner_said', 'last_error', 'closed_ok', 'resolved_at'];

function getHeraldSettings(orgId) {
  const r = stmt(requireDb(), 'SELECT settings_json FROM aware_herald_settings WHERE org_id = ?').get(orgId);
  return r ? parse(r.settings_json) : null;
}

function setHeraldSettings(orgId, settings, now = Date.now()) {
  stmt(requireDb(), `INSERT INTO aware_herald_settings (org_id, settings_json, updated_at) VALUES (?,?,?)
    ON CONFLICT(org_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`)
    .run(orgId, JSON.stringify(settings), now);
  return settings;
}

function escRow(r) {
  return r ? { ...r, closed_ok: r.closed_ok == null ? null : !!r.closed_ok } : null;
}

function getEscalation(orgId, ref) {
  return escRow(stmt(requireDb(), 'SELECT * FROM aware_escalations WHERE org_id = ? AND ref = ?').get(orgId, ref));
}

function listEscalations(orgId, { status } = {}) {
  const rows = status
    ? stmt(requireDb(), 'SELECT * FROM aware_escalations WHERE org_id = ? AND status = ? ORDER BY created_at, ref').all(orgId, status)
    : stmt(requireDb(), 'SELECT * FROM aware_escalations WHERE org_id = ? ORDER BY created_at, ref').all(orgId);
  return rows.map(escRow);
}

/** Insert or update one escalation row; only known columns are written. */
function saveEscalation(orgId, ref, fields = {}, now = Date.now()) {
  const db = requireDb();
  const keys = Object.keys(fields).filter((k) => ESC_COLS.includes(k));
  const vals = keys.map((k) => (typeof fields[k] === 'boolean' ? (fields[k] ? 1 : 0) : fields[k]));
  const prev = stmt(db, 'SELECT 1 FROM aware_escalations WHERE org_id = ? AND ref = ?').get(orgId, ref);
  if (!prev) {
    const all = { episode_since: now, level: 'l1_inbox', status: 'open', ...fields };
    const cols = ['org_id', 'ref', 'created_at', 'updated_at', ...ESC_COLS.filter((c) => all[c] !== undefined)];
    const vs = [orgId, ref, now, now, ...ESC_COLS.filter((c) => all[c] !== undefined).map((c) => (typeof all[c] === 'boolean' ? (all[c] ? 1 : 0) : all[c]))];
    stmt(db, `INSERT INTO aware_escalations (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vs);
  } else if (keys.length) {
    stmt(db, `UPDATE aware_escalations SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE org_id = ? AND ref = ?`)
      .run(...vals, now, orgId, ref);
  }
  return getEscalation(orgId, ref);
}

/** Drop a resolved row so a returning item starts a fresh episode. */
function deleteEscalation(orgId, ref) {
  return stmt(requireDb(), 'DELETE FROM aware_escalations WHERE org_id = ? AND ref = ?').run(orgId, ref).changes > 0;
}

function getHeraldMeta(orgId, key) {
  const r = stmt(requireDb(), 'SELECT value_json FROM aware_herald_meta WHERE org_id = ? AND key = ?').get(orgId, key);
  return r ? parse(r.value_json) : null;
}

function setHeraldMeta(orgId, key, value, now = Date.now()) {
  stmt(requireDb(), `INSERT INTO aware_herald_meta (org_id, key, value_json, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(org_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
    .run(orgId, key, JSON.stringify(value), now);
}

/** Run fn inside one transaction (one commit for a whole gatherer post). */
function transaction(fn) {
  return requireDb().transaction(fn)();
}

module.exports = {
  scrubPii,
  transaction,
  needsGeneration,
  LEDGERS, KINDS,
  ensure, isReady, getDb: requireDb, append, applySnapshot, setObserver,
  getJournalRow, setWardEntryId, addBriefing, getBriefing, setBriefingWardId, listBriefings, journalUpTo, journalWindow,
  generation, getSubject, listOpenSubjects, listJournal, journalTail, recentJournal, journalSince, latestSeq, listFeeds,
  getCursor, advanceCursor, declareExpected, undeclareExpected, listExpected,
  getHeraldSettings, setHeraldSettings, getEscalation, listEscalations, saveEscalation, deleteEscalation, getHeraldMeta, setHeraldMeta,
  subjectHistory, addLesson, listLessons, deleteLesson, LESSON_SCOPES, LESSON_FIELDS, STORM_LIMIT, _resetStorm,
};
