/**
 * Approval Gate Executor
 *
 * Handles approval:gate nodes that pause workflow execution
 * pending human approval. Creates an ApprovalRequest via the
 * approval engine, then signals the pipeline to pause.
 *
 * Node type: approval:gate
 * Config:
 *   - approvers: string[] — who can approve (emails, groups, or '*' for anyone)
 *   - message: string — human-readable description of what's being approved
 *   - timeout_ms: number — optional timeout (default: engine default, 24h)
 */

import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';
import { ApprovalEngine } from '../approval/index.js';

interface ApprovalGateConfig {
  approvers: string[];
  message?: string;
  timeout_ms?: number;
}

export class ApprovalGateExecutor implements NodeExecutor {
  readonly nodeTypes = ['approval:gate'];
  private approvalEngine: ApprovalEngine;

  constructor(options: { approvalEngine: ApprovalEngine }) {
    this.approvalEngine = options.approvalEngine;
  }

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const config = node.config as unknown as ApprovalGateConfig;
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    // Create the approval request
    const approval = await this.approvalEngine.createApproval({
      correlationId: context.correlationId,
      workflowId: context.workflow.id,
      workflowName: context.workflow?.name,
      executionId: context.id,
      nodeId: node.id,
      trigger: {
        policyId: 'workflow',
        ruleId: node.id,
        condition: config.message || `Approval required at node ${node.name ?? node.id}`,
      },
      approvers: config.approvers,
      timeoutMs: config.timeout_ms,
      metadata: {
        message: config.message,
        nodeName: node.name ?? node.id,
        pipelineInput: input,
        // P8.F HITL-ORGID-PLUMB: prefer first-class context.orgId (set at execution time),
        // then fall back to variables/input/config for legacy compatibility.
        orgId: context.orgId
          || context.getVariables()?.orgId
          || (input as Record<string, unknown>)?.orgId
          || (config as unknown as Record<string, unknown>)?.orgId,
      },
    });

    // Emit approval requested envelope
    const approvalEnv = factory.event(
      Intents.APPROVAL.REQUESTED,
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        approvalId: approval.id,
        approvers: config.approvers,
        message: config.message,
        expiresAt: approval.expiresAt,
      }
    );
    emitted.push(approvalEnv);

    return {
      success: true,
      output: {
        approvalId: approval.id,
        status: 'pending',
        approvers: config.approvers,
        message: config.message,
        expiresAt: approval.expiresAt,
      },
      envelopes: emitted,
      paused: true,
      pauseReason: config.message || 'Awaiting human approval',
      metadata: {
        approvalId: approval.id,
        pausedNodeId: node.id,
      },
    };
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const config = node.config as unknown as ApprovalGateConfig;
    const errors: string[] = [];

    if (!config.approvers || !Array.isArray(config.approvers) || config.approvers.length === 0) {
      errors.push('approvers is required and must be a non-empty array');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}
