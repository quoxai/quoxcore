/**
 * TB-6 CrossTenant — Engine Surface 4, 5, 6
 *
 * Validates: cross-tenant isolation — policies and budgets in org-A must NOT
 * fire for workflows executing in org-B.
 *
 * R3.coverage: All previous TBs use a single org_id. This TB adds two-org
 * coverage to catch the class of bug where a policy or budget leaks across
 * tenant boundaries.
 *
 * Scenario A (Policy cross-tenant):
 *   - Seed a policy tagged orgId='org-A' that requires approval for any transform
 *   - Execute the same workflow in org-B
 *   - Assert: execution completes (not paused) — org-A policy was excluded
 *
 * Scenario B (Budget cross-tenant):
 *   - Create a budget for org-A with max_iterations=1
 *   - Execute a 1-step workflow in org-B
 *   - Assert: execution succeeds — org-A budget is NOT charged against org-B run
 *
 * Scenario C (Correct-org policy fires):
 *   - Same org-A policy from Scenario A
 *   - Execute workflow in org-A
 *   - Assert: execution pauses (policy fires correctly for the right tenant)
 */

import { ValidationAgent, RunResult, RunOptions, TBId } from '../types.js';
import { assert, summarise, collectIntents } from './_helpers.js';
import { ControlPipeline } from '../../pipeline/control-pipeline.js';
import { createInMemoryStore } from '../../store/envelope-store.js';
import { ExecutorRegistry } from '../../executors/executor.interface.js';
import { InMemoryPolicyStore } from '../../store/policy-store.js';
import { InMemoryBudgetStore } from '../../budget/budget-store.js';
import { BudgetEvaluator } from '../../budget/budget-evaluator.js';
import { PolicyEvaluator } from '../../policy/evaluator.js';
import { ApprovalEngine } from '../../approval/approval-engine.js';
import { InMemoryApprovalStore } from '../../approval/approval-store.js';
import { SYSTEM_SCOPE } from '../../api/middleware/org-scope.js';
import { transformExecutor } from '../../executors/transform.executor.js';
import { webhookExecutor } from '../../executors/webhook.executor.js';
import { Workflow } from '../../core/workflow.js';
import { PolicyDefinition } from '../../policy/types.js';

function buildWorkflow(id: string, path: string): Workflow {
  return {
    id,
    name: `TB-6 ${id}`,
    nodes: [
      { id: 'trigger', type: 'trigger:webhook' as any, config: { path } },
      { id: 'tx', type: 'data:transform' as any, config: { expression: '({ done: true })' } },
    ],
    edges: [{ source: 'trigger', target: 'tx' }],
  } as any;
}

function buildOrgAPolicy(): PolicyDefinition {
  return {
    id: 'pol-tb6-orgA',
    name: 'Org-A Only Gate',
    description: 'Must NOT fire for org-B executions',
    enabled: true,
    priority: 10,
    scope: { workflows: ['*'], nodeTypes: ['data:transform'] },
    rules: [
      {
        id: 'rule-tb6-gate',
        name: 'Always gate (org-A only)',
        condition: 'true',
        action: { type: 'require_approval' as const, approvers: ['orgA-approvers'], timeout_ms: 3600000 },
      },
    ],
    gate_position: 'pre_node',
  } as any;
}

export const tb6CrossTenant: ValidationAgent = {
  id: 'TB-6' as TBId,
  name: 'TB-6 CrossTenant',
  description: 'Validates cross-tenant isolation: org-A policies/budgets do not affect org-B executions (surface 4, 5, 6)',
  surfacesCovered: [4, 5, 6],

  async run(_opts?: RunOptions): Promise<RunResult> {
    const start = Date.now();
    const assertions: ReturnType<typeof assert>[] = [];
    const allIntents: string[] = [];

    try {
      // ── Scenario A: org-A policy must NOT fire for org-B execution ──
      const policyStoreA = new InMemoryPolicyStore();
      const orgAPolicy = buildOrgAPolicy();
      // Tag policy to org-A
      (orgAPolicy as any).orgId = 'org-A';
      await policyStoreA.save(orgAPolicy);

      const approvalStoreA = new InMemoryApprovalStore();
      const approvalEngineA = new ApprovalEngine({ store: approvalStoreA });
      const policyEvaluatorA = new PolicyEvaluator(policyStoreA);

      const regA = new ExecutorRegistry();
      regA.register(webhookExecutor);
      regA.register(transformExecutor);

      const pipelineA = new ControlPipeline({
        store: createInMemoryStore(),
        executors: regA,
        policyEvaluator: policyEvaluatorA,
        approvalEngine: approvalEngineA,
      });

      const sA = await pipelineA.execute(buildWorkflow('tb6-wf-A', '/tb6a'), {}, { orgId: 'org-B' });
      allIntents.push(...collectIntents(sA.envelopes));

      // org-A policy tagged with orgA must NOT fire for org-B run
      assertions.push(assert('A: org-B execution not paused by org-A policy', !sA.paused, false, sA.paused));
      assertions.push(assert('A: org-B execution succeeds', sA.success === true, true, sA.success));

      // QF-MT WP6: scope is required on ApprovalStore reads — SYSTEM_SCOPE
      // (full visibility) is correct here since this asserts NO rows exist
      // at all in this isolated store instance, regardless of org.
      const pendingA = await approvalStoreA.list({ status: 'pending' }, SYSTEM_SCOPE);
      assertions.push(assert('A: no approval records created for org-B run', pendingA.length === 0, 0, pendingA.length));

      // ── Scenario B: org-A budget must NOT block org-B execution ──
      const budgetStoreB = new InMemoryBudgetStore();
      const now = new Date();
      const future = new Date(now.getTime() + 86400000);
      await budgetStoreB.createBudget({
        scope_kind: 'execution',
        scope_id: 'org-A',  // Scoped to org-A
        org_id: 'org-A',
        period_start: now.toISOString(),
        period_end: future.toISOString(),
        max_tokens: null, max_cost_usd_micro: null, max_tool_calls: null,
        max_duration_ms: null,
        max_iterations: 0,  // Hard block — would deny any iteration
        hard_stop: true,
      });

      const budgetEvalB = new BudgetEvaluator(budgetStoreB);
      // Resolver: maps orgId → execution scope using the same orgId as scope_id
      const resolverB = (_wfId: string, orgId?: string) =>
        orgId ? { scope: 'execution' as const, scopeId: orgId, orgId } : null;

      const regB = new ExecutorRegistry();
      regB.register(webhookExecutor);
      regB.register(transformExecutor);

      const pipelineB = new ControlPipeline({
        store: createInMemoryStore(),
        executors: regB,
        budgetEvaluator: budgetEvalB,
        budgetScopeResolver: resolverB,
      });

      // Execute in org-B — the org-A budget (scope_id='org-A') must NOT block this
      const sB = await pipelineB.execute(buildWorkflow('tb6-wf-B', '/tb6b'), {}, { orgId: 'org-B' });
      allIntents.push(...collectIntents(sB.envelopes));

      // org-B execution should succeed because there is no budget for scope_id='org-B'
      assertions.push(assert('B: org-B execution not blocked by org-A budget', sB.success === true, true, sB.success));
      assertions.push(assert('B: org-A budget_exhausted NOT emitted for org-B run',
        !allIntents.includes('quox.budget.exhausted'), false, allIntents.includes('quox.budget.exhausted')));

      // ── Scenario C: same org-A policy DOES fire for org-A execution ──
      const pipelineC = new ControlPipeline({
        store: createInMemoryStore(),
        executors: regA,
        policyEvaluator: policyEvaluatorA,
        approvalEngine: approvalEngineA,
      });

      const sC = await pipelineC.execute(buildWorkflow('tb6-wf-C', '/tb6c'), {}, { orgId: 'org-A' });
      allIntents.push(...collectIntents(sC.envelopes));

      // org-A execution SHOULD be paused (policy fires correctly for the right tenant)
      assertions.push(assert('C: org-A execution paused by org-A policy', sC.paused === true, true, sC.paused));

    } catch (err: any) {
      assertions.push(assert('No unexpected throw', false, undefined, err.message));
    }

    const uniqueIntents = [...new Set(allIntents)].sort();
    const { passed, failureReason } = summarise(assertions);

    return {
      id: 'TB-6' as TBId,
      name: 'TB-6 CrossTenant',
      passed,
      durationMs: Date.now() - start,
      surfacesCovered: [4, 5, 6],
      envelopeIntents: uniqueIntents,
      tokensIn: 0,
      tokensOut: 0,
      costUsdMicro: 0,
      failureReason,
      assertions,
    };
  },
};
