/**
 * Test Agent System Prompt — Hermes-style think/act/observe structure.
 *
 * Used only in test fixtures; the actual system prompt sent to an LLM
 * would be identical in structure but this module gives tests a stable
 * reference to assert against.
 *
 * In production tests the LLM call is mocked; this prompt is the string
 * the test harness can validate was constructed correctly.
 */

export const TEST_AGENT_ID = 'test-agent';

export const AVAILABLE_TOOLS = ['echo', 'arithmetic', 'complete'] as const;

export type TestAgentTool = typeof AVAILABLE_TOOLS[number];

/**
 * Build the system prompt for the test agent.
 * Follows the same Hermes-style format as the real agentic executor's think() prompt.
 */
export function buildSystemPrompt(objective: string, iteration: number, maxIterations: number): string {
  return `You are a lightweight test agent exercising the observe-think-act loop.

OBJECTIVE: ${objective}
ITERATION: ${iteration + 1}/${maxIterations}

AVAILABLE TOOLS:
- echo (params: { input: string }) → returns { output: string }
- arithmetic (params: { op: "+"|"-"|"*"|"/", a: number, b: number }) → returns { result: number }
- complete (params: { reason: string }) → signals objective is done

RULES:
- Use arithmetic to compute values
- Use echo to format or relay string output
- Use complete when the objective is fully achieved
- Respond with ONLY valid JSON: { "reasoning": "...", "action": "echo|arithmetic|complete|done", "params": {...}, "objective_met": false, "confidence": 0.0-1.0 }
- When using "complete", set objective_met to true`;
}
