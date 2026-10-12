/**
 * Browser Executor
 *
 * Handles browser automation nodes by calling the screencap service.
 * Supports single actions (screenshot, extract, fill_form) and full
 * multi-step objectives.
 *
 * Node types:
 *   browser:navigate    — Navigate to a URL and return page info
 *   browser:screenshot  — Take a screenshot of the current page
 *   browser:extract     — Extract structured data from a page
 *   browser:fill_form   — Fill a web form with field values
 *   browser:objective   — Execute a full multi-step browser objective
 */

import { ulid } from 'ulid';
import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';
import { processValue } from '../expression/engine.js';
import { captureToolArgs, captureToolResult } from './lib/tool-envelope.js';
import { combineAbortSignals } from './lib/abort-utils.js';
import type { EvidenceStore } from '../evidence/types.js';
// SSRF protection: reuse the same guard the `call` executor uses (blocks
// loopback, link-local/metadata, and RFC1918 unless allowlisted via
// QUOXFLOW_ALLOWED_PRIVATE). Without this, a workflow author (or anything
// that can write node config) could point browser:navigate/browser:objective
// at the screencap service's internal network and use it as an SSRF proxy —
// the `call` executor already blocks this path, but browser nodes forwarded
// resolvedConfig.url straight through with no check.
import { validateUrl } from './call.executor.js';

const SCREENCAP_URL = process.env.SCREENCAP_URL || 'http://screencap:3300';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
const DEFAULT_TIMEOUT_MS = 120000;
const OBJECTIVE_POLL_INTERVAL_MS = 3000;
const OBJECTIVE_MAX_WAIT_MS = 300000;

interface BrowserConfig {
  url?: string;
  action?: string;
  selector?: string;
  format?: string;
  fields?: Record<string, string>;
  full_page?: boolean;
  intent?: string;
  credential_id?: string;
  needs_login?: boolean;
  steps?: Array<{ action: string; description: string; params: Record<string, unknown>; needs_hitl?: boolean }>;
  session_id?: string;
  org_id?: string;
  timeout_ms?: number;
}

async function screencapFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-service-key': INTERNAL_SERVICE_KEY,
    ...(opts.headers as Record<string, string> || {}),
  };
  return fetch(`${SCREENCAP_URL}${path}`, {
    ...opts,
    headers,
    signal: combineAbortSignals(opts.signal as AbortSignal | undefined, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)),
  });
}

interface BrowserExecutorOptions {
  evidenceStore?: EvidenceStore;
  inlineMaxBytes?: number;
  binaryMaxBytes?: number;
}

export class BrowserExecutor implements NodeExecutor {
  readonly nodeTypes = [
    'browser:navigate',
    'browser:screenshot',
    'browser:extract',
    'browser:fill_form',
    'browser:objective',
  ];
  readonly hasExternalEffect = true;
  private evidenceStore?: EvidenceStore;
  private inlineMaxBytes?: number;
  private binaryMaxBytes?: number;

  constructor(options?: BrowserExecutorOptions) {
    this.evidenceStore = options?.evidenceStore;
    this.inlineMaxBytes = options?.inlineMaxBytes;
    this.binaryMaxBytes = options?.binaryMaxBytes;
  }

  /** AEE-FULL-P2: post-construction wiring for the singleton export (server.ts). */
  setEvidenceStore(store: EvidenceStore): void {
    this.evidenceStore = store;
  }

  async execute(node: Node, input: unknown, context: ExecutionContext): Promise<ExecutorResult> {
    const config = (node as any).config as BrowserConfig || {};
    const exprContext = context.createExpressionContext(node.id, input);
    const envelopes: Envelope[] = [];
    const factory = context.envelopes;

    // Resolve expressions in config
    const resolvedConfig: BrowserConfig = {};
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'string') {
        resolvedConfig[key as keyof BrowserConfig] = processValue(value, exprContext) as any;
      } else {
        resolvedConfig[key as keyof BrowserConfig] = value as any;
      }
    }

    // QF-MT #111: the browser-service calls below (:170-305) send this as the
    // tenant org_id. Prefer an explicit node config org, then the run's real
    // authenticated org (context.orgId), and only fall back to 'default' when
    // neither exists — otherwise every un-configured browser node reported as
    // 'default' even though the real tenant was known. (WP5 already did this for
    // the capture context at :127; this closes the same gap for the service calls.)
    const orgId = resolvedConfig.org_id || context.orgId || 'default';
    const sessionId = resolvedConfig.session_id || `wf_${context.correlationId}_${node.id}`;
    const toolName = node.type; // e.g. 'browser:navigate', 'browser:screenshot'
    const startedAt = new Date().toISOString();

    // Build capture context for tool.* envelopes
    const captureCtx = {
      evidenceStore: this.evidenceStore,
      correlationId: context.correlationId,
      envelopeId: ulid(),
      workflowId: context.workflow.id,
      executionId: context.id,
      nodeId: node.id,
      orgId: context.orgId, // QF-MT WP5: the run's org (not `orgId` above, which is the browser session's config org_id)
      caps: { inlineMaxBytes: this.inlineMaxBytes, binaryMaxBytes: this.binaryMaxBytes },
    };

    // Capture args and emit tool.invoked
    const invokedEnvelopeId = ulid();
    const argsCaptured = await captureToolArgs(
      { nodeType: node.type, config: resolvedConfig },
      { ...captureCtx, envelopeId: invokedEnvelopeId }
    );
    const invokedEnv = factory.event(
      'quox.flow.tool.invoked',
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        nodeType: node.type,
        tool: toolName,
        args: argsCaptured.value,
        args_truncated: argsCaptured.truncated,
        args_size_bytes: argsCaptured.size_bytes,
        ...(argsCaptured.full_sha256 !== undefined ? { args_full_sha256: argsCaptured.full_sha256 } : {}),
        startedAt,
      }
    );
    envelopes.push(invokedEnv);

    // Emit start envelope (NODE.STARTED)
    const taskEnv = factory.task(
      'browser', Intents.NODE.STARTED, context.correlationId,
      { nodeId: node.id, nodeType: node.type, config: resolvedConfig },
    );
    envelopes.push(taskEnv);

    try {
      let result: unknown;

      switch (node.type as string) {
        case 'browser:navigate':
          if (resolvedConfig.url) await validateUrl(resolvedConfig.url);
          result = await this.executeAction('browser_navigate', {
            url: resolvedConfig.url,
            session_id: sessionId,
            org_id: orgId,
          }, context.cancellationSignal);
          break;

        case 'browser:screenshot':
          result = await this.executeAction('browser_screenshot', {
            full_page: resolvedConfig.full_page ?? true,
            session_id: sessionId,
            org_id: orgId,
          }, context.cancellationSignal);
          break;

        case 'browser:extract':
          result = await this.executeAction('browser_extract', {
            format: resolvedConfig.format || 'text',
            selector: resolvedConfig.selector,
            session_id: sessionId,
            org_id: orgId,
          }, context.cancellationSignal);
          break;

        case 'browser:fill_form':
          result = await this.executeAction('browser_fill_form', {
            fields: resolvedConfig.fields || {},
            submit: false,
            session_id: sessionId,
            org_id: orgId,
          }, context.cancellationSignal);
          break;

        case 'browser:objective':
          if (resolvedConfig.url) await validateUrl(resolvedConfig.url);
          result = await this.executeObjective(resolvedConfig, orgId, sessionId, context.cancellationSignal);
          break;

        default:
          throw new Error(`Unknown browser node type: ${node.type}`);
      }

      const durationMs = Date.now() - new Date(startedAt).getTime();

      // Capture result and emit tool.completed
      const completedEnvelopeId = ulid();
      const resultCaptured = await captureToolResult(result, { ...captureCtx, envelopeId: completedEnvelopeId });
      const toolCompletedEnv = factory.event(
        'quox.flow.tool.completed',
        context.correlationId,
        {
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          nodeType: node.type,
          tool: toolName,
          toolSuccess: true,
          cost_usd_micro: 0,
          result: resultCaptured.value,
          result_truncated: resultCaptured.truncated,
          result_size_bytes: resultCaptured.size_bytes,
          result_type: resultCaptured.type,
          ...(resultCaptured.full_sha256 !== undefined ? { result_full_sha256: resultCaptured.full_sha256 } : {}),
          ...(resultCaptured.too_large ? { result_too_large: true } : {}),
          duration_ms: durationMs,
        }
      );
      envelopes.push(toolCompletedEnv);

      // Emit NODE.COMPLETED
      const resultEnv = factory.result(
        taskEnv, Intents.NODE.COMPLETED,
        { nodeId: node.id, output: result },
      );
      envelopes.push(resultEnv);

      return { success: true, output: result, envelopes };
    } catch (err: any) {
      // Emit tool.failed
      const toolFailedEnv = factory.event(
        'quox.flow.tool.failed',
        context.correlationId,
        {
          nodeId: node.id,
          nodeName: node.name ?? node.id,
          nodeType: node.type,
          tool: toolName,
          error_code: 'BROWSER_ERROR',
          error_message: err.message,
        }
      );
      envelopes.push(toolFailedEnv);

      const errorEnv = factory.error(taskEnv, Intents.NODE.FAILED, {
        code: 'BROWSER_ERROR',
        message: err.message,
        details: { nodeType: node.type },
      });
      envelopes.push(errorEnv);

      return {
        success: false,
        output: null,
        error: { code: 'BROWSER_ERROR', message: err.message },
        envelopes,
      };
    }
  }

  /**
   * Execute a single browser action via the screencap tool API.
   */
  private async executeAction(toolId: string, input: Record<string, unknown>, cancellationSignal?: AbortSignal): Promise<unknown> {
    const res = await screencapFetch('/execute', {
      method: 'POST',
      body: JSON.stringify({ tool_id: toolId, input }),
      signal: cancellationSignal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Screencap ${toolId} failed (${res.status}): ${text.substring(0, 200)}`);
    }
    return res.json();
  }

  /**
   * Execute a full browser objective (create → plan → execute → poll).
   */
  private async executeObjective(config: BrowserConfig, orgId: string, sessionId: string, cancellationSignal?: AbortSignal): Promise<unknown> {
    const orgParam = `org_id=${encodeURIComponent(orgId)}`;

    // Step 1: Create
    const createRes = await screencapFetch(`/api/browser-objectives?${orgParam}`, {
      method: 'POST',
      body: JSON.stringify({
        url: config.url,
        intent: config.intent || `Browser automation: ${config.url}`,
        credential_id: config.credential_id || null,
        needs_login: config.needs_login || false,
        org_id: orgId,
      }),
      signal: cancellationSignal,
    });
    if (!createRes.ok) throw new Error(`Create objective failed: ${createRes.status}`);
    const { objective } = await createRes.json() as any;

    // Step 2: Plan
    const planBody = config.steps?.length ? { steps: config.steps } : {};
    const planRes = await screencapFetch(`/api/browser-objectives/${objective.id}/plan?${orgParam}`, {
      method: 'POST',
      body: JSON.stringify(planBody),
      signal: cancellationSignal,
    });
    if (!planRes.ok) throw new Error(`Plan objective failed: ${planRes.status}`);

    // Step 3: Execute
    const execRes = await screencapFetch(`/api/browser-objectives/${objective.id}/execute?${orgParam}`, {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId }),
      signal: cancellationSignal,
    });
    if (!execRes.ok) throw new Error(`Execute objective failed: ${execRes.status}`);

    // Step 4: Poll for completion
    const deadline = Date.now() + (config.timeout_ms || OBJECTIVE_MAX_WAIT_MS);
    let status = 'running';
    let finalObjective: any = null;

    while (Date.now() < deadline && (status === 'running' || status === 'planned')) {
      await new Promise(r => setTimeout(r, OBJECTIVE_POLL_INTERVAL_MS));

      const checkRes = await screencapFetch(`/api/browser-objectives/${objective.id}?${orgParam}`, { signal: cancellationSignal });
      if (checkRes.ok) {
        const data = await checkRes.json() as any;
        finalObjective = data.objective || data;
        status = finalObjective.status || 'unknown';
        if (status === 'paused') break; // HITL gate
      }
    }

    return {
      objective_id: objective.id,
      status,
      completed: status === 'completed',
      paused: status === 'paused',
      steps_completed: finalObjective?.steps?.filter((s: any) => s.status === 'completed').length || 0,
      total_steps: finalObjective?.steps?.length || 0,
      results: finalObjective?.results || null,
    };
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const config = (node as any).config as BrowserConfig || {};
    const errors: string[] = [];

    const nodeType = node.type as string;
    if (nodeType === 'browser:navigate' && !config.url) {
      errors.push('browser:navigate requires a url');
    }
    if (nodeType === 'browser:objective' && !config.url && !config.intent) {
      errors.push('browser:objective requires url or intent');
    }
    if (nodeType === 'browser:fill_form' && (!config.fields || Object.keys(config.fields).length === 0)) {
      errors.push('browser:fill_form requires fields');
    }

    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }
}

export const browserExecutor = new BrowserExecutor();
