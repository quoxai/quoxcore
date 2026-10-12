'use strict';

/**
 * createVoltSkillReader({ db })
 *
 * Factory that returns a reader backed by the injected better-sqlite3 Database.
 * Reads tool.call.executed events from volt_events for a given corr (conversation).
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 */
function createVoltSkillReader({ db }) {
  /**
   * Find tool executions for a correlation ID since a given ISO timestamp.
   *
   * Returns only successful executions (success !== false).
   * Tolerates JSON parse errors silently (skips the row).
   *
   * @param {string} corrId
   * @param {string} sinceIsoTs  — ISO 8601 string
   * @param {{ limit?: number }} [opts]
   * @returns {{ event_id: string, ts: string, tool: string, success: boolean }[]}
   */
  function findToolExecutionsSince(corrId, sinceIsoTs, opts = {}) {
    const limit = opts.limit !== undefined ? opts.limit : 200;

    const sql = `
      SELECT ve.event_id, ve.ts, ve.data
      FROM volt_events ve
      JOIN volt_runs vr ON ve.run_id = vr.run_id
      WHERE vr.corr = ?
        AND ve.event_type = 'tool.call.executed'
        AND ve.ts >= ?
      ORDER BY ve.ts DESC
      LIMIT ?
    `;

    const rows = db.prepare(sql).all(corrId, sinceIsoTs, limit);
    const results = [];

    for (const row of rows) {
      let parsed;
      try {
        parsed = JSON.parse(row.data);
      } catch (_) {
        continue; // tolerate JSON parse errors silently
      }

      // Drop rows where success === false
      if (parsed.success === false) {
        continue;
      }

      results.push({
        event_id: row.event_id,
        ts: row.ts,
        tool: parsed.tool,
        success: parsed.success,
      });
    }

    return results;
  }

  return { findToolExecutionsSince };
}

module.exports = { createVoltSkillReader };
