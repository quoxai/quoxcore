'use strict';
/**
 * quox#1013: which VOLT run does a run id the user holds mean?
 *
 * `quox workflow run` prints the workflow ENGINE execution id (a ULID). VOLT captures that run
 * through the AEE bridge (lib/aeeVoltBridge.js) under its own id
 * `VR_wf-<workflowId>-<last8 of executionId>_<ms>`; the execution id is recorded only in the
 * run's run.started event (context.execution_id). The VOLT routes looked the id up as a VOLT
 * run_id only, so certifying the run a user can actually name was always a 404 "No events found".
 *
 * resolve(id) accepts, in order:
 *   1. a VOLT run id                 -> that run
 *   2. a corr (wf-..., QXC_...)      -> a run on that corr (indexed)
 *   3. an engine execution id (ULID) -> QuoxFlow's execution.correlationId -> step 2 (indexed;
 *      WORKER1's approach: dev holds ~278k VOLT runs, so no table scan on the normal path).
 *      Only when QuoxFlow cannot be asked (down, misconfigured) does it fall back to a bounded
 *      scan for wf- runs whose corr ends in the id's last 8 characters (~95 ms at 280k rows).
 * For an execution id a run counts only when its run.started event names that exact execution
 * id (a corr suffix is a hint, never proof). When several runs share the corr (a trailing
 * envelope can open a short second run after the terminal one, seen on dev 2026-10-15), the run
 * holding the most events wins, not the newest. The caller's visibility filter applies before
 * choosing, so another org's run is never picked.
 */

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const MAX_CANDIDATES = 20;

function createVoltRunResolver(db) {
  const getRun = db.prepare('SELECT * FROM volt_runs WHERE run_id = ?');
  const getRunsByCorr = db.prepare('SELECT * FROM volt_runs WHERE corr = ? ORDER BY started_at DESC LIMIT ?');
  const getWorkflowRunsBySuffix = db.prepare(
    "SELECT * FROM volt_runs WHERE substr(corr, 1, 3) = 'wf-' AND substr(corr, -9) = ? ORDER BY started_at DESC LIMIT ?",
  );
  const getGenesis = db.prepare('SELECT data FROM volt_events WHERE run_id = ? AND seq = 1 LIMIT 1');

  function executionIdOf(runId) {
    const row = getGenesis.get(runId);
    if (!row) return null;
    try {
      const ev = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      return ev?.context?.execution_id || ev?.payload?.execution_id || null;
    } catch {
      return null;
    }
  }

  function mostEvidence(rows, keep) {
    let best = null;
    for (const row of rows) {
      if (!keep(row)) continue;
      if (!best || (Number(row.seq) || 0) > (Number(best.seq) || 0)) best = row;
    }
    return best;
  }

  /**
   * @param {string} id
   * @param {{ visible?: (row) => boolean, fetchExecution?: (id) => Promise<object|null> }} opts
   *   fetchExecution resolves the QuoxFlow execution, null when QuoxFlow says it does not exist,
   *   and throws when QuoxFlow could not be asked.
   * @returns {Promise<{ run: object|null, resolvedFrom: null|'corr'|'execution_id' }>}
   */
  async function resolve(id, { visible = () => true, fetchExecution = null } = {}) {
    const none = { run: null, resolvedFrom: null };
    if (typeof id !== 'string' || !id.trim()) return none;
    id = id.trim();

    const direct = getRun.get(id);
    if (direct) return visible(direct) ? { run: direct, resolvedFrom: null } : none;

    const onCorr = mostEvidence(getRunsByCorr.all(id, MAX_CANDIDATES), visible);
    if (onCorr) return { run: onCorr, resolvedFrom: 'corr' };

    if (!ULID_RE.test(id)) return none;
    const isThisExecution = (row) => visible(row) && executionIdOf(row.run_id) === id;

    let candidates;
    try {
      if (typeof fetchExecution !== 'function') throw new Error('no QuoxFlow lookup');
      const exec = await fetchExecution(id);
      const corr = exec && (exec.correlationId || exec.correlation_id);
      candidates = corr ? getRunsByCorr.all(corr, MAX_CANDIDATES) : [];
    } catch {
      candidates = getWorkflowRunsBySuffix.all(`-${id.slice(-8)}`, MAX_CANDIDATES);
    }
    const run = mostEvidence(candidates, isThisExecution);
    return run ? { run, resolvedFrom: 'execution_id' } : none;
  }

  return { resolve };
}

function notFoundMessage(id) {
  return `No VOLT evidence found for run ${id}. Pass a VOLT run id (VR_...), a correlation id, or the `
    + 'execution id of a workflow run whose evidence VOLT captured (the id `quox workflow run` prints). '
    + 'A run that started before the collector was up, or that sent no AEE envelopes, has no VOLT evidence.';
}

module.exports = { createVoltRunResolver, notFoundMessage };
