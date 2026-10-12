/**
 * TB-4 BudgetBound — Engine Surface 5
 *
 * Validates: budget evaluator (4 scopes: org / objective / execution / iteration),
 * exhaustion envelope emission, and clean failure on budget breach.
 *
 * Scenario: agent configured with iteration budget = 2 (max_iterations=2 in
 * the BudgetStore), runs with a mock LLM that would produce 5 iterations.
 * At iteration 3, the budget evaluator fires → executor returns success=false
 * with error.code='BUDGET_EXHAUSTED' and emits a quox.budget.exhausted envelope.
 *
 * Also validates that with NO budget configured, the same run succeeds cleanly.
 */

import { ValidationAgent, RunResult, RunOptions, TBId } from '../types.js';
import { mockThinker, collectIntents, assert, summarise, ThinkDecision } from './_helpers.js';
import { AgenticExecutor } from '../../executors/agentic.executor.js';
import { BudgetEvaluator } from '../../budget/budget-evaluator.js';
import { InMemoryBudgetStore } from '../../budget/budget-store.js';
import { ExecutionContext } from '../../core/execution.js';
import { ExecutorRegistry } from '../../executors/executor.interface.js';
import { registerTestAgent } from '../../agents/test-agent/register.js';
import { createDefaultObservationRegistry } from '../../pipeline/observation-registry.js';
import { Intents } from '../../core/envelope.js';
import { Workflow, Node } from '../../core/workflow.js';

/** Fixtures that would run indefinitely — budget should stop it at iteration 2 */
const FIXTURES_LONG: ThinkDecision[] = [
  { reasoning: 'Iter 1', action: 'echo', params: { input: 'i1' }, objective_met: false, confidence: 0.5 },
  { reasoning: 'Iter 2', action: 'echo', params: { input: 'i2' }, objective_met: false, confidence: 0.5 },
  { reasoning: 'Iter 3', action: 'echo', params: { input: 'i3' }, objective_met: false, confidence: 0.5 },
  { reasoning: 'Iter 4', action: 'echo', params: { input: 'i4' }, objective_met: false, confidence: 0.5 },
  { reasoning: 'Iter 5 done', action: 'complete', params: { reason: 'done' }, objective_met: true, confidence: 1.0 },
];

function buildWorkflow(): Workflow {
  return {
    id: 'tb4-wf',
    name: 'TB-4 BudgetBound',
    nodes: [{ id: 'agent', type: 'agent:agentic' as any, name: 'TB-4 Agent' }],
    edges: [],
  } as any;
}

function buildNode(budgetScopeId: string): Node {
  return {
    id: 'tb4-agent',
    type: 'agent:agentic' as any,
    name: 'TB-4 BudgetBound',
    config: {
      objective: 'Run until budget stops me',
      max_iterations: 10,
      available_actions: ['echo', 'complete'],
      collector_url: 'http://test-collector:9848',
      service_key: 'test-key',
      budget_scope_id: budgetScopeId,
      org_id: 'tb4-org',
      crystal_retrieval: { enabled: false, max_crystals: 0, match: 'agent_id' },
      crystal_drafting: { enabled: false, min_iteration: 99 },
    },
  } as any;
}

function buildContext(): ExecutionContext {
  const registry = new ExecutorRegistry();
  registerTestAgent(registry);

  const ctx = new ExecutionContext(buildWorkflow(), {}, { orgId: 'tb4-org' });
  ctx.executors = registry;
  return ctx;
}

async function buildBudgetEvaluator(scopeId: string, maxIterations: number): Promise<BudgetEvaluator> {
  const budgetStore = new InMemoryBudgetStore();
  const now = new Date();
  const future = new Date(now.getTime() + 86400000);

  await budgetStore.createBudget({
    scope_kind: 'iteration',
    scope_id: scopeId,
    org_id: 'tb4-org',
    period_start: now.toISOString(),
    period_end: future.toISOString(),
    max_tokens: null,
    max_cost_usd_micro: null,
    max_tool_calls: null,
    max_duration_ms: null,
    max_iterations: maxIterations,
    hard_stop: true,
  });

  return new BudgetEvaluator(budgetStore);
}

export const tb4BudgetBound: ValidationAgent = {
  id: 'TB-4' as TBId,
  name: 'TB-4 BudgetBound',
  description: 'Validates budget evaluator exhaustion + clean failure (surface 5)',
  surfacesCovered: [5],

  async run(_opts?: RunOptions): Promise<RunResult> {
    const start = Date.now();
    const assertions: ReturnType<typeof assert>[] = [];
    const allIntents: string[] = [];

    let savedFetch: typeof fetch | undefined;

    try {
      savedFetch = global.fetch;
      global.fetch = mockThinker([...FIXTURES_LONG]);

      // ── S1: Budget limit = 2 iterations → exhausts at iter 3 ────
      const scopeId = 'tb4-scope-budget';
      const budgetEval = await buildBudgetEvaluator(scopeId, 2);
      const executor = new AgenticExecutor(createDefaultObservationRegistry(), budgetEval);
      const result = await executor.execute(buildNode(scopeId), null, buildContext());

      allIntents.push(...collectIntents(result.envelopes));

      assertions.push(assert('S1: execution fails (budget exhausted)', result.success === false, false, result.success));
      assertions.push(assert('S1: error code is BUDGET_EXHAUSTED', result.error?.code === 'BUDGET_EXHAUSTED', 'BUDGET_EXHAUSTED', result.error?.code));
      assertions.push(assert('S1: budget_exhausted flag in output', (result.output as any)?.budget_exhausted === true, true, (result.output as any)?.budget_exhausted));
      assertions.push(assert('S1: BUDGET.EXHAUSTED envelope emitted', allIntents.includes(Intents.BUDGET.EXHAUSTED), true, allIntents));
      assertions.push(assert('S1: stops at or before iteration 3', (result.output as any)?.iterations <= 3, '<= 3', (result.output as any)?.iterations));

      // ── S2: No budget → same fixture runs 5 iters and completes ─
      global.fetch = mockThinker([...FIXTURES_LONG]);
      const executorNoBudget = new AgenticExecutor(createDefaultObservationRegistry());
      const result2 = await executorNoBudget.execute(buildNode('tb4-scope-no-budget'), null, buildContext());

      assertions.push(assert('S2: no-budget run succeeds', result2.success === true, true, result2.success));

    } catch (err: any) {
      assertions.push(assert('No unexpected throw', false, undefined, err.message));
    } finally {
      if (savedFetch) global.fetch = savedFetch;
    }

    const uniqueIntents = [...new Set(allIntents)].sort();
    const { passed, failureReason } = summarise(assertions);

    return {
      id: 'TB-4' as TBId,
      name: 'TB-4 BudgetBound',
      passed,
      durationMs: Date.now() - start,
      surfacesCovered: [5],
      envelopeIntents: uniqueIntents,
      tokensIn: 0,
      tokensOut: 0,
      costUsdMicro: 0,
      failureReason,
      assertions,
    };
  },
};
