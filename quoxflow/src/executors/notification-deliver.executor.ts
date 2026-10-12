/**
 * Notification Deliver Executor
 *
 * Handles notification:deliver nodes that drop an info-only item into the
 * user's inbox WITHOUT pausing the workflow. Unlike human:task, there is no
 * approve/deny decision — the notification is a terminal output, and
 * execution continues (or terminates) immediately.
 *
 * Node type: notification:deliver
 * Config:
 *   - title?: string — inbox item title. Default: `Notification: <node.name|node.id>`. Supports ${...}.
 *   - message: string — body (markdown). Required. Supports ${...}.
 *   - assignTo?: string[] — recipients (user IDs, team IDs, or '*'). Default: ['*'].
 *   - kind?: string — inbox item kind. Default: 'notification'.
 *   - priority?: 'low' | 'normal' | 'high' — inbox item priority. Default: 'normal'.
 *
 * Key differences from human:task:
 *   - Does NOT pause the workflow (paused is omitted / false).
 *   - Does NOT create action buttons (no custom_actions, no response_schema, no returnNodes).
 *   - metadata.type = 'notification' (auth inbox endpoint renders info-only item).
 *   - metadata.autoComplete = true (signals the approval record needs no human action).
 *   - Output === input (passes through unchanged so downstream nodes see the same data).
 */

import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';
import { ApprovalEngine } from '../approval/index.js';
import { createTemplateInterpolator } from '../expression/template.js';
import { normaliseAssignTo } from '../expression/assignees.js';

interface NotificationDeliverConfig {
  title?: string;
  message: string;
  assignTo?: string[];
  kind?: string;
  priority?: 'low' | 'normal' | 'high';
}

export class NotificationDeliverExecutor implements NodeExecutor {
  readonly nodeTypes = ['notification:deliver'];
  readonly hasExternalEffect = true;
  private approvalEngine: ApprovalEngine;

  constructor(options: { approvalEngine: ApprovalEngine }) {
    this.approvalEngine = options.approvalEngine;
  }

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const config = node.config as unknown as NotificationDeliverConfig;
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    const nodeName = node.name ?? node.id;

    // Shared with human-task: handles `{{X}}` → `${X}` shim AND the
    // `${nodeId.field}` → `${nodes.nodeId.output.field}` rewrite, so
    // workflows authored with WEAVER's natural shorthand resolve here too.
    const exprContext = context.createExpressionContext(node.id, input);
    const interpolate = createTemplateInterpolator(context, exprContext);

    const title = interpolate(config.title) || `Notification: ${nodeName}`;
    const message = interpolate(config.message);
    const kind = config.kind || 'notification';
    const priority = config.priority || 'normal';
    const assignTo = normaliseAssignTo(config.assignTo);

    // Build inbox payload — no custom_actions, no response_schema, no returnNodes
    const inboxPayload: Record<string, unknown> = {
      source: 'notification_deliver',
      workflow_id: context.workflow.id,
      workflow_name: context.workflow.name,
      execution_id: context.id,
      node_id: node.id,
      node_name: nodeName,
    };

    // Emit notification delivered envelope
    const notifEnv = factory.event(
      'ops.notification.delivered',
      context.correlationId,
      {
        nodeId: node.id,
        nodeName,
        assignTo,
        title,
        message,
        kind,
        priority,
      }
    );
    emitted.push(notifEnv);

    try {
      // Reuse the approval engine for inbox plumbing.
      // metadata.type = 'notification' tells the auth service inbox endpoint
      // to render an info-only item (no action buttons).
      // metadata.autoComplete = true signals that this record needs no human
      // action — the server can mark it resolved immediately if it chooses to.
      const approval = await this.approvalEngine.createApproval({
        correlationId: context.correlationId,
        workflowId: context.workflow.id,
        workflowName: context.workflow.name,
        executionId: context.id,
        nodeId: node.id,
        trigger: {
          policyId: 'workflow',
          ruleId: node.id,
          condition: message || title,
        },
        approvers: assignTo,
        metadata: {
          type: 'notification',
          autoComplete: true,
          title,
          message,
          nodeName,
          kind,
          priority,
          // P8.F HITL-ORGID-PLUMB: prefer first-class context.orgId
          orgId: context.orgId
            || context.getVariables()?.orgId
            || (input as Record<string, unknown>)?.orgId
            || (config as unknown as Record<string, unknown>)?.orgId,
        },
      });

      // Emit NODE.COMPLETED envelope
      const completedEnv = factory.event(
        Intents.NODE.COMPLETED,
        context.correlationId,
        {
          nodeId: node.id,
          nodeName,
          approvalId: approval.id,
          notificationDelivered: true,
        }
      );
      emitted.push(completedEnv);

      // Critical: pass input through unchanged, do NOT set paused
      return {
        success: true,
        output: input,
        envelopes: emitted,
        metadata: {
          approvalId: approval.id,
          notificationDelivered: true,
        },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      return {
        success: false,
        output: null,
        error: {
          code: 'NOTIFICATION_DELIVERY_FAILED',
          message: errorMsg,
        },
        envelopes: emitted,
      };
    }
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const config = node.config as unknown as NotificationDeliverConfig;
    const errors: string[] = [];

    if (!config.message || typeof config.message !== 'string') {
      errors.push('message is required and must be a string');
    }

    if (
      config.priority !== undefined &&
      !['low', 'normal', 'high'].includes(config.priority)
    ) {
      errors.push("priority must be 'low', 'normal', or 'high'");
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}
