/**
 * VOLT-RETENTION P4: read-path honesty for pruned runs. When a run's events
 * were pruned to cold storage, its volt_archive_anchors row says so.
 * Returns the public anchor shape, or null (no anchor, or the table does not
 * exist yet on an old DB).
 */
'use strict';

function getArchivedAnchor(voltDb, runId) {
  if (!voltDb || !runId) return null;
  try {
    const row = voltDb.prepare(
      'SELECT bundle_id, location, file_sha256, event_count, archived_at FROM volt_archive_anchors WHERE run_id = ?'
    ).get(runId);
    return row || null;
  } catch (_) {
    return null; // table missing on an old DB
  }
}

module.exports = { getArchivedAnchor };
