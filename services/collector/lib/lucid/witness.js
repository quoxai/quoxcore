'use strict';

/**
 * LUCID witness: what did the system know, and what did it tell the person, as a chain they
 * can check afterwards. Selective by design (WARD appendEntry was already 11s of every 90s of
 * collector CPU): only the rows that answer "what did LUCID know and say", never gatherer
 * heartbeats or session ticks.
 *
 * Path: journal.append -> observer (O(1), queues a seq) -> a later tick drains the queue ->
 * sink({ event_id, hash, ts, org_id }) -> the existing VOLT/WARD hook (server.js wardHookVOLT,
 * source_kind VOLT, event_id `LUCID_<type>_<org>_<n>`) -> entry.ward_entry_id is written back onto
 * aware_journal / aware_briefings. Nothing here blocks or throws into append; every failure is
 * COUNTED and surfaced as the epistemic fact `epistemic:witness` (failing / ok), never swallowed.
 *
 * Wiring (server.js): require('./lib/lucid/witness.js').start({ sink: wardHookVOLT })
 */

const crypto = require('crypto');
const journal = require('./journal.js');

const HERALD_STEPS = new Set(['l1_inbox', 'l2_slot', 'l3_call', 'resolved', 'l2_failed', 'l3_failed']);
const BRIEFING_DEDUPE_MS = 10 * 60 * 1000;
const QUEUE_MAX = 2000;
const BATCH = 20;

let _started = false;
let _sink = null;
let _queue = [];
let _queued = new Set();          // `${org}|${seq}`: one witness per row
let _scheduled = false;
let _briefSeen = new Map();       // `${org}|${viewer}|${surface}` -> { hash, at }
let _hashFn = null;
let _now = () => Date.now();
const _stats = { witnessed: 0, failed: 0, dropped: 0, skipped_no_sink: 0, last_error: null, last_error_at: null, failing: false };

function getStats() { return { ..._stats, queued: _queue.length, sink: !!_sink }; }

function configure({ sink, now, hashFn } = {}) {
  if (sink !== undefined) _sink = typeof sink === 'function' ? sink : null;
  if (typeof now === 'function') _now = now;
  if (hashFn !== undefined) _hashFn = hashFn;
}

function start({ sink, now, hashFn } = {}) {
  configure({ sink, now, hashFn });
  _started = true;
  journal.setObserver(onAppend);
}

function reset() {
  _started = false; _sink = null; _queue = []; _queued = new Set(); _scheduled = false; _briefSeen = new Map(); _hashFn = null; _now = () => Date.now();
  for (const k of Object.keys(_stats)) _stats[k] = typeof _stats[k] === 'number' ? 0 : (typeof _stats[k] === 'boolean' ? false : null);
  journal.setObserver(null);
}

// ---- selection (the contract) ---------------------------------------------------------------

/** The witness event type for a journal row, or null when the row is not worth a chain entry. */
function typeFor(row) {
  if (!row || row.kind === 'heartbeat') return null;
  const subject = String(row.subject || '');
  const status = String(row.status || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  if (subject.startsWith('herald:')) return HERALD_STEPS.has(status) ? `aware.escalate.${status}` : null;
  if (subject === 'epistemic:witness') return null; // never witness the witness's own alarm
  if (row.ledger === 'epistemic' && subject.startsWith('epistemic:')) return `aware.epistemic.${subject.slice(10).split(':')[0].replace(/[^a-z0-9_]+/gi, '_') || 'fact'}`;
  if (subject.startsWith('approval:')) return `aware.approval.${status || 'changed'}`;
  if (subject.startsWith('security:')) return `aware.security.${status || 'changed'}`;
  return null;
}

// ---- queue ----------------------------------------------------------------------------------

function enqueue(job) {
  if (_queue.length >= QUEUE_MAX) {
    _queue.shift();
    _stats.dropped += 1;
    noteFailure('witness queue overflow: oldest entry dropped');
  }
  _queue.push(job);
  schedule();
}

function schedule() {
  if (_scheduled) return;
  _scheduled = true;
  setImmediate(() => { _scheduled = false; drain().catch((e) => noteFailure(e && e.message)); });
}

function onAppend(orgId, seq) {
  const key = `${orgId}|${seq}`;
  if (_queued.has(key)) return;
  if (_queued.size > 20000) _queued.clear();
  _queued.add(key);
  // Selection needs the row; reading it is deferred to the drain tick so append stays O(1).
  enqueue({ t: 'row', orgId, seq });
}

/** Herald (and anyone holding a seq) can ask explicitly. Deduped with the observer. */
function witnessSeq(orgId, seq) {
  if (!_started || !orgId || !seq) return;
  onAppend(orgId, seq);
}

function digest(obj) { return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex'); }

async function callSink(payload) {
  if (!_sink) { _stats.skipped_no_sink += 1; throw new Error('no witness sink wired (WARD hook unavailable)'); }
  const entry = await _sink(payload);
  // The collector's wardHookVOLT is fire-and-forget: it witnesses under the event_id we supply and
  // returns nothing. A returned entry id is used when a sink gives one; otherwise the event_id IS the
  // WARD reference (the receipt resolver looks receipts up by it). A thrown error is a real failure.
  const id = (entry && (entry.ward_entry_id || entry.id)) || payload.event_id;
  if (!id) throw new Error('witness sink returned no entry and the event had no id');
  return String(id);
}

async function runJob(job) {
  if (job.t === 'row') {
    const row = journal.getJournalRow(job.seq);
    const type = typeFor(row);
    if (!type) return false;
    const hash = digest({ org: row.org_id, seq: row.seq, ts: row.ts, ledger: row.ledger, subject: row.subject, kind: row.kind, status: row.status, summary: row.summary });
    const id = await callSink({ event_id: `LUCID_${type}_${row.org_id}_${row.seq}`, hash, ts: new Date(row.ts).toISOString(), org_id: row.org_id });
    journal.setWardEntryId(row.seq, id);
  } else if (job.t === 'briefing') {
    const b = journal.getBriefing(job.id);
    if (!b) return false;
    const hash = digest({ org: b.org_id, id: b.id, ts: b.ts, viewer: b.viewer, surface: b.surface, kind: b.kind, situation_hash: b.situation_hash });
    const wid = await callSink({ event_id: `LUCID_aware.briefing.issued_${b.org_id}_${b.id}`, hash, ts: new Date(b.ts).toISOString(), org_id: b.org_id });
    journal.setBriefingWardId(b.id, wid);
  } else if (job.t === 'raw') {
    await callSink({ event_id: `LUCID_${job.type}_${job.orgId}_${job.ref}`, hash: digest(job.body), ts: new Date(job.ts).toISOString(), org_id: job.orgId });
  }
}

async function drain() {
  const batch = _queue.splice(0, BATCH);
  for (const job of batch) {
    try {
      const did = await runJob(job);
      if (job.t === 'row') _queued.delete(`${job.orgId}|${job.seq}`);
      if (did === false) continue; // not selected: neither a success nor a failure
      _stats.witnessed += 1;
      if (_stats.failing) noteRecovered(job.orgId);
    } catch (err) {
      if (job.t === 'row') _queued.delete(`${job.orgId}|${job.seq}`);
      noteFailure(err && err.message, job.orgId || (job.t === 'briefing' && (journal.getBriefing(job.id) || {}).org_id));
    }
  }
  if (_queue.length) schedule();
}

// ---- failure surfacing ------------------------------------------------------------------------

const _orgsSeen = new Set();

function noteFailure(message, orgId) {
  _stats.failed += 1;
  _stats.last_error = String(message || 'unknown').slice(0, 300);
  _stats.last_error_at = _now();
  if (orgId) _orgsSeen.add(orgId);
  if (_stats.failing) return;
  _stats.failing = true;
  console.error('[LUCID/witness] failing:', _stats.last_error);
  for (const org of _orgsSeen) emitFact(org, 'failing', `The witness chain is unavailable: ${_stats.last_error}. LUCID's record of what it told you is not being witnessed.`);
}

function noteRecovered(orgId) {
  _stats.failing = false;
  for (const org of new Set([...(orgId ? [orgId] : []), ..._orgsSeen])) emitFact(org, 'ok', 'The witness chain is available again.');
}

function emitFact(orgId, status, summary) {
  try {
    if (!journal.isReady()) return;
    journal.append({
      org_id: orgId, ledger: 'epistemic', subject: 'epistemic:witness', kind: 'state', ts: _now(),
      state: { status, failed: _stats.failed, witnessed: _stats.witnessed, last_error: _stats.last_error },
      summary, salience: status === 'failing' ? { needs: 'owner' } : undefined,
      source: { surface: 'lucid', feed: 'witness', writer: 'witness' },
    });
  } catch (err) { console.error('[LUCID/witness] could not record epistemic:witness:', err && err.message); }
}

// ---- briefings issued -------------------------------------------------------------------------

function hashOf(value) {
  try {
    if (_hashFn) return _hashFn(value);
    const { wireOf } = require('./routes.js');
    return crypto.createHash('sha256').update(wireOf(value).body).digest('hex');
  } catch { return null; }
}

/**
 * A person-facing situation was delivered. Records the delivery (and its wire hash, so replay
 * can prove the body matches) and queues the witness. Never throws. The same viewer+surface
 * receiving the same body inside 10 minutes (a memo hit) is not a new briefing.
 * @param {string} orgId
 * @param {{viewer?:string, surface?:string, kind?:string}} who
 * @param {object} value situationFor's return value (its wire body is hashed; wireOf caches it for the response)
 */
function briefingIssued(orgId, { viewer = 'owner', surface = 'api', kind = 'view' } = {}, value) {
  try {
    if (!_started || !orgId || !journal.isReady()) return null;
    const now = _now();
    const key = `${orgId}|${viewer}|${surface}`;
    const seen = _briefSeen.get(key);
    const hash = value ? hashOf(value) : null;
    if (seen && now - seen.at < BRIEFING_DEDUPE_MS && (!hash || !seen.hash || seen.hash === hash)) return null;
    if (_briefSeen.size > 500) _briefSeen.clear();
    _briefSeen.set(key, { hash, at: now });
    const id = journal.addBriefing(orgId, { ts: now, viewer, surface, kind, situation_hash: hash });
    enqueue({ t: 'briefing', id });
    return id;
  } catch (err) {
    noteFailure(`briefing record failed: ${err && err.message}`, orgId);
    return null;
  }
}

// ---- lessons and measures (no journal row; witnessed straight through) ---------------------------

function witnessRaw(orgId, type, ref, body, ts = _now()) {
  enqueue({ t: 'raw', orgId, type, ref: String(ref), body, ts });
}
function witnessLesson(orgId, lesson) { if (lesson) witnessRaw(orgId, 'aware.lesson.added', lesson.id || lesson.ts || _now(), lesson); }
function witnessMeasure(orgId, { ref, measure, status } = {}) { witnessRaw(orgId, 'aware.measure.run', `${ref}_${measure}_${_now()}`, { ref, measure, status }); }

module.exports = {
  start, configure, reset, getStats, typeFor, witnessSeq, briefingIssued, witnessLesson, witnessMeasure,
  _drain: drain, BRIEFING_DEDUPE_MS,
};
