/**
 * Respond-to-Webhook Executor — MACHINERY
 *
 * Handles `respondToWebhook` nodes. Resolves the per-execution deferred
 * response channel (see ../api/webhook-response-channel.ts) so the inbound
 * webhook HTTP request — held open by webhook-triggers.ts — can return the
 * workflow-produced body/status/headers instead of the default 202.
 *
 * If the triggering request wasn't held open (e.g. this workflow was run
 * from the CLI, a schedule, or the webhook route decided not to wait —
 * no pending entry for this executionId), `resolve()` is a no-op and the
 * node still completes successfully so the rest of the workflow can run.
 */

import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node, RespondWebhookNode } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';
import { processValue } from '../expression/engine.js';
import { webhookResponseChannel, WebhookResponseChannel } from '../api/webhook-response-channel.js';

export class RespondWebhookExecutor implements NodeExecutor {
  readonly nodeTypes = ['respondToWebhook'];
  private channel: WebhookResponseChannel;

  constructor(options?: { responseChannel?: WebhookResponseChannel }) {
    this.channel = options?.responseChannel ?? webhookResponseChannel;
  }

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const respondNode = node as RespondWebhookNode;
    const config = respondNode.config ?? {};
    const factory = context.envelopes;
    const emitted: Envelope[] = [];
    const nodeName = node.name ?? node.id;

    const exprContext = context.createExpressionContext(node.id, input);

    // statusCode — default 200, resolves ${...} expressions if given as a string.
    let statusCode = 200;
    if (config.statusCode !== undefined) {
      const resolved = processValue(config.statusCode, exprContext);
      const num = typeof resolved === 'number' ? resolved : Number(resolved);
      if (Number.isFinite(num)) statusCode = num;
    }

    // body — default to passthrough input if not configured.
    const body = config.body !== undefined
      ? processValue(config.body, exprContext)
      : input;

    // headers — default {}.
    const headers = config.headers
      ? (processValue(config.headers, exprContext) as Record<string, string>)
      : {};

    const responded = this.channel.resolve(context.id, { status: statusCode, body, headers });

    const completedEnv = factory.event(
      Intents.NODE.COMPLETED,
      context.correlationId,
      {
        nodeId: node.id,
        nodeName,
        nodeType: node.type,
        statusCode,
        responded,
      }
    );
    emitted.push(completedEnv);

    return {
      success: true,
      output: { statusCode, body, headers, responded },
      envelopes: emitted,
      metadata: { statusCode, responded },
    };
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const respondNode = node as RespondWebhookNode;
    const errors: string[] = [];

    if (
      respondNode.config?.statusCode !== undefined &&
      typeof respondNode.config.statusCode !== 'number' &&
      typeof respondNode.config.statusCode !== 'string'
    ) {
      errors.push('statusCode must be a number or an expression string');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

export const respondWebhookExecutor = new RespondWebhookExecutor();
