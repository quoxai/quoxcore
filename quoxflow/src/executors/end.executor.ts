/**
 * End Executor
 *
 * Handles flow:end nodes — the explicit terminal marker for a workflow
 * branch. flow:end was accepted at creation/validation time (NodeBaseSchema
 * validates `type` as a plain string) but had no registered executor, so any
 * workflow whose branch actually reached the node failed at runtime with
 * UNKNOWN_NODE_TYPE (quoxflow#4). This is a no-op terminal: it passes the
 * input through unchanged and emits a completion event, mirroring the
 * pass-through shape of util:log and the terminal shape of flow:merge.
 */

import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';

export class EndExecutor implements NodeExecutor {
  readonly nodeTypes = ['flow:end'];

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

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
      output: input, // Pass through unchanged
      envelopes: emitted,
    };
  }
}

export const endExecutor = new EndExecutor();
