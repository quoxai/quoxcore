/**
 * Latency-budgeted delegation contracts (COMMANDERQ P6).
 *
 * The mechanism behind "voice-over-background-Q": when CommanderQ delegates a
 * sub-task, the delegation carries a CONTRACT — a deadline, an optional cost
 * budget, and a degrade path — and a watchdog enforces it. On breach it
 * CANCELS, REROUTES to another target, or DEGRADES to a graceful "still
 * working" answer, instead of the old fixed 90s hang with no fallback. A
 * minimal per-target circuit breaker trips a repeatedly-slow/failing target so
 * the next delegation fast-degrades rather than waiting again.
 *
 * Pure + injectable (executeFn, rerouteFn, breaker, now) so it is unit-testable
 * with deterministic fakes and carries no server/network import. Never throws:
 * a blown delegation resolves to a structured degraded outcome, never a hang or
 * an exception that kills the turn.
 *
 * This does NOT touch agent_contracts (that table is a permission/obligation
 * manifest — RSP-CONTRACT — with no SLA fields; overloading it would conflate
 * "what an agent may do" with "how fast/cheap"). SLA lives on the delegation.
 */

'use strict';

const DEFAULT_DEADLINE_MS = 90000;   // back-compat with the old fixed abort
// QUOXON-Z2H: a local model on CPU can need 60-160 s for one turn, so the deadline is provider-aware.
// Cloud keeps 90 s (QUOX_DELEGATION_DEADLINE_MS overrides). A local turn (ollama, or a self-hosted
// OpenAI-compatible preset) gets the Ollama turn timeout (QUOX_OLLAMA_TURN_TIMEOUT_MS, default 300 s)
// plus this margin (QUOX_DELEGATION_LOCAL_MARGIN_MS), so the turn's own timeout fires first.
const LOCAL_DELEGATION_MARGIN_MS = 30000;
const LOCAL_PRESETS = new Set(['lmstudio', 'vllm']);
const envMs = (env, key, min) => {
  const n = Number(env && env[key]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : null;
};

/** -> { ms, local } for a delegated turn that runs on { provider, preset }. */
function delegationDeadlineMs({ provider, preset, env = process.env } = {}) {
  const local = provider === 'ollama' || (provider === 'openai_compatible' && LOCAL_PRESETS.has(String(preset || '').toLowerCase()));
  if (!local) return { ms: envMs(env, 'QUOX_DELEGATION_DEADLINE_MS', 1000) || DEFAULT_DEADLINE_MS, local: false };
  const margin = envMs(env, 'QUOX_DELEGATION_LOCAL_MARGIN_MS', 0);
  return { ms: require('./ollamaProvider.js').ollamaTurnTimeoutMs(env) + (margin == null ? LOCAL_DELEGATION_MARGIN_MS : margin), local: true };
}

/**
 * The deadline for delegating to `agentId`, from that agent's resolved provider plan. A plan that
 * cannot be resolved gives the cloud deadline (the previous behaviour); this never throws.
 */
async function resolveDelegateDeadline({ orgId, agentId, env = process.env, resolvePlan } = {}) {
  try {
    const resolve = resolvePlan || (async (a) => {
      const resolved = await require('./llmRoutingPolicy.cjs').resolveCollectorPolicyPlan(a);
      return require('./openaiCompatProvider.js').applyCompatSelection(resolved && resolved.plan, {});
    });
    const plan = await resolve({ orgId, selectedAgent: agentId });
    return delegationDeadlineMs({ provider: plan && plan.provider, preset: plan && plan.preset, env });
  } catch (_) {
    return delegationDeadlineMs({ env });
  }
}

const DEGRADE_PATHS = new Set(['cancel', 'reroute', 'degrade']);

/**
 * Normalize a caller-supplied contract into a complete, safe shape.
 */
function normalizeContract(input = {}) {
  const deadlineRaw = Number(input.deadline_ms);
  const deadline_ms = Number.isFinite(deadlineRaw) && deadlineRaw > 0
    ? Math.min(deadlineRaw, 600000)   // hard ceiling, 10 min
    : DEFAULT_DEADLINE_MS;
  const degrade_path = DEGRADE_PATHS.has(input.degrade_path) ? input.degrade_path : 'degrade';
  const costRaw = Number(input.cost_budget_tokens);
  const cost_budget_tokens = Number.isFinite(costRaw) && costRaw > 0 ? costRaw : null;
  return {
    deadline_ms,
    degrade_path,
    reroute_to: typeof input.reroute_to === 'string' && input.reroute_to ? input.reroute_to : null,
    cost_budget_tokens,
    target: typeof input.target === 'string' && input.target ? input.target : null,
    deadline_note: typeof input.deadline_note === 'string' && input.deadline_note ? input.deadline_note : null,
    breaker_key: typeof input.breaker_key === 'string' && input.breaker_key ? input.breaker_key : null,
  };
}

/**
 * Minimal per-key circuit breaker: closed → (threshold failures) → open →
 * (cooldown) → half-open (one trial) → closed on success. In-memory; scope it
 * per target agent so one slow target doesn't make every delegation wait.
 */
class DelegationBreaker {
  constructor({ threshold = 3, cooldownMs = 30000, now = () => Date.now() } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this._state = new Map(); // key -> { failures, openedAt }
  }
  _get(key) {
    if (!this._state.has(key)) this._state.set(key, { failures: 0, openedAt: 0, halfOpenInFlight: false });
    return this._state.get(key);
  }
  // PURE query (used by stateOf/reporting — must NOT mutate). "Is the breaker
  // currently blocking new calls?" = cooling down, OR half-open with a trial
  // already in flight. Do the test-and-set in tryEnter(), not here.
  isOpen(key) {
    if (!key) return false;
    const s = this._get(key);
    if (s.failures < this.threshold) return false;                 // closed
    if ((this.now() - s.openedAt) < this.cooldownMs) return true;   // open (cooling)
    return !!s.halfOpenInFlight;                                    // half-open: open iff a trial is running
  }
  // GATE with side effect: returns true and CLAIMS the single half-open trial if
  // the caller may run; false if it must degrade. Guards against concurrent
  // callers all trialing at once after cooldown (the "one trial" invariant).
  tryEnter(key) {
    if (!key) return true;
    const s = this._get(key);
    if (s.failures < this.threshold) return true;                  // closed
    if ((this.now() - s.openedAt) < this.cooldownMs) return false; // open (cooling)
    if (s.halfOpenInFlight) return false;                          // another trial in flight
    s.halfOpenInFlight = true;                                     // claim the one trial (test-and-set)
    return true;
  }
  recordSuccess(key) {
    if (!key) return;
    this._state.set(key, { failures: 0, openedAt: 0, halfOpenInFlight: false });
  }
  recordFailure(key) {
    if (!key) return;
    const s = this._get(key);
    s.failures += 1;
    s.halfOpenInFlight = false;                    // the trial (if any) resolved
    if (s.failures >= this.threshold) s.openedAt = this.now();
  }
  stateOf(key) { return { ...this._get(key), open: this.isOpen(key) }; }
}

const fmtSecs = (ms) => `${Math.round(ms / 100) / 10} s`;

function degradedMessage(reason, target, ms, note) {
  const who = target ? `${target} ` : '';
  if (reason === 'breaker_open') return `${who}is temporarily unavailable (recent failures); answering without it for now.`;
  const why = note ? ` (${note})` : '';
  return `Still working: ${who || 'the agent '}did not respond within ${fmtSecs(ms)}${why}; continuing without it.`;
}

/**
 * Run a delegation under a latency/cost contract.
 *
 * @param {object} contractInput  { deadline_ms, degrade_path, reroute_to, cost_budget_tokens, breaker_key }
 * @param {function} executeFn    async (signal) => result. result may carry { success, tokensUsed }.
 * @param {object} deps
 *   rerouteFn {async (target, signal) => result}  called when degrade_path==='reroute'
 *   breaker   {DelegationBreaker}                  optional
 *   now       {() => number}                       injectable clock (default Date.now)
 * @returns {Promise<object>} { ok, breached, cost_breached, action_taken, elapsed_ms,
 *                              result?, degraded?, rerouted_to?, breaker_state? }
 *   never throws.
 */
async function runWithContract(contractInput, executeFn, deps = {}) {
  const c = normalizeContract(contractInput);
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const breaker = deps.breaker || null;
  const started = now();
  const elapsed = () => now() - started;

  // Breaker gate at entry → don't even call the failing target; degrade/reroute now.
  // tryEnter (not isOpen) so exactly ONE trial passes in the half-open window.
  if (breaker && c.breaker_key && !breaker.tryEnter(c.breaker_key)) {
    if (c.degrade_path === 'reroute' && c.reroute_to && typeof deps.rerouteFn === 'function') {
      try {
        const r = await deps.rerouteFn(c.reroute_to);
        return { ok: !!(r && r.success !== false), breached: true, action_taken: 'rerouted_breaker_open', rerouted_to: c.reroute_to, result: r, elapsed_ms: elapsed(), breaker_state: breaker.stateOf(c.breaker_key) };
      } catch (e) {
        return { ok: false, breached: true, action_taken: 'reroute_failed', degraded: { message: degradedMessage('breaker_open', c.reroute_to, c.deadline_ms) }, error: e && e.message, elapsed_ms: elapsed() };
      }
    }
    return { ok: false, breached: true, action_taken: 'breaker_open_degraded', degraded: { message: degradedMessage('breaker_open', c.breaker_key, c.deadline_ms) }, elapsed_ms: elapsed(), breaker_state: breaker.stateOf(c.breaker_key) };
  }

  const controller = new AbortController();
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), c.deadline_ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });

  let raced;
  try {
    raced = await Promise.race([
      Promise.resolve().then(() => executeFn(controller.signal)).then(
        (result) => ({ __result: result }),
        (err) => ({ __error: err }),
      ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Deadline won the race.
  if (raced && raced.__timeout) {
    try { controller.abort(); } catch (_) { /* noop */ }
    if (breaker) breaker.recordFailure(c.breaker_key);
    if (c.degrade_path === 'cancel') {
      return { ok: false, breached: true, action_taken: 'cancelled', degraded: { message: `Delegation${c.target ? ` to ${c.target}` : ''} cancelled: no answer within ${fmtSecs(c.deadline_ms)}${c.deadline_note ? ` (${c.deadline_note})` : ''}.` }, elapsed_ms: elapsed(), ...(breaker && c.breaker_key ? { breaker_state: breaker.stateOf(c.breaker_key) } : {}) };
    }
    if (c.degrade_path === 'reroute' && c.reroute_to && typeof deps.rerouteFn === 'function') {
      try {
        const r = await deps.rerouteFn(c.reroute_to);
        return { ok: !!(r && r.success !== false), breached: true, action_taken: 'rerouted', rerouted_to: c.reroute_to, result: r, elapsed_ms: elapsed(), ...(breaker && c.breaker_key ? { breaker_state: breaker.stateOf(c.breaker_key) } : {}) };
      } catch (e) {
        return { ok: false, breached: true, action_taken: 'reroute_failed', degraded: { message: degradedMessage('timeout', c.target || c.reroute_to, c.deadline_ms, c.deadline_note) }, error: e && e.message, elapsed_ms: elapsed() };
      }
    }
    return { ok: false, breached: true, action_taken: 'degraded', degraded: { message: degradedMessage('timeout', c.target || c.reroute_to, c.deadline_ms, c.deadline_note) }, elapsed_ms: elapsed(), ...(breaker && c.breaker_key ? { breaker_state: breaker.stateOf(c.breaker_key) } : {}) };
  }

  // executeFn threw.
  if (raced && raced.__error) {
    if (breaker) breaker.recordFailure(c.breaker_key);
    return { ok: false, breached: false, action_taken: 'execute_error', error: raced.__error && raced.__error.message, elapsed_ms: elapsed(), ...(breaker && c.breaker_key ? { breaker_state: breaker.stateOf(c.breaker_key) } : {}) };
  }

  // executeFn completed within the deadline.
  const result = raced.__result;
  const ok = !!(result && result.success !== false);
  if (breaker) { ok ? breaker.recordSuccess(c.breaker_key) : breaker.recordFailure(c.breaker_key); }
  const tokensUsed = result && Number(result.tokensUsed);
  const cost_breached = !!(c.cost_budget_tokens && Number.isFinite(tokensUsed) && tokensUsed > c.cost_budget_tokens);
  return {
    ok, breached: false, cost_breached,
    action_taken: cost_breached ? 'completed_over_budget' : 'completed',
    result, elapsed_ms: elapsed(),
    ...(breaker && c.breaker_key ? { breaker_state: breaker.stateOf(c.breaker_key) } : {}),
  };
}

module.exports = {
  normalizeContract,
  DelegationBreaker,
  runWithContract,
  DEFAULT_DEADLINE_MS,
  LOCAL_DELEGATION_MARGIN_MS,
  delegationDeadlineMs,
  resolveDelegateDeadline,
  DEGRADE_PATHS,
};
