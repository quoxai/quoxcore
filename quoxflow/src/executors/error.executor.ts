/**
 * Error Handling Executors
 *
 * Handles try/catch/throw patterns for error management.
 */

import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node, TryNode, CatchNode, ThrowNode } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';
import { evaluateExpression, processValue } from '../expression/engine.js';

/**
 * Try Executor
 *
 * Marks the start of a try block. The actual error catching
 * is handled by the pipeline based on the catch/finally config.
 */
export class TryExecutor implements NodeExecutor {
  readonly nodeTypes = ['error:try'];

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const tryNode = node as TryNode;
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    // Emit try block start event
    const startEnvelope = factory.event(
      Intents.NODE.STARTED,
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        nodeType: node.type,
        bodyNode: tryNode.config.body,
        catchNode: tryNode.config.catch,
        finallyNode: tryNode.config.finally,
      }
    );
    emitted.push(startEnvelope);

    // Pass through to body, with error handling context
    return {
      success: true,
      output: input,
      envelopes: emitted,
      nextNodes: [tryNode.config.body],
      metadata: {
        isTryBlock: true,
        catchNodeId: tryNode.config.catch,
        finallyNodeId: tryNode.config.finally,
      },
    };
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const tryNode = node as TryNode;
    const errors: string[] = [];

    if (!tryNode.config.body) {
      errors.push('body node ID is required');
    }

    if (!tryNode.config.catch) {
      errors.push('catch node ID is required');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

/**
 * Catch Executor
 *
 * Handles errors caught from try blocks.
 */
export class CatchExecutor implements NodeExecutor {
  readonly nodeTypes = ['error:catch'];

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const catchNode = node as CatchNode;
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    // Input should contain the error information
    const errorInput = input as { error?: { code: string; message: string; type?: string } };

    // Check if we should handle this error type
    if (catchNode.config.errorTypes && catchNode.config.errorTypes.length > 0) {
      const errorType = errorInput.error?.type ?? errorInput.error?.code;
      if (errorType && !catchNode.config.errorTypes.includes(errorType)) {
        // Re-throw - we don't handle this error type
        const skipEnvelope = factory.event(
          Intents.NODE.SKIPPED,
          context.correlationId,
          {
            nodeId: node.id,
            reason: `Error type "${errorType}" not in handled types`,
            handledTypes: catchNode.config.errorTypes,
          }
        );
        emitted.push(skipEnvelope);

        return {
          success: false,
          output: input,
          error: {
            code: errorInput.error?.code ?? 'UNHANDLED_ERROR',
            message: errorInput.error?.message ?? 'Error not handled by catch block',
          },
          envelopes: emitted,
        };
      }
    }

    // Emit catch event
    const catchEnvelope = factory.event(
      Intents.NODE.COMPLETED,
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        nodeType: node.type,
        caughtError: errorInput.error,
      }
    );
    emitted.push(catchEnvelope);

    // Pass the error info as output for handling
    return {
      success: true,
      output: {
        caught: true,
        error: errorInput.error,
        originalInput: errorInput,
      },
      envelopes: emitted,
    };
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const catchNode = node as CatchNode;
    const errors: string[] = [];

    if (catchNode.config.errorTypes && !Array.isArray(catchNode.config.errorTypes)) {
      errors.push('errorTypes must be an array');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

/**
 * Throw Executor
 *
 * Explicitly throws an error to be caught by a try/catch block.
 */
export class ThrowExecutor implements NodeExecutor {
  readonly nodeTypes = ['error:throw'];

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const throwNode = node as ThrowNode;
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    const exprContext = context.createExpressionContext(node.id, input);

    try {
      // Evaluate the error message expression
      const message = processValue(throwNode.config.message, exprContext) as string;
      const details = throwNode.config.details
        ? processValue(throwNode.config.details, exprContext)
        : undefined;

      // Emit throw event
      const throwEnvelope = factory.event(
        Intents.NODE.FAILED,
        context.correlationId,
        {
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          nodeType: node.type,
          thrownError: {
            type: throwNode.config.type,
            message,
            details,
          },
        }
      );
      emitted.push(throwEnvelope);

      // Return as failure with the thrown error
      return {
        success: false,
        output: null,
        error: {
          code: throwNode.config.type,
          message,
          details,
        },
        envelopes: emitted,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const errorEnvelope = factory.event(
        Intents.NODE.FAILED,
        context.correlationId,
        {
          nodeId: node.id,
          error: `Failed to evaluate throw expression: ${errorMessage}`,
        }
      );
      emitted.push(errorEnvelope);

      return {
        success: false,
        output: null,
        error: {
          code: 'THROW_EVAL_FAILED',
          message: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        },
        envelopes: emitted,
      };
    }
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const throwNode = node as ThrowNode;
    const errors: string[] = [];

    if (!throwNode.config.type) {
      errors.push('type is required');
    }

    if (!throwNode.config.message) {
      errors.push('message is required');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

export const tryExecutor = new TryExecutor();
export const catchExecutor = new CatchExecutor();
export const throwExecutor = new ThrowExecutor();
