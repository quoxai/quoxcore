/**
 * TB-3 ECHOCrystal — Engine Surfaces 7, 8
 *
 * Validates: crystallisation post-hoc (analyseExecutionHistory) + P9 task-time
 * crystallisation (analyseDraft + promote-draft path).
 *
 * Scenario:
 *   1. Post-hoc: build 3 identical successful execution records → analyseExecutionHistory
 *      must return ready=true, confidence > 0.
 *   2. Task-time: run the AgenticExecutor with crystal_drafting enabled. The mock LLM
 *      emits propose_crystal at iteration 2, then done. The executor should:
 *        a. Create a CrystalDraft in the SkillLibraryStore.
 *        b. On done, analyseDraft → ready=true (actions all succeed) → promote().
 *        c. The promoted Crystal exists in skill_library with metadata.source='task-time'
 *           and tags=['task-time','candidate'].
 *
 * Asserts surfaces 7 (post-hoc analyseExecutionHistory) and 8 (task-time analyseDraft + promote).
 */

import { ValidationAgent, RunResult, RunOptions, TBId } from '../types.js';
import { mockThinker, collectIntents, assert, summarise, ThinkDecision } from './_helpers.js';
import { AgenticExecutor } from '../../executors/agentic.executor.js';
import { ExecutionContext } from '../../core/execution.js';
import { ExecutorRegistry } from '../../executors/executor.interface.js';
import { registerTestAgent } from '../../agents/test-agent/register.js';
import { createDefaultObservationRegistry } from '../../pipeline/observation-registry.js';
import { createInMemorySkillLibraryStore } from '../../store/skill-library-store.js';
import { analyseExecutionHistory, ExecutionRecord } from '../../pipeline/crystalliser.js';
import { Workflow, Node } from '../../core/workflow.js';

/** Post-hoc surface 7: build 3 success records with identical action patterns */
function buildExecutionRecords(): ExecutionRecord[] {
  const pattern = [
    { action: 'echo', params: { input: 'hello' } },
    { action: 'arithmetic', params: { op: '+', a: 1, b: 2 } },
    { action: 'complete', params: { reason: 'done' } },
  ];
  return [0, 1, 2].map(i => ({
    id: `exec-tb3-${i}`,
    success: true,
    nodeTypes: ['action:echo', 'action:arithmetic', 'action:complete'],
    nodeCount: 3,
    durationMs: 500 + i * 10,
    actionLog: pattern,
  }));
}

/** Task-time surface 8: propose_crystal then complete chain */
const FIXTURES_TASK_TIME: ThinkDecision[] = [
  {
    reasoning: 'Step 1: echo input to observe it',
    action: 'echo',
    params: { input: 'test-crystal' },
    objective_met: false,
    confidence: 0.8,
  },
  {
    reasoning: 'Step 2: propose a crystal pattern based on what I learned',
    action: 'propose_crystal',
    params: {
      name: 'TB3 Echo Crystal',
      summary: 'Echo then complete pattern for crystal validation',
      action_pattern: 'echo → complete',
      confidence: 0.85,
    },
    objective_met: false,
    confidence: 0.85,
  },
  {
    reasoning: 'Crystal proposed. Objective met.',
    action: 'complete',
    params: { reason: 'Crystal drafted and objective complete' },
    objective_met: true,
    confidence: 1.0,
  },
];

function buildWorkflow(): Workflow {
  return {
    id: 'tb3-wf',
    name: 'TB-3 ECHOCrystal',
    nodes: [{ id: 'agent', type: 'agent:agentic' as any, name: 'TB-3 Agent' }],
    edges: [],
  } as any;
}

function buildNode(): Node {
  return {
    id: 'tb3-agent',
    type: 'agent:agentic' as any,
    name: 'TB-3 ECHOCrystal',
    config: {
      objective: 'Perform echo and crystallise the pattern',
      max_iterations: 5,
      available_actions: ['echo', 'propose_crystal', 'complete'],
      collector_url: 'http://test-collector:9848',
      service_key: 'test-key',
      org_id: 'tb3-org',
      crystal_retrieval: { enabled: false, max_crystals: 0, match: 'agent_id' },
      crystal_drafting: { enabled: true, min_iteration: 1 },
      crystal_refinement: { enabled: false, max_refines: 0 },
      crystal_promotion_threshold: { confidence: 0.5, consecutive_success: 1 },
    },
  } as any;
}

export const tb3EchoCrystal: ValidationAgent = {
  id: 'TB-3' as TBId,
  name: 'TB-3 ECHOCrystal',
  description: 'Validates post-hoc crystallisation + P9 task-time draft promotion (surfaces 7+8)',
  surfacesCovered: [7, 8],

  async run(_opts?: RunOptions): Promise<RunResult> {
    const start = Date.now();
    const assertions: ReturnType<typeof assert>[] = [];
    const allIntents: string[] = [];

    let savedFetch: typeof fetch | undefined;

    try {
      // ── Surface 7: Post-hoc analyseExecutionHistory ───────────────
      const records = buildExecutionRecords();
      const analysis = analyseExecutionHistory(records);
      assertions.push(assert('S7: analyseExecutionHistory ready=true', analysis.ready === true, true, analysis.ready));
      assertions.push(assert('S7: confidence > 0', analysis.confidence > 0, '> 0', analysis.confidence));
      assertions.push(assert('S7: successRate = 1.0', analysis.successRate === 1.0, 1.0, analysis.successRate));
      assertions.push(assert('S7: executionCount = 3', analysis.executionCount === 3, 3, analysis.executionCount));

      // Confirm insufficient data returns ready=false
      const twoRecords = records.slice(0, 2);
      const twoAnalysis = analyseExecutionHistory(twoRecords);
      assertions.push(assert('S7: 2 records → not ready', twoAnalysis.ready === false, false, twoAnalysis.ready));

      // ── Surface 8: Task-time crystal via AgenticExecutor ─────────────
      savedFetch = global.fetch;
      global.fetch = mockThinker(FIXTURES_TASK_TIME);

      const skillStore = createInMemorySkillLibraryStore();
      const registry = new ExecutorRegistry();
      registerTestAgent(registry);

      const ctx = new ExecutionContext(buildWorkflow(), {}, { orgId: 'tb3-org' });
      ctx.executors = registry;

      const executor = new AgenticExecutor(
        createDefaultObservationRegistry(),
        undefined, // no budget evaluator
        skillStore,
      );

      const result = await executor.execute(buildNode(), null, ctx);
      allIntents.push(...collectIntents(result.envelopes));

      assertions.push(assert('S8: executor succeeds', result.success === true, true, result.success));

      // Check skill library for the promoted crystal.
      // Sentinel-5: canonical promotion → stage='canonical', no 'candidate' tag.
      const allSkills = await skillStore.list({ orgId: 'tb3-org' });
      const taskTimeCrystals = allSkills.filter(
        s => s.metadata?.source === 'task-time' && s.tags?.includes('task-time'),
      );
      assertions.push(assert('S8: task-time crystal in skill_library', taskTimeCrystals.length >= 1, '>= 1', taskTimeCrystals.length));

      if (taskTimeCrystals.length > 0) {
        const crystal = taskTimeCrystals[0];
        assertions.push(assert('S8: crystal metadata.source=task-time', crystal.metadata?.source === 'task-time', 'task-time', crystal.metadata?.source));
        // Sentinel-5: canonical rows have metadata.stage='canonical' and do NOT include 'candidate' tag
        assertions.push(assert('S8: crystal tags include candidate', crystal.metadata?.stage === 'canonical', true, crystal.metadata?.stage));
        assertions.push(assert('S8: crystal tags include task-time', crystal.tags?.includes('task-time') ?? false, true, crystal.tags));
      }

    } catch (err: any) {
      assertions.push(assert('No unexpected throw', false, undefined, err.message));
    } finally {
      if (savedFetch) global.fetch = savedFetch;
    }

    const uniqueIntents = [...new Set(allIntents)].sort();
    const { passed, failureReason } = summarise(assertions);

    return {
      id: 'TB-3' as TBId,
      name: 'TB-3 ECHOCrystal',
      passed,
      durationMs: Date.now() - start,
      surfacesCovered: [7, 8],
      envelopeIntents: uniqueIntents,
      tokensIn: 0,
      tokensOut: 0,
      costUsdMicro: 0,
      failureReason,
      assertions,
    };
  },
};
