/**
 * Transform Executor
 *
 * Handles data transformation using expressions.
 */

import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node, TransformNode, SetNode } from '../core/workflow.js';
import { ExecutionContext, ExpressionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';
import { evaluateExpression, interpolateString } from '../expression/engine.js';

export class TransformExecutor implements NodeExecutor {
  readonly nodeTypes = ['data:transform', 'data:set'];

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    // Handle data:set nodes (simple key-value assignment)
    if (node.type === 'data:set') {
      return this.executeSet(node as SetNode, input, context);
    }

    const transformNode = node as TransformNode;
    const exprContext = context.createExpressionContext(node.id, input);
    const mode = transformNode.config.mode ?? 'single';
    // Defence-in-depth: salvage transform expressions that were authored as
    // function bodies (top-level const / let / var / function / return), which
    // the expression engine would otherwise reject because it wraps user code
    // as `const __r = (${expression})`. WEAVER's prompt forbids this shape,
    // but legacy and manually-edited workflows survive via this auto-wrap.
    const expression = autoWrapMultiStatementExpression(transformNode.config.expression);

    try {
      let output: unknown;

      if (mode === 'each' && Array.isArray(input)) {
        // Transform each item in the array
        output = input.map((item, index) => {
          const itemContext = {
            ...exprContext,
            input: item,
            vars: {
              ...exprContext.vars,
              index,
              item,
            },
          };
          const result = evaluateExpression(expression, itemContext);
          return interpolateStringsInValue(result, itemContext);
        });
      } else {
        // Transform the whole input
        output = evaluateExpression(expression, exprContext);
        // Post-process to interpolate any ${...} patterns in strings
        output = interpolateStringsInValue(output, exprContext);
      }

      // Honour `config.outputField` — wrap the expression result as
      // `{ [outputField]: result }` so downstream nodes can read
      // `${input.<outputField>}`. The dashboard's fieldSchema declares
      // outputField as required for data:transform; before this wrap the
      // engine ignored it entirely and downstream interpolations
      // silently resolved to undefined → empty inbox bodies.
      const outputField = (transformNode.config as { outputField?: string }).outputField;
      if (typeof outputField === 'string' && outputField.length > 0) {
        // If the expression already returned an object that has the field,
        // leave it alone — wrapping again would produce nested duplicates
        // ({ report: { report: ... } }).
        const alreadyHasField =
          output !== null
          && typeof output === 'object'
          && !Array.isArray(output)
          && Object.prototype.hasOwnProperty.call(output as Record<string, unknown>, outputField);
        if (!alreadyHasField) {
          output = { [outputField]: output };
        }
      }

      // Emit completion event
      const resultEnvelope = factory.event(
        Intents.NODE.COMPLETED,
        context.correlationId,
        {
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          nodeType: node.type,
          inputType: Array.isArray(input) ? 'array' : typeof input,
          outputType: Array.isArray(output) ? 'array' : typeof output,
        }
      );
      emitted.push(resultEnvelope);

      return {
        success: true,
        output,
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
          expression: transformNode.config.expression,
        }
      );
      emitted.push(errorEnvelope);

      return {
        success: false,
        output: null,
        error: {
          code: 'TRANSFORM_FAILED',
          message: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        },
        envelopes: emitted,
      };
    }
  }

  /**
   * Execute a data:set node — simple key-value assignment or merge.
   */
  private async executeSet(
    node: SetNode,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const factory = context.envelopes;
    const emitted: Envelope[] = [];
    const config = node.config;
    const mode = config.mode ?? 'set';

    let output: unknown;

    if (mode === 'merge' && input && typeof input === 'object' && !Array.isArray(input)) {
      output = { ...(input as Record<string, unknown>), ...config.values };
    } else {
      output = { ...config.values };
    }

    const resultEnvelope = factory.event(
      Intents.NODE.COMPLETED,
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        nodeType: node.type,
        mode,
        keyCount: Object.keys(config.values).length,
      }
    );
    emitted.push(resultEnvelope);

    return { success: true, output, envelopes: emitted };
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];

    // data:set validation
    if (node.type === 'data:set') {
      const setNode = node as SetNode;
      if (!setNode.config.values || typeof setNode.config.values !== 'object') {
        errors.push('values is required and must be an object');
      }
      const validModes = ['set', 'merge'];
      if (setNode.config.mode && !validModes.includes(setNode.config.mode)) {
        errors.push(`mode must be one of: ${validModes.join(', ')}`);
      }
      return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
    }

    // data:transform validation
    const transformNode = node as TransformNode;
    if (!transformNode.config.expression) {
      errors.push('expression is required');
    }

    const validModes = ['single', 'each'];
    if (transformNode.config.mode && !validModes.includes(transformNode.config.mode)) {
      errors.push(`mode must be one of: ${validModes.join(', ')}`);
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

/**
 * Recursively interpolate ${...} patterns in string values
 */
function interpolateStringsInValue(value: unknown, context: ExpressionContext): unknown {
  if (typeof value === 'string') {
    // Check if string contains ${...} patterns
    if (value.includes('${')) {
      return interpolateString(value, context);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => interpolateStringsInValue(item, context));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = interpolateStringsInValue(val, context);
    }
    return result;
  }

  return value;
}

/**
 * If the expression begins with a statement keyword (const / let / var /
 * function / return), wrap the entire body in an IIFE so the engine's
 * `const __r = (${expr})` wrap remains syntactically valid. Conservative
 * by design: only the FIRST non-whitespace token is inspected, so nested
 * declarations inside arrow functions (the legitimate case) are untouched.
 *
 * Exported for tests; used as a guard inside TransformExecutor.execute().
 */
export function autoWrapMultiStatementExpression(expression: string): string {
  if (typeof expression !== 'string' || expression.length === 0) return expression;
  const trimmed = expression.trim();
  if (trimmed.length === 0) return expression;
  // First identifier-shaped token at the very start of the trimmed expression.
  const firstWord = trimmed.split(/[\s({]/, 1)[0];
  const STATEMENT_STARTERS = new Set(['const', 'let', 'var', 'function', 'return']);
  if (STATEMENT_STARTERS.has(firstWord)) {
    return `(() => { ${expression} })()`;
  }
  return expression;
}

export const transformExecutor = new TransformExecutor();
