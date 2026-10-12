/**
 * Observation Registry — Maps node types to observation producers.
 *
 * Each node type can register a function that extracts a structured
 * Observation from its ExecutorResult. This enables the agentic loop
 * to "see" what happened after each step, regardless of node type.
 *
 * Built-in producers:
 *   browser:* → screenshot + DOM summary
 *   action:call → HTTP response summary
 *   agent:invoke → agent output summary
 *   approval:gate → human decision
 *   human:task → human response
 *   action:transform → transformed data summary
 *   util:log → log output
 *   default → generic result summary
 */

import { Node } from '../core/workflow.js';
import { ExecutorResult } from '../executors/executor.interface.js';
import { Observation } from './lifecycle-hooks.js';

type ObservationProducer = (node: Node, result: ExecutorResult) => Observation | null;

/**
 * Registry of observation producers, keyed by node type prefix or exact type.
 * Prefix matching: 'browser:' matches 'browser:navigate', 'browser:screenshot', etc.
 */
export class ObservationRegistry {
  private producers: Map<string, ObservationProducer> = new Map();

  /**
   * Register a producer for a node type or prefix.
   * Use 'browser:' to match all browser node types.
   * Use 'action:call' to match exactly.
   */
  register(typeOrPrefix: string, producer: ObservationProducer): void {
    this.producers.set(typeOrPrefix, producer);
  }

  /**
   * Produce an observation for a node's execution result.
   * Tries exact match first, then prefix match, then default.
   */
  produce(node: Node, result: ExecutorResult): Observation | null {
    // Exact match
    const exact = this.producers.get(node.type);
    if (exact) return exact(node, result);

    // Prefix match (e.g., 'browser:' for 'browser:navigate')
    const prefix = node.type.split(':')[0] + ':';
    const prefixProducer = this.producers.get(prefix);
    if (prefixProducer) return prefixProducer(node, result);

    // Default
    const defaultProducer = this.producers.get('default');
    if (defaultProducer) return defaultProducer(node, result);

    return null;
  }
}

// ─── Built-in Observation Producers ─────────────────────────────────

/** Browser nodes: extract URL, title, screenshot ref, login detection */
export const browserObservationProducer: ObservationProducer = (node, result) => {
  const rawOutput = result.output as Record<string, unknown> | null;
  if (!rawOutput) return null;

  // Screencap /execute wraps data in { success, result: {...}, metadata }
  // Unwrap to get the actual page data
  const output = (rawOutput.result && typeof rawOutput.result === 'object')
    ? rawOutput.result as Record<string, unknown>
    : rawOutput;

  const url = (output.url as string) || '';
  const title = (output.title as string) || '';
  const loginDetected = output.login_detected === true;
  const redirected = output.redirected === true;
  const warnings = output.warnings as string[] | undefined;
  const screenshotId = output.screenshot_id as string | undefined;
  const formAnalysis = output.forms as unknown;
  // Extract text content (from browser_extract results)
  const extractedData = output.data as string | undefined;
  const extractedText = typeof extractedData === 'string' ? extractedData.substring(0, 500) : '';

  // Build rich summary — include URL so the agent knows WHERE it is
  let summary = `Page: ${title || 'unknown'}`;
  if (url) summary += ` (${url})`;
  if (loginDetected) summary += ' [LOGIN PAGE — need to authenticate]';
  if (redirected) summary += ` [REDIRECTED from ${output.requested_url || 'original URL'}]`;
  if (warnings?.length) summary += ` — ${warnings[0]}`;
  if (formAnalysis) summary += ' [forms detected on page]';
  if (extractedText) summary += ` | Content: ${extractedText.substring(0, 200)}`;

  // BQ Phase 2: Capture vision-ready screenshot from screencap response
  const imageBase64 = (output.screenshot_base64 as string) || undefined;
  const imageMediaType = (output.screenshot_media_type as string) || (imageBase64 ? 'image/jpeg' : undefined);

  // BQ-SMART Phase 2: Include a11y tree in summary for richer LLM context
  const a11yTree = (output.a11y_tree as string) || '';
  if (a11yTree) {
    summary += `\n\nPage structure:\n${a11yTree.substring(0, 1500)}`;
  }

  return {
    type: 'screenshot',
    summary,
    contentHash: screenshotId || undefined,
    imageBase64,
    imageMediaType,
    metadata: {
      url,
      title,
      loginDetected,
      redirected,
      requestedUrl: output.requested_url,
      warnings,
      formCount: (output as any).formCount,
      hasCookieBanner: (output as any).hasCookieBanner,
    },
  };
};

/** HTTP call nodes: extract status, headers, body summary */
export const httpCallObservationProducer: ObservationProducer = (node, result) => {
  const output = result.output as Record<string, unknown> | null;
  if (!output) return null;

  const status = output.status as number || 0;
  const statusText = output.statusText as string || '';
  const bodySize = output.bodySize as number || 0;
  const url = (node as any).config?.url || '';

  return {
    type: 'api_response',
    summary: `HTTP ${status} ${statusText} from ${url} (${bodySize} bytes)`,
    contentSizeBytes: bodySize,
    metadata: {
      status,
      statusText,
      url,
      bodySize,
      headers: output.headers,
    },
  };
};

/** Agent invoke nodes: extract agent response summary */
export const agentInvokeObservationProducer: ObservationProducer = (node, result) => {
  const output = result.output as Record<string, unknown> | null;
  if (!output) return null;

  const agentResult = (output.result as string) || '';
  const agentId = (output.agent as string) || (node as any).config?.agent_id || '';
  const toolsUsed = output.tools_used as string[] || [];

  return {
    type: 'tool_output',
    summary: `Agent ${agentId}: ${agentResult.substring(0, 200)}${agentResult.length > 200 ? '...' : ''}`,
    metadata: {
      agentId,
      toolsUsed,
      success: output.success,
      resultLength: agentResult.length,
    },
  };
};

/** Approval gate: extract human decision */
export const approvalObservationProducer: ObservationProducer = (node, result) => {
  const output = result.output as Record<string, unknown> | null;

  return {
    type: 'human_response',
    summary: result.paused
      ? 'Waiting for human approval'
      : `Approved: ${output?.approved ? 'yes' : 'no'}`,
    metadata: {
      paused: result.paused,
      approved: output?.approved,
      approver: output?.approver,
      comment: output?.comment,
    },
  };
};

/** Human task: extract response data */
export const humanTaskObservationProducer: ObservationProducer = (node, result) => {
  const output = result.output as Record<string, unknown> | null;

  return {
    type: 'human_response',
    summary: result.paused
      ? `Waiting for human input: ${result.pauseReason || (node as any).config?.title || 'response needed'}`
      : `Human responded: ${JSON.stringify(output).substring(0, 150)}`,
    metadata: {
      paused: result.paused,
      taskTitle: (node as any).config?.title,
      responseData: output,
    },
  };
};

/** Default: generic result summary */
export const defaultObservationProducer: ObservationProducer = (node, result) => {
  const outputStr = result.output != null
    ? JSON.stringify(result.output).substring(0, 200)
    : 'null';

  return {
    type: 'generic',
    summary: `${node.type}: ${result.success ? 'completed' : 'failed'}${result.error ? ` — ${result.error.message}` : ''} → ${outputStr}`,
    metadata: {
      nodeType: node.type,
      success: result.success,
      error: result.error,
    },
  };
};

/**
 * Create a fully-configured observation registry with all built-in producers.
 */
export function createDefaultObservationRegistry(): ObservationRegistry {
  const registry = new ObservationRegistry();

  registry.register('browser:', browserObservationProducer);
  registry.register('action:call', httpCallObservationProducer);
  registry.register('agent:invoke', agentInvokeObservationProducer);
  registry.register('approval:gate', approvalObservationProducer);
  registry.register('human:task', humanTaskObservationProducer);
  registry.register('default', defaultObservationProducer);

  return registry;
}
