/**
 * Enhanced Policy Layer
 *
 * Replaces DefaultPolicyLayer with full policy evaluation capabilities.
 */

import { PolicyLayer, LayerResult } from '../pipeline/layers/index.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';
import { PolicyStore, PolicyContext, AggregatedPolicyResult } from './types.js';
import { PolicyEvaluator } from './evaluator.js';

export interface EnhancedPolicyLayerConfig {
  policyStore: PolicyStore;
  defaultAction?: 'allow' | 'deny';
  bypassHeader?: string; // Header name for emergency bypass
}

export class EnhancedPolicyLayer implements PolicyLayer {
  private evaluator: PolicyEvaluator;
  private defaultAction: 'allow' | 'deny';

  constructor(private config: EnhancedPolicyLayerConfig) {
    this.evaluator = new PolicyEvaluator(config.policyStore);
    this.defaultAction = config.defaultAction ?? 'allow';
  }

  async process(data: unknown, context: ExecutionContext): Promise<LayerResult> {
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    // Build policy context
    const policyContext: PolicyContext = {
      workflowId: context.workflow.id,
      workflowName: context.workflow.name,
      executionId: context.id,
      correlationId: context.correlationId,
      input: data,
      variables: context.getVariables(),
      env: {},
    };

    try {
      // Evaluate all applicable policies
      const result = await this.evaluator.evaluateAll(policyContext);

      // Handle the decision
      switch (result.overallDecision) {
        case 'allow':
          return this.handleAllow(result, data, context, emitted);

        case 'deny':
          return this.handleDeny(result, data, context, emitted);

        case 'pending_approval':
          return this.handlePendingApproval(result, data, context, emitted);

        default:
          // Fallback to default action
          if (this.defaultAction === 'deny') {
            return this.handleDefaultDeny(data, context, emitted);
          }
          return this.handleAllow(result, data, context, emitted);
      }
    } catch (error) {
      // On evaluation error, use default action
      const errorMessage = error instanceof Error ? error.message : String(error);

      const errorEnvelope = factory.event(
        Intents.AOCL.POLICY_EVALUATED,
        context.correlationId,
        {
          error: errorMessage,
          defaultAction: this.defaultAction,
          decision: this.defaultAction,
        }
      );
      emitted.push(errorEnvelope);

      if (this.defaultAction === 'deny') {
        return {
          proceed: false,
          data,
          reason: `Policy evaluation failed: ${errorMessage}`,
          envelopes: emitted,
        };
      }

      return {
        proceed: true,
        data,
        envelopes: emitted,
        metadata: { policyError: errorMessage },
      };
    }
  }

  private handleAllow(
    result: AggregatedPolicyResult,
    data: unknown,
    context: ExecutionContext,
    emitted: Envelope[]
  ): LayerResult {
    const factory = context.envelopes;

    // Emit log messages from policies
    for (const policyResult of result.policiesEvaluated) {
      for (const log of policyResult.logMessages) {
        const logEnvelope = factory.event(
          `quox.flow.policy.log.${log.level}`,
          context.correlationId,
          {
            policyId: policyResult.policyId,
            policyName: policyResult.policyName,
            level: log.level,
            message: log.message,
          }
        );
        emitted.push(logEnvelope);
      }
    }

    // Emit policy evaluated event
    const envelope = factory.event(
      Intents.AOCL.POLICY_EVALUATED,
      context.correlationId,
      {
        decision: 'allow',
        policiesEvaluated: result.policiesEvaluated.map(p => ({
          policyId: p.policyId,
          policyName: p.policyName,
          decision: p.decision,
          rulesEvaluated: p.rulesEvaluated.length,
        })),
        totalPolicies: result.totalPolicies,
        passedPolicies: result.passedPolicies,
        requiresEvidence: result.requiresEvidence,
        evaluationMs: result.evaluationMs,
      }
    );
    emitted.push(envelope);

    return {
      proceed: true,
      data,
      envelopes: emitted,
      metadata: {
        requiresEvidence: result.requiresEvidence,
        policiesEvaluated: result.totalPolicies,
      },
    };
  }

  private handleDeny(
    result: AggregatedPolicyResult,
    data: unknown,
    context: ExecutionContext,
    emitted: Envelope[]
  ): LayerResult {
    const factory = context.envelopes;

    // Find the denying policy
    const denyingPolicy = result.policiesEvaluated.find(p => p.decision === 'deny');

    // Emit policy denied event
    const envelope = factory.event(
      Intents.AOCL.POLICY_DENIED,
      context.correlationId,
      {
        decision: 'deny',
        reason: result.reason,
        denyingPolicy: denyingPolicy ? {
          policyId: denyingPolicy.policyId,
          policyName: denyingPolicy.policyName,
          reason: denyingPolicy.reason,
        } : undefined,
        policiesEvaluated: result.policiesEvaluated.map(p => ({
          policyId: p.policyId,
          policyName: p.policyName,
          decision: p.decision,
        })),
        evaluationMs: result.evaluationMs,
      }
    );
    emitted.push(envelope);

    return {
      proceed: false,
      data,
      reason: result.reason ?? 'Policy denied',
      envelopes: emitted,
      metadata: {
        denyingPolicy: denyingPolicy?.policyId,
      },
    };
  }

  private handlePendingApproval(
    result: AggregatedPolicyResult,
    data: unknown,
    context: ExecutionContext,
    emitted: Envelope[]
  ): LayerResult {
    const factory = context.envelopes;

    // Emit approval requested event
    const envelope = factory.event(
      Intents.APPROVAL.REQUESTED,
      context.correlationId,
      {
        decision: 'pending_approval',
        approval: result.pendingApproval,
        policiesEvaluated: result.policiesEvaluated.map(p => ({
          policyId: p.policyId,
          policyName: p.policyName,
          decision: p.decision,
        })),
        evaluationMs: result.evaluationMs,
      }
    );
    emitted.push(envelope);

    // For now, we'll stop the pipeline - approval flow will resume it later
    return {
      proceed: false,
      data,
      reason: 'Pending approval',
      envelopes: emitted,
      metadata: {
        pendingApproval: result.pendingApproval,
        requiresEvidence: result.requiresEvidence,
      },
    };
  }

  private handleDefaultDeny(
    data: unknown,
    context: ExecutionContext,
    emitted: Envelope[]
  ): LayerResult {
    const factory = context.envelopes;

    const envelope = factory.event(
      Intents.AOCL.POLICY_DENIED,
      context.correlationId,
      {
        decision: 'deny',
        reason: 'No policies matched, default action is deny',
        policiesEvaluated: [],
      }
    );
    emitted.push(envelope);

    return {
      proceed: false,
      data,
      reason: 'No policies matched, default action is deny',
      envelopes: emitted,
    };
  }
}

/**
 * Create an enhanced policy layer instance
 */
export function createEnhancedPolicyLayer(config: EnhancedPolicyLayerConfig): PolicyLayer {
  return new EnhancedPolicyLayer(config);
}
