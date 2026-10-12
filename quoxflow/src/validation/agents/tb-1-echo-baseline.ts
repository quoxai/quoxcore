/**
 * TB-1 EchoBaseline — Engine Surfaces 1, 2, 3
 *
 * Validates: agentic.executor (think-act-observe loop, iteration cap, max_iterations),
 * control-pipeline (AOCL 7-layer pipeline), envelope emission (per-node and per-iteration).
 *
 * Scenario: agent runs a 3-iteration math-then-complete chain using the existing
 * test-agent tools (arithmetic → arithmetic → complete) with a mocked LLM.
 * Asserts:
 *   - executor returns success=true with 3 iterations
 *   - at least 3 AOCL envelopes emitted (start + 2 think + result)
 *   - Intents.NODE.STARTED and Intents.NODE.COMPLETED present
 *   - max_iterations enforcement: agent configured with max 5 does NOT overflow
 */

import { ValidationAgent, RunResult, RunOptions, TBId } from '../types.js';
import { mockThinker, collectIntents, assert, summarise, ThinkDecision } from './_helpers.js';
import { AgenticExecutor } from '../../executors/agentic.executor.js';
import { ExecutionContext } from '../../core/execution.js';
import { ExecutorRegistry } from '../../executors/executor.interface.js';
import { registerTestAgent } from '../../agents/test-agent/register.js';
import { createDefaultObservationRegistry } from '../../pipeline/observation-registry.js';
import { Intents } from '../../core/envelope.js';
import { Workflow, Node } from '../../core/workflow.js';

const FIXTURES: ThinkDecision[] = [
  {
    reasoning: 'Step 1: compute 6 + 7',
    action: 'arithmetic',
    params: { op: '+', a: 6, b: 7 },
    objective_met: false,
    confidence: 0.9,
  },
  {
    reasoning: 'Step 2: compute 13 * 2',
    action: 'arithmetic',
    params: { op: '*', a: 13, b: 2 },
    objective_met: false,
    confidence: 0.9,
  },
  {
    reasoning: 'All computations done — objective met.',
    action: 'complete',
    params: { reason: 'Arithmetic chain finished' },
    objective_met: true,
    confidence: 1.0,
  },
];

function buildWorkflow(): Workflow {
  return {
    id: 'tb1-wf',
    name: 'TB-1 EchoBaseline',
    nodes: [{ id: 'agent', type: 'agent:agentic' as any, name: 'TB-1 Agent' }],
    edges: [],
  } as any;
}

function buildNode(): Node {
  return {
    id: 'tb1-agent',
    type: 'agent:agentic' as any,
    name: 'TB-1 EchoBaseline',
    config: {
      objective: 'Perform arithmetic chain: 6+7 then multiply by 2',
      max_iterations: 5,
      available_actions: ['arithmetic', 'complete'],
      collector_url: 'http://test-collector:9848',
      service_key: 'test-key',
      crystal_retrieval: { enabled: false, max_crystals: 0, match: 'agent_id' },
      crystal_drafting: { enabled: false, min_iteration: 99 },
    },
  } as any;
}

function buildContext(): ExecutionContext {
  const registry = new ExecutorRegistry();
  registerTestAgent(registry);

  const ctx = new ExecutionContext(buildWorkflow(), {});
  ctx.executors = registry;
  return ctx;
}

export const tb1EchoBaseline: ValidationAgent = {
  id: 'TB-1' as TBId,
  name: 'TB-1 EchoBaseline',
  description: 'Validates executor loop, AOCL pipeline, envelope emission (surfaces 1+2+3)',
  surfacesCovered: [1, 2, 3],

  async run(_opts?: RunOptions): Promise<RunResult> {
    const start = Date.now();
    const assertions: ReturnType<typeof assert>[] = [];

    let result;
    let savedFetch: typeof fetch | undefined;

    try {
      savedFetch = global.fetch;
      global.fetch = mockThinker(FIXTURES);

      const executor = new AgenticExecutor(createDefaultObservationRegistry());
      const node = buildNode();
      const context = buildContext();

      result = await executor.execute(node, null, context);
    } catch (err: any) {
      return {
        id: 'TB-1' as TBId,
        name: 'TB-1 EchoBaseline',
        passed: false,
        durationMs: Date.now() - start,
        surfacesCovered: [1, 2, 3],
        envelopeIntents: [],
        tokensIn: 0,
        tokensOut: 0,
        costUsdMicro: 0,
        failureReason: `Unexpected throw: ${err.message}`,
        assertions: [assert('No unexpected throw', false)],
      };
    } finally {
      if (savedFetch) global.fetch = savedFetch;
    }

    const out = result.output as any;
    const intents = collectIntents(result.envelopes);

    assertions.push(assert('execution succeeded', result.success === true, true, result.success));
    assertions.push(assert('objective_met=true', out?.objective_met === true, true, out?.objective_met));
    assertions.push(assert('3 iterations completed', out?.iterations === 3, 3, out?.iterations));
    assertions.push(assert('at least 3 envelopes emitted', result.envelopes.length >= 3, '>= 3', result.envelopes.length));
    assertions.push(assert('NODE.STARTED intent present', intents.includes(Intents.NODE.STARTED), Intents.NODE.STARTED, intents));
    assertions.push(assert('NODE.COMPLETED intent present', intents.includes(Intents.NODE.COMPLETED), Intents.NODE.COMPLETED, intents));
    // The done branch exits before appending to actionLog — so only the 2 non-done actions are logged.
    assertions.push(assert('action_log has 2 entries (done exits before append)', out?.action_log?.length === 2, 2, out?.action_log?.length));

    const { passed, failureReason } = summarise(assertions);

    return {
      id: 'TB-1' as TBId,
      name: 'TB-1 EchoBaseline',
      passed,
      durationMs: Date.now() - start,
      surfacesCovered: [1, 2, 3],
      envelopeIntents: intents,
      tokensIn: 0,
      tokensOut: 0,
      costUsdMicro: 0,
      failureReason,
      assertions,
    };
  },
};
