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

// #957/#959/#964: per-agent wait budgets. The agent's own config (assistant JSON
// `delegation.wait_ms`) is the source of truth: Browser-Q drives a real headless browser through
// ScreenCap (46-56 s a page, delegated cases now over 170 s), NotesQ write chains (create, update,
// restore) ran past 90 s, InboxQ is quick (60 s). The map below is only the fallback for when the
// assistant entities are not loaded (unit tests, early boot). Unlisted agents use the provider default.
// Sentinel audits the fleet one host at a time (~10 s a host): a fleet-wide permission audit ran 101 s.
// Gemini agent: a long analysis ran 62.5 s and the agent answered at 92.6 s (quox#1090).
// HYPERION (atlas): a VM snapshot inventory across the Proxmox nodes overran 90 s under load and answered late,
// so the nested proxmox_read was never attributed to the delegation (proof proxmox/t1-proxmox_snapshots_list, 2026-10-17).
// nova (DAEDALUS): box health reads five feeds and answered in 63.9 s against a model-chosen 60 s budget, so the
// nested box_health was never attributed (proof fleet/t1-box_health, 2026-10-17).
const AGENT_WAIT_FALLBACK_MS = { 'browser-q': 180000, notesq: 180000, inboxq: 60000, sentinel: 180000, gemini: 150000, concierge: 180000, beacon: 180000, atlas: 180000, nova: 150000 };
function agentWaitMs(agentId) {
  const id = String(agentId || '').toLowerCase();
  try {
    const a = require('./entityAssistantLoader').getAssistant(id);
    const n = Number(a && a.delegation && a.delegation.wait_ms);
    if (Number.isFinite(n) && n >= 1000) return Math.min(Math.floor(n), 600000);
  } catch (_) { /* loader not available: fall through to the fallback */ }
  return AGENT_WAIT_FALLBACK_MS[id] || 0;
}
// Kept for callers/tests: the agent's own budget, 0 when it has none.
function agentDeadlineFloorMs(agentId) { return agentWaitMs(agentId); }

/**
 * The wait for one delegation. `callerMs` is a budget the model chose (or null), `providerMs` the
 * provider-aware default (local models keep their long default). The agent's own budget replaces
 * the cloud default and floors a caller budget; it never shortens a local model's wait.
 */
function resolveAgentWaitMs({ agentId, callerMs, providerMs, local = false } = {}) {
  const own = agentWaitMs(agentId);
  if (callerMs) return Math.max(callerMs, own);
  if (!own) return providerMs || DEFAULT_DEADLINE_MS;
  return local ? Math.max(own, providerMs || 0) : own;
}

const DEGRADE_PATHS = new Set(['cancel', 'reroute', 'degrade']);

/**
 * Normalize a caller-supplied contract into a complete, safe shape.
 */
const KEEP_RUNNING_CEILING_FLOOR_MS = 600000; // 10 min

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
    detach: input.detach === true,
    // HYPERION review of quox#1248: work kept running past the deadline (a timeout reroute's primary, a detached
    // delegation) is stopped here at the latest: default max(10 x deadline, 10 min); a caller may set it explicitly.
    keep_running_ceiling_ms: (() => {
      const raw = Number(input.keep_running_ceiling_ms);
      return Number.isFinite(raw) && raw > 0 ? raw : Math.max(10 * deadline_ms, KEEP_RUNNING_CEILING_FLOOR_MS);
    })(),
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

function pendingMessage(target, ms, handle) {
  const who = target ? String(target) : 'the specialist';
  return `Still working: ${who} is on it. It did not finish within ${fmtSecs(ms)} and has not confirmed anything yet, so treat the task as NOT done${handle ? ` (handle ${handle})` : ''}. Its result will be posted to this conversation when it finishes.`;
}

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
  const work = Promise.resolve().then(() => executeFn(controller.signal)).then(
    (result) => ({ __result: result }),
    (err) => ({ __error: err }),
  );
  try {
    raced = await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Deadline won the race.
  if (raced && raced.__timeout) {
    // DETACH (#964): the specialist keeps working. Do not abort and do not count the slow answer as
    // a failure; hand the still-running work back so the caller can attach its result when it lands.
    // A hard ceiling (HYPERION review): a HUNG primary would otherwise never settle, never open the breaker, and leave
    // one more un-aborted hop behind on every later turn. At the ceiling: abort, count a failure, say it was stopped.
    const ceilingMs = c.keep_running_ceiling_ms;
    const keepRunning = () => {
      const handle = `dlg_${Math.random().toString(36).slice(2, 10)}${now().toString(36).slice(-4)}`;
      let ceilingTimer = null;
      const ceiling = new Promise((resolve) => {
        ceilingTimer = setTimeout(() => resolve({ __ceiling: true }), ceilingMs);
        if (ceilingTimer && typeof ceilingTimer.unref === 'function') ceilingTimer.unref();
      });
      const settled = Promise.race([work, ceiling]).then((w) => {
        if (ceilingTimer) clearTimeout(ceilingTimer);
        if (w && w.__ceiling) {
          try { controller.abort(); } catch (_) { /* noop */ }
          if (breaker) breaker.recordFailure(c.breaker_key);
          return { ok: false, late: true, cancelled_at_ceiling: true, ceiling_ms: ceilingMs, error: `stopped at the ${fmtSecs(ceilingMs)} ceiling without an answer` };
        }
        if (w.__error) { if (breaker) breaker.recordFailure(c.breaker_key); return { ok: false, error: w.__error && w.__error.message, late: true }; }
        const res = w.__result;
        const okLate = !!(res && res.success !== false);
        if (breaker) { okLate ? breaker.recordSuccess(c.breaker_key) : breaker.recordFailure(c.breaker_key); }
        return { ok: okLate, result: res, late: true };
      });
      return { handle, settled };
    };
    if (c.detach) {
      const { handle, settled } = keepRunning();
      return { ok: false, breached: true, action_taken: 'pending', pending: true, handle, settled, degraded: { message: pendingMessage(c.target, c.deadline_ms, handle) }, elapsed_ms: elapsed(), ...(breaker && c.breaker_key ? { breaker_state: breaker.stateOf(c.breaker_key) } : {}) };
    }
    // quox#1248: a REROUTE after a timeout must not cancel the primary. Aborting only drops our
    // read of its answer; the specialist may keep acting server-side. Keep it running, give it a
    // handle, and tell the caller so the receipt never implies the record is complete.
    if (c.degrade_path === 'reroute' && c.reroute_to && typeof deps.rerouteFn === 'function') {
      const { handle, settled } = keepRunning();
      const primary = { agent: c.target, handle, still_running: true, actions_included: false, ceiling_ms: ceilingMs };
      try {
        const r = await deps.rerouteFn(c.reroute_to);
        return { ok: !!(r && r.success !== false), breached: true, action_taken: 'rerouted', rerouted_to: c.reroute_to, result: r, primary, primary_settled: settled, elapsed_ms: elapsed(), ...(breaker && c.breaker_key ? { breaker_state: breaker.stateOf(c.breaker_key) } : {}) };
      } catch (e) {
        return { ok: false, breached: true, action_taken: 'reroute_failed', degraded: { message: degradedMessage('timeout', c.target || c.reroute_to, c.deadline_ms, c.deadline_note) }, error: e && e.message, primary, primary_settled: settled, elapsed_ms: elapsed() };
      }
    }
    try { controller.abort(); } catch (_) { /* noop */ }
    if (breaker) breaker.recordFailure(c.breaker_key);
    if (c.degrade_path === 'cancel') {
      return { ok: false, breached: true, action_taken: 'cancelled', degraded: { message: `Delegation${c.target ? ` to ${c.target}` : ''} cancelled: no answer within ${fmtSecs(c.deadline_ms)}${c.deadline_note ? ` (${c.deadline_note})` : ''}.` }, elapsed_ms: elapsed(), ...(breaker && c.breaker_key ? { breaker_state: breaker.stateOf(c.breaker_key) } : {}) };
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
  agentDeadlineFloorMs,
  agentWaitMs,
  resolveAgentWaitMs,
  pendingMessage,
  DEGRADE_PATHS,
};
