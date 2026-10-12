/**
 * Condition Executor
 *
 * Handles binary branching (if/else) based on expression evaluation.
 */

import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node, ConditionNode } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';
import { evaluateExpression } from '../expression/engine.js';

export class ConditionExecutor implements NodeExecutor {
  readonly nodeTypes = ['flow:condition'];

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const conditionNode = node as ConditionNode;
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    const exprContext = context.createExpressionContext(node.id, input);

    try {
      // Evaluate the condition expression
      const result = evaluateExpression(conditionNode.config.expression, exprContext);
      const conditionMet = Boolean(result);

      // Determine which branch to take
      const nextNodeId = conditionMet
        ? conditionNode.config.outputs.true
        : conditionNode.config.outputs.false;

      // Emit completion event with decision recorded
      const resultEnvelope = factory.event(
        Intents.NODE.COMPLETED,
        context.correlationId,
        {
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          nodeType: node.type,
          expression: conditionNode.config.expression,
          result: conditionMet,
          branch: conditionMet ? 'true' : 'false',
          nextNode: nextNodeId,
        }
      );
      emitted.push(resultEnvelope);

      return {
        success: true,
        output: input, // Pass input through unchanged
        envelopes: emitted,
        nextNodes: [nextNodeId], // Override default graph traversal
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const errorEnvelope = factory.event(
        Intents.NODE.FAILED,
        context.correlationId,
        {
          nodeId: node.id,
          error: errorMessage,
          expression: conditionNode.config.expression,
        }
      );
      emitted.push(errorEnvelope);

      return {
        success: false,
        output: null,
        error: {
          code: 'CONDITION_EVAL_FAILED',
          message: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        },
        envelopes: emitted,
      };
    }
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const conditionNode = node as ConditionNode;
    const errors: string[] = [];

    if (!conditionNode.config.expression) {
      errors.push('expression is required');
    }

    if (!conditionNode.config.outputs) {
      errors.push('outputs is required');
    } else {
      if (!conditionNode.config.outputs.true) {
        errors.push('outputs.true is required');
      }
      if (!conditionNode.config.outputs.false) {
        errors.push('outputs.false is required');
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

export const conditionExecutor = new ConditionExecutor();
