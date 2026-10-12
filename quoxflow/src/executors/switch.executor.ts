/**
 * Switch Executor
 *
 * Handles multi-way routing based on expression value matching.
 */

import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node, SwitchNode } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';
import { evaluateExpression } from '../expression/engine.js';

export class SwitchExecutor implements NodeExecutor {
  readonly nodeTypes = ['flow:switch'];

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const switchNode = node as SwitchNode;
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    const exprContext = context.createExpressionContext(node.id, input);

    try {
      // Evaluate the switch expression
      const switchValue = evaluateExpression(switchNode.config.expression, exprContext);

      // Find matching case
      let matchedCase: { value: unknown; target: string } | undefined;
      let matchIndex = -1;

      for (let i = 0; i < switchNode.config.cases.length; i++) {
        const caseConfig = switchNode.config.cases[i];
        // Use loose equality to match values (like JavaScript switch)
        if (switchValue == caseConfig.value) {
          matchedCase = caseConfig;
          matchIndex = i;
          break;
        }
      }

      // Determine target node
      const nextNodeId = matchedCase?.target ?? switchNode.config.default;

      if (!nextNodeId) {
        // No match and no default - this is an error
        const errorEnvelope = factory.event(
          Intents.NODE.FAILED,
          context.correlationId,
          {
            nodeId: node.id,
            error: 'No matching case and no default defined',
            switchValue,
          }
        );
        emitted.push(errorEnvelope);

        return {
          success: false,
          output: null,
          error: {
            code: 'SWITCH_NO_MATCH',
            message: `No case matched value "${switchValue}" and no default defined`,
          },
          envelopes: emitted,
        };
      }

      // Emit completion event with decision recorded
      const resultEnvelope = factory.event(
        Intents.NODE.COMPLETED,
        context.correlationId,
        {
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          nodeType: node.type,
          expression: switchNode.config.expression,
          switchValue,
          matchedCase: matchedCase ? { index: matchIndex, value: matchedCase.value } : null,
          usedDefault: !matchedCase,
          nextNode: nextNodeId,
        }
      );
      emitted.push(resultEnvelope);

      return {
        success: true,
        output: input, // Pass input through unchanged
        envelopes: emitted,
        nextNodes: [nextNodeId],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const errorEnvelope = factory.event(
        Intents.NODE.FAILED,
        context.correlationId,
        {
          nodeId: node.id,
          error: errorMessage,
          expression: switchNode.config.expression,
        }
      );
      emitted.push(errorEnvelope);

      return {
        success: false,
        output: null,
        error: {
          code: 'SWITCH_EVAL_FAILED',
          message: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        },
        envelopes: emitted,
      };
    }
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const switchNode = node as SwitchNode;
    const errors: string[] = [];

    if (!switchNode.config.expression) {
      errors.push('expression is required');
    }

    if (!switchNode.config.cases || !Array.isArray(switchNode.config.cases)) {
      errors.push('cases array is required');
    } else if (switchNode.config.cases.length === 0) {
      errors.push('at least one case is required');
    } else {
      switchNode.config.cases.forEach((c, i) => {
        if (c.value === undefined) {
          errors.push(`cases[${i}].value is required`);
        }
        if (!c.target) {
          errors.push(`cases[${i}].target is required`);
        }
      });
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

export const switchExecutor = new SwitchExecutor();
