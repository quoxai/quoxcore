#!/usr/bin/env node
/*
 * QuoxTrust conformance gate (quoxflow).
 *
 * The sibling of quox-dashboard scripts/trust-conformance.mjs, pointed at
 * quoxflow's own trust invariants. It makes the QUOXTRUST-B1..B4 regressions a
 * SINGLE required check. It:
 *   1. asserts every invariant regression file still EXISTS (no silent removal
 *      of a guard: deleting the test that pins an invariant fails the gate);
 *   2. RUNS every invariant suite (each contains the positive AND the negative
 *      case), so a regression cannot ship green.
 *
 * This is the "this can't keep happening" floor for quoxflow: the four trust
 * defects codex reproduced (false approval on resume, dropped central-witness
 * forwards, no durable intent before external effects, silently swallowed
 * evidence writes) are each pinned by a file below. If a future change breaks
 * one, this gate goes red.
 *
 * Cross-repo coverage note (for the worthiness gauge D4): quoxflow is ONE repo
 * in the platform. The dashboard/collector invariants live in the dashboard
 * conformance gate; the two together are the cross-repo manifest. A repo with
 * no conformance gate is un-audited and CAPS D4 (you cannot claim complete
 * mediation over code you never enumerated).
 */

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The invariant manifest: the source of truth for what QuoxTrust pins in
// quoxflow CI. Adding a new invariant regression? Add it here so the gate
// enforces it.
const MANIFEST = [
  {
    id: 'T-AUTH/B1',
    property:
      'resume route consumes the governed approval boundary: a non-approver or identity-mismatch resume is refused, so a cryptographic record can never preserve a false human approval',
    file: 'src/api/routes/executions-resume-auth.test.ts',
  },
  {
    id: 'T3/B2',
    property:
      'central-witness forwarding is a durable outbox: a failed forward is retained (pending) not dropped, re-drained with capped backoff, retired to failed after the attempt cap; an empty drain is not counted as a failure',
    file: 'src/store/envelope-store.test.ts',
  },
  {
    id: 'T3/B3',
    property:
      'durable dispatch intent is appended (fail-closed) BEFORE every external effect, and a dispatch-settled record follows with the outcome',
    file: 'src/pipeline/control-pipeline.dispatch-intent.test.ts',
  },
  {
    id: 'T3/B3',
    property:
      'unsettled dispatch intents reconcile to outcome_unknown on restart, idempotently, and the effect is never blindly re-fired',
    file: 'src/pipeline/dispatch-intent-reconciliation.test.ts',
  },
  {
    id: 'T3/B3',
    property:
      'the envelope store surfaces unsettled dispatch intents (the intent ledger the reconciler consumes)',
    file: 'src/store/envelope-store.dispatch-intent.test.ts',
  },
  {
    id: 'T3-a/B4',
    property:
      'a dropped durable-store append is accounted (counter + warning), never silently swallowed, so an evidence hole cannot be invisible',
    file: 'src/pipeline/control-pipeline.store-append-failures.test.ts',
  },
  {
    id: 'T3/B5',
    property:
      'an ambiguous external dispatch (request sent, response lost) is NOT auto-retried for a non-idempotent method without an idempotency key, and settles outcome_unknown rather than failed (no duplicate consequential effect, no false failure record)',
    file: 'src/pipeline/dispatch-ambiguous-outcome.test.ts',
  },
  {
    id: 'T3/E2E',
    property:
      'one governed workflow survives approval + durable intent + ambiguous outcome + crash recovery with a complete, correlated, non-lossy evidence trail',
    file: 'src/pipeline/governed-workflow-survival.test.ts',
  },
  {
    id: 'T9/B6',
    property:
      'a loop body passes the SAME governance chokepoint as a top-level node: it goes through dispatchExecutor (durable dispatch-intent-before-effect) and the per-node policy/replay gate, so a node wrapped as a loop body cannot run an external effect ungoverned',
    file: 'src/pipeline/control-pipeline.loop-body-governance.test.ts',
  },
  {
    id: 'T-AUTH/B7',
    property:
      'an approval/paused loop body is never treated as a completed success the workflow silently runs past: it fails closed (mid-loop pause/resume is unsupported) rather than proceeding as if approved',
    file: 'src/pipeline/control-pipeline.loop-body-governance.test.ts',
  },
  {
    id: 'T10/F12',
    property:
      'per-workflow concurrency is bounded above by a HARD ceiling (HARD_MAX_CONCURRENCY): an author may lower the admission cap but never raise it past the ceiling, so a large maxConcurrency cannot defeat the trigger-storm guard (bounded resource consumption)',
    file: 'src/api/services/execution-service.max-concurrency.test.ts',
  },
  {
    id: 'T-CONF/F13',
    property:
      'the call executor redacts secret header VALUES before persisting request headers into the evidence store (safe-name allowlist, not a denylist so an oddly-named secret header is still redacted); header names are kept and the real outbound request is never mutated (secret/data confidentiality)',
    file: 'src/executors/call.executor.evidence-redaction.test.ts',
  },
  {
    id: 'T10/F15',
    property:
      'the public /webhooks route is rate limited (per-IP-per-path, 10/s, internal service-key callers bypass) at the app level — the documented limit is actually wired, not just claimed; an unauthenticated flood is 429ed (bounded resource consumption, no DoS surface)',
    file: 'src/api/app.webhook-rate-limit.test.ts',
  },
];

function log(m) {
  console.log(m);
}

log('\u{1F9ED} QUOXTRUST │ conformance gate (quoxflow) │ checking ' + MANIFEST.length + ' invariants');

// 1. Existence check: a pinned guard must not silently disappear.
const missing = MANIFEST.filter((m) => !existsSync(path.join(ROOT, m.file)));
if (missing.length > 0) {
  log('✖ QUOXTRUST conformance FAILED: pinned invariant files are missing (a guard was removed):');
  for (const m of missing) {
    log(`    [${m.id}] ${m.file}`);
    log(`        pins: ${m.property}`);
  }
  process.exit(1);
}
log('✔ all ' + MANIFEST.length + ' pinned invariant files present');

// 2. Run every pinned suite. One vitest invocation over the exact file set.
const files = [...new Set(MANIFEST.map((m) => m.file))];
log('◐ running pinned invariant suites via vitest...');
try {
  execSync(`npx vitest run ${files.map((f) => JSON.stringify(f)).join(' ')}`, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
} catch (err) {
  log('✖ QUOXTRUST conformance FAILED: a pinned invariant suite is red (a trust regression shipped)');
  process.exit(1);
}

log('✔ QUOXTRUST │ conformance gate (quoxflow) │ all invariants hold');
