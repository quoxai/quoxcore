/**
 * MON-GOV-4: Agent behavioural baselines + anomaly detection.
 *
 * TRUST-GATE-MT SCOPE NOTE (2026-07-05, sweep verdict: documented-limitation):
 * activity_rate and error_rate baselines are INSTANCE-scoped ('__default__')
 * because the aee envelopes table carries no org_id; deny_rate baselines ARE
 * org-scoped (sourced from governance incidents, which do). Consequence: a
 * per-org UI reading activity/error baselines for a real org finds nothing —
 * consumers must query those two metrics under '__default__'. Unifying this
 * requires adding org_id to the envelopes schema (real migration, deferred —
 * tracked in roadmap TRUST-GATE-MT notes). Do not "fix" by silently relabeling
 * instance metrics with a real org id: that would fabricate per-tenant data.
 *
 * Rolling per-agent statistics (error_rate, activity_rate, deny_rate)
 * computed on a 7-day window, persisted into voltDb. Every detection
 * pass compares the current hour against the stored baseline and
 * flags agents whose metric exceeds ±3σ — but only if the agent has
 * been active long enough (7-day maturity) and has enough samples
 * (≥30) to make σ meaningful. Detected anomalies create
 * incident_type='anomaly_detected' rows, deduped per (agent, metric,
 * bucket_hour) so a sustained spike is one incident, not one per
 * minute.
 *
 * Data sources:
 *  - voltDb.governance_incidents  → deny_rate per agent
 *  - aeeDb.envelopes (ATTACHed)   → error_rate, activity_rate per agent
 *
 * voltDb is always the primary handle; aeeDb is attached via
 * ATTACH DATABASE so a single statement can read both.
 */

const { createIncident } = require('./governanceIncidents.js');

const ATTACH_ALIAS = 'aee';

const BASELINE_WINDOW_DAYS = 7;
// 2026-10-17 receipts honesty: tool calls that RETURN { success:false } are witnessed as type 'error' from the first boot
// that runs that code (they were success receipts). error_rate steps up against baselines built under the old rule, so
// for one baseline window after that boot an error_rate RISE says plainly that counting changed (the old hours cannot
// be recounted). The moment is per install (anchorErrorCountingChange, written once at startup); this constant is only
// the fallback when that store cannot be read or written (HYPERION review).
const ERROR_COUNTING_CHANGED_AT = '2026-10-17T00:00:00Z';
const META_ERROR_COUNTING_KEY = 'error_counting_changed_at';
const DEFAULT_MIN_SAMPLES = 30;
const DEFAULT_MIN_MATURITY_DAYS = 7;

// Severity scaling for σ magnitude of the current deviation.
const SIGMA_SEVERITY = [
  { sigma: 8, severity: 'critical' },
  { sigma: 5, severity: 'high' },
  { sigma: 3, severity: 'medium' },
];

const METRICS = ['error_rate', 'activity_rate', 'deny_rate'];

// ─── Schema ──────────────────────────────────────────────────────────────

function initAgentBehaviorBaselines(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_behavior_baselines (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      baseline_value REAL NOT NULL,
      stddev REAL NOT NULL,
      sample_count INTEGER NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      computed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(org_id, agent_id, metric)
    );
    CREATE INDEX IF NOT EXISTS idx_baseline_agent ON agent_behavior_baselines(agent_id, metric);
    CREATE INDEX IF NOT EXISTS idx_baseline_org ON agent_behavior_baselines(org_id);
    CREATE TABLE IF NOT EXISTS agent_behavior_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      set_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/** At startup: record the first boot that runs the receipts-honesty rule (kept on later boots). Returns the anchor. */
function anchorErrorCountingChange(db, now = new Date()) {
  try {
    db.prepare('INSERT OR IGNORE INTO agent_behavior_meta (key, value) VALUES (?, ?)').run(META_ERROR_COUNTING_KEY, now.toISOString());
    return getErrorCountingChangedAt(db);
  } catch (err) {
    console.warn(`[MON-GOV] error-counting anchor not written (${err && err.message}); using ${ERROR_COUNTING_CHANGED_AT}`);
    return ERROR_COUNTING_CHANGED_AT;
  }
}

/** This install's anchor, or the shipped constant when none can be read. */
function getErrorCountingChangedAt(db) {
  try {
    const row = db.prepare('SELECT value FROM agent_behavior_meta WHERE key = ?').get(META_ERROR_COUNTING_KEY);
    return (row && row.value) || ERROR_COUNTING_CHANGED_AT;
  } catch {
    return ERROR_COUNTING_CHANGED_AT;
  }
}

// ─── ATTACH helpers ──────────────────────────────────────────────────────

/**
 * ATTACH the AEE database to this voltDb handle as 'aee'. Returns true on
 * successful attach, false if already attached (or attach failed — e.g.
 * the caller passed no path for tests). Safe to call repeatedly.
 */
function attachAeeDb(voltDb, aeePath) {
  if (!voltDb || !aeePath) return false;
  try {
    voltDb.prepare(`SELECT 1 FROM ${ATTACH_ALIAS}.sqlite_master LIMIT 1`).get();
    return true; // Already attached
  } catch {
    // Not attached — continue.
  }
  try {
    const escaped = String(aeePath).replace(/'/g, "''");
    voltDb.exec(`ATTACH DATABASE '${escaped}' AS ${ATTACH_ALIAS}`);
    return true;
  } catch (err) {
    console.warn('[MON-GOV] ATTACH aee db failed:', err.message);
    return false;
  }
}

// ─── Maths ──────────────────────────────────────────────────────────────

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values, avg) {
  if (values.length < 2) return 0;
  const variance = values.reduce((acc, v) => acc + (v - avg) * (v - avg), 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function severityForSigma(sigmaMagnitude) {
  for (const row of SIGMA_SEVERITY) {
    if (sigmaMagnitude >= row.sigma) return row.severity;
  }
  return null;
}

// ─── Per-metric collectors ──────────────────────────────────────────────

/**
 * Hourly bucketed counts of envelopes where "from" is `agent.*` —
 * the agent's total throughput. Returns rows of
 * { org_id, agent_id, bucket_hour, count }.
 */
function hourlyActivity(voltDb, fromIso, toIso) {
  // envelopes table lives in the attached 'aee' database
  const rows = voltDb.prepare(`
    SELECT
      COALESCE(substr("from", 7), '') AS agent_id,
      substr(ts, 1, 13) AS bucket_hour,
      COUNT(*) AS cnt
    FROM ${ATTACH_ALIAS}.envelopes
    WHERE "from" LIKE 'agent.%'
      AND ts >= ? AND ts < ?
    GROUP BY agent_id, bucket_hour
  `).all(fromIso, toIso);

  // envelopes don't carry org_id — caller passes '__default__' unless
  // later phases add multi-tenant agent scoping.
  return rows.map((r) => ({
    org_id: '__default__',
    agent_id: r.agent_id,
    metric: 'activity_rate',
    bucket_hour: r.bucket_hour,
    value: r.cnt,
  }));
}

// quox#777: range on "from" (== LIKE 'agent.%' for lowercase ASCII ids) plus
// unary-plus on type so SQLite uses idx_envelopes_from_type_ts instead of
// scanning every error row via idx_type (the planner ignores the range
// without ANALYZE stats; the live aee.db has none).
function hourlyErrors(voltDb, fromIso, toIso) {
  const rows = voltDb.prepare(`
    SELECT
      COALESCE(substr("from", 7), '') AS agent_id,
      substr(ts, 1, 13) AS bucket_hour,
      COUNT(*) AS cnt
    FROM ${ATTACH_ALIAS}.envelopes
    -- 2026-10-16: the ts range drives (idx_ts); "from"/type are checked per row. With the "from" RANGE driving,
    -- every slice walked all agent envelopes ever written (21 s per boot catch-up, a 26.7 s loop block).
    WHERE ts >= ? AND ts < ?
      AND +"from" >= 'agent.' AND +"from" < 'agent/'
      AND +type = 'error'
    GROUP BY agent_id, bucket_hour
  `).all(fromIso, toIso);

  return rows.map((r) => ({
    org_id: '__default__',
    agent_id: r.agent_id,
    metric: 'error_rate',
    bucket_hour: r.bucket_hour,
    value: r.cnt,
  }));
}

function hourlyDenies(voltDb, fromIso, toIso) {
  const rows = voltDb.prepare(`
    SELECT
      COALESCE(agent_id, '') AS agent_id,
      org_id,
      substr(created_at, 1, 13) AS bucket_hour,
      COUNT(*) AS cnt
    FROM governance_incidents
    WHERE agent_id IS NOT NULL
      AND incident_type IN ('policy_violation', 'identity_missing', 'response_blocked')
      AND created_at >= ? AND created_at < ?
    GROUP BY agent_id, org_id, bucket_hour
  `).all(fromIso, toIso);

  return rows.map((r) => ({
    org_id: r.org_id || '__default__',
    agent_id: r.agent_id,
    metric: 'deny_rate',
    bucket_hour: r.bucket_hour,
    value: r.cnt,
  }));
}

function collectHourlyValues(voltDb, fromIso, toIso) {
  // Hourly buckets may exist across metrics; collectors run independently
  // and their outputs are concatenated. Agents missing from a metric
  // simply have no rows for it.
  return [
    ...hourlyActivity(voltDb, fromIso, toIso),
    ...hourlyErrors(voltDb, fromIso, toIso),
    ...hourlyDenies(voltDb, fromIso, toIso),
  ];
}

// ─── Baseline computation ───────────────────────────────────────────────

function groupKey(row) {
  return `${row.org_id}|${row.agent_id}|${row.metric}`;
}

/**
 * Build a per-(org, agent, metric) summary from the hourly-bucketed
 * values. Empty hours are counted as zero so a quiet agent does not
 * produce a falsely-high mean.
 */
function summariseForBaselines(hourlyRows, totalHours) {
  const byKey = new Map();
  for (const row of hourlyRows) {
    const key = groupKey(row);
    if (!byKey.has(key)) {
      byKey.set(key, { ...row, values: [], first_seen: row.bucket_hour });
    }
    const group = byKey.get(key);
    group.values.push(row.value);
    if (row.bucket_hour < group.first_seen) group.first_seen = row.bucket_hour;
  }

  const summaries = [];
  for (const [, group] of byKey) {
    // Pad to totalHours with zeros so quiet hours count.
    const zerosToAdd = Math.max(0, totalHours - group.values.length);
    const values = [...group.values, ...new Array(zerosToAdd).fill(0)];
    const avg = mean(values);
    const sd = stddev(values, avg);
    summaries.push({
      org_id: group.org_id,
      agent_id: group.agent_id,
      metric: group.metric,
      baseline_value: avg,
      stddev: sd,
      sample_count: values.length,
      first_seen: group.first_seen,
    });
  }
  return summaries;
}

/**
 * Compute baselines over the past `windowDays` hours and upsert into
 * agent_behavior_baselines. Returns the array of upserted rows.
 */
function computeBaselines(voltDb, options = {}) {
  const {
    windowDays = BASELINE_WINDOW_DAYS,
    now = new Date(),
    aeeAttached = true,
  } = options;

  if (!aeeAttached) {
    console.warn('[MON-GOV] computeBaselines skipped — aee db not attached');
    return [];
  }

  const toIso = now.toISOString();
  const fromIso = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const totalHours = windowDays * 24;

  const hourly = collectHourlyValues(voltDb, fromIso, toIso);
  const summaries = summariseForBaselines(hourly, totalHours);
  const upsert = makeBaselineUpsert(voltDb, fromIso, toIso);
  return summaries.map(upsert);
}

function makeBaselineUpsert(voltDb, fromIso, toIso) {
  const insert = voltDb.prepare(`
    INSERT INTO agent_behavior_baselines (
      id, org_id, agent_id, metric,
      baseline_value, stddev, sample_count,
      window_start, window_end, first_seen_at, computed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id, agent_id, metric) DO UPDATE SET
      baseline_value = excluded.baseline_value,
      stddev = excluded.stddev,
      sample_count = excluded.sample_count,
      window_start = excluded.window_start,
      window_end = excluded.window_end,
      computed_at = excluded.computed_at
  `);
  return (s) => {
    const id = `BL_${s.org_id}_${s.agent_id}_${s.metric}`
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .slice(0, 96);
    insert.run(
      id,
      s.org_id,
      s.agent_id,
      s.metric,
      s.baseline_value,
      s.stddev,
      s.sample_count,
      fromIso,
      toIso,
      // If first_seen bucket is earlier, baseline is at least that old.
      new Date(`${s.first_seen}:00:00.000Z`).toISOString(),
      toIso,
    );
    return { ...s, id, window_start: fromIso, window_end: toIso };
  };
}

// One hourly collector over hour-aligned time slices, yielding between them.
// Rows are merged by their GROUP BY key (a bucket split across two slices is
// summed) and returned in the collector's own GROUP BY order, so the result is
// the one-query result. WORKER7 2026-10-16: each collector was one synchronous
// GROUP BY over 7 days of envelopes, run at every collector start.
async function collectSliced(collect, voltDb, fromIso, toIso, { sliceHours, yieldFn }) {
  const step = Math.max(1, sliceHours) * 60 * 60 * 1000;
  const toMs = Date.parse(toIso);
  const merged = new Map();
  for (let a = Date.parse(fromIso); a < toMs;) {
    const b = Math.min(toMs, (Math.floor(a / step) + 1) * step);
    const from = a === Date.parse(fromIso) ? fromIso : new Date(a).toISOString();
    const to = b === toMs ? toIso : new Date(b).toISOString();
    for (const r of collect(voltDb, from, to)) {
      const k = `${r.agent_id}\u0000${r.org_id}\u0000${r.bucket_hour}`;
      const m = merged.get(k);
      if (m) m.value += r.value;
      else merged.set(k, { ...r });
    }
    a = b;
    await yieldFn();
  }
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  return [...merged.values()].sort((x, y) => cmp(x.agent_id, y.agent_id) || cmp(x.org_id, y.org_id) || cmp(x.bucket_hour, y.bucket_hour));
}

/**
 * Event-loop-friendly computeBaselines for the boot catch-up and the daily run:
 * identical output, but each hourly collector runs over `sliceHours` time
 * slices with a yield between them, and upserts yield too, so no single
 * synchronous slice holds the loop for the whole pass.
 */
async function computeBaselinesAsync(voltDb, options = {}) {
  const {
    windowDays = BASELINE_WINDOW_DAYS,
    now = new Date(),
    aeeAttached = true,
    yieldFn = () => new Promise((r) => setImmediate(r)),
    chunkSize = 1,
    sliceHours = 6,
  } = options;

  if (!aeeAttached) {
    console.warn('[MON-GOV] computeBaselines skipped — aee db not attached');
    return [];
  }

  const toIso = now.toISOString();
  const fromIso = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const totalHours = windowDays * 24;

  const hourly = [];
  for (const collect of [hourlyActivity, hourlyErrors, hourlyDenies]) {
    hourly.push(...await collectSliced(collect, voltDb, fromIso, toIso, { sliceHours, yieldFn }));
  }
  const summaries = summariseForBaselines(hourly, totalHours);
  const upsert = makeBaselineUpsert(voltDb, fromIso, toIso);

  const upserted = [];
  for (let i = 0; i < summaries.length; i += 1) {
    upserted.push(upsert(summaries[i]));
    if ((i + 1) % chunkSize === 0) await yieldFn();
  }
  return upserted;
}

// ─── Anomaly detection ──────────────────────────────────────────────────

function listBaselines(voltDb, { org_id } = {}) {
  const params = [];
  let where = '';
  if (org_id) {
    where = 'WHERE org_id = ?';
    params.push(org_id);
  }
  const rows = voltDb
    .prepare(`SELECT * FROM agent_behavior_baselines ${where} ORDER BY agent_id, metric`)
    .all(...params);
  return rows;
}

/**
 * Read the value for a single (agent, metric) in the current
 * (hourlyBucket) bucket. Mirrors collectHourlyValues structure but
 * scoped to one hour.
 */
function currentHourValue(voltDb, agent_id, metric, bucketHourIso) {
  const fromIso = `${bucketHourIso}:00:00.000Z`;
  const toIso = new Date(new Date(fromIso).getTime() + 60 * 60 * 1000).toISOString();

  if (metric === 'activity_rate') {
    const r = voltDb.prepare(`
      SELECT COUNT(*) AS cnt FROM ${ATTACH_ALIAS}.envelopes
      WHERE "from" = ? AND ts >= ? AND ts < ?
    `).get(`agent.${agent_id}`, fromIso, toIso);
    return r.cnt || 0;
  }
  if (metric === 'error_rate') {
    const r = voltDb.prepare(`
      SELECT COUNT(*) AS cnt FROM ${ATTACH_ALIAS}.envelopes
      WHERE "from" = ? AND type = 'error' AND ts >= ? AND ts < ?
    `).get(`agent.${agent_id}`, fromIso, toIso);
    return r.cnt || 0;
  }
  if (metric === 'deny_rate') {
    const r = voltDb.prepare(`
      SELECT COUNT(*) AS cnt FROM governance_incidents
      WHERE agent_id = ?
        AND incident_type IN ('policy_violation', 'identity_missing', 'response_blocked')
        AND created_at >= ? AND created_at < ?
    `).get(agent_id, fromIso, toIso);
    return r.cnt || 0;
  }
  return 0;
}

/**
 * Compare the current hour against every stored baseline. Emits an
 * incident for each agent+metric pair that clears the σ threshold AND
 * the sample/maturity guards. Returns an array of { agent_id, metric,
 * sigma, severity, incident } describing what fired.
 */
function detectAnomalies(voltDb, options = {}) {
  const {
    now = new Date(),
    minSamples = DEFAULT_MIN_SAMPLES,
    minMaturityDays = DEFAULT_MIN_MATURITY_DAYS,
    minSigma = 3,
    aeeAttached = true,
    errorCountingChangedAt = getErrorCountingChangedAt(voltDb),
  } = options;
  const changedMs = Date.parse(errorCountingChangedAt || '');
  const countingChanged = Number.isFinite(changedMs) && now.getTime() >= changedMs
    && now.getTime() - changedMs < BASELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  if (!aeeAttached) return [];

  const baselines = listBaselines(voltDb);
  if (baselines.length === 0) return [];

  const bucketHour = new Date(Math.floor(now.getTime() / 3600000) * 3600000)
    .toISOString()
    .slice(0, 13); // YYYY-MM-DDTHH
  const maturityCutoffMs = minMaturityDays * 24 * 60 * 60 * 1000;

  const fired = [];

  for (const b of baselines) {
    // Guard 1: enough history to trust σ
    if ((b.sample_count || 0) < minSamples) continue;
    // Guard 2: agent must be mature
    const firstSeenMs = Date.parse(b.first_seen_at || '');
    if (!Number.isFinite(firstSeenMs)) continue;
    if (now.getTime() - firstSeenMs < maturityCutoffMs) continue;
    // Guard 3: stddev must be non-zero (otherwise σ-based detection degenerates)
    if (b.stddev <= 0) continue;

    const current = currentHourValue(voltDb, b.agent_id, b.metric, bucketHour);
    const delta = current - b.baseline_value;
    const sigma = delta / b.stddev;

    if (Math.abs(sigma) < minSigma) continue;

    const severity = severityForSigma(Math.abs(sigma));
    if (!severity) continue;

    // Upsert an anomaly incident. corr is synthesised from
    // (agent, metric, bucket_hour) so retries within the same hour
    // collapse through the existing incident dedup_key.
    const corr = `ANOM_${b.agent_id}_${b.metric}_${bucketHour}`;
    const changeNote = countingChanged && b.metric === 'error_rate' && sigma > 0;
    const changedDay = changeNote ? new Date(changedMs).toISOString().slice(0, 10) : null;
    const title = `Agent ${b.agent_id} ${b.metric} deviates ${sigma.toFixed(1)}σ from baseline${changeNote ? ' (error counting changed)' : ''}`;
    const description =
      `Observed ${current.toFixed(2)} in the current hour vs baseline ${b.baseline_value.toFixed(2)} (σ=${b.stddev.toFixed(2)}, samples=${b.sample_count}).`
      + (changeNote ? ` Error counting changed on ${changedDay}: refused tool calls (a tool that returns a failure instead of throwing) now count as errors, and this baseline was built before that, so part or all of this rise is the new rule, not new failures. Check the failing calls before treating it as a spike.` : '');

    const incident = createIncident(voltDb, {
      org_id: b.org_id,
      incident_type: 'anomaly_detected',
      severity,
      layer: null,
      policy_id: null,
      policy_name: null,
      framework_mapping: [],
      corr,
      envelope_ids: [],
      agent_id: b.agent_id,
      user_id: null,
      title,
      description,
      context_json: {
        source: 'agentBehaviorService',
        metric: b.metric,
        baseline_value: b.baseline_value,
        current_value: current,
        stddev: b.stddev,
        sigma,
        sample_count: b.sample_count,
        bucket_hour: bucketHour,
        ...(changeNote ? { error_counting_changed_at: errorCountingChangedAt } : {}),
      },
    });

    fired.push({
      agent_id: b.agent_id,
      metric: b.metric,
      sigma,
      severity,
      incident_id: incident.id,
      _inserted: !!incident._inserted,
    });
  }

  return fired;
}

module.exports = {
  METRICS,
  BASELINE_WINDOW_DAYS,
  DEFAULT_MIN_SAMPLES,
  DEFAULT_MIN_MATURITY_DAYS,
  initAgentBehaviorBaselines,
  anchorErrorCountingChange,
  getErrorCountingChangedAt,
  ERROR_COUNTING_CHANGED_AT,
  attachAeeDb,
  computeBaselines,
  computeBaselinesAsync,
  detectAnomalies,
  listBaselines,
  severityForSigma,
};
