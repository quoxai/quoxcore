'use strict';
/**
 * Z2H-7B2: a hard wall-clock budget for one LOCAL (Ollama) model turn.
 *
 * Where the 300 s came from: lib/ollamaProvider.js OLLAMA_TURN_TIMEOUT_MS (Z2H-3B), passed as
 * `timeoutMs` to the OpenAI-compatible loop, where it is BOTH the fetch wait for the first byte of
 * a round AND the idle gap between stream chunks (readOpenAIChatStream idleTimeoutMs). Neither is a
 * total: a model that trickles tokens, or a turn of several rounds, resets it each time, and a
 * stalled first byte is silent for the whole 300 s. Those two stay as the stall guards (their
 * defaults are pinned by tests and a cold CPU model load is legitimately slow).
 *
 * This adds the missing cap: the whole model-and-tools phase of the turn gets QUOX_LOCAL_TURN_BUDGET_MS
 * (default 150 s, min 5 s), after which the in-flight call is aborted and the user gets an honest
 * message saying what ran and what did not. 150 s sits above the 60-160 s CPU turns measured on
 * the pool VMs for a single round with fetched data in hand, and half the old silence.
 */
const DEFAULT_LOCAL_TURN_BUDGET_MS = 150000;

function localTurnBudgetMs(env = process.env) {
  const n = Number(env && env.QUOX_LOCAL_TURN_BUDGET_MS);
  return Number.isFinite(n) && n >= 5000 ? Math.floor(n) : DEFAULT_LOCAL_TURN_BUDGET_MS;
}

/** -> { signal, expired(), elapsedMs(), clear() }. signal aborts on the parent's abort OR the budget. */
function createTurnBudget({ ms = localTurnBudgetMs(), parent = null, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const ctl = new AbortController();
  const startedAt = now();
  let hit = false;
  const timer = setTimer(() => { hit = true; try { ctl.abort(); } catch { /* already aborted */ } }, ms);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return {
    signal: parent ? AbortSignal.any([parent, ctl.signal]) : ctl.signal,
    expired: () => hit,
    elapsedMs: () => now() - startedAt,
    budgetMs: ms,
    clear: () => clearTimer(timer),
  };
}

/** Plain, honest message (lines under 100 columns). */
function budgetExpiredMessage({ model, host, budgetMs, toolsRan = [] } = {}) {
  const secs = Math.round((budgetMs || DEFAULT_LOCAL_TURN_BUDGET_MS) / 1000);
  const lines = [
    `Your Ollama (${model || 'model'} at ${host || 'this host'}) had not finished after ${secs} s, so this turn was stopped.`,
    toolsRan.length
      ? `Looked up before it stopped: ${toolsRan.join(', ')} (the real result is in the tool activity above).`
      : 'Nothing was looked up and no answer was produced.',
    'Local models on a CPU can be slow. Try a smaller model, a machine with a GPU, or raise QUOX_LOCAL_TURN_BUDGET_MS.',
  ];
  return lines.join('\n');
}

module.exports = { DEFAULT_LOCAL_TURN_BUDGET_MS, localTurnBudgetMs, createTurnBudget, budgetExpiredMessage };
