/**
 * QSKL-11b: Concrete LLM client for the skill judge, wrapping the collector's
 * /api/internal/agents/invoke endpoint. Wired in server.ts (Slice 4).
 */

import type { SkillJudgeLlmClient } from './skill-judge-llm-client.js';

export interface CollectorLlmClientConfig {
  /** Base URL of the collector service (e.g. http://localhost:3001) */
  collectorUrl: string;
  /** Service-to-service API key */
  serviceKey: string;
}

/**
 * Factory that returns a SkillJudgeLlmClient backed by the collector's
 * /api/internal/agents/invoke endpoint.
 *
 * POST body shape:
 *   { agent_id: 'skill-judge', task: req.user, context: req.system,
 *     no_tools: true, model: req.model, max_tokens: req.max_tokens }
 *
 * Expected response shape:
 *   { result: string, usage: { input_tokens, output_tokens, model } }
 *
 * Throws if the HTTP response is not ok, or if usage is missing from the response.
 */
export function createCollectorLlmClient(config: CollectorLlmClientConfig): SkillJudgeLlmClient {
  const { collectorUrl, serviceKey } = config;

  return {
    async complete(req) {
      const body = {
        agent_id: 'skill-judge',
        task: req.user,
        context: req.system,
        no_tools: true,
        model: req.model,
        ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
      };

      const response = await fetch(`${collectorUrl}/api/internal/agents/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': serviceKey,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '<unreadable>');
        throw new Error(
          `[SkillJudgeCollectorClient] invoke failed: ${response.status} ${response.statusText} — ${text}`
        );
      }

      const data = (await response.json()) as Record<string, unknown>;

      if (!data.usage || typeof data.usage !== 'object') {
        throw new Error(
          '[SkillJudgeCollectorClient] invoke response missing "usage" field'
        );
      }

      const usage = data.usage as Record<string, unknown>;
      if (
        typeof usage.input_tokens !== 'number' ||
        typeof usage.output_tokens !== 'number' ||
        typeof usage.model !== 'string'
      ) {
        throw new Error(
          '[SkillJudgeCollectorClient] invoke response "usage" is malformed — ' +
          `expected {input_tokens, output_tokens, model}, got: ${JSON.stringify(usage)}`
        );
      }

      return {
        text: String(data.result ?? ''),
        usage: {
          input_tokens: usage.input_tokens as number,
          output_tokens: usage.output_tokens as number,
          model: usage.model as string,
        },
      };
    },

    // fleet #372 — same endpoint `quox llm status` uses (GET /chat/status,
    // unauthenticated, no service key needed). Cheap: no LLM call, just
    // reads whether any provider key/OAuth token is configured.
    async isReady(): Promise<boolean> {
      try {
        const response = await fetch(`${collectorUrl}/chat/status`);
        if (!response.ok) return false;
        const data = (await response.json()) as Record<string, unknown>;
        return data.ready === true;
      } catch {
        return false;
      }
    },
  };
}
