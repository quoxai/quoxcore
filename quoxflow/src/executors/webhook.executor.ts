/**
 * Webhook Executor
 *
 * Handles webhook trigger nodes.
 * Note: In CLI mode, this processes provided trigger data.
 * In API mode, this would register HTTP endpoints.
 */

import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node, WebhookTriggerNode } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';

export interface WebhookTriggerData {
  method: string;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export class WebhookExecutor implements NodeExecutor {
  readonly nodeTypes = ['trigger:webhook'];

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const webhookNode = node as WebhookTriggerNode;
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    // Input for webhook trigger is the incoming request data
    const triggerData = input as WebhookTriggerData | unknown;

    // Emit ingress event
    const ingressEnvelope = factory.event(
      'quox.flow.trigger.webhook.received',
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        nodeType: node.type,
        path: webhookNode.config.path,
        expectedMethod: webhookNode.config.method ?? 'POST',
        receivedMethod: (triggerData as WebhookTriggerData)?.method,
      }
    );
    emitted.push(ingressEnvelope);

    // Validate request if we have trigger data with method info
    if (triggerData && typeof triggerData === 'object' && 'method' in triggerData) {
      const data = triggerData as WebhookTriggerData;
      const expectedMethod = webhookNode.config.method ?? 'POST';

      if (data.method !== expectedMethod) {
        const errorEnvelope = factory.event(
          Intents.AOCL.INGRESS_REJECTED,
          context.correlationId,
          {
            nodeId: node.id,
            reason: `Method mismatch: expected ${expectedMethod}, got ${data.method}`,
          }
        );
        emitted.push(errorEnvelope);

        return {
          success: false,
          output: null,
          error: {
            code: 'METHOD_NOT_ALLOWED',
            message: `Expected ${expectedMethod}, got ${data.method}`,
          },
          envelopes: emitted,
        };
      }
    }

    // Pass through the trigger data as output
    // The body is what flows to the next node
    const output = (triggerData && typeof triggerData === 'object' && 'body' in triggerData)
      ? (triggerData as WebhookTriggerData).body
      : triggerData;

    // Emit completion event
    const completeEnvelope = factory.event(
      Intents.NODE.COMPLETED,
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        nodeType: node.type,
      }
    );
    emitted.push(completeEnvelope);

    return {
      success: true,
      output,
      envelopes: emitted,
    };
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const webhookNode = node as WebhookTriggerNode;
    const errors: string[] = [];

    if (!webhookNode.config.path) {
      errors.push('path is required');
    }

    const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
    if (webhookNode.config.method && !validMethods.includes(webhookNode.config.method)) {
      errors.push(`method must be one of: ${validMethods.join(', ')}`);
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

export const webhookExecutor = new WebhookExecutor();
