/**
 * Lineage Analyzer — MEM-DECAY MD.3 (lineage graph)
 *
 * One narrow LLM call: given a failed workflow run's action log, the
 * failure error, and what the run was trying to do (motivation), produce a
 * short natural-language lesson. The lesson is written onto the run's
 * execution_history row (durable-hooks.ts) and forward-fed into the same
 * workflow's future runs at agentic.executor.ts's crystal-retrieval
 * injection site.
 *
 * Deliberately self-contained — this is a single unstructured text
 * generation, not a scored rubric evaluation, so it does NOT borrow the
 * QSKL-12 persona system or the skill-judge machinery. Both the LLM client
 * interface and its collector-backed implementation live in this one file.
 */

/** Minimal LLM-client surface this module depends on — mirrors the shape of
 * SkillJudgeLlmClient (src/agentic/skill-judge-llm-client.ts) without
 * importing it, so this stays a standalone, engine-local dependency. */
export interface LineageAnalyzerLlmClient {
  complete(req: {
    system: string;
    user: string;
    max_tokens?: number;
  }): Promise<{ text: string }>;
}

export interface LineageAnalysisInput {
  actionLog: Array<{ action: string; params?: Record<string, unknown> }>;
  /** Human-readable description of the failure (e.g. joined node errors). */
  error: string;
  /** What the run was trying to achieve (the agentic node's objective/goal). */
  motivation: string;
}

const MAX_LESSON_CHARS = 500;
const MAX_ACTIONS_IN_PROMPT = 30;

const SYSTEM_PROMPT =
  'You analyse a single failed automated workflow run and write ONE short, ' +
  'concrete lesson (1-3 sentences, plain text, no markdown) that a future ' +
  'run of the SAME workflow should know before trying again. Focus on what ' +
  'to do differently next time, not a restatement of the error.';

/**
 * Runs the one LLM call and returns a lesson string, or null when the model
 * returned nothing usable. Throws only on a hard client failure — callers
 * (durable-hooks.ts) wrap this in a try/catch per the "hooks are non-fatal"
 * convention, so a thrown error never blocks execution-history recording.
 */
export async function analyzeLineage(
  input: LineageAnalysisInput,
  llmClient: LineageAnalyzerLlmClient,
): Promise<string | null> {
  const actions = input.actionLog.slice(0, MAX_ACTIONS_IN_PROMPT);
  const actionSummary = actions.length > 0
    ? actions.map((a, i) => `${i + 1}. ${a.action}`).join('\n')
    : '(no actions recorded)';

  const user =
    `MOTIVATION (what this run was trying to do):\n${input.motivation || '(unknown)'}\n\n` +
    `ACTIONS TAKEN:\n${actionSummary}\n\n` +
    `ERROR (why it failed):\n${input.error || '(unknown)'}\n\n` +
    `Write the lesson.`;

  const result = await llmClient.complete({
    system: SYSTEM_PROMPT,
    user,
    max_tokens: 200,
  });

  const lesson = result.text?.trim();
  if (!lesson) return null;

  return lesson.length > MAX_LESSON_CHARS
    ? `${lesson.slice(0, MAX_LESSON_CHARS)}...`
    : lesson;
}

export interface LineageAnalyzerCollectorClientConfig {
  /** Base URL of the collector service (e.g. http://collector:9848) */
  collectorUrl: string;
  /** Service-to-service API key */
  serviceKey: string;
}

/**
 * Production LLM client: wraps the collector's /api/internal/agents/invoke
 * endpoint, same wire contract as skill-judge-collector-client.ts's client
 * but scoped to lineage analysis (its own agent_id) — kept in this file
 * rather than sharing the skill-judge client so the two capabilities stay
 * independently evolvable.
 */
export function createLineageAnalyzerCollectorClient(
  config: LineageAnalyzerCollectorClientConfig,
): LineageAnalyzerLlmClient {
  const { collectorUrl, serviceKey } = config;

  return {
    async complete(req) {
      const response = await fetch(`${collectorUrl}/api/internal/agents/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': serviceKey,
        },
        body: JSON.stringify({
          agent_id: 'lineage-analyzer',
          task: req.user,
          context: req.system,
          no_tools: true,
          ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '<unreadable>');
        throw new Error(
          `[LineageAnalyzerCollectorClient] invoke failed: ${response.status} ${response.statusText} — ${text}`,
        );
      }

      const data = (await response.json()) as Record<string, unknown>;
      return { text: String(data.result ?? '') };
    },
  };
}
