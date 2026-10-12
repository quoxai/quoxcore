'use strict';

/**
 * buildLearning.js — QUOXIFY PASS 3 (DEVSUITE phase 16): the L5 gap.
 *
 * The quoxification audit's blunt finding (note #2842, S-Q2): "Nothing gets
 * smarter with use: QuoxBuild failures do not teach, QLoop successes are not
 * crystallized, RepoBrain does not learn snippet usefulness. This is why
 * nothing in the bundle reaches ladder L5."
 *
 * This closes the first of those three, which is the one with a real
 * deterministic signal already flowing: every build writes a receipt, and a
 * FAIL is unambiguous. So:
 *
 *   1. A build that fails REPEATEDLY records a wisdom entry (a pattern, not a
 *      one-off), via the tasks service's existing service-key wisdom route.
 *   2. The next dispatch of that target READS it back and warns first.
 *
 * That is the whole loop, and it is deliberately narrow. Two design choices
 * worth stating because they are load-bearing:
 *
 * ONLY REPEATED FAILURES TEACH. A single red build is usually a typo, not a
 * lesson; recording every one would fill the wisdom store with noise and make
 * the advisory worthless, which is worse than having no advisory. The
 * threshold is the same streak logic bob_detect_repeated_failures already
 * uses, so the CLI, the agent and the learner all agree on what "repeated"
 * means.
 *
 * NO LLM IN THE BUILD PATH. The suite's token-discipline law says panels and
 * build paths read state and never call a model. Recording and reading wisdom
 * here is two HTTP calls against a SQLite-backed store; the reasoning about
 * an advisory happens later, in BOB, and only when a human asks.
 *
 * Everything here is fail-soft. A learning wire that can fail a build is a
 * worse product than a build that does not learn.
 */

const TASKS_URL = () => `http://${process.env.TASKS_HOST || 'tasks'}:${process.env.TASKS_PORT || '3104'}`;
const INTERNAL_SERVICE_KEY = () => process.env.INTERNAL_SERVICE_KEY || '';
const FETCH_TIMEOUT_MS = 5000;

// A build has to fail this many times IN A ROW before it counts as a pattern.
// Matches bobTools' repeated-failure threshold so the three surfaces agree.
const REPEAT_THRESHOLD = Number(process.env.BUILD_LEARN_THRESHOLD || 3);

function headers(orgId) {
  return {
    'Content-Type': 'application/json',
    'X-Service-Key': INTERNAL_SERVICE_KEY(),
    'X-Org-Id': orgId || 'default',
  };
}

/**
 * Current consecutive-failure streak for a target, newest first. A neutral
 * result (UNVERIFIED) or a success ends the streak; running out of history
 * ends it too. Pure function of the rows handed in, so it is testable without
 * a database.
 */
function currentFailureStreak(receipts) {
  let streak = 0;
  for (const r of receipts || []) {
    const result = String(r && r.result || '').toLowerCase();
    if (result === 'fail') streak += 1;
    else break;
  }
  return streak;
}

/**
 * Record a repeated-build-failure pattern as wisdom. Returns true only if
 * something was actually recorded, so a caller can never report learning that
 * did not happen.
 */
async function recordBuildFailurePattern({ orgId, target, streak, message }) {
  if (!INTERNAL_SERVICE_KEY()) return false;
  if (!target || !streak || streak < REPEAT_THRESHOLD) return false;
  try {
    const res = await fetch(`${TASKS_URL()}/api/wisdom`, {
      method: 'POST',
      headers: headers(orgId),
      body: JSON.stringify({
        org_id: orgId || 'default',
        pattern_name: `build_repeated_failure:${target}`,
        category: 'build',
        lesson: `The build target "${target}" has failed ${streak} times in a row.`
          + (message ? ` Most recent receipt message: ${String(message).slice(0, 300)}` : ''),
        directive: `Before dispatching "${target}" again, check what changed since the last green build.`
          + ' Repeated identical failures usually mean the cause is upstream of the build itself'
          + ' (a dependency the container never received, a stale image, or a broken Dockerfile step),'
          + ' not something a retry will fix.',
        severity: streak >= REPEAT_THRESHOLD * 2 ? 'high' : 'medium',
        tags: ['build', 'devsuite', target],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return res.ok;
  } catch (err) {
    console.warn(`[BuildLearning] could not record failure pattern for ${target} (non-fatal): ${err.message}`);
    return false;
  }
}

/**
 * Read back any wisdom relevant to building this target. Returns [] on any
 * failure, and the CALLER must treat [] as "nothing known", never as "safe".
 */
async function getBuildAdvisory({ orgId, target }) {
  if (!INTERNAL_SERVICE_KEY() || !target) return [];
  try {
    const url = `${TASKS_URL()}/api/wisdom?q=${encodeURIComponent(`build ${target}`)}&limit=3`;
    const res = await fetch(url, { headers: headers(orgId), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    const entries = Array.isArray(data && data.wisdom) ? data.wisdom : [];
    // Only surface entries actually about THIS target. The search is fuzzy,
    // and warning about the wrong target trains people to ignore the warning.
    return entries
      .filter((w) => String(w.pattern_name || '').includes(target) || (Array.isArray(w.tags) && w.tags.includes(target)))
      .map((w) => ({
        pattern: w.pattern_name,
        lesson: w.lesson,
        directive: w.directive,
        severity: w.severity,
        confidence: w.confidence,
      }));
  } catch (err) {
    console.warn(`[BuildLearning] advisory lookup failed for ${target} (non-fatal): ${err.message}`);
    return [];
  }
}

/**
 * The hook the receipt route calls. Fire-and-forget by contract: it takes the
 * receipt that was just stored plus that target's recent history, decides
 * whether a pattern exists, and records it. Never throws.
 */
async function learnFromReceipt({ orgId, receipt, recentReceipts }) {
  try {
    if (!receipt || String(receipt.result || '').toLowerCase() !== 'fail') return false;
    const streak = currentFailureStreak(recentReceipts);
    if (streak < REPEAT_THRESHOLD) return false;
    return await recordBuildFailurePattern({
      orgId,
      target: receipt.target,
      streak,
      message: receipt.message,
    });
  } catch (err) {
    console.warn(`[BuildLearning] learnFromReceipt failed (non-fatal): ${err.message}`);
    return false;
  }
}

module.exports = {
  REPEAT_THRESHOLD,
  currentFailureStreak,
  recordBuildFailurePattern,
  getBuildAdvisory,
  learnFromReceipt,
};
