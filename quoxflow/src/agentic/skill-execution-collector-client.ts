/**
 * QSKL-5.F — Real skill-execution context, wrapping the collector's
 * /api/internal/agents/invoke endpoint (the same live path used elsewhere in
 * quoxflow to run an LLM turn against the collector — see
 * skill-judge-collector-client.ts for the analogous judge-only wiring).
 *
 * Unlike the judge client (which always sets no_tools:true for deterministic
 * scoring), skill execution runs WITH tools available so that a skill's
 * `skill_should_emit` test assertions can be checked against the tools the
 * agent actually invoked while following the skill's body_md instructions.
 * The collector reports those as `tools_used` on the invoke response; we map
 * that straight onto SkillTestExecuteContext's `emitted` field.
 */

import type { QuoxSkillRecord } from '../store/quox-skills-store.js';
import type { SkillTestExecuteContext } from './skill-test-runner.js';

export interface CollectorSkillExecuteContextConfig {
  /** Base URL of the collector service (e.g. http://collector:9848) */
  collectorUrl: string;
  /** Service-to-service API key */
  serviceKey: string;
}

/**
 * Factory that returns a SkillTestExecuteContext backed by the collector's
 * /api/internal/agents/invoke endpoint.
 *
 * POST body shape:
 *   { agent_id: 'skill-test-runner', task: JSON.stringify(input),
 *     context: skill.bodyMd, org_id: skill.orgId }
 *
 * Expected response shape:
 *   { success: boolean, result: string, tools_used?: string[], error?: string }
 *
 * Throws if the HTTP response is not ok, or if the collector reports failure
 * (success: false) — runSkillTests already treats a thrown executeSkill call
 * as a failing test result, so this surfaces honestly rather than silently
 * returning empty output.
 */
export function createCollectorSkillExecuteContext(
  config: CollectorSkillExecuteContextConfig,
): SkillTestExecuteContext {
  const { collectorUrl, serviceKey } = config;

  return {
    async executeSkill(skill: QuoxSkillRecord, input: Record<string, unknown>) {
      const body = {
        agent_id: 'skill-test-runner',
        task: JSON.stringify(input ?? {}),
        context: skill.bodyMd,
        org_id: skill.orgId,
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
          `[CollectorSkillExecuteContext] invoke failed: ${response.status} ${response.statusText} — ${text}`,
        );
      }

      const data = (await response.json()) as Record<string, unknown>;

      if (data.success === false) {
        throw new Error(
          `[CollectorSkillExecuteContext] skill ${skill.id} execution failed: ${String(data.error ?? 'unknown error')}`,
        );
      }

      return {
        output: String(data.result ?? ''),
        emitted: Array.isArray(data.tools_used) ? (data.tools_used as string[]) : [],
      };
    },
  };
}
