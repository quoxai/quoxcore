/**
 * VOLT evidence bundle construction (VOLT SPEC section 7), shared by the
 * /volt/bundles/create route and scripts/volt-archive.js so there is ONE
 * implementation of manifest + events_ndjson.
 *
 * buildBundleParts(rows, opts)
 *   rows: any iterable of volt_events rows ({ data: '<json string>', ... }).
 *         Iterables (e.g. a better-sqlite3 statement .iterate()) are consumed
 *         once, so a caller never has to materialise the row set itself.
 *   opts: { runId, status, bundleId?, createdTs? }
 *   returns { manifest, eventsNdjson, eventCount } or null when there are no rows.
 */

function buildBundleParts(rows, opts = {}) {
  const { runId, status } = opts;
  const lines = [];
  let first = null;
  let last = null;
  for (const e of rows) {
    let parsed;
    try { parsed = { ...e, data: JSON.parse(e.data) }; } catch { parsed = e; }
    const body = parsed.data || parsed;
    if (first === null) first = body;
    last = body;
    lines.push(JSON.stringify(body));
  }
  if (lines.length === 0) return null;

  const manifest = {
    volt_version: '0.1',
    bundle_id: opts.bundleId || `BDL_${runId}_${Date.now()}`,
    run_id: runId,
    created_ts: opts.createdTs || new Date().toISOString(),
    hash_alg: 'sha256',
    event_count: lines.length,
    first_event_hash: first.hash || null,
    last_event_hash: last.hash || null,
    bundle_mode: status === 'completed' ? 'final' : 'rolling',
    producer: { name: 'quox-collector', version: '1.0' },
  };
  return { manifest, eventsNdjson: lines.join('\n'), eventCount: lines.length };
}

module.exports = { buildBundleParts };
