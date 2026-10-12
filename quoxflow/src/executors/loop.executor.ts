/**
 * Loop Executor
 *
 * Handles iteration over arrays. The loop body is executed for each item.
 * This executor collects results from all iterations.
 */

import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node, LoopNode } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';
import { evaluateExpression } from '../expression/engine.js';

// STABILITY-AUDITS: iteration count and accumulated iteration-data size were
// unbounded — a large/attacker-influenced `items` array could exhaust memory
// before the pipeline ever ran a single loop body. Cap both. `maxIterations`
// is configurable lower per-node but never higher than the hard ceiling;
// `maxOutputBytes` bounds the serialised size of the prepared iteration data.
export const HARD_MAX_ITERATIONS = 10_000;
// Kept well below the expression engine's isolate memory limit
// (src/expression/engine.ts ISOLATE_MEMORY_LIMIT, 8MB) — an items payload
// approaching that ceiling already risks the isolate itself failing (with
// a much less clear error) before this check ever runs, so a downstream
// default any higher than this would rarely fire in practice.
export const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2MB

type LoopConfigWithLimits = LoopNode['config'] & {
  maxIterations?: number;
  maxOutputBytes?: number;
};

export class LoopExecutor implements NodeExecutor {
  readonly nodeTypes = ['flow:loop'];

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const loopNode = node as LoopNode;
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    const exprContext = context.createExpressionContext(node.id, input);

    try {
      // Evaluate the items expression to get the array to iterate
      const items = evaluateExpression(loopNode.config.items, exprContext);

      if (!Array.isArray(items)) {
        const errorEnvelope = factory.event(
          Intents.NODE.FAILED,
          context.correlationId,
          {
            nodeId: node.id,
            error: 'items expression must evaluate to an array',
            itemsExpression: loopNode.config.items,
            actualType: typeof items,
          }
        );
        emitted.push(errorEnvelope);

        return {
          success: false,
          output: null,
          error: {
            code: 'LOOP_ITEMS_NOT_ARRAY',
            message: `items expression must evaluate to an array, got ${typeof items}`,
          },
          envelopes: emitted,
        };
      }

      // Enforce a max-iterations cap. Configurable lower via config.maxIterations,
      // but Math.min() means a workflow author can never raise it past
      // HARD_MAX_ITERATIONS.
      const rawLoopConfig = loopNode.config as LoopConfigWithLimits;
      const configuredMaxIterations = (rawLoopConfig.maxIterations && rawLoopConfig.maxIterations > 0)
        ? rawLoopConfig.maxIterations
        : HARD_MAX_ITERATIONS;
      const maxIterations = Math.min(configuredMaxIterations, HARD_MAX_ITERATIONS);

      if (items.length > maxIterations) {
        const errorEnvelope = factory.event(
          Intents.NODE.FAILED,
          context.correlationId,
          {
            nodeId: node.id,
            error: `Loop items array (${items.length}) exceeds max iterations (${maxIterations})`,
            itemsExpression: loopNode.config.items,
            itemCount: items.length,
            maxIterations,
          }
        );
        emitted.push(errorEnvelope);

        return {
          success: false,
          output: null,
          error: {
            code: 'LOOP_MAX_ITERATIONS_EXCEEDED',
            message: `Loop items array (${items.length} items) exceeds the max-iterations cap (${maxIterations}). Reduce the items expression's result size or raise config.maxIterations (hard ceiling: ${HARD_MAX_ITERATIONS}).`,
          },
          envelopes: emitted,
        };
      }

      const itemVar = loopNode.config.itemVar ?? 'item';
      const indexVar = loopNode.config.indexVar ?? 'index';

      // Emit start event
      const startEnvelope = factory.event(
        Intents.NODE.STARTED,
        context.correlationId,
        {
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          nodeType: node.type,
          itemCount: items.length,
          bodyNode: loopNode.config.body,
        }
      );
      emitted.push(startEnvelope);

      // Prepare iteration data
      // The pipeline will need to execute the body node for each iteration
      // We'll pass the iteration context as output
      const iterationData = items.map((item, index) => ({
        [itemVar]: item,
        [indexVar]: index,
        _loopMeta: {
          total: items.length,
          isFirst: index === 0,
          isLast: index === items.length - 1,
        },
      }));

      // Enforce a cap on the accumulated size of the prepared iteration
      // data. A huge/attacker-influenced items array can pass the
      // max-iterations check above (few, but enormous, items) and still
      // blow up memory when serialised downstream — fail the node cleanly
      // instead of letting the process OOM.
      const maxOutputBytes = (rawLoopConfig.maxOutputBytes && rawLoopConfig.maxOutputBytes > 0)
        ? rawLoopConfig.maxOutputBytes
        : DEFAULT_MAX_OUTPUT_BYTES;
      let iterationDataBytes: number;
      try {
        iterationDataBytes = Buffer.byteLength(JSON.stringify(iterationData) ?? '', 'utf-8');
      } catch {
        // Circular/unserialisable structures — treat as over-limit rather
        // than crash the process trying to measure it.
        iterationDataBytes = maxOutputBytes + 1;
      }

      if (iterationDataBytes > maxOutputBytes) {
        const errorEnvelope = factory.event(
          Intents.NODE.FAILED,
          context.correlationId,
          {
            nodeId: node.id,
            error: `Loop iteration data (${iterationDataBytes} bytes) exceeds max output size (${maxOutputBytes} bytes)`,
            itemsExpression: loopNode.config.items,
            itemCount: items.length,
            iterationDataBytes,
            maxOutputBytes,
          }
        );
        emitted.push(errorEnvelope);

        return {
          success: false,
          output: null,
          error: {
            code: 'LOOP_OUTPUT_TOO_LARGE',
            message: `Loop iteration data (${iterationDataBytes} bytes) exceeds the max-output-size cap (${maxOutputBytes} bytes). Reduce the items expression's result size or raise config.maxOutputBytes.`,
          },
          envelopes: emitted,
        };
      }

      // Emit completion event
      const resultEnvelope = factory.event(
        Intents.NODE.COMPLETED,
        context.correlationId,
        {
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          nodeType: node.type,
          itemCount: items.length,
          nextNode: loopNode.config.body,
        }
      );
      emitted.push(resultEnvelope);

      // For now, we'll output the iteration data
      // The pipeline will need special handling to iterate through body
      return {
        success: true,
        output: {
          _isLoop: true,
          items: iterationData,
          originalInput: input,
          bodyNodeId: loopNode.config.body,
          nextNodeId: loopNode.config.next,
        },
        envelopes: emitted,
        // Don't set nextNodes - let the pipeline handle loop execution
        metadata: {
          isLoop: true,
          itemCount: items.length,
          bodyNodeId: loopNode.config.body,
          nextNodeId: loopNode.config.next,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const errorEnvelope = factory.event(
        Intents.NODE.FAILED,
        context.correlationId,
        {
          nodeId: node.id,
          error: errorMessage,
          itemsExpression: loopNode.config.items,
        }
      );
      emitted.push(errorEnvelope);

      return {
        success: false,
        output: null,
        error: {
          code: 'LOOP_EVAL_FAILED',
          message: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        },
        envelopes: emitted,
      };
    }
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const loopNode = node as LoopNode;
    const errors: string[] = [];

    if (!loopNode.config.items) {
      errors.push('items expression is required');
    }

    if (!loopNode.config.body) {
      errors.push('body node ID is required');
    }

    if (!loopNode.config.next) {
      errors.push('next node ID is required');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

export const loopExecutor = new LoopExecutor();
