/**
 * Agent Invoke Executor
 *
 * Handles agent:invoke nodes that delegate tasks to QuoxCORE agents
 * via the collector's internal agent invocation endpoint.
 *
 * Node type: agent:invoke
 * Config:
 *   - agent_id: string — target agent (e.g., 'sentinel', 'prism', 'quox')
 *   - prompt: string — task instruction (supports ${...} expressions)
 *   - output_schema?: string — JSON schema for result validation
 *   - timeout_ms?: number — per-invocation timeout (default: 30000)
 *   - max_tokens?: number — token budget hint passed to agent
 *   - context?: object — additional context passed to agent
 *   - inject_dependency_results?: boolean — prepend upstream outputs into prompt (default: true)
 *   - evidence?: boolean — store prompt+response as evidence (default: true)
 *
 * Security:
 *   - Only calls the known collector URL (no SSRF risk)
 *   - Uses INTERNAL_SERVICE_KEY for service-to-service auth
 *   - Agent ID validated against allowlist if provided
 */

import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node } from '../core/workflow.js';
import { ExecutionContext, actorToString } from '../core/execution.js';
import { Envelope } from '../core/envelope.js';
import { processValue } from '../expression/engine.js';
import { ulid } from 'ulid';
import type { EvidenceStore } from '../evidence/types.js';
import {
  captureLlmPrompt,
  captureLlmCompletion,
  buildLlmUsagePayload,
} from './lib/llm-envelope.js';
import { combineAbortSignals } from './lib/abort-utils.js';

export interface AgentInvokeConfig {
  agent_id: string;
  prompt: string;
  output_schema?: string;
  timeout_ms?: number;
  max_tokens?: number;
  context?: Record<string, unknown>;
  inject_dependency_results?: boolean;
  evidence?: boolean;
  // MACH-FOLLOWUP WI-D: owner-authored per-task persona/voice channel
  system_prompt?: string;
}

export interface AgentInvokeExecutorOptions {
  collectorUrl?: string;
  serviceKey?: string;
  evidenceStore?: EvidenceStore;
  inlineMaxBytes?: number;
}

export class AgentInvokeExecutor implements NodeExecutor {
  readonly nodeTypes = ['agent:invoke'];
  readonly hasExternalEffect = true;
  private collectorUrl: string;
  private serviceKey: string;
  private evidenceStore?: EvidenceStore;
  private inlineMaxBytes: number;

  constructor(options?: AgentInvokeExecutorOptions) {
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

    // Resolve config expressions
    const exprContext = context.createExpressionContext(node.id, input);
    const rawConfig = node.config as unknown as AgentInvokeConfig;

    const agentId = (processValue(rawConfig.agent_id, exprContext) as string) || rawConfig.agent_id;
    const prompt = (processValue(rawConfig.prompt, exprContext) as string) || rawConfig.prompt;
    const timeoutMs = rawConfig.timeout_ms ?? 120000;
    const collectEvidence = rawConfig.evidence !== false;
    const injectDeps = rawConfig.inject_dependency_results !== false;

    // Build full prompt with dependency injection
    let fullPrompt = prompt;
    if (injectDeps) {
      const depResults = this.gatherDependencyResults(node, context);
      if (depResults) {
        fullPrompt = `Context from previous steps:\n${depResults}\n\nTask:\n${prompt}`;
      }
    }

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

    // Build messages array for capture (mirrors LLM call shape)
    const promptMessages = [{ role: 'user', content: fullPrompt }];
    const promptCapture = await captureLlmPrompt(promptMessages, captureCtx);

    // Emit invoked envelope — fires BEFORE the LLM call (SD-2)
    const taskEnvelope = factory.task(
      `agent.${agentId}`,
      'quox.flow.llm.invoked',
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        nodeType: node.type,
        agent_id: agentId,
        prompt: promptCapture,
        parameters: {
          timeout_ms: timeoutMs,
          has_output_schema: !!rawConfig.output_schema,
          max_tokens: rawConfig.max_tokens,
        },
        startedAt: new Date().toISOString(),
      },
      collectEvidence ? { requires: { evidence: true, timeout_ms: timeoutMs } } : undefined
    );
    emitted.push(taskEnvelope);

    // SD-2: Emit invoked envelope immediately via the context flush hook so the
    // auditable pre-call record is durable BEFORE the LLM call fires. The
    // pipeline's flush hook writes directly to the envelope store. The envelope
    // is also in emitted[] so the pipeline accumulates it normally (idempotent
    // append is a no-op for the duplicate).
    context.emitImmediate(taskEnvelope);

    const startTime = Date.now();

    try {
      const url = `${this.collectorUrl}/api/internal/agents/invoke`;
      // org_id: the RUN's org (context.orgId) is authoritative, as for evidence above. Workflow
      // metadata (set by converters) and trigger input are fallbacks only for a run with no org of
      // its own. ASSAY audit 2026-10-17: a `quox workflow apply` workflow has no metadata.orgId, so
      // no org was sent and the collector ran the agent in 'default' with none of its org's tools.
      const wfMeta = (context.workflow.metadata ?? {}) as Record<string, unknown>;
      const inputData = (typeof input === 'object' && input !== null) ? input as Record<string, unknown> : {};
      const orgId = context.orgId ?? wfMeta.orgId ?? inputData.orgId;
      // FND_01M55X6TRMDS63SDZK3TDS63SD: the user is the run's REAL initiator only. Workflow metadata and
      // trigger input are author-controlled and must never pick which same-org user an agent runs as.
      const userId = context.actor?.kind === 'user' ? context.actor.userId : undefined;

      const body: Record<string, unknown> = {
        agent_id: agentId,
        task: fullPrompt,
        ...(orgId ? { org_id: orgId } : {}),
        ...(userId ? { user_id: userId } : {}),
        // MACH-FOLLOWUP WI-D: owner-authored per-task persona/voice channel,
        // forwarded verbatim to collector's /api/internal/agents/invoke
        // (plan §4.4 step 6). Additive/optional — backward-compatible.
        ...(typeof rawConfig.system_prompt === 'string' && rawConfig.system_prompt
          ? { system_prompt: rawConfig.system_prompt }
          : {}),
        // REPLAY-ONLY .A-1a: effective replay_only for this run, always sent
        // (not conditionally spread) so a collector-side gate can distinguish
        // "false" from "unset". Foundation only — no gate reads this yet.
        effective_replay_only: context.effectiveReplayOnly,
        context: {
          source: 'quoxflow',
          workflow_id: context.workflow.id,
          execution_id: context.id,
          node_id: node.id,
          // node config cannot supply `actor`: only the run's own actor is ever reported.
          ...(({ actor: _forged, ...rest }) => rest)((rawConfig.context ?? {}) as Record<string, unknown>),
          // A system-initiated run names itself. After the config spread so node config cannot forge it.
          ...(context.actor?.kind === 'system' ? { actor: actorToString(context.actor) } : {}),
        },
      };

      if (rawConfig.max_tokens) {
        body.max_tokens = rawConfig.max_tokens;
      }
      if (rawConfig.output_schema) {
        body.output_schema = rawConfig.output_schema;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': this.serviceKey,
        },
        body: JSON.stringify(body),
        signal: combineAbortSignals(AbortSignal.timeout(timeoutMs), context.cancellationSignal),
      });

      const durationMs = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        const errorMsg = `Agent ${agentId} invocation failed: HTTP ${response.status} — ${errorText}`;

        const errorEnvelope = factory.error(
          taskEnvelope,
          'quox.flow.llm.failed',
          {
            code: 'AGENT_INVOKE_HTTP_ERROR',
            message: errorMsg,
            details: {
              nodeId: node.id,
              nodeName: node.name ?? node.id,
              nodeType: node.type,
              agent_id: agentId,
              error_code: 'AGENT_INVOKE_HTTP_ERROR',
              error_message: errorMsg,
              cancelled: false,
              partial_output: null,
              cancelled_at: null,
              cancelled_by: null,
            },
          }
        );
        emitted.push(errorEnvelope);

        return {
          success: false,
          output: null,
          error: {
            code: 'AGENT_INVOKE_HTTP_ERROR',
            message: errorMsg,
          },
          envelopes: emitted,
        };
      }

      const result = await response.json() as Record<string, unknown>;

      // Capture completion text
      const completionText = typeof result.result === 'string' ? result.result : JSON.stringify(result.result ?? '');
      const completionCapture = await captureLlmCompletion(completionText, {
        ...captureCtx,
        envelopeId: ulid(),
      });

      // Build token usage payload (honest-zero if usage absent)
      const rawUsage = result.usage as { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number; model?: string; cost_usd?: number; provider?: string } | undefined;
      // Collector's /api/internal/agents/invoke is policy-driven and returns the
      // actual provider that served the request ('anthropic' | 'openai' | ...).
      // Prefer the top-level field, fall back to usage.provider, then the
      // historical hardcoded default as a last resort.
      const resolvedProvider = (result.provider as string | undefined) ?? rawUsage?.provider ?? 'anthropic';
      const usagePayload = buildLlmUsagePayload(rawUsage, resolvedProvider);

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
            envelopeId: taskEnvelope.id,
            workflowId: context.workflow.id,
            executionId: context.id,
            nodeId: node.id,
            type: 'tool_result',
            contentType: 'application/json',
            content: JSON.stringify({
              agent_id: agentId,
              prompt: fullPrompt,
              response: result,
            }),
            orgId: context.orgId,
          });
          evidenceRefs.push(`evidence:${record.id}`);
        } catch (err) {
          // Non-fatal: evidence capture must never break the workflow run.
          console.warn('[agent-invoke] evidenceStore.store() failed (non-fatal):', err);
        }
      }

      // Emit completion envelope (SD-1 canonical: quox.flow.llm.completed)
      const resultEnvelope = factory.result(
        taskEnvelope,
        'quox.flow.llm.completed',
        {
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          nodeType: node.type,
          agent_id: agentId,
          completion: completionCapture,
          tool_calls: (result.toolsUsed ?? result.tools_used ?? []) as unknown[],
          finish_reason: result.finish_reason ?? (result.success !== false ? 'stop' : 'error'),
          // Token schema via buildLlmUsagePayload helper (SD-4)
          ...usagePayload,
          // Cancellation prep fields (SD-3 — Gap 4 wires; all null today)
          cancelled: false,
          partial_output: null,
          cancelled_at: null,
          cancelled_by: null,
          duration_ms: durationMs,
        },
        evidenceRefs.length > 0 ? evidenceRefs : undefined
      );
      emitted.push(resultEnvelope);

      // SD-warning: emit usage_unavailable sibling when tokens_unknown=true
      if (usagePayload.tokens_unknown) {
        const warningEnvelope = factory.event(
          'quox.flow.llm.usage_unavailable',
          context.correlationId,
          {
            nodeId: node.id,
            nodeName: node.name ?? node.id,
            agent_id: agentId,
            reason: 'collector_response_missing_usage_block',
          }
        );
        emitted.push(warningEnvelope);
      }

      return {
        success: result.success !== false,
        output: {
          result: result.result ?? result.response ?? result,
          agent_id: agentId,
          tokens_used: result.tokensUsed ?? result.tokens_used ?? 0,
          tools_used: result.toolsUsed ?? result.tools_used ?? [],
          duration_ms: durationMs,
          result_structured: result.result_structured,
        },
        envelopes: emitted,
        evidenceRefs,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = errorMsg.includes('abort') || errorMsg.includes('timeout');

      const errorEnvelope = factory.error(
        taskEnvelope,
        'quox.flow.llm.failed',
        {
          code: isTimeout ? 'AGENT_INVOKE_TIMEOUT' : 'AGENT_INVOKE_FAILED',
          message: errorMsg,
          details: {
            nodeId: node.id,
            nodeName: node.name ?? node.id,
            nodeType: node.type,
            agent_id: agentId,
            error_code: isTimeout ? 'AGENT_INVOKE_TIMEOUT' : 'AGENT_INVOKE_FAILED',
            error_message: errorMsg,
            cancelled: false,
            partial_output: null,
            cancelled_at: null,
            cancelled_by: null,
          },
        }
      );
      emitted.push(errorEnvelope);

      return {
        success: false,
        output: null,
        error: {
          code: isTimeout ? 'AGENT_INVOKE_TIMEOUT' : 'AGENT_INVOKE_FAILED',
          message: errorMsg,
        },
        envelopes: emitted,
      };
    }
  }

  /**
   * Gather outputs from upstream (dependency) nodes to inject into prompt.
   * Mirrors the objective executor's dependency result injection.
   */
  private gatherDependencyResults(node: Node, context: ExecutionContext): string | null {
    const incomingNodeIds: string[] = [];
    for (const edge of context.workflow.edges) {
      if (edge.target === node.id) {
        incomingNodeIds.push(edge.source);
      }
    }

    if (incomingNodeIds.length === 0) return null;

    const parts: string[] = [];
    for (const depId of incomingNodeIds) {
      const output = context.getNodeOutput(depId);
      if (output === undefined || output === null) continue;

      const depNode = context.workflow.nodes.find(n => n.id === depId);
      const label = depNode?.name ?? depId;
      const text = typeof output === 'string' ? output
        : typeof (output as Record<string, unknown>)?.result === 'string' ? (output as Record<string, unknown>).result as string
        : JSON.stringify(output, null, 2);

      parts.push(`[${label}]: ${text}`);
    }

    return parts.length > 0 ? parts.join('\n\n') : null;
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const config = node.config as unknown as AgentInvokeConfig;
    const errors: string[] = [];

    if (!config.agent_id || typeof config.agent_id !== 'string') {
      errors.push('agent_id is required and must be a string');
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

    if (config.output_schema !== undefined && typeof config.output_schema !== 'string') {
      errors.push('output_schema must be a JSON schema string');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

export const agentInvokeExecutor = new AgentInvokeExecutor();
