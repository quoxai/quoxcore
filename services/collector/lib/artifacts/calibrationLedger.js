/**
 * Calibration self-audit ledger (COMMANDERQ P11 / B3).
 *
 * The honesty question this answers: how often does CommanderQ assert a LIVE
 * system-state fact WITHOUT grounding it? P3's evidence-cited verifier already
 * classifies every turn's state-claims as cited / disclaimed / uncited and
 * emits a counts-only envelope. This ledger persists those per-turn counts
 * (unencrypted, query-friendly) so we can aggregate them into a calibration
 * report and watch the grounding trend — is Q getting MORE grounded over time,
 * or drifting toward confident-but-uncited assertions?
 *
 * Grounding score = (cited + disclaimed) / total_claims: the fraction of
 * live-state claims Q either backed with a source OR honestly hedged. The
 * inverse (uncited_rate) is the over-confident-ungrounded rate to minimize.
 * This is a self-audit of the SAME honesty P3 enforces — not a truth oracle:
 * it measures whether claims were GROUNDED, not whether they were correct.
 *
 * Pure — caller passes the voltDb handle. Reads scope by org_id.
 */

'use strict';

function initCalibrationLedger(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calibration_ledger (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id       TEXT NOT NULL,
      agent        TEXT,
      corr         TEXT,
      ts           TEXT NOT NULL,
      state_claims INTEGER NOT NULL,
      cited        INTEGER NOT NULL,
      disclaimed   INTEGER NOT NULL,
      uncited      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_calibration_org_ts ON calibration_ledger (org_id, ts);
  `);
}

/**
 * Record one turn's calibration counts. No-op when there were no state claims
 * (the vast majority of turns) — the ledger only tracks turns that made a
 * live-state assertion, so it stays cheap and meaningful.
 */
function recordCalibration(db, { orgId, agent, corr, ts, stateClaims, cited, disclaimed, uncited }) {
  if (!orgId || !(stateClaims > 0)) return false;
  db.prepare(`
    INSERT INTO calibration_ledger (org_id, agent, corr, ts, state_claims, cited, disclaimed, uncited)
    VALUES (@org_id, @agent, @corr, @ts, @state_claims, @cited, @disclaimed, @uncited)
  `).run({
    org_id: orgId,
    agent: agent || null,
    corr: corr || null,
    ts: ts || new Date().toISOString(),
    state_claims: stateClaims,
    cited: cited || 0,
    disclaimed: disclaimed || 0,
    uncited: uncited || 0,
  });
  return true;
}

function pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : null; }

/**
 * Aggregate an org's calibration over an optional window.
 * @returns a report object (never throws-empty: zero turns => zeroed report).
 */
function aggregateCalibration(db, orgId, { sinceIso, limit = 500 } = {}) {
  const empty = {
    turns_with_claims: 0, total_claims: 0, cited: 0, disclaimed: 0, uncited: 0,
    cited_rate: null, disclaimed_rate: null, uncited_rate: null, grounding_score: null,
    window_since: sinceIso || null,
  };
  if (!orgId) return empty;
  const cap = Math.min(Math.max(1, limit | 0), 5000);
  const rows = sinceIso
    ? db.prepare('SELECT * FROM calibration_ledger WHERE org_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?').all(orgId, sinceIso, cap)
    : db.prepare('SELECT * FROM calibration_ledger WHERE org_id = ? ORDER BY ts DESC LIMIT ?').all(orgId, cap);
  if (rows.length === 0) return empty;

  let total = 0, cited = 0, disclaimed = 0, uncited = 0;
  for (const r of rows) {
    total += r.state_claims; cited += r.cited; disclaimed += r.disclaimed; uncited += r.uncited;
  }
  return {
    turns_with_claims: rows.length,
    total_claims: total,
    cited, disclaimed, uncited,
    cited_rate: pct(cited, total),
    disclaimed_rate: pct(disclaimed, total),
    uncited_rate: pct(uncited, total),
    // grounded = cited OR honestly hedged; the headline honesty number.
    grounding_score: pct(cited + disclaimed, total),
    window_since: sinceIso || null,
  };
}

module.exports = {
  initCalibrationLedger,
  recordCalibration,
  aggregateCalibration,
};
