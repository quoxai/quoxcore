/**
 * QSKL-11b: Minimal LLM-client surface the judge job depends on.
 * Concrete implementation in src/agentic/skill-judge-collector-client.ts
 * wraps the collector's /api/internal/agents/invoke endpoint.
 */
export interface SkillJudgeLlmClient {
  complete(req: {
    model: string;
    system: string;
    user: string;
    max_tokens?: number;
  }): Promise<{
    text: string;
    usage: { input_tokens: number; output_tokens: number; model: string };
  }>;
  /**
   * fleet #372 — cheap pre-flight check (GET /chat/status, same endpoint
   * `quox llm status` uses) so the job can skip cleanly instead of running
   * every stable skill through complete() only to have each one throw
   * "invoke response missing usage field" and log a skill_judge_error. Any
   * fresh org with no LLM provider configured hit this on the first Monday
   * cron: 29/29 crystals, 0 real judge failures, 29 identical error entries.
   */
  isReady(): Promise<boolean>;
}
