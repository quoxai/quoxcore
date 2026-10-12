/**
 * Tool Call Executor
 *
 * Handles action:tool nodes that invoke collector tools.
 * Makes HTTP POST to collector's internal tool endpoint.
 *
 * Node type: action:tool
 * Config:
 *   - tool: string — tool name (e.g., 'fleet_status', 'docker_status')
 *   - input: object — input parameters for the tool
 *
 * Security:
 *   - Only calls the known collector URL (SSRF-safe)
 *   - Uses INTERNAL_SERVICE_KEY for auth
 *   - Agent ID is always 'quoxflow' (RBAC-restricted in collector)
 *
 * TODO (P2.D): server.ts constructs ToolCallExecutor at boot; pass the
 *   evidenceStore instance created at server.ts:171 once orchestrator wires
 *   production EvidenceStore during live-verify prep.
 */

import { ulid } from 'ulid';
import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';
import { captureToolArgs, captureToolResult } from './lib/tool-envelope.js';
import { combineAbortSignals } from './lib/abort-utils.js';
import type { EvidenceStore } from '../evidence/types.js';

interface ToolCallConfig {
  tool: string;
  input?: Record<string, unknown>;
}

interface ToolCallExecutorOptions {
  collectorUrl?: string;
  serviceKey?: string;
  evidenceStore?: EvidenceStore;
  inlineMaxBytes?: number;
  binaryMaxBytes?: number;
}

export class ToolCallExecutor implements NodeExecutor {
  readonly nodeTypes = ['action:tool'];
  readonly hasExternalEffect = true;
  private collectorUrl: string;
  private serviceKey: string;
  private evidenceStore?: EvidenceStore;
  private inlineMaxBytes?: number;
  private binaryMaxBytes?: number;

  constructor(options?: ToolCallExecutorOptions) {
    this.collectorUrl = options?.collectorUrl || process.env.COLLECTOR_URL || 'http://collector:9848';
    this.serviceKey = options?.serviceKey || process.env.INTERNAL_SERVICE_KEY || '';
    this.evidenceStore = options?.evidenceStore;
    this.inlineMaxBytes = options?.inlineMaxBytes;
    this.binaryMaxBytes = options?.binaryMaxBytes;
  }

  /** AEE-FULL-P2: post-construction wiring for the singleton export (server.ts). */
  setEvidenceStore(store: EvidenceStore): void {
    this.evidenceStore = store;
  }

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const config = node.config as unknown as ToolCallConfig;
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    const toolName = config.tool;
    const toolInput = config.input || {};
    const startedAt = new Date().toISOString();

    const captureCtx = {
      evidenceStore: this.evidenceStore,
      correlationId: context.correlationId,
      envelopeId: '', // filled per-envelope below
      workflowId: context.workflow.id,
      executionId: context.id,
      nodeId: node.id,
      orgId: context.orgId, // QF-MT WP5: the run's org
      caps: {
        inlineMaxBytes: this.inlineMaxBytes,
        binaryMaxBytes: this.binaryMaxBytes,
      },
    };

    // Capture args (pre-generate envelope ID so the evidence record can reference it)
    const invokedEnvelopeId = ulid();
    const argsCaptured = await captureToolArgs(toolInput, {
      ...captureCtx,
      envelopeId: invokedEnvelopeId,
    });

    // Emit tool.invoked
    const invokedEnvelope = factory.event(
      'quox.flow.tool.invoked',
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        nodeType: 'action:tool',
        tool: toolName,
        args: argsCaptured.value,
        args_truncated: argsCaptured.truncated,
        args_size_bytes: argsCaptured.size_bytes,
        ...(argsCaptured.full_sha256 !== undefined ? { args_full_sha256: argsCaptured.full_sha256 } : {}),
        startedAt,
      }
    );
    emitted.push(invokedEnvelope);

    try {
      const url = `${this.collectorUrl}/api/internal/tools/execute`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': this.serviceKey,
        },
        body: JSON.stringify({
          tool: toolName,
          input: toolInput,
          agent_id: 'quoxflow',
        }),
        signal: combineAbortSignals(AbortSignal.timeout(30000), context.cancellationSignal), // 30s timeout + cancellation
      });

      if (!response.ok) {
        const errorText = await response.text();
        const errorMsg = `Collector returned ${response.status}: ${errorText}`;

        const failedEnvelope = factory.event(
          'quox.flow.tool.failed',
          context.correlationId,
          {
            nodeId: node.id,
            nodeName: node.name ?? node.id,
            nodeType: 'action:tool',
            tool: toolName,
            error_code: 'TOOL_CALL_ERROR',
            error_message: errorMsg,
          }
        );
        emitted.push(failedEnvelope);

        return {
          success: false,
          output: null,
          error: {
            code: 'TOOL_CALL_ERROR',
            message: errorMsg,
          },
          envelopes: emitted,
        };
      }

      // Detect content type for binary vs JSON handling
      const contentType = response.headers?.get?.('content-type') ?? '';
      let rawResult: unknown;
      let isBinary = false;

      if (contentType.includes('application/octet-stream') || contentType.includes('image/')) {
        // Binary response — read as buffer
        try {
          const ab = await response.arrayBuffer();
          rawResult = Buffer.from(ab);
          isBinary = true;
        } catch {
          rawResult = await response.text();
        }
      } else {
        // Try JSON first, fall back to text
        try {
          rawResult = await response.json() as Record<string, unknown>;
        } catch {
          rawResult = await response.text();
        }
      }

      // R5.med: Extract cost reported by the collector tool so the budget evaluator
      // can account for tool-call spend.
      const resultObj = (!isBinary && rawResult && typeof rawResult === 'object') ? rawResult as Record<string, unknown> : {};
      const costUsdMicro = typeof resultObj.cost_usd_micro === 'number' ? resultObj.cost_usd_micro : 0;

      const completedAt = Date.now();
      const durationMs = completedAt - new Date(startedAt).getTime();

      // Capture result (pre-generate envelope ID so the evidence record can reference it)
      const completedEnvelopeId = ulid();
      const resultCaptured = await captureToolResult(rawResult, {
        ...captureCtx,
        envelopeId: completedEnvelopeId,
      });

      // Emit tool.completed
      const completedEnvelope = factory.event(
        'quox.flow.tool.completed',
        context.correlationId,
        {
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          nodeType: 'action:tool',
          tool: toolName,
          toolSuccess: !isBinary ? (resultObj.success !== false) : true,
          cost_usd_micro: costUsdMicro,
          result: resultCaptured.value,
          result_truncated: resultCaptured.truncated,
          result_size_bytes: resultCaptured.size_bytes,
          result_type: resultCaptured.type,
          ...(resultCaptured.full_sha256 !== undefined ? { result_full_sha256: resultCaptured.full_sha256 } : {}),
          ...(resultCaptured.too_large ? { result_too_large: true } : {}),
          duration_ms: durationMs,
        }
      );
      emitted.push(completedEnvelope);

      // Emit NODE.COMPLETED for the node lifecycle layer
      const nodeCompletedEnvelope = factory.event(
        Intents.NODE.COMPLETED,
        context.correlationId,
        {
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          nodeType: node.type,
          tool: toolName,
          toolSuccess: !isBinary ? (resultObj.success !== false) : true,
          cost_usd_micro: costUsdMicro,
        }
      );
      emitted.push(nodeCompletedEnvelope);

      return {
        success: !isBinary ? (resultObj.success !== false) : true,
        output: rawResult,
        envelopes: emitted,
        // R5.med: include cost in metadata so the budget evaluator can read it
        metadata: { cost_usd_micro: costUsdMicro },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      const failedEnvelope = factory.event(
        'quox.flow.tool.failed',
        context.correlationId,
        {
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          nodeType: 'action:tool',
          tool: toolName,
          error_code: 'TOOL_CALL_FAILED',
          error_message: errorMsg,
        }
      );
      emitted.push(failedEnvelope);

      return {
        success: false,
        output: null,
        error: {
          code: 'TOOL_CALL_FAILED',
          message: errorMsg,
        },
        envelopes: emitted,
      };
    }
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const config = node.config as unknown as ToolCallConfig;
    const errors: string[] = [];

    if (!config.tool || typeof config.tool !== 'string') {
      errors.push('tool name is required and must be a string');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

export const toolCallExecutor = new ToolCallExecutor();
