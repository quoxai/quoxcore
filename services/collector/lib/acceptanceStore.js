/**
 * SEO-MOAT — minimal witnessed acceptance verdict ("did it work").
 *
 * Owner ruling 2026-09-03: all four round-3 benchmark assessors converged on
 * the same last gap in the evidence chain — VOLT/WARD prove what HAPPENED
 * (and that it has not been altered since), but nothing in the platform
 * records whether the action ACHIEVED its intent. This module is the ruled
 * minimal answer: a post-terminal attestation a human or calling system
 * attaches to a run. It is honestly an attestation, not automated
 * evaluation — the record carries the credential-derived actor_type
 * (see utils/httpAuth.js deriveActorType) so a reader always sees WHO said
 * "it worked". A declared-criteria evaluator is deliberately deferred.
 *
 * Witnessing design: the verdict is recorded as its OWN small VOLT run
 * (corr `accept:<target run_id>`) whose single substantive event pins the
 * target run's head_hash. Completing that run rides the exact same
 * auto-bundle + WARD pipeline as every other run (server.js's
 * onRunComplete), so the verdict is witnessed with zero new witnessing
 * code AND the target's already-sealed bundle is never touched
 * retroactively. The `accept:` corr prefix keeps lib/aeeVoltBridge.js's
 * corr-based run lookup from ever confusing a verdict run with the
 * workflow run it attests.
 *
 * Store shape mirrors killSwitchStore.js: plain CRUD on the collector's
 * voltDb, append-only (a later verdict supersedes; history is never
 * edited), org_id on every row and every query (fail closed).
 */

const ACCEPTANCE_VERDICTS = ['pass', 'fail'];
const TERMINAL_STATUSES = new Set(['completed', 'failed']);

function initAcceptanceStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_acceptance_verdicts (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      verdict TEXT NOT NULL,
      reason TEXT,
      actor_id TEXT NOT NULL DEFAULT 'unknown',
      actor_type TEXT NOT NULL DEFAULT 'unknown',
      actor_label TEXT,
      target_head_hash TEXT,
      evidence_run_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_run_acceptance_verdicts_run
      ON run_acceptance_verdicts(org_id, run_id, created_at DESC);
  `);
}

function generateVerdictId() {
  return `AV_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Resolve the target run for an org, fail closed. Mirrors the
 * getRunsByOrg precedent in server.js: runs with a null org_id are
 * system/background runs visible to any authenticated org; a run tagged
 * with a DIFFERENT org is reported as not found (never as forbidden —
 * existence across an org boundary is itself information).
 */
function resolveTargetRun(db, orgId, runId) {
  const run = db.prepare('SELECT * FROM volt_runs WHERE run_id = ?').get(runId);
  if (!run) return null;
  if (run.org_id != null && run.org_id !== orgId) return null;
  return run;
}

/**
 * Record an acceptance verdict for a terminal run.
 *
 * @param {Database} db - collector voltDb (verdict table + volt_runs)
 * @param {Object} voltStatements - unused today, kept in the signature so the
 *   call site reads identically to every other volt-adjacent seam
 * @param {Object} voltEmitter - the process's shared emitter (createVoltEmitter)
 * @param {Object} p - { orgId, runId, verdict, reason, actor }
 *   actor: { actorId, actorType ('human'|'agent'|'service'), actorLabel }
 * @returns {Object} the inserted verdict row
 */
function recordAcceptanceVerdict(db, voltStatements, voltEmitter, { orgId, runId, verdict, reason = null, actor = {} }) {
  if (!db) throw new Error('acceptance storage not available');
  if (!orgId) throw new Error('org_id is required');
  if (!runId) throw new Error('run_id is required');
  if (!ACCEPTANCE_VERDICTS.includes(verdict)) {
    throw new Error(`invalid verdict: ${verdict} (expected one of ${ACCEPTANCE_VERDICTS.join(', ')})`);
  }

  const target = resolveTargetRun(db, orgId, runId);
  if (!target) throw new Error(`run not found: ${runId}`);
  if (!TERMINAL_STATUSES.has(target.status)) {
    throw new Error(`run ${runId} is not terminal (status: ${target.status}) — there is no outcome to attest yet`);
  }

  const record = {
    id: generateVerdictId(),
    org_id: orgId,
    run_id: runId,
    verdict,
    reason: reason ?? null,
    actor_id: actor.actorId || 'unknown',
    actor_type: actor.actorType || 'unknown',
    actor_label: actor.actorLabel ?? actor.actorId ?? null,
    target_head_hash: target.head_hash ?? null,
    evidence_run_id: null,
    created_at: new Date().toISOString(),
  };

  // Witness the verdict through the standard run pipeline. Failures here are
  // non-fatal by voltEmitter's own contract (it warns and returns null); the
  // verdict row still records honestly that no evidence run was minted.
  if (voltEmitter && voltEmitter.isAvailable?.()) {
    const evRunId = voltEmitter.startRun(`accept:${runId}`, { org_id: orgId, user_id: record.actor_id });
    if (evRunId) {
      voltEmitter.emit(evRunId, 'run.acceptance.recorded', {
        actor: { actor_type: record.actor_type, actor_id: record.actor_id },
        verdict_id: record.id,
        target_run_id: runId,
        target_corr: target.corr ?? null,
        target_status: target.status,
        target_head_hash: target.head_hash ?? null,
        verdict,
        reason: record.reason,
      });
      voltEmitter.completeRun(evRunId);
      record.evidence_run_id = evRunId;
    }
  }

  db.prepare(`
    INSERT INTO run_acceptance_verdicts
      (id, org_id, run_id, verdict, reason, actor_id, actor_type, actor_label, target_head_hash, evidence_run_id, created_at)
    VALUES (@id, @org_id, @run_id, @verdict, @reason, @actor_id, @actor_type, @actor_label, @target_head_hash, @evidence_run_id, @created_at)
  `).run(record);

  return record;
}

/** Full verdict history for a run, latest first. Latest row is the standing verdict. */
function getAcceptanceVerdicts(db, orgId, runId) {
  if (!db || !orgId || !runId) return [];
  return db.prepare(`
    SELECT * FROM run_acceptance_verdicts
    WHERE org_id = ? AND run_id = ?
    ORDER BY created_at DESC, rowid DESC
  `).all(orgId, runId);
}

module.exports = {
  ACCEPTANCE_VERDICTS,
  initAcceptanceStore,
  recordAcceptanceVerdict,
  getAcceptanceVerdicts,
};
