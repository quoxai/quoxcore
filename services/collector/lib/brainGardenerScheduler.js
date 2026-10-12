'use strict';

/**
 * brainGardenerScheduler.js - ONE-BRAIN CX6 "the gardener".
 *
 * The brain proposes tidy-ups of the user's own private notes; the user
 * approves each one in the approvals inbox. Nothing is ever applied here:
 * every proposal goes through executeTool('brain_garden_apply'), an
 * ALWAYS-PROPOSE tool, so the one approval boundary files the card and the
 * archive happens only on approve (lib/toolExecutors/brainGarden.js).
 *
 * Per tick (hourly by default; first tick at +interval, never at boot):
 *  1. orgs that opted in (org setting BRAIN_GARDENER_ENABLED=true, supplied by
 *     listOptedInOrgs; a stored org override is the ONLY opt-in);
 *  2. per org, the users who own private notes (quoxbrain /internal/garden/users);
 *  3. per user, at most once a day: quoxbrain notebookHealth AS that user
 *     (scope=user, so only their own private notes are ever considered);
 *  4. each finding group becomes ONE proposal (see buildProposals), skipping
 *     any note already proposed in the last 30 days, capped per run.
 *
 * What it deliberately does NOT propose:
 *  - title-only duplicate groups (same title, different bodies: archiving one
 *    could lose content);
 *  - broken links (a dangling wikilink cannot be repaired without guessing the
 *    target, and archiving the source would hide good content);
 *  - shared org notes (notebookHealth is run with scope=user only).
 *
 * Loop hygiene triad (CLAUDE.md "Loop & Restart Hygiene"):
 *  - failures are counted DISTINCTLY from empty runs (stats.failures vs
 *    stats.empty); a brain error, a listing error or a proposal the gate did
 *    not file is a failure and never marks the user as having run;
 *  - capped backoff per target: after f consecutive failures it is skipped
 *    min(2^(f-1)-1, MAX_BACKOFF_TICKS) ticks (in memory);
 *  - durable retirement: after RETIRE_AFTER_FAILURES consecutive failures the
 *    user is disabled (brain_gardener_state.disabled_at + reason), loudly
 *    logged; re-enable by deleting that row.
 * Durable state: sqlite tables below, in the collector's own database.
 */

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const RUN_EVERY_MS = 24 * 60 * 60 * 1000;
const DEDUPE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BACKOFF_TICKS = 8;
const RETIRE_AFTER_FAILURES = 10;
const MAX_PROPOSALS_PER_RUN = 5;
const STALE_BATCH = 10;
const REQUEST_TIMEOUT_MS = 30000;
const AGENT_ID = 'cortex';

function resolveIntervalMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(n, MIN_INTERVAL_MS);
}

function backoffTicks(failures) {
  return Math.min(Math.pow(2, Math.max(failures, 1) - 1) - 1, MAX_BACKOFF_TICKS);
}

/** Turn notebookHealth findings into proposal inputs (without hashes). Pure. */
function buildProposals(h) {
  const out = [];
  const titleOf = (n) => String(n.title || 'untitled');
  for (const g of Array.isArray(h && h.duplicates) ? h.duplicates : []) {
    if (!g || (g.kind !== 'exact' && g.kind !== 'near') || !Array.isArray(g.notes) || g.notes.length < 2) continue;
    // notebookHealth lists each group newest first: keep the newest, archive the rest.
    const [keep, ...rest] = g.notes;
    const doomed = rest.slice(0, 20);
    out.push({
      action: 'archive',
      proposalKind: 'duplicate',
      noteIds: doomed.map((n) => n.id),
      titles: Object.fromEntries(doomed.map((n) => [n.id, titleOf(n)])),
      reason: g.kind === 'exact'
        ? `Identical text to "${titleOf(keep)}", which is newer and stays.`
        : `About ${Math.round((g.similarity || 0) * 100)}% the same text as "${titleOf(keep)}", which is newer and stays.`,
    });
  }
  const stale = (Array.isArray(h && h.stale) ? h.stale : [])
    .slice()
    .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)))
    .slice(0, STALE_BATCH);
  if (stale.length) {
    out.push({
      action: 'archive',
      proposalKind: 'stale',
      noteIds: stale.map((n) => n.id),
      titles: Object.fromEntries(stale.map((n) => [n.id, titleOf(n)])),
      reason: `Not edited for a long time (oldest: ${String(stale[0].updated_at).slice(0, 10)}). Check nothing still depends on them: other notes link to some of these.`,
    });
  }
  return out;
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brain_gardener_state (
      org_id TEXT NOT NULL, user_id TEXT NOT NULL,
      last_run_at INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, disabled_at INTEGER, disabled_reason TEXT,
      PRIMARY KEY (org_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS brain_gardener_proposed (
      org_id TEXT NOT NULL, user_id TEXT NOT NULL, note_id TEXT NOT NULL,
      kind TEXT NOT NULL, set_key TEXT NOT NULL, approval_id TEXT, proposed_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, user_id, note_id, proposed_at)
    );
    CREATE INDEX IF NOT EXISTS idx_brain_gardener_proposed_lookup ON brain_gardener_proposed(org_id, user_id, proposed_at);
  `);
}

function createBrainGardenerScheduler({
  db,
  brainUrl,
  serviceKey,
  listOptedInOrgs,
  executeTool,
  fetchFn = (...a) => fetch(...a),
  now = () => Date.now(),
  log = console.log,
  logError = console.error,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxProposalsPerRun = MAX_PROPOSALS_PER_RUN,
  staleDays = 180,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!db) throw new Error('brainGardenerScheduler requires a database handle');
  ensureTables(db);
  const skipTicks = new Map(); // target key -> ticks still to skip
  let timer = null;
  let running = false;

  const headers = (orgId, userId) => ({
    'Content-Type': 'application/json',
    'X-Service-Key': serviceKey || '',
    ...(orgId ? { 'X-Org-Id': orgId } : {}),
    ...(userId ? { 'X-User-Id': userId } : {}),
  });

  async function get(url, orgId, userId) {
    const res = await fetchFn(url, { method: 'GET', headers: headers(orgId, userId), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new Error(`GET ${url.replace(/\?.*/, '')} -> ${res.status}${json && json.error ? ` ${json.error}` : ''}`);
    return json;
  }

  const stateOf = (o, u) => db.prepare('SELECT * FROM brain_gardener_state WHERE org_id = ? AND user_id = ?').get(o, u);
  const wasProposed = db.prepare('SELECT 1 FROM brain_gardener_proposed WHERE org_id = ? AND user_id = ? AND note_id = ? AND proposed_at >= ? LIMIT 1');

  function markRun(o, u) {
    db.prepare(`INSERT INTO brain_gardener_state (org_id, user_id, last_run_at, consecutive_failures, last_error) VALUES (?, ?, ?, 0, NULL)
      ON CONFLICT(org_id, user_id) DO UPDATE SET last_run_at = excluded.last_run_at, consecutive_failures = 0, last_error = NULL`).run(o, u, now());
  }

  function markFailure(o, u, message) {
    db.prepare(`INSERT INTO brain_gardener_state (org_id, user_id, consecutive_failures, last_error) VALUES (?, ?, 1, ?)
      ON CONFLICT(org_id, user_id) DO UPDATE SET consecutive_failures = consecutive_failures + 1, last_error = excluded.last_error`).run(o, u, String(message).slice(0, 500));
    const row = stateOf(o, u);
    if (row.consecutive_failures >= RETIRE_AFTER_FAILURES && !row.disabled_at) {
      db.prepare('UPDATE brain_gardener_state SET disabled_at = ?, disabled_reason = ? WHERE org_id = ? AND user_id = ?')
        .run(now(), `${row.consecutive_failures} consecutive failures, last: ${String(message).slice(0, 200)}`, o, u);
      return { row: stateOf(o, u), retired: true };
    }
    return { row, retired: false };
  }

  function recordProposed(o, u, p, approvalId) {
    const key = p.noteIds.slice().sort().join(',');
    const ins = db.prepare('INSERT OR IGNORE INTO brain_gardener_proposed (org_id, user_id, note_id, kind, set_key, approval_id, proposed_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const t = now();
    for (const id of p.noteIds) ins.run(o, u, id, p.proposalKind, key, approvalId || null, t);
  }

  const isFiled = (r) => !!(r && (r.pending === true || r.status === 'awaiting_approval') && (r.approvalId || (r._approval && r._approval.id)));

  async function processTarget(orgId, userId, stats) {
    const h = await get(`${brainUrl}/notesq/health?scope=user&stale_days=${staleDays}`, orgId, userId);
    const candidates = buildProposals(h);
    const since = now() - DEDUPE_MS;
    let proposed = 0;
    for (const cand of candidates) {
      if (proposed >= maxProposalsPerRun) break;
      // Dedupe on the note set, and stricter: a note proposed in any group in the window is not re-proposed.
      const fresh = cand.noteIds.filter((id) => !wasProposed.get(orgId, userId, id, since));
      if (!fresh.length) { stats.deduped++; continue; }
      const noteIds = fresh;
      // Hashes as they stand now, so a note edited before approval is skipped on apply.
      const expectedHashes = {};
      const present = [];
      for (const id of noteIds) {
        const d = await get(`${brainUrl}/notesq/notes/${encodeURIComponent(id)}`, orgId, userId);
        const n = d && d.note;
        if (!n || n.scope !== 'user' || !n.content_hash) continue;
        expectedHashes[id] = n.content_hash;
        present.push(id);
      }
      if (!present.length) continue;
      const input = {
        action: 'archive',
        proposalKind: cand.proposalKind,
        noteIds: present,
        reason: cand.reason,
        titles: Object.fromEntries(present.map((id) => [id, (cand.titles || {})[id] || ''])),
        expectedHashes,
      };
      const r = await executeTool('brain_garden_apply', input, { orgId, userId, agentId: AGENT_ID, session_id: `brain-gardener:${orgId}:${userId}` });
      if (!isFiled(r)) {
        throw new Error(`proposal not filed (${cand.proposalKind}): ${(r && (r.error || r.message)) || 'no approval id returned'}`);
      }
      recordProposed(orgId, userId, input, r.approvalId || (r._approval && r._approval.id));
      proposed++;
    }
    return proposed;
  }

  async function tick() {
    if (running) return { skippedOverlap: true };
    running = true;
    const stats = { orgs: 0, users: 0, proposed: 0, deduped: 0, empty: 0, failures: 0, backedOff: 0, notDue: 0, retired: 0, justRetired: 0 };
    try {
      let orgs;
      try {
        orgs = [...new Set((await listOptedInOrgs()) || [])];
      } catch (err) {
        stats.failures++;
        logError(`[BrainGardener] tick FAILED to list opted-in orgs: ${err.message}`);
        return stats;
      }
      stats.orgs = orgs.length;
      for (const orgId of orgs) {
        const orgKey = `org:${orgId}`;
        const orgLeft = skipTicks.get(orgKey) || 0;
        if (orgLeft > 0) { skipTicks.set(orgKey, orgLeft - 1); stats.backedOff++; continue; }
        let users;
        try {
          const d = await get(`${brainUrl}/internal/garden/users`, orgId, 'service');
          users = Array.isArray(d && d.users) ? d.users : [];
          skipTicks.delete(orgKey);
        } catch (err) {
          // Brain unreachable is a failure, never "0 users".
          stats.failures++;
          skipTicks.set(orgKey, MAX_BACKOFF_TICKS);
          logError(`[BrainGardener] could not list users for org ${orgId}: ${err.message}`);
          continue;
        }
        for (const userId of users) {
          stats.users++;
          const key = `${orgId}:${userId}`;
          const st = stateOf(orgId, userId);
          if (st && st.disabled_at) { stats.retired++; continue; }
          const left = skipTicks.get(key) || 0;
          if (left > 0) { skipTicks.set(key, left - 1); stats.backedOff++; continue; }
          if (st && st.last_run_at && now() - st.last_run_at < RUN_EVERY_MS) { stats.notDue++; continue; }
          try {
            const n = await processTarget(orgId, userId, stats);
            markRun(orgId, userId);
            skipTicks.delete(key);
            if (n > 0) stats.proposed += n; else stats.empty++;
          } catch (err) {
            stats.failures++;
            const out = markFailure(orgId, userId, err.message);
            skipTicks.set(key, backoffTicks(out.row.consecutive_failures));
            if (out.retired) {
              stats.justRetired++;
              logError(`[BrainGardener] RETIRED ${key}: ${out.row.disabled_reason}`);
            } else {
              logError(`[BrainGardener] ${key} failed (${out.row.consecutive_failures} consecutive): ${err.message}`);
            }
          }
        }
      }
      if (stats.proposed || stats.failures) {
        log(`[BrainGardener] tick: ${stats.orgs} org(s), ${stats.users} user(s), ${stats.proposed} proposed, ${stats.deduped} deduped, ${stats.empty} nothing to tidy, ${stats.failures} failed, ${stats.backedOff} backed off, ${stats.retired} retired`);
      }
      return stats;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    // First tick at +interval, never at boot.
    timer = setIntervalFn(() => { tick().catch((e) => logError(`[BrainGardener] tick crashed: ${e.message}`)); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function stop() { if (timer) { clearIntervalFn(timer); timer = null; } }

  return { tick, start, stop, intervalMs };
}

module.exports = {
  createBrainGardenerScheduler, buildProposals, resolveIntervalMs, backoffTicks,
  DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_BACKOFF_TICKS, RETIRE_AFTER_FAILURES, MAX_PROPOSALS_PER_RUN, RUN_EVERY_MS, DEDUPE_MS,
};
