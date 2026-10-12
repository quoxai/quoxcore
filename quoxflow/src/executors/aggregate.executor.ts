/**
 * Aggregate Executor
 *
 * Handles data:aggregate nodes for collecting and aggregating data.
 */

import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';
import { evaluateExpression } from '../expression/engine.js';

interface AggregateConfig {
  mode?: 'collect' | 'sum' | 'count' | 'avg' | 'min' | 'max' | 'first' | 'last' | 'flatten';
  field?: string; // Field to aggregate (for sum, avg, min, max)
  expression?: string; // Custom aggregation expression
}

export class AggregateExecutor implements NodeExecutor {
  readonly nodeTypes = ['data:aggregate'];

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const config = node.config as AggregateConfig;
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    const mode = config.mode || 'collect';

    // Input should be an array for aggregation
    const items = Array.isArray(input) ? input : [input];

    let result: unknown;

    try {
      switch (mode) {
        case 'collect':
          result = items;
          break;

        case 'flatten':
          result = items.flat();
          break;

        case 'count':
          result = items.length;
          break;

        case 'sum':
          result = items.reduce((acc: number, item: unknown) => {
            const value = config.field ? getNestedValue(item, config.field) : item;
            return acc + (typeof value === 'number' ? value : 0);
          }, 0);
          break;

        case 'avg':
          if (items.length === 0) {
            result = 0;
          } else {
            const sum = items.reduce((acc: number, item: unknown) => {
              const value = config.field ? getNestedValue(item, config.field) : item;
              return acc + (typeof value === 'number' ? value : 0);
            }, 0);
            result = sum / items.length;
          }
          break;

        case 'min':
          result = items.reduce((min: number | null, item: unknown) => {
            const value = config.field ? getNestedValue(item, config.field) : item;
            if (typeof value !== 'number') return min;
            return min === null ? value : Math.min(min, value);
          }, null);
          break;

        case 'max':
          result = items.reduce((max: number | null, item: unknown) => {
            const value = config.field ? getNestedValue(item, config.field) : item;
            if (typeof value !== 'number') return max;
            return max === null ? value : Math.max(max, value);
          }, null);
          break;

        case 'first':
          result = items[0];
          break;

        case 'last':
          result = items[items.length - 1];
          break;

        default:
          result = items;
      }

      // Apply custom expression if provided
      if (config.expression) {
        const exprContext = context.createExpressionContext(node.id, result);
        result = evaluateExpression(config.expression, exprContext);
      }

      // Emit completion event
      const completeEnvelope = factory.event(
        Intents.NODE.COMPLETED,
        context.correlationId,
        {
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          nodeType: node.type,
          mode,
          inputCount: items.length,
          resultType: typeof result,
        }
      );
      emitted.push(completeEnvelope);

      return {
        success: true,
        output: result,
        envelopes: emitted,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const errorEnvelope = factory.event(
        Intents.NODE.FAILED,
        context.correlationId,
        {
          nodeId: node.id,
          error: errorMessage,
          mode,
        }
      );
      emitted.push(errorEnvelope);

      return {
        success: false,
        output: null,
        error: {
          code: 'AGGREGATE_FAILED',
          message: errorMessage,
        },
        envelopes: emitted,
      };
    }
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const config = node.config as AggregateConfig;
    const errors: string[] = [];

    const validModes = ['collect', 'sum', 'count', 'avg', 'min', 'max', 'first', 'last', 'flatten'];
    if (config.mode && !validModes.includes(config.mode)) {
      errors.push(`mode must be one of: ${validModes.join(', ')}`);
    }

    if (['sum', 'avg', 'min', 'max'].includes(config.mode || '') && !config.field) {
      // Field is optional - will use item directly if not specified
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

/**
 * Get a nested value from an object using dot notation
 */
function getNestedValue(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) return undefined;

  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

export const aggregateExecutor = new AggregateExecutor();
