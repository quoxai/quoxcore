/**
 * Assistant Invoke Executor
 *
 * Handles assistant:invoke nodes that pin a specific assistant persona
 * (e.g. NOVA, CIPHER, COREY) for a single node call.
 *
 * Different from agent:invoke in INTENT: assistant:invoke locks in the
 * assistant's persona/voice/system-prompt rather than simply dispatching to
 * agent tooling. The `pin_persona: true` context flag is a hint to the
 * collector to enforce the persona's systemPrompt strictly. If the collector
 * ignores it today, the assistant_id is still the authoritative persona
 * reference — the flag is forward-compatible.
 *
 * Node type: assistant:invoke
 * Config:
 *   - assistant_id: string — Required. e.g. 'nova', 'cipher', 'corey'.
 *   - prompt: string — Required. Supports ${...} expressions.
 *   - timeout_ms?: number — Default 60_000.
 *   - max_tokens?: number — Token budget hint.
 *   - context?: object — Extra metadata passed through.
 *   - evidence?: boolean — Default true.
 *
 * Security:
 *   - Only calls the known collector URL (no SSRF risk)
 *   - Uses INTERNAL_SERVICE_KEY for service-to-service auth
 *   - No retries — invocations are idempotency-unsafe
 */

import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';
import { processValue } from '../expression/engine.js';
import { ulid } from 'ulid';
import type { EvidenceStore } from '../evidence/types.js';
import {
  captureLlmPrompt,
  captureLlmCompletion,
  buildLlmUsagePayload,
} from './lib/llm-envelope.js';
import { combineAbortSignals } from './lib/abort-utils.js';

export interface AssistantInvokeConfig {
  assistant_id: string;
  prompt: string;
  timeout_ms?: number;
  max_tokens?: number;
  /** Optional system-prompt prefix passed to the collector. STRING ONLY —
   * the collector treats this as text (prepended to the assistant's persona),
   * so an object would stringify to "[object Object]" and break every fast
   * path. Use it for short workflow-specific framing like
   * "You are processing day-N data, focus on flagged items". */
  context?: string;
  evidence?: boolean;
  /**
   * If true, the collector's tool surface is suppressed and the call goes
   * via the fast-LLM path (direct API, no MCP, no `--dangerously-skip-
   * permissions` — which Claude CLI 2.1.126 rejects when the collector
   * runs as root). Use this for LLM calls that just summarise input and
   * don't need to call tools (web_search, memory, etc.). Default is
   * false (tools enabled) for parity with chat dispatch.
   */
  no_tools?: boolean;
}

export interface AssistantInvokeExecutorOptions {
  collectorUrl?: string;
  serviceKey?: string;
  evidenceStore?: EvidenceStore;
  inlineMaxBytes?: number;
}

export class AssistantInvokeExecutor implements NodeExecutor {
  readonly nodeTypes = ['assistant:invoke'];
  readonly hasExternalEffect = true;
  private collectorUrl: string;
  private serviceKey: string;
  private evidenceStore?: EvidenceStore;
  private inlineMaxBytes: number;

  constructor(options?: AssistantInvokeExecutorOptions) {
    this.collectorUrl = options?.collectorUrl || process.env.COLLECTOR_URL || 'http://collector:9848';
    this.serviceKey = options?.serviceKey || process.env.INTERNAL_SERVICE_KEY || '';
    this.evidenceStore = options?.evidenceStore;
    this.inlineMaxBytes = options?.inlineMaxBytes ?? 16 * 1024;
  }

  setEvidenceStore(store: EvidenceStore): void {
    this.evidenceStore = store;
  }

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    const exprContext = context.createExpressionContext(node.id, input);
    const rawConfig = node.config as unknown as AssistantInvokeConfig;

    const assistantId = rawConfig.assistant_id;
    const prompt = (processValue(rawConfig.prompt, exprContext) as string) || rawConfig.prompt;
    const timeoutMs = rawConfig.timeout_ms ?? 60_000;
    const collectEvidence = rawConfig.evidence !== false;

    // Extract org_id/user_id
    const wfMeta = (context.workflow.metadata ?? {}) as Record<string, unknown>;
    const inputData = (typeof input === 'object' && input !== null) ? input as Record<string, unknown> : {};
    const orgId = (wfMeta.orgId ?? inputData.orgId ?? undefined) as string | undefined;
    const userId = (wfMeta.userId ?? inputData.userId ?? undefined) as string | undefined;

    // Capture prompt for invoked envelope
    const invEnvId = ulid();
    const captureCtx = {
      correlationId: context.correlationId,
      envelopeId: invEnvId,
      workflowId: context.workflow.id,
      executionId: context.id,
      nodeId: node.id,
      caps: { inlineMaxBytes: this.inlineMaxBytes },
      evidenceStore: this.evidenceStore,
      orgId: context.orgId, // QF-MT WP5: the run's org
    };
    const promptMessages = [{ role: 'user', content: prompt }];
    const promptCapture = await captureLlmPrompt(promptMessages, captureCtx);

    // Emit start envelope — canonical quox.flow.llm.invoked (SD-1)
    const startEnvelope = factory.task(
      `assistant.${assistantId}`,
      'quox.flow.llm.invoked',
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        nodeType: node.type,
        assistant_id: assistantId,
        prompt: promptCapture,
        parameters: {
          timeout_ms: timeoutMs,
          has_output_schema: false,
          max_tokens: rawConfig.max_tokens,
        },
        startedAt: new Date().toISOString(),
      },
      collectEvidence ? { requires: { evidence: true, timeout_ms: timeoutMs } } : undefined
    );
    emitted.push(startEnvelope);

    // SD-2: emit immediately before fetch so pre-call record is durable
    context.emitImmediate(startEnvelope);

    try {
      const url = `${this.collectorUrl}/api/internal/agents/invoke`;
      // The collector treats `context` as a STRING (system-prompt prefix)
      // in both its fast paths and the /chat fall-through. Sending it as
      // an object stringifies to "[object Object]" — every fast path then
      // fails with a malformed system prompt and the call silently routes
      // through MCP/Claude-CLI which itself fails when the collector runs
      // as root. Pass the workflow trace fields as a stringified context
      // so they at least show up readably; the executor's envelope chain
      // is the canonical record of metadata.
      const userContext = typeof rawConfig.context === 'string' ? rawConfig.context : '';
      const traceContext = `[workflow=${context.workflow.id} execution=${context.id} node=${node.id}]`;
      const contextStr = userContext
        ? `${traceContext}\n${userContext}`
        : traceContext;
      const body: Record<string, unknown> = {
        agent_id: assistantId,
        task: prompt,
        ...(orgId ? { org_id: orgId } : {}),
        ...(userId ? { user_id: userId } : {}),
        max_duration_ms: timeoutMs,
        no_tools: rawConfig.no_tools === true,
        context: contextStr,
        // REPLAY-ONLY .A0: structured run identity (top-level, not embedded in
        // the stringified `context` above) so a collector-side gate can
        // identify the run (docs/STREAM_REPLAY_ONLY_FABLE_REVIEW.md §5 .A0)
        workflow_id: context.workflow.id,
        execution_id: context.id,
        // REPLAY-ONLY .A-1a: effective replay_only for this run, always sent
        // (not conditionally spread) so a collector-side gate can distinguish
        // "false" from "unset". Foundation only — no gate reads this yet.
        effective_replay_only: context.effectiveReplayOnly,
      };

      if (rawConfig.max_tokens) {
        body.max_tokens = rawConfig.max_tokens;
      }

      const startTime = Date.now();
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': this.serviceKey,
        },
        body: JSON.stringify(body),
        signal: combineAbortSignals(AbortSignal.timeout(timeoutMs), context.cancellationSignal),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const errorMsg = `Assistant ${assistantId} invocation failed: HTTP ${response.status} — ${errorText}`;

        emitted.push(factory.error(startEnvelope, 'quox.flow.llm.failed', {
          code: 'ASSISTANT_INVOKE_HTTP_ERROR',
          message: errorMsg,
          details: {
            nodeId: node.id,
            nodeName: node.name ?? node.id,
            nodeType: node.type,
            assistant_id: assistantId,
            error_code: 'ASSISTANT_INVOKE_HTTP_ERROR',
            error_message: errorMsg,
            cancelled: false,
            partial_output: null,
            cancelled_at: null,
            cancelled_by: null,
          },
        }));

        return {
          success: false,
          output: null,
          error: {
            code: 'ASSISTANT_INVOKE_HTTP_ERROR',
            message: errorMsg,
          },
          envelopes: emitted,
        };
      }

      const result = await response.json() as Record<string, unknown>;

      // The collector returns 200 OK even when the assistant call fails —
      // success:false + error:'<reason>' (e.g. 'l7_denied' for AOCL policy
      // denial / quota exhaustion). If we just emit NODE.COMPLETED with
      // success:false the upstream pipeline reports "Node X failed without
      // error details" which is impossible to debug. Emit llm.failed with
      // the collector's error/hint instead, so the inbox + execution
      // detail show what actually went wrong.
      if (result.success === false) {
        const collectorErr = typeof result.error === 'string' ? result.error : 'unknown';
        const collectorHint = typeof result.hint === 'string' ? result.hint : '';
        const failMsg = collectorHint
          ? `${collectorErr} — ${collectorHint}`
          : `Assistant ${assistantId} returned an error: ${collectorErr}`;

        emitted.push(factory.error(startEnvelope, 'quox.flow.llm.failed', {
          code: 'ASSISTANT_INVOKE_REJECTED',
          message: failMsg,
          details: {
            nodeId: node.id,
            nodeName: node.name ?? node.id,
            assistant_id: assistantId,
            error_code: 'ASSISTANT_INVOKE_REJECTED',
            error_message: failMsg,
            cancelled: false,
            partial_output: null,
            cancelled_at: null,
            cancelled_by: null,
          },
        }));

        return {
          success: false,
          output: null,
          error: { code: 'ASSISTANT_INVOKE_REJECTED', message: failMsg },
          envelopes: emitted,
        };
      }

      // Evidence collection — persist the full prompt+response exchange via
      // the injected EvidenceStore so an `evidence:<id>` ref (if attached)
      // resolves to a real, hash-chained record. Previously this minted a
      // ulid and attached it as `evidence:${ulid()}` WITHOUT ever calling
      // evidenceStore.store() — a phantom pointer an auditor could never
      // dereference. If no store is injected, or the write fails, we do NOT
      // attach a ref.
      const evidenceRefs: string[] = [];
      if (collectEvidence && this.evidenceStore) {
        try {
          const record = await this.evidenceStore.store({
            correlationId: context.correlationId,
            envelopeId: startEnvelope.id,
            workflowId: context.workflow.id,
            executionId: context.id,
            nodeId: node.id,
            type: 'tool_result',
            contentType: 'application/json',
            content: JSON.stringify({
              assistant_id: assistantId,
              prompt,
              response: result,
            }),
            orgId: context.orgId,
          });
          evidenceRefs.push(`evidence:${record.id}`);
        } catch (err) {
          // Non-fatal: evidence capture must never break the workflow run.
          console.warn('[assistant-invoke] evidenceStore.store() failed (non-fatal):', err);
        }
      }

      // Capture completion
      const completionText = typeof result.result === 'string' ? result.result : JSON.stringify(result.result ?? '');
      const completionCapture = await captureLlmCompletion(completionText, {
        ...captureCtx,
        envelopeId: ulid(),
      });

      // Build token usage payload (honest-zero if usage absent)
      const rawUsage = result.usage as { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number; model?: string; cost_usd?: number } | undefined;
      const usagePayload = buildLlmUsagePayload(rawUsage, 'anthropic');

      // Emit quox.flow.llm.completed — full payload (fixes empty-payload bug)
      const completedEnvelope = factory.result(
        startEnvelope,
        'quox.flow.llm.completed',
        {
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          nodeType: node.type,
          assistant_id: assistantId,
          completion: completionCapture,
          tool_calls: [],
          finish_reason: result.finish_reason ?? (result.success !== false ? 'stop' : 'error'),
          ...usagePayload,
          cancelled: false,
          partial_output: null,
          cancelled_at: null,
          cancelled_by: null,
          duration_ms: Date.now() - startTime,
        },
        evidenceRefs.length > 0 ? evidenceRefs : undefined
      );
      emitted.push(completedEnvelope);

      // Emit usage_unavailable warning if tokens_unknown
      if (usagePayload.tokens_unknown) {
        emitted.push(factory.event(
          'quox.flow.llm.usage_unavailable',
          context.correlationId,
          {
            nodeId: node.id,
            nodeName: node.name ?? node.id,
            assistant_id: assistantId,
            reason: 'collector_response_missing_usage_block',
          }
        ));
      }

      // Keep lifecycle NODE.COMPLETED for pipeline observability (audit lifecycle vs LLM detail)
      emitted.push(factory.event(Intents.NODE.COMPLETED, context.correlationId, {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        assistant_id: assistantId,
        success: true,
      }));

      return {
        success: true,
        output: {
          assistant_id: assistantId,
          result: result.result ?? result.response ?? result,
        },
        envelopes: emitted,
        evidenceRefs,
      };

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = errorMsg.includes('abort') || errorMsg.includes('timeout');

      emitted.push(factory.error(startEnvelope, 'quox.flow.llm.failed', {
        code: isTimeout ? 'ASSISTANT_INVOKE_TIMEOUT' : 'ASSISTANT_INVOKE_FAILED',
        message: errorMsg,
        details: {
          nodeId: node.id,
          assistant_id: assistantId,
          error_code: isTimeout ? 'ASSISTANT_INVOKE_TIMEOUT' : 'ASSISTANT_INVOKE_FAILED',
          error_message: errorMsg,
          cancelled: false,
          partial_output: null,
          cancelled_at: null,
          cancelled_by: null,
        },
      }));

      return {
        success: false,
        output: null,
        error: {
          code: isTimeout ? 'ASSISTANT_INVOKE_TIMEOUT' : 'ASSISTANT_INVOKE_FAILED',
          message: errorMsg,
        },
        envelopes: emitted,
      };
    }
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const config = node.config as unknown as AssistantInvokeConfig;
    const errors: string[] = [];

    if (!config.assistant_id || typeof config.assistant_id !== 'string') {
      errors.push('assistant_id is required and must be a string');
    }

    if (!config.prompt || typeof config.prompt !== 'string') {
      errors.push('prompt is required and must be a string');
    }

    if (config.timeout_ms !== undefined && (typeof config.timeout_ms !== 'number' || config.timeout_ms <= 0)) {
      errors.push('timeout_ms must be a positive number');
    }

    if (config.max_tokens !== undefined && (typeof config.max_tokens !== 'number' || config.max_tokens <= 0)) {
      errors.push('max_tokens must be a positive number');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

export const assistantInvokeExecutor = new AssistantInvokeExecutor();
