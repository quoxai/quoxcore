/**
 * Team Invoke Executor
 *
 * Handles team:invoke nodes that dispatch an objective to a Stream AT
 * agentic team via the tasks service and poll for completion.
 *
 * Node type: team:invoke
 * Config:
 *   - team_id: string — target Stream AT team id (e.g. 'fleet-ops', 'security-review')
 *   - objective: string — natural-language goal (supports ${...} expressions)
 *   - timeout_ms?: number — poll deadline in ms (default: 1_800_000 — 30 min)
 *   - max_tokens?: number — token budget hint for the team orchestrator
 *   - context?: object — extra metadata passed to the team objective
 *   - evidence?: boolean — when true, evidence_refs include the team-instance id (default: true)
 *
 * Security:
 *   - Only calls the known tasks service URL (no SSRF risk)
 *   - Uses INTERNAL_SERVICE_KEY for service-to-service auth
 *   - No retries — teams are idempotency-unsafe; callers must handle resubmission
 */

import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope } from '../core/envelope.js';
import { processValue } from '../expression/engine.js';
import { ulid } from 'ulid';
import { combineAbortSignals } from './lib/abort-utils.js';

// STABILITY-AUDITS: fetches carried no AbortSignal at all, so a hung tasks
// service could block a fetch indefinitely — the overall elapsed-time check
// in the poll loop never gets a chance to run while blocked inside a single
// fetch. Mirror call.executor's pattern: AbortSignal.timeout() per request,
// combined with the workflow's cancellation signal. The per-request timeout
// is derived from the node's timeout_ms but bounded by a default (used when
// timeout_ms is missing/invalid) and a hard ceiling (so one HTTP call can
// never itself block for the full, much larger, poll deadline).
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;

export interface TeamInvokeConfig {
  team_id: string;
  objective: string;
  timeout_ms?: number;
  max_tokens?: number;
  context?: Record<string, unknown>;
  evidence?: boolean;
}

export interface TeamInvokeExecutorOptions {
  tasksUrl?: string;
  serviceKey?: string;
  pollInterval?: number;
}

/** Terminal statuses returned by GET /api/objectives/:id */
const TERMINAL_STATUSES = new Set([
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
]);

export class TeamInvokeExecutor implements NodeExecutor {
  readonly nodeTypes = ['team:invoke'];
  readonly hasExternalEffect = true;
  private tasksUrl: string;
  private serviceKey: string;
  private pollInterval: number;

  constructor(options?: TeamInvokeExecutorOptions) {
    this.tasksUrl = options?.tasksUrl || process.env.TASKS_URL || 'http://tasks:3104';
    this.serviceKey = options?.serviceKey || process.env.INTERNAL_SERVICE_KEY || '';
    this.pollInterval = options?.pollInterval ?? 3000;
  }

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    // Resolve config expressions
    const exprContext = context.createExpressionContext(node.id, input);
    const rawConfig = node.config as unknown as TeamInvokeConfig;

    const teamId = rawConfig.team_id;
    const objective = (processValue(rawConfig.objective, exprContext) as string) || rawConfig.objective;
    const timeoutMs = rawConfig.timeout_ms ?? 1_800_000;
    const collectEvidence = rawConfig.evidence !== false;

    // Per-request timeout for each individual fetch — see comment above.
    const requestTimeoutMs = Math.min(
      (Number.isFinite(timeoutMs) && timeoutMs > 0) ? timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS
    );
    const requestSignal = () => combineAbortSignals(
      AbortSignal.timeout(requestTimeoutMs),
      context.cancellationSignal,
    );

    // Extract org_id/user_id — workflow metadata is authoritative (set by converter),
    // fall back to trigger data (first node input) for direct API executions
    const wfMeta = (context.workflow.metadata ?? {}) as Record<string, unknown>;
    const inputData = (typeof input === 'object' && input !== null) ? input as Record<string, unknown> : {};
    const orgId = (wfMeta.orgId ?? inputData.orgId ?? 'default') as string;
    const userId = (wfMeta.userId ?? inputData.userId ?? 'service') as string;

    // Emit task envelope — team invocation started
    const taskEnvelope = factory.task(
      `team.${teamId}`,
      'quox.flow.team.invoked',
      context.correlationId,
      {
        nodeId: node.id,
        nodeName: node.name ?? node.id,
        nodeType: node.type,
        team_id: teamId,
        objective_length: objective.length,
        timeout_ms: timeoutMs,
      }
    );
    emitted.push(taskEnvelope);

    const startTime = Date.now();

    try {
      // ── Step 1: Create objective via tasks service ──────────────────────
      const createUrl = `${this.tasksUrl}/api/objectives`;
      const createBody: Record<string, unknown> = {
        title: objective,
        team_id: teamId,
        max_duration_ms: timeoutMs,
        context: {
          source: 'quoxflow',
          workflow_id: context.workflow.id,
          execution_id: context.id,
          node_id: node.id,
          ...rawConfig.context,
        },
      };

      if (rawConfig.max_tokens) {
        createBody.max_tokens = rawConfig.max_tokens;
      }

      const createResponse = await fetch(createUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': this.serviceKey,
          'X-Org-Id': orgId,
          'X-User-Id': userId,
        },
        body: JSON.stringify(createBody),
        signal: requestSignal(),
      });

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        const errorMsg = `Team objective creation failed: HTTP ${createResponse.status} — ${errorText}`;

        const errorEnvelope = factory.error(
          taskEnvelope,
          'quox.flow.team.failed',
          {
            code: 'TEAM_INVOKE_FAILED',
            message: errorMsg,
            details: { team_id: teamId, status: createResponse.status },
          }
        );
        emitted.push(errorEnvelope);

        return {
          success: false,
          output: null,
          error: {
            code: 'TEAM_INVOKE_FAILED',
            message: errorMsg,
          },
          envelopes: emitted,
        };
      }

      const created = await createResponse.json() as Record<string, unknown>;
      const objectiveId = created.id as string;

      // ── Step 2: Poll for completion ─────────────────────────────────────
      const pollUrl = `${this.tasksUrl}/api/objectives/${objectiveId}`;
      let lastStatus = 'pending';

      while (true) {
        const elapsed = Date.now() - startTime;
        if (elapsed > timeoutMs) {
          const timeoutMsg = `Team objective ${objectiveId} timed out after ${elapsed}ms (limit: ${timeoutMs}ms)`;

          const errorEnvelope = factory.error(
            taskEnvelope,
            'quox.flow.team.failed',
            {
              code: 'TEAM_INVOKE_FAILED',
              message: timeoutMsg,
              details: { team_id: teamId, objective_id: objectiveId, elapsed_ms: elapsed },
            }
          );
          emitted.push(errorEnvelope);

          return {
            success: false,
            output: null,
            error: {
              code: 'TEAM_INVOKE_FAILED',
              message: timeoutMsg,
            },
            envelopes: emitted,
          };
        }

        const pollResponse = await fetch(pollUrl, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Key': this.serviceKey,
            'X-Org-Id': orgId,
            'X-User-Id': userId,
          },
          signal: requestSignal(),
        });

        if (!pollResponse.ok) {
          // Transient polling errors — treat as still running if not 404
          if (pollResponse.status === 404) {
            const notFoundMsg = `Team objective ${objectiveId} not found during polling`;
            const errorEnvelope = factory.error(
              taskEnvelope,
              'quox.flow.team.failed',
              {
                code: 'TEAM_INVOKE_FAILED',
                message: notFoundMsg,
                details: { team_id: teamId, objective_id: objectiveId },
              }
            );
            emitted.push(errorEnvelope);
            return {
              success: false,
              output: null,
              error: { code: 'TEAM_INVOKE_FAILED', message: notFoundMsg },
              envelopes: emitted,
            };
          }
          // Non-fatal poll error — wait and retry
          await delay(this.pollInterval);
          continue;
        }

        const polled = await pollResponse.json() as Record<string, unknown>;
        lastStatus = (polled.status as string) || 'unknown';

        if (TERMINAL_STATUSES.has(lastStatus)) {
          break;
        }

        await delay(this.pollInterval);
      }

      const durationMs = Date.now() - startTime;

      // ── Step 3: Assess terminal state ───────────────────────────────────
      if (lastStatus === 'completed') {
        // Re-fetch to get full response (last poll is already cached above
        // but we need the tasks/result fields — they come from the same GET)
        const finalResponse = await fetch(pollUrl, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Key': this.serviceKey,
            'X-Org-Id': orgId,
            'X-User-Id': userId,
          },
          signal: requestSignal(),
        });

        const final = finalResponse.ok
          ? (await finalResponse.json() as Record<string, unknown>)
          : {};

        const tasksArr = (final.tasks as unknown[]) ?? [];
        const tasksCompleted = (tasksArr as Array<Record<string, unknown>>).filter(t => t.status === 'completed').length;
        const tasksFailed = (tasksArr as Array<Record<string, unknown>>).filter(t => t.status === 'failed').length;

        // Evidence collection
        const evidenceRefs: string[] = [];
        if (collectEvidence) {
          const teamInstanceId = (final.team_instance_id as string) || ulid();
          evidenceRefs.push(`team-instance:${teamInstanceId}`);
        }

        const resultEnvelope = factory.result(
          taskEnvelope,
          'quox.flow.team.completed',
          {
            nodeId: node.id,
            nodeName: node.name ?? node.id,
            team_id: teamId,
            objective_id: objectiveId,
            status: lastStatus,
            tasks_completed: tasksCompleted,
            tasks_failed: tasksFailed,
            duration_ms: durationMs,
          },
          evidenceRefs.length > 0 ? evidenceRefs : undefined
        );
        emitted.push(resultEnvelope);

        return {
          success: true,
          output: {
            objective_id: objectiveId,
            status: lastStatus,
            result: (final.result as unknown) ?? null,
            tasks_completed: tasksCompleted,
            tasks_failed: tasksFailed,
          },
          envelopes: emitted,
          evidenceRefs,
        };
      } else {
        // failed | cancelled | completed_with_errors
        const reason = lastStatus === 'failed'
          ? `Team objective ${objectiveId} failed`
          : lastStatus === 'cancelled'
          ? `Team objective ${objectiveId} was cancelled`
          : `Team objective ${objectiveId} completed with errors`;

        const errorEnvelope = factory.error(
          taskEnvelope,
          'quox.flow.team.failed',
          {
            code: 'TEAM_INVOKE_FAILED',
            message: reason,
            details: { team_id: teamId, objective_id: objectiveId, status: lastStatus, duration_ms: durationMs },
          }
        );
        emitted.push(errorEnvelope);

        return {
          success: false,
          output: null,
          error: {
            code: 'TEAM_INVOKE_FAILED',
            message: reason,
          },
          envelopes: emitted,
        };
      }
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);

      const errorEnvelope = factory.error(
        taskEnvelope,
        'quox.flow.team.failed',
        {
          code: 'TEAM_INVOKE_FAILED',
          message: errorMsg,
          details: { team_id: teamId, duration_ms: durationMs },
        }
      );
      emitted.push(errorEnvelope);

      return {
        success: false,
        output: null,
        error: {
          code: 'TEAM_INVOKE_FAILED',
          message: errorMsg,
        },
        envelopes: emitted,
      };
    }
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const config = node.config as unknown as TeamInvokeConfig;
    const errors: string[] = [];

    if (!config.team_id || typeof config.team_id !== 'string') {
      errors.push('team_id is required');
    }

    if (!config.objective || typeof config.objective !== 'string') {
      errors.push('objective is required');
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const teamInvokeExecutor = new TeamInvokeExecutor();
