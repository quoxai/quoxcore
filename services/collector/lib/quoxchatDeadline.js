/**
 * QuoxChat per-request time budget.
 *
 * Some /message calls hung for 90s: each provider call had its own 15s
 * timeout, but a turn can chain up to 3 tool-loop rounds, a corrective
 * regeneration and a claim-verifier pass, so the per-call timeouts stacked.
 * A request-scoped budget (AsyncLocalStorage, so no signature changes through
 * the call tree) caps every provider call to the time remaining and lets the
 * loops stop early and answer honestly instead of hanging.
 */
'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const store = new AsyncLocalStorage();

const DEFAULT_BUDGET_MS = 25000;
// Below this a provider call is not worth starting (an optional pass).
const MIN_USEFUL_MS = 3000;

/** Start the budget for the current async context (call once per request). */
function enterDeadline(totalMs = DEFAULT_BUDGET_MS, now = Date.now()) {
  const state = { deadlineAt: now + totalMs, totalMs };
  store.enterWith(state);
  return state;
}

function currentDeadline() {
  const s = store.getStore();
  return s ? s.deadlineAt : null;
}

/** Milliseconds left, or Infinity when no budget is active. */
function remainingMs(now = Date.now()) {
  const d = currentDeadline();
  return d === null ? Infinity : d - now;
}

function expired(now = Date.now()) {
  return remainingMs(now) <= 0;
}

/** True when there is still enough budget to start an optional extra pass. */
function hasBudgetFor(minMs = MIN_USEFUL_MS, now = Date.now()) {
  return remainingMs(now) >= minMs;
}

/** Cap a per-call timeout to the remaining budget (never below 1ms). */
function cappedTimeoutMs(ms, now = Date.now()) {
  const rem = remainingMs(now);
  return Math.max(1, Math.min(ms, rem));
}

function deadlineError() {
  const e = new Error('deadline_exceeded: request time budget used up');
  e.name = 'TimeoutError';
  e.code = 'deadline_exceeded';
  return e;
}

module.exports = {
  DEFAULT_BUDGET_MS,
  MIN_USEFUL_MS,
  enterDeadline,
  currentDeadline,
  remainingMs,
  expired,
  hasBudgetFor,
  cappedTimeoutMs,
  deadlineError,
  _store: store,
};
