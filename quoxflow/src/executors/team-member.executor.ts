/**
 * Team Member Executor
 *
 * Handles team:member nodes that route a task to a SPECIFIC ROLE within a team.
 * The team manifest is fetched from the tasks service at runtime to resolve
 * role → agent_id, so the workflow author never needs to know which agent
 * fills a role.
 *
 * Node type: team:member
 * Config:
 *   - role: string — Required. e.g. 'orchestrator', 'validator', 'planner'.
 *   - prompt: string — Required. Task instruction. Supports ${...} expressions.
 *   - team_id?: string — Optional. Falls back to context.workflow.team_id or
 *                        context.getVariables()?.team_id. Error if none resolve.
 *   - timeout_ms?: number — Default 60_000.
 *   - max_tokens?: number — Token budget hint.
 *   - context?: object — Extra metadata passed through.
 *   - evidence?: boolean — Default true.
 *
 * Team manifest shape (GET /api/teams/:teamId response):
 *   {
 *     id: string,
 *     manifest: {
 *       orchestrator: { agentId: string, role: 'orchestrator' },
 *       members: [{ agentId: string, role: string, domains: string[] }]
 *     }
 *   }
 * Role lookup checks manifest.orchestrator first (role === 'orchestrator'),
 * then manifest.members[*].role. Both use the agentId field.
 *
 * Security:
 *   - Only calls the known tasks service URL (no SSRF risk)
 *   - Only calls the known collector URL (no SSRF risk)
 *   - Uses INTERNAL_SERVICE_KEY for service-to-service auth
 *   - No retries — agent invocations are idempotency-unsafe
 */

import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';
import { processValue } from '../expression/engine.js';
import type { EvidenceStore } from '../evidence/types.js';

export interface TeamMemberConfig {
  role: string;
  prompt: string;
  team_id?: string;
  timeout_ms?: number;
  max_tokens?: number;
  context?: Record<string, unknown>;
  evidence?: boolean;
}

export interface TeamMemberExecutorOptions {
  tasksUrl?: string;
  collectorUrl?: string;
  serviceKey?: string;
  evidenceStore?: EvidenceStore;
}

export class TeamMemberExecutor implements NodeExecutor {
  readonly nodeTypes = ['team:member'];
  readonly hasExternalEffect = true;
  private tasksUrl: string;
  private collectorUrl: string;
  private serviceKey: string;
  private evidenceStore?: EvidenceStore;

  constructor(options?: TeamMemberExecutorOptions) {
    this.tasksUrl = options?.tasksUrl || process.env.TASKS_URL || 'http://tasks:3104';
    this.collectorUrl = options?.collectorUrl || process.env.COLLECTOR_URL || 'http://collector:9848';
    this.serviceKey = options?.serviceKey || process.env.INTERNAL_SERVICE_KEY || '';
    this.evidenceStore = options?.evidenceStore;
  }

  /** AEE-FULL-P2/P3 pattern: post-construction wiring for the singleton
   * export (server.ts) since the store isn't available at module load. */
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

    const exprContext = context.createExpressionContext(node.id, input);
    const rawConfig = node.config as unknown as TeamMemberConfig;

    const role = rawConfig.role;
    const prompt = (processValue(rawConfig.prompt, exprContext) as string) || rawConfig.prompt;
    const timeoutMs = rawConfig.timeout_ms ?? 60_000;
    const collectEvidence = rawConfig.evidence !== false;

    // Extract org_id/user_id
    const wfMeta = (context.workflow.metadata ?? {}) as Record<string, unknown>;
    const inputData = (typeof input === 'object' && input !== null) ? input as Record<string, unknown> : {};
    const orgId = (wfMeta.orgId ?? inputData.orgId ?? undefined) as string | undefined;
    const userId = (wfMeta.userId ?? inputData.userId ?? undefined) as string | undefined;

    // Resolve team_id: config > workflow.team_id > variables.team_id
    const wfTeamId = (context.workflow as unknown as Record<string, unknown>).team_id as string | undefined;
    const vars = context.getVariables() as Record<string, unknown> | undefined;
    const teamId = rawConfig.team_id || wfTeamId || (vars?.team_id as string | undefined);

    if (!teamId) {
      return {
        success: false,
        output: null,
        error: {
          code: 'TEAM_MEMBER_NO_TEAM_ID',
          message: 'team_id could not be resolved: set config.team_id, workflow.team_id, or variables.team_id',
        },
        envelopes: emitted,
      };
    }

    // Emit start envelope
    const startEnvelope = factory.event(
      'ops.team.member.dispatched',
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        nodeType: node.type,
        team_id: teamId,
        role,
        prompt_length: prompt.length,
        timeout_ms: timeoutMs,
      }
    );
    emitted.push(startEnvelope);

    try {
      // ── Step 1: Fetch team manifest ─────────────────────────────────────
      const teamUrl = `${this.tasksUrl}/api/teams/${teamId}`;
      const teamResponse = await fetch(teamUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': this.serviceKey,
          ...(orgId ? { 'X-Org-Id': orgId } : {}),
          ...(userId ? { 'X-User-Id': userId } : {}),
        },
      });

      if (!teamResponse.ok) {
        if (teamResponse.status === 404) {
          const errorMsg = `Team '${teamId}' not found`;
          emitted.push(factory.event(Intents.NODE.FAILED, context.correlationId, {
            nodeId: node.id, code: 'TEAM_NOT_FOUND', message: errorMsg,
          }));
          return {
            success: false,
            output: null,
            error: { code: 'TEAM_NOT_FOUND', message: errorMsg },
            envelopes: emitted,
          };
        }
        const errorText = await teamResponse.text();
        const errorMsg = `Team lookup failed: HTTP ${teamResponse.status} — ${errorText}`;
        emitted.push(factory.event(Intents.NODE.FAILED, context.correlationId, {
          nodeId: node.id, code: 'TEAM_LOOKUP_FAILED', message: errorMsg,
        }));
        return {
          success: false,
          output: null,
          error: { code: 'TEAM_LOOKUP_FAILED', message: errorMsg },
          envelopes: emitted,
        };
      }

      const teamData = await teamResponse.json() as Record<string, unknown>;
      const manifest = teamData.manifest as Record<string, unknown> | undefined;

      // ── Step 2: Resolve role → agent_id ────────────────────────────────
      let resolvedAgentId: string | undefined;

      if (manifest) {
        // Check orchestrator role
        const orchestrator = manifest.orchestrator as Record<string, unknown> | undefined;
        if (orchestrator && (orchestrator.role as string) === role) {
          resolvedAgentId = orchestrator.agentId as string;
        }

        // Check members array
        if (!resolvedAgentId) {
          const members = (manifest.members as Array<Record<string, unknown>>) || [];
          const match = members.find(m => (m.role as string) === role);
          if (match) {
            resolvedAgentId = match.agentId as string;
          }
        }
      }

      if (!resolvedAgentId) {
        // Collect available roles for the error message
        const availableRoles: string[] = [];
        if (manifest) {
          const orchestrator = manifest.orchestrator as Record<string, unknown> | undefined;
          if (orchestrator?.role) availableRoles.push(orchestrator.role as string);
          const members = (manifest.members as Array<Record<string, unknown>>) || [];
          for (const m of members) {
            if (m.role) availableRoles.push(m.role as string);
          }
        }
        const errorMsg = `Role '${role}' not found in team '${teamId}'. Available roles: [${availableRoles.join(', ') || 'none'}]`;
        emitted.push(factory.event(Intents.NODE.FAILED, context.correlationId, {
          nodeId: node.id, code: 'TEAM_MEMBER_ROLE_NOT_FOUND', message: errorMsg,
        }));
        return {
          success: false,
          output: null,
          error: { code: 'TEAM_MEMBER_ROLE_NOT_FOUND', message: errorMsg },
          envelopes: emitted,
        };
      }

      // ── Step 3: Invoke the resolved agent via collector ─────────────────
      const agentUrl = `${this.collectorUrl}/api/internal/agents/invoke`;
      const body: Record<string, unknown> = {
        agent_id: resolvedAgentId,
        task: prompt,
        ...(orgId ? { org_id: orgId } : {}),
        ...(userId ? { user_id: userId } : {}),
        max_duration_ms: timeoutMs,
        no_tools: false,
        // REPLAY-ONLY .A-1a: effective replay_only for this run, always sent
        // (not conditionally spread) so a collector-side gate can distinguish
        // "false" from "unset". Foundation only — no gate reads this yet.
        effective_replay_only: context.effectiveReplayOnly,
        context: {
          source: 'quoxflow',
          workflow_id: context.workflow.id,
          execution_id: context.id,
          node_id: node.id,
          team_id: teamId,
          role,
          ...rawConfig.context,
        },
      };

      if (rawConfig.max_tokens) {
        body.max_tokens = rawConfig.max_tokens;
      }

      const agentResponse = await fetch(agentUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': this.serviceKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!agentResponse.ok) {
        const errorText = await agentResponse.text();
        const errorMsg = `Agent ${resolvedAgentId} (role: ${role}) invocation failed: HTTP ${agentResponse.status} — ${errorText}`;
        emitted.push(factory.event(Intents.NODE.FAILED, context.correlationId, {
          nodeId: node.id, code: 'AGENT_INVOKE_HTTP_ERROR', message: errorMsg,
          details: { agent_id: resolvedAgentId, role, team_id: teamId, status: agentResponse.status },
        }));
        return {
          success: false,
          output: null,
          error: { code: 'AGENT_INVOKE_HTTP_ERROR', message: errorMsg },
          envelopes: emitted,
        };
      }

      const agentResult = await agentResponse.json() as Record<string, unknown>;

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
            envelopeId: startEnvelope.id,
            workflowId: context.workflow.id,
            executionId: context.id,
            nodeId: node.id,
            type: 'tool_result',
            contentType: 'application/json',
            content: JSON.stringify({
              team_id: teamId,
              role,
              agent_id: resolvedAgentId,
              prompt,
              response: agentResult,
            }),
            orgId: context.orgId, // QF-MT WP5: the run's org (mirrors sibling executors)
          });
          evidenceRefs.push(`evidence:${record.id}`);
        } catch (err) {
          // Non-fatal: evidence capture must never break the workflow run.
          console.warn('[team-member] evidenceStore.store() failed (non-fatal):', err);
        }
      }

      // Emit NODE.COMPLETED
      emitted.push(factory.event(Intents.NODE.COMPLETED, context.correlationId, {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        team_id: teamId,
        role,
        agent_id: resolvedAgentId,
        success: agentResult.success !== false,
      }));

      return {
        success: agentResult.success !== false,
        output: {
          agent_id: resolvedAgentId,
          role,
          result: agentResult.result ?? agentResult.response ?? agentResult,
        },
        envelopes: emitted,
        evidenceRefs,
      };

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      emitted.push(factory.event(Intents.NODE.FAILED, context.correlationId, {
        nodeId: node.id, code: 'TEAM_MEMBER_FAILED', message: errorMsg,
      }));

      return {
        success: false,
        output: null,
        error: { code: 'TEAM_MEMBER_FAILED', message: errorMsg },
        envelopes: emitted,
      };
    }
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const config = node.config as unknown as TeamMemberConfig;
    const errors: string[] = [];

    if (!config.role || typeof config.role !== 'string') {
      errors.push('role is required and must be a string');
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

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

export const teamMemberExecutor = new TeamMemberExecutor();
