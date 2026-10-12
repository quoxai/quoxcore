/**
 * Event Trigger Executor
 *
 * Handles trigger:event nodes that fire when a matching AEE event occurs.
 * Works with the EventBus for inter-workflow triggers.
 *
 * Node type: trigger:event
 * Config:
 *   - pattern: event intent pattern (e.g., "ops.approval.grant", "quox.flow.*")
 *   - filter: optional payload filter expression
 */

import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';

interface EventTriggerConfig {
  pattern: string;         // Intent pattern to match
  filter?: string;         // Optional expression to filter events
}

/**
 * EventTriggerExecutor handles trigger:event nodes.
 *
 * When executed (by the pipeline after an event matches), it emits an
 * event-received envelope and passes the triggering envelope's payload downstream.
 */
export class EventTriggerExecutor implements NodeExecutor {
  readonly nodeTypes = ['trigger:event'];

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const config = node.config as EventTriggerConfig;
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    // Emit event-received trigger envelope
    const triggerEnvelope = factory.event(
      'quox.flow.trigger.event.received',
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        pattern: config.pattern,
        receivedAt: new Date().toISOString(),
        // Include source event info if available
        ...(typeof input === 'object' && input !== null && 'intent' in (input as Record<string, unknown>)
          ? { sourceIntent: (input as Record<string, unknown>).intent }
          : {}
        ),
      }
    );
    emitted.push(triggerEnvelope);

    // Extract payload from triggering envelope or pass input through
    let output: unknown;
    if (typeof input === 'object' && input !== null && 'payload' in (input as Record<string, unknown>)) {
      // Input is an envelope — extract its payload
      const envelope = input as Envelope;
      output = {
        event_intent: envelope.intent,
        event_from: envelope.from,
        event_corr: envelope.corr,
        event_ts: envelope.ts,
        payload: envelope.payload,
      };
    } else {
      // Raw input — pass through
      output = input;
    }

    // Emit completion
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
    const config = node.config as EventTriggerConfig;
    const errors: string[] = [];

    if (!config.pattern) {
      errors.push('pattern is required');
    } else if (typeof config.pattern !== 'string') {
      errors.push('pattern must be a string');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

export const eventTriggerExecutor = new EventTriggerExecutor();
