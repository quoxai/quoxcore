/**
 * Validation Suite — Shared Helpers
 *
 * mockThinker: replaces the AgenticExecutor's LLM fetch with a deterministic
 * fixture sequence. Token spend = 0 in this mode.
 *
 * Each TB declares its expected ThinkDecision[] fixture. The helper intercepts
 * `fetch` calls to /api/internal/agents/invoke and returns the next fixture
 * in sequence. When the fixture sequence is exhausted it returns done=true
 * so the loop terminates cleanly.
 */

export interface ThinkDecision {
  reasoning: string;
  action: string;
  params: Record<string, unknown>;
  objective_met: boolean;
  confidence?: number;
}

/**
 * Returns a mock fetch implementation that serves ThinkDecision fixtures
 * to the AgenticExecutor's think() call in sequence.
 *
 * Non-think URLs (e.g. budget usage, screencap) are silently swallowed
 * and return a generic success so the executor keeps running.
 */
export function mockThinker(fixtures: ThinkDecision[]): typeof fetch {
  let callIndex = 0;

  return async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    // Think calls: /api/internal/agents/invoke or /api/internal/agents/vision-invoke
    if (url.includes('/api/internal/agents/')) {
      const decision: ThinkDecision = callIndex < fixtures.length
        ? fixtures[callIndex++]
        : { reasoning: 'All fixtures consumed — declaring done.', action: 'done', params: {}, objective_met: true, confidence: 1.0 };

      return new Response(
        JSON.stringify({ success: true, result: JSON.stringify(decision) }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    // Budget usage ingestion POST — swallow silently
    if (url.includes('/api/v1/budget/usage')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Wisdom query / progress callbacks — swallow silently
    if (url.includes('/api/wisdom') || url.includes('/api/internal/progress')) {
      return new Response(JSON.stringify({ ok: true, wisdom: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Any other fetch (e.g. screencap) — return error so isBrowserAgent path stays off
    return new Response(JSON.stringify({ success: false, error: 'Not mocked in validation suite' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  };
}

/**
 * Collect all unique envelope intents from a list of envelopes.
 */
export function collectIntents(envelopes: Array<{ intent: string }>): string[] {
  return [...new Set(envelopes.map(e => e.intent))].sort();
}

/**
 * Build a simple assertion result.
 */
export function assert(label: string, condition: boolean, expected?: unknown, actual?: unknown) {
  return { label, passed: condition, expected, actual };
}

/**
 * Summarise assertions and determine overall pass/fail.
 */
export function summarise(assertions: ReturnType<typeof assert>[]): {
  passed: boolean;
  failureReason?: string;
} {
  const failed = assertions.filter(a => !a.passed);
  if (failed.length === 0) return { passed: true };
  return {
    passed: false,
    failureReason: failed.map(a => a.label).join('; '),
  };
}
