/**
 * Policy Evaluator
 *
 * Evaluates policy rules against execution context using the expression engine.
 */

import { ulid } from 'ulid';
import { evaluateExpression, interpolateString, processValue } from '../expression/engine.js';
import { ExpressionContext } from '../core/execution.js';
import {
  PolicyDefinition,
  PolicyRule,
  PolicyAction,
  PolicyContext,
  PolicyEvaluationResult,
  RuleEvaluationResult,
  AggregatedPolicyResult,
  PolicyStore,
  ApprovalTemplateStore,
} from './types.js';
import { SYSTEM_SCOPE } from '../api/middleware/org-scope.js';

// ============================================================================
// Per-Node Evaluation Types — P8.C.2
// ============================================================================

export interface NodeEvalContext extends PolicyContext {
  /** Current accumulated budget state for budget_gate policies */
  currentBudgetState: Record<string, number> | null;
  /** Org ID for resolving approval templates */
  orgId?: string;
}

export interface NodeApprovalSpec {
  policyId: string;
  policyName: string;
  ruleId: string;
  approvers: string[];
  timeout_ms: number;
  multi_party_threshold?: number;
  escalation_chain?: string[];
  templateId?: string;
}

export interface NodeDenySpec {
  policyId: string;
  policyName: string;
  ruleId: string;
  reason: string;
}

export interface NodeEvalResult {
  requiresApproval: boolean;
  approvalSpec?: NodeApprovalSpec;
  /** Issue #498: the live per-node gate must enforce 'deny', not just 'require_approval'. */
  denied?: boolean;
  denySpec?: NodeDenySpec;
}

export class PolicyEvaluator {
  constructor(
    private policyStore: PolicyStore,
    private templateStore?: ApprovalTemplateStore
  ) {}

  /**
   * Evaluate all applicable policies for a given context
   *
   * R5.high-1: orgId is now passed to getApplicable so cross-tenant policies
   * are excluded. context.orgId is defined on NodeEvalContext (which extends
   * PolicyContext) and may be undefined for legacy callers — those callers get
   * the unscoped view (same behaviour as before, no regression: QF-MT WP7
   * made getApplicable's scope param required, so the previous "undefined"
   * unscoped case is now the explicit SYSTEM_SCOPE sentinel instead).
   */
  async evaluateAll(context: PolicyContext): Promise<AggregatedPolicyResult> {
    const startTime = Date.now();

    // Thread orgId through so store implementations can filter by tenant.
    const orgId = (context as { orgId?: string }).orgId;

    // Get applicable policies
    const policies = await this.policyStore.getApplicable(
      context.workflowId,
      context.nodeType,
      orgId ?? SYSTEM_SCOPE
    );

    if (policies.length === 0) {
      return {
        overallDecision: 'allow',
        policiesEvaluated: [],
        totalPolicies: 0,
        passedPolicies: 0,
        failedPolicies: 0,
        pendingPolicies: 0,
        requiresEvidence: false,
        evaluationMs: Date.now() - startTime,
      };
    }

    // Evaluate each policy
    const results: PolicyEvaluationResult[] = [];
    let requiresEvidence = false;

    for (const policy of policies) {
      const result = await this.evaluatePolicy(policy, context);
      results.push(result);

      if (result.requiresEvidence) {
        requiresEvidence = true;
      }

      // Short-circuit on deny
      if (result.decision === 'deny') {
        return {
          overallDecision: 'deny',
          policiesEvaluated: results,
          totalPolicies: policies.length,
          passedPolicies: results.filter(r => r.decision === 'allow').length,
          failedPolicies: 1,
          pendingPolicies: 0,
          reason: result.reason,
          requiresEvidence,
          evaluationMs: Date.now() - startTime,
        };
      }

      // Short-circuit on pending_approval (first one wins)
      if (result.decision === 'pending_approval' && result.pendingApproval) {
        return {
          overallDecision: 'pending_approval',
          policiesEvaluated: results,
          totalPolicies: policies.length,
          passedPolicies: results.filter(r => r.decision === 'allow').length,
          failedPolicies: 0,
          pendingPolicies: 1,
          pendingApproval: result.pendingApproval,
          requiresEvidence,
          evaluationMs: Date.now() - startTime,
        };
      }
    }

    return {
      overallDecision: 'allow',
      policiesEvaluated: results,
      totalPolicies: policies.length,
      passedPolicies: results.length,
      failedPolicies: 0,
      pendingPolicies: 0,
      requiresEvidence,
      evaluationMs: Date.now() - startTime,
    };
  }

  /**
   * P8.C.2: Evaluate applicable policies for a specific node before execution.
   *
   * Returns { requiresApproval: true, approvalSpec } when any enabled policy
   * with gate_position='pre_node' (or matching governance_kind) fires a
   * require_approval action for this node type.
   *
   * If the policy has an approval_template_id, the template's approver roster
   * replaces the rule's inline approvers. Falls back to inline if template
   * is not found.
   */
  async evaluateForNode(context: NodeEvalContext): Promise<NodeEvalResult> {
    // Pass orgId to getApplicable so cross-tenant policies are excluded.
    const policies = await this.policyStore.getApplicable(context.workflowId, context.nodeType, context.orgId ?? SYSTEM_SCOPE);

    const exprContext = this.buildExpressionContext(context);
    // Inject budget state into vars so budget_gate conditions can reference
    // ${currentBudget.cost_usd_micro}, etc. The expression engine passes vars
    // directly to the sandbox, making it available without engine changes.
    if (context.currentBudgetState) {
      exprContext.vars = {
        ...exprContext.vars,
        currentBudget: context.currentBudgetState,
      };
    }

    for (const policy of policies) {
      // Only fire pre_node gates in per-node evaluation
      if (policy.gate_position && policy.gate_position !== 'pre_node') continue;

      for (const rule of policy.rules) {
        const ruleResult = await this.evaluateRule(rule, exprContext as ExpressionContext, context);
        if (!ruleResult.conditionResult || !ruleResult.actionTaken) continue;

        // Issue #498: 'deny' must hard-stop the node — the pre-node gate
        // previously only acted on 'require_approval' and silently skipped
        // 'deny', so a matched deny rule never blocked execution.
        if (ruleResult.actionTaken.type === 'deny') {
          return {
            requiresApproval: false,
            denied: true,
            denySpec: {
              policyId: policy.id,
              policyName: policy.name,
              ruleId: rule.id,
              reason: ruleResult.actionTaken.reason,
            },
          };
        }

        if (ruleResult.actionTaken.type !== 'require_approval') continue;

        const action = ruleResult.actionTaken;

        // Resolve approval template if set
        let approvers = action.approvers;
        let timeout_ms = action.timeout_ms ?? 86400000;
        let multi_party_threshold: number | undefined;
        let escalation_chain: string[] | undefined;
        let templateId: string | undefined;

        if (policy.approval_template_id && this.templateStore && context.orgId) {
          try {
            const tpl = await this.templateStore.get(policy.approval_template_id, context.orgId);
            if (tpl) {
              approvers = tpl.approvers;
              timeout_ms = tpl.timeout_ms ?? timeout_ms;
              multi_party_threshold = tpl.multi_party_threshold;
              escalation_chain = tpl.escalation_chain;
              templateId = tpl.id;
            }
          } catch {
            // Fall back to inline approvers on template load failure
          }
        }

        return {
          requiresApproval: true,
          approvalSpec: {
            policyId: policy.id,
            policyName: policy.name,
            ruleId: rule.id,
            approvers,
            timeout_ms,
            multi_party_threshold,
            escalation_chain,
            templateId,
          },
        };
      }
    }

    return { requiresApproval: false };
  }

  /**
   * Evaluate a single policy
   */
  async evaluatePolicy(
    policy: PolicyDefinition,
    context: PolicyContext
  ): Promise<PolicyEvaluationResult> {
    const startTime = Date.now();
    const rulesEvaluated: RuleEvaluationResult[] = [];
    const logMessages: Array<{ level: 'info' | 'warn'; message: string }> = [];
    let requiresEvidence = false;
    let pendingApproval: PolicyEvaluationResult['pendingApproval'] | undefined;

    // Build expression context
    const exprContext = this.buildExpressionContext(context);

    for (const rule of policy.rules) {
      const ruleResult = await this.evaluateRule(rule, exprContext, context);
      rulesEvaluated.push(ruleResult);

      // Only process action if condition was true
      if (ruleResult.conditionResult && ruleResult.actionTaken) {
        const action = ruleResult.actionTaken;

        switch (action.type) {
          case 'deny':
            return {
              policyId: policy.id,
              policyName: policy.name,
              decision: 'deny',
              rulesEvaluated,
              reason: action.reason,
              requiresEvidence,
              logMessages,
              evaluationMs: Date.now() - startTime,
            };

          case 'require_approval':
            if (!pendingApproval) {
              pendingApproval = {
                approvalId: ulid(),
                approvers: action.approvers,
                timeout_ms: action.timeout_ms ?? 86400000,
                trigger: {
                  policyId: policy.id,
                  ruleId: rule.id,
                  condition: rule.condition,
                },
              };
            }
            break;

          case 'require_evidence':
            requiresEvidence = true;
            break;

          case 'log':
            const message = rule.message
              ? interpolateString(rule.message, exprContext)
              : action.message;
            logMessages.push({ level: action.level, message });
            break;

          case 'allow':
            // Continue evaluating other rules
            break;
        }
      }
    }

    // If any rule requires approval, return pending
    if (pendingApproval) {
      return {
        policyId: policy.id,
        policyName: policy.name,
        decision: 'pending_approval',
        rulesEvaluated,
        pendingApproval,
        requiresEvidence,
        logMessages,
        evaluationMs: Date.now() - startTime,
      };
    }

    return {
      policyId: policy.id,
      policyName: policy.name,
      decision: 'allow',
      rulesEvaluated,
      requiresEvidence,
      logMessages,
      evaluationMs: Date.now() - startTime,
    };
  }

  /**
   * Evaluate a single rule
   */
  private async evaluateRule(
    rule: PolicyRule,
    exprContext: ExpressionContext,
    policyContext: PolicyContext
  ): Promise<RuleEvaluationResult> {
    try {
      // Evaluate the condition expression
      // processValue handles ${...} syntax, or evaluate raw expression
      let conditionResult: boolean;
      if (rule.condition.includes('${')) {
        conditionResult = Boolean(processValue(rule.condition, exprContext));
      } else {
        conditionResult = Boolean(evaluateExpression(rule.condition, exprContext));
      }

      // Interpolate message if present
      let message: string | undefined;
      if (rule.message && conditionResult) {
        try {
          message = interpolateString(rule.message, exprContext);
        } catch {
          message = rule.message;
        }
      }

      return {
        ruleId: rule.id,
        ruleName: rule.name,
        condition: rule.condition,
        conditionResult,
        actionTaken: conditionResult ? rule.action : null,
        message,
      };
    } catch (error) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        condition: rule.condition,
        conditionResult: false,
        actionTaken: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Build expression context from policy context
   */
  private buildExpressionContext(context: PolicyContext): ExpressionContext {
    return {
      input: context.input,
      nodes: {},
      vars: context.variables,
      workflow: {
        id: context.workflowId,
        name: context.workflowName,
      },
      execution: {
        id: context.executionId,
        correlationId: context.correlationId,
      },
      env: context.env,
    };
  }

  /**
   * Test a policy against sample data without storing
   */
  async testPolicy(
    policy: PolicyDefinition,
    sampleData: {
      input: unknown;
      variables?: Record<string, unknown>;
      workflowId?: string;
    }
  ): Promise<PolicyEvaluationResult> {
    const context: PolicyContext = {
      workflowId: sampleData.workflowId ?? 'test-workflow',
      workflowName: 'Test Workflow',
      executionId: 'test-execution',
      correlationId: 'test-correlation',
      input: sampleData.input,
      variables: sampleData.variables ?? {},
      env: {},
    };

    return this.evaluatePolicy(policy, context);
  }
}
