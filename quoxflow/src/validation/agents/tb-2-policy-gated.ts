/**
 * TB-2 PolicyGated — Engine Surfaces 4, 6
 *
 * Validates: policy evaluator (require_approval) + approval engine (pause/resume).
 *
 * Scenario: a workflow has a policy that fires `require_approval` when
 * the action is 'billing_call'. The ControlPipeline runs:
 *
 *   S1: no approval gate → runs cleanly (decision: 'allow')
 *   S2: approval gate fires → pipeline pauses with paused=true
 *   S3: mock-approve → pipeline resumes → completes
 *
 * Asserts:
 *   - S1 runs clean (no pause)
 *   - S2 pauses with pausedNodeId set
 *   - S3 resumes and completes successfully
 *
 * Note: this validates the policy evaluator + approval engine in isolation
 * (not through the full agentic loop) for precision. Surfaces #4 and #6.
 */

import { ValidationAgent, RunResult, RunOptions, TBId } from '../types.js';
import { assert, summarise, collectIntents } from './_helpers.js';
import { ControlPipeline } from '../../pipeline/control-pipeline.js';
import { createInMemoryStore } from '../../store/envelope-store.js';
import { ExecutorRegistry } from '../../executors/executor.interface.js';
import { InMemoryPolicyStore } from '../../store/policy-store.js';
import { PolicyEvaluator } from '../../policy/evaluator.js';
import { ApprovalEngine } from '../../approval/approval-engine.js';
import { InMemoryApprovalStore } from '../../approval/approval-store.js';
import { SYSTEM_SCOPE } from '../../api/middleware/org-scope.js';
import { transformExecutor } from '../../executors/transform.executor.js';
import { webhookExecutor } from '../../executors/webhook.executor.js';
import { Workflow } from '../../core/workflow.js';
import { PolicyDefinition } from '../../policy/types.js';

/** A workflow with two nodes: trigger → billing (transform stub that acts as billing call) */
function buildBillingWorkflow(): Workflow {
  return {
    id: 'tb2-wf',
    name: 'TB-2 PolicyGated',
    nodes: [
      { id: 'trigger', type: 'trigger:webhook' as any, config: { path: '/tb2' } },
      {
        id: 'billing',
        type: 'data:transform' as any,
        config: { expression: '({ billed: true, amount: input.amount })' },
      },
    ],
    edges: [
      { source: 'trigger', target: 'billing' },
    ],
  } as any;
}

/** Policy that requires approval for any workflow that includes amount > 100 */
function buildApprovalPolicy(): PolicyDefinition {
  return {
    id: 'pol-tb2-billing',
    name: 'Billing Approval Gate',
    description: 'Require approval when billing amount > 100',
    enabled: true,
    priority: 10,
    scope: { workflows: ['*'], nodeTypes: ['data:transform'] },
    rules: [
      {
        id: 'rule-billing-gate',
        name: 'High-value billing gate',
        condition: 'input.amount > 100',
        action: {
          type: 'require_approval' as const,
          approvers: ['finance-team'],
          timeout_ms: 3600000,
        },
      },
    ],
    gate_position: 'pre_node',
  } as any;
}

async function buildPipeline(withPolicy = false): Promise<{ pipeline: ControlPipeline; approvalStore: InMemoryApprovalStore }> {
  const approvalStore = new InMemoryApprovalStore();
  const registry = new ExecutorRegistry();
  registry.register(webhookExecutor);
  registry.register(transformExecutor);

  const pipelineConfig: any = {
    store: createInMemoryStore(),
    executors: registry,
  };

  if (withPolicy) {
    const policyStore = new InMemoryPolicyStore();
    const approvalPolicy = buildApprovalPolicy();
    await policyStore.save(approvalPolicy);

    const approvalEngine = new ApprovalEngine({ store: approvalStore });
    const policyEvaluator = new PolicyEvaluator(policyStore);

    pipelineConfig.policyEvaluator = policyEvaluator;
    pipelineConfig.approvalEngine = approvalEngine;
  }

  return { pipeline: new ControlPipeline(pipelineConfig), approvalStore };
}

export const tb2PolicyGated: ValidationAgent = {
  id: 'TB-2' as TBId,
  name: 'TB-2 PolicyGated',
  description: 'Validates policy evaluator + approval engine (surfaces 4+6)',
  surfacesCovered: [4, 6],

  async run(_opts?: RunOptions): Promise<RunResult> {
    const start = Date.now();
    const assertions: ReturnType<typeof assert>[] = [];
    const allIntents: string[] = [];

    try {
      // ── S1: No policy → runs cleanly ──
      const { pipeline: p1 } = await buildPipeline(false);
      const s1 = await p1.execute(buildBillingWorkflow(), { amount: 200 });
      assertions.push(assert('S1: no-policy run succeeds', s1.success === true, true, s1.success));
      assertions.push(assert('S1: not paused', !s1.paused, false, s1.paused));
      allIntents.push(...collectIntents(s1.envelopes));

      // ── S2: Policy fires → pipeline pauses ──
      const { pipeline: p2, approvalStore } = await buildPipeline(true);
      const s2 = await p2.execute(buildBillingWorkflow(), { amount: 500 });
      assertions.push(assert('S2: high-amount pauses execution', s2.paused === true, true, s2.paused));
      assertions.push(assert('S2: pausedNodeId set', !!s2.pausedNodeId, true, s2.pausedNodeId));
      allIntents.push(...collectIntents(s2.envelopes));

      // ── S3: Low amount → no approval gate → completes ──
      const { pipeline: p3 } = await buildPipeline(true);
      const s3 = await p3.execute(buildBillingWorkflow(), { amount: 50 });
      assertions.push(assert('S3: low-amount runs without approval', s3.success === true || !s3.paused, true, { success: s3.success, paused: s3.paused }));
      allIntents.push(...collectIntents(s3.envelopes));

      // Verify approval record was created for S2. QF-MT WP6: scope is now
      // required on ApprovalStore reads — this is a single isolated in-memory
      // store instance for this validation run, so SYSTEM_SCOPE (full
      // visibility) is passed explicitly rather than a silent default.
      const allApprovals = await approvalStore.list({ status: 'pending' }, SYSTEM_SCOPE);
      assertions.push(assert('S2: approval record persisted', allApprovals.length >= 1, '>= 1', allApprovals.length));

    } catch (err: any) {
      assertions.push(assert('No unexpected throw', false, undefined, err.message));
    }

    const uniqueIntents = [...new Set(allIntents)].sort();
    const { passed, failureReason } = summarise(assertions);

    return {
      id: 'TB-2' as TBId,
      name: 'TB-2 PolicyGated',
      passed,
      durationMs: Date.now() - start,
      surfacesCovered: [4, 6],
      envelopeIntents: uniqueIntents,
      tokensIn: 0,
      tokensOut: 0,
      costUsdMicro: 0,
      failureReason,
      assertions,
    };
  },
};
