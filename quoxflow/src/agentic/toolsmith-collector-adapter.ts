/**
 * QSKL-6 — Real ToolsmithAdapter, backed by the collector's live Toolsmith
 * pipeline (/api/internal/toolsmith/validate, /analyse, /sandbox/run — see
 * quox-dashboard/services/collector/server.js).
 *
 * buildToolFromSkill (skill → tool):
 *   Real. A skill that wants a tool built carries the tool's authored source
 *   in its `scripts` map under the collector's canonical Toolsmith filenames
 *   (tool.json, script.py, tests.json — see toolsmithValidator.js). This
 *   adapter runs that source through the SAME validate → analyse → sandbox/run
 *   pipeline ScriptForgeView.jsx drives interactively, and reports ok:true
 *   only once all three stages pass.
 *
 *   The collector has no LLM code-generation endpoint (nothing turns a
 *   skill's body_md into Python from scratch) — when a skill has no
 *   authored source yet, this honestly reports NOT_SHIPPED rather than
 *   pretending to build something. When source IS present, this is a real
 *   build, not a stub.
 *
 * draftSkillFromTool (tool → skill):
 *   Genuinely not available. The collector's tool_definitions store is
 *   write-only from quoxflow's vantage point (see
 *   POST /api/internal/tool-definitions/install, called BY the auth
 *   service — there is no GET-by-name endpoint returning a tool's
 *   description/schema/docs). Without a documentation source, there is
 *   nothing to draft a skill body_md from. This returns the pre-existing
 *   `NO_DOCS` reason (already part of ToolsmithDraftErr's contract) instead
 *   of a blanket NOT_SHIPPED — the gap is "no docs available", not "nothing
 *   is wired".
 */

import type { QuoxSkillsStore } from '../store/quox-skills-store.js';
import type {
  ToolsmithAdapter,
  ToolsmithBuildResult,
  ToolsmithDraftResult,
  BuildToolHint,
} from './toolsmith-adapter.js';

export interface CollectorToolsmithAdapterConfig {
  /** Base URL of the collector service (e.g. http://collector:9848) */
  collectorUrl: string;
  /** Service-to-service API key */
  serviceKey: string;
  /** Used to look up the skill's authored tool source (scripts map) by ID. */
  skillsStore: QuoxSkillsStore;
}

interface ToolsmithValidateResponse {
  valid: boolean;
  errors: Array<{ file: string; severity: string; code: string; message: string }>;
  warnings: Array<{ file: string; severity: string; code: string; message: string }>;
}

interface ToolsmithAnalyseResponse {
  flags: Array<{ pattern: string; line: number; severity: string; suggestion: string }>;
  suggestedPermissions: {
    network: boolean;
    filesystem: boolean;
    secrets: string[];
    subprocess: boolean;
    approval_required: boolean;
  };
}

interface ToolsmithSandboxRunResponse {
  exitCode?: number;
  stderr?: string;
  error?: string;
}

const REQUIRED_SOURCE_FILES = ['tool.json', 'script.py'] as const;

export function createCollectorToolsmithAdapter(
  config: CollectorToolsmithAdapterConfig,
): ToolsmithAdapter {
  const { collectorUrl, serviceKey, skillsStore } = config;

  async function postJson<T>(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const response = await fetch(`${collectorUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': serviceKey,
        ...(extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      throw new Error(
        `[CollectorToolsmithAdapter] ${path} failed: ${response.status} ${response.statusText} — ${text}`,
      );
    }

    return (await response.json()) as T;
  }

  return {
    async buildToolFromSkill(skillId: string, hint: BuildToolHint): Promise<ToolsmithBuildResult> {
      const skill = await skillsStore.findByIdUnchecked(skillId);
      if (!skill) {
        return { ok: false, reason: 'BUILD_FAILED', detail: `skill ${skillId} not found` };
      }

      const files = (skill.scripts as Record<string, string> | undefined) ?? {};
      const missingSource = REQUIRED_SOURCE_FILES.filter(name => !files[name]);
      if (missingSource.length > 0) {
        return {
          ok: false,
          reason: 'NOT_SHIPPED',
          detail:
            `Collector Toolsmith has no code-generation endpoint — buildToolFromSkill requires ` +
            `the skill to already carry authored source in scripts[${missingSource.map(n => `"${n}"`).join(', ')}]. ` +
            `Skill ${skillId} is missing: ${missingSource.join(', ')}.`,
        };
      }

      // 1. Structural validation (tool.json / script.py / tests.json shape).
      let validateRes: ToolsmithValidateResponse;
      try {
        validateRes = await postJson<ToolsmithValidateResponse>(
          '/api/internal/toolsmith/validate',
          { files },
        );
      } catch (err) {
        return { ok: false, reason: 'BUILD_FAILED', detail: err instanceof Error ? err.message : String(err) };
      }
      if (!validateRes.valid) {
        return {
          ok: false,
          reason: 'BUILD_FAILED',
          detail: `validation failed: ${validateRes.errors.map(e => `${e.file}: ${e.message}`).join('; ')}`,
        };
      }

      // 2. Static analysis for blocked patterns + suggested sandbox permissions.
      let analyseRes: ToolsmithAnalyseResponse;
      try {
        analyseRes = await postJson<ToolsmithAnalyseResponse>(
          '/api/internal/toolsmith/analyse',
          { scriptPy: files['script.py'] },
        );
      } catch (err) {
        return { ok: false, reason: 'BUILD_FAILED', detail: err instanceof Error ? err.message : String(err) };
      }
      const blockingFlags = (analyseRes.flags ?? []).filter(f => f.severity === 'block');
      if (blockingFlags.length > 0) {
        return {
          ok: false,
          reason: 'POLICY_VIOLATION',
          detail: blockingFlags.map(f => f.suggestion || f.pattern).join('; '),
        };
      }

      // 3. Sandbox execution — proves the script actually runs before we call it built.
      let sandboxRes: ToolsmithSandboxRunResponse;
      try {
        sandboxRes = await postJson<ToolsmithSandboxRunResponse>(
          '/api/internal/toolsmith/sandbox/run',
          {
            scriptContent: files['script.py'],
            inputsJson: {},
            permissions: analyseRes.suggestedPermissions,
          },
          { 'X-Quox-Org-Id': skill.orgId },
        );
      } catch (err) {
        return { ok: false, reason: 'BUILD_FAILED', detail: err instanceof Error ? err.message : String(err) };
      }
      if (sandboxRes.error || sandboxRes.exitCode !== 0) {
        return {
          ok: false,
          reason: 'BUILD_FAILED',
          detail: sandboxRes.error ?? `sandbox exited with code ${sandboxRes.exitCode} — stderr: ${sandboxRes.stderr ?? ''}`,
        };
      }

      return { ok: true, toolName: hint.name, version: hint.version ?? '1.0.0' };
    },

    async draftSkillFromTool(_toolName: string, _version: string): Promise<ToolsmithDraftResult> {
      return {
        ok: false,
        reason: 'NO_DOCS',
        detail:
          'The collector has no endpoint to fetch a published tool\'s description/schema by ' +
          'name+version (tool_definitions is write-only from quoxflow\'s side — see ' +
          'POST /api/internal/tool-definitions/install). draftSkillFromTool cannot draft a ' +
          'skill body_md without a documentation source; this is a real gap, not a stub.',
      };
    },
  };
}
