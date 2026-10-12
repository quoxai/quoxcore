/**
 * Durable Hooks — STUDY-REV W2
 *
 * Factory that produces a LifecycleHooks implementation backed by:
 *   - ObservationStore           (per-step observation persistence — R2)
 *   - ExecutionHistoryStore      (run-level outcomes feeding Crystalliser)
 *   - SkillLibraryStore          (Crystalliser output persistence — K5)
 *
 * Behaviour:
 *   - captureObservation:        delegates to an ObservationRegistry
 *                                (default registry used if none supplied).
 *   - afterNodeExecute:          writes the Observation row, accumulates
 *                                an action log for the run.
 *   - onWorkflowComplete:        records the ExecutionRecord, then runs
 *                                analyseExecutionHistory; if the workflow
 *                                is ready and no skill exists yet, calls
 *                                crystallise() and persists the result
 *                                as version 1 in the Skill Library.
 *
 * All persistence calls are wrapped — hook errors must not break execution.
 */

import { Node } from '../core/workflow.js';
import { ExecutorResult } from '../executors/executor.interface.js';
import { LifecycleHooks, Observation } from './lifecycle-hooks.js';
import { ObservationRegistry, createDefaultObservationRegistry } from './observation-registry.js';
import {
  analyseExecutionHistory,
  crystallise,
  extractVariables,
  CrystallisationCandidate,
  ExecutionRecord,
} from './crystalliser.js';
import { ObservationStore } from '../store/observation-store.js';
import { ExecutionHistoryStore } from '../store/execution-history-store.js';
import { SkillLibraryStore } from '../store/skill-library-store.js';
import { EvidenceStore, EvidenceType, CreateEvidenceRequest } from '../evidence/index.js';
import { ulid } from 'ulid';
import { runTaskTimePromotionSweep } from './task-time-promotion-sweep.js';
import { createSkillFirewall, SkillFirewall } from '../security/skill_firewall.js';
import type { SkillFirewallLogStore } from '../store/skill-firewall-log-store.js';
import { logger } from '../logger.js';
import { analyzeLineage, type LineageAnalyzerLlmClient } from './lineage-analyzer.js';

const sweepLog = logger.for('DurableHooks.TaskTimeSweep');

/**
 * Maps an Observation type to the corresponding EvidenceType.
 * Exported for unit testing.
 * Sprint 1 SC#3 — STUDY-REV AOCL wire.
 */
export function observationTypeToEvidenceType(obsType: Observation['type']): EvidenceType {
  switch (obsType) {
    case 'screenshot':      return 'screenshot';
    case 'tool_output':     return 'data_snapshot';
    case 'api_response':    return 'http_response';
    case 'command_output':  return 'log';
    case 'human_response':  return 'data_snapshot';
    case 'generic':         return 'data_snapshot';
    default:                return 'data_snapshot';
  }
}

export interface DurableHooksConfig {
  observationStore: ObservationStore;
  executionHistoryStore: ExecutionHistoryStore;
  skillLibraryStore: SkillLibraryStore;
  /** Org scope for all persisted records. Required for multi-tenant safety. */
  orgId: string;
  /** Optional ObservationRegistry override; defaults to createDefaultObservationRegistry(). */
  observationRegistry?: ObservationRegistry;
  /**
   * Optional resolver mapping a correlationId → caller-supplied taskId
   * (e.g. when the Tasks service triggers a workflow run on behalf of an
   * objective). When undefined, observations omit task_id.
   */
  resolveTaskId?: (correlationId: string) => string | undefined;
  /** STUDY-REV AOCL wire: when supplied, every observation also produces
   *  an EvidenceRecord (the audit-chain entry the AOCL pipeline consumes).
   *  Sprint 1 SC#3. */
  evidenceStore?: EvidenceStore;
  /**
   * MACHINERY: task-time crystal promotion sweep.
   * Firewall gate applied to any Crystal the sweep promotes — same content-scan
   * mechanism used on the Skill write path. Defaults to createSkillFirewall().
   */
  skillFirewall?: SkillFirewall;
  /** MACHINERY: best-effort log of every sweep firewall scan (allow + block). */
  skillFirewallLogStore?: SkillFirewallLogStore;
  /** MACHINERY: promotion thresholds for the sweep. Defaults match agentic.executor.ts's default. */
  crystalPromotionThreshold?: { confidence: number; consecutive_success: number };
  /**
   * MACHINERY: enable/disable the run-completion task-time promotion sweep.
   * Default ON. Also honours CRYSTAL_TASKTIME_PROMOTION_DISABLED=true env var
   * as an ops kill-switch (mirrors QSKL_FIREWALL_DISABLED convention) when
   * this field is left undefined.
   */
  crystalTasktimePromotionEnabled?: boolean;
  /**
   * MEM-DECAY MD.3: lineage graph. When supplied, onWorkflowComplete looks up
   * the workflow's most recent prior execution_history row (parent pointer,
   * written on every run) and, on failure, calls lineage-analyzer.ts's one
   * LLM call to write a short `lesson` onto the row. Optional and best-effort
   * — absent client means the parent pointer is still recorded but no
   * lesson is ever generated.
   */
  lineageLlmClient?: LineageAnalyzerLlmClient;
}

interface AgenticUsage {
  agentId?: string;
  orgId: string;
  objectiveMet: boolean;
  actionLog: Array<{ action: string; success: boolean }>;
}

interface RunAccumulator {
  workflowId: string;
  /**
   * QF-MT #111: the run's real authenticated org, captured from context.orgId
   * during node execution. onWorkflowComplete's summary carries no org, so
   * without this the workflow-complete records (execution history, lineage,
   * Skill-Library crystallisation) fell back to the hook's static closure org —
   * which is 'default' for the process-wide ExecutionService singleton, tagging
   * every tenant's completed runs as 'default'.
   */
  orgId?: string;
  startedAt: number;
  success: boolean;
  actionLog: Array<{ action: string; params: Record<string, unknown> }>;
  nodeTypes: string[];
  nodeCount: number;
  /** MACHINERY: per-agentic-node usage captured for the task-time promotion sweep. */
  agenticUsages: AgenticUsage[];
}

/**
 * MEM-DECAY MD.3: best-effort motivation extraction for the lineage lesson.
 * Scans the run's action log for the first agentic node's `objective`/`goal`
 * config field (the same aliasing agentic.executor.ts itself accepts at
 * config-resolution time) — this is read from data already captured for the
 * run, never fabricated. Falls back to the workflowId when no agentic node
 * ran (e.g. a purely deterministic workflow failed on a call/transform node).
 */
function deriveMotivation(actionLog: RunAccumulator['actionLog'], workflowId: string): string {
  for (const entry of actionLog) {
    const params = entry.params ?? {};
    const objective = (params.objective as string | undefined) ?? (params.goal as string | undefined);
    if (typeof objective === 'string' && objective.trim().length > 0) {
      return objective;
    }
  }
  return workflowId;
}

export function createDurableHooks(config: DurableHooksConfig): LifecycleHooks {
  const {
    observationStore,
    executionHistoryStore,
    skillLibraryStore,
    orgId,
    observationRegistry = createDefaultObservationRegistry(),
    resolveTaskId,
    evidenceStore,
    skillFirewall,
    skillFirewallLogStore,
    crystalPromotionThreshold,
    lineageLlmClient,
  } = config;

  // MACHINERY: default ON, env kill-switch mirrors QSKL_FIREWALL_DISABLED convention.
  const crystalTasktimePromotionEnabled = config.crystalTasktimePromotionEnabled
    ?? (process.env.CRYSTAL_TASKTIME_PROMOTION_DISABLED !== 'true');

  const runs = new Map<string, RunAccumulator>();

  function getOrCreate(correlationId: string, workflowId: string): RunAccumulator {
    let acc = runs.get(correlationId);
    if (!acc) {
      acc = {
        workflowId,
        startedAt: Date.now(),
        success: true,
        actionLog: [],
        nodeTypes: [],
        nodeCount: 0,
        agenticUsages: [],
      };
      runs.set(correlationId, acc);
    }
    return acc;
  }

  return {
    captureObservation(node: Node, result: ExecutorResult): Promise<Observation | null> {
      try {
        return Promise.resolve(observationRegistry.produce(node, result));
      } catch {
        return Promise.resolve(null);
      }
    },

    async afterNodeExecute(node, result, observation, context) {
      // Track action signature for Crystalliser, regardless of observation outcome.
      const acc = getOrCreate(context.correlationId, context.workflowId);
      // QF-MT #111: capture the run's real org for onWorkflowComplete (its
      // summary carries none). First non-empty context.orgId wins.
      if (context.orgId && !acc.orgId) acc.orgId = context.orgId;
      acc.nodeTypes.push(node.type);
      acc.nodeCount++;
      const params = ((node as any).config && typeof (node as any).config === 'object')
        ? (node as any).config as Record<string, unknown>
        : {};
      acc.actionLog.push({ action: node.type, params });

      // MACHINERY: capture agentic-node usage for the task-time promotion sweep.
      // Mirrors agentic.executor.ts's config aliasing (agent/agentId/agent_id).
      // Note: 'agent:agentic' is a valid NodeType but has no corresponding Node
      // union member (pre-existing gap — agentic.executor.ts casts similarly),
      // hence the string cast for the comparison.
      if ((node.type as string) === 'agent:agentic') {
        const output = result.output as Record<string, unknown> | undefined;
        const fineGrainedLog = output?.action_log as Array<{ action: string; success: boolean }> | undefined;
        if (result.success && Array.isArray(fineGrainedLog) && fineGrainedLog.length > 0) {
          const nodeAgentId = (params.agent as string | undefined)
            ?? (params.agentId as string | undefined)
            ?? (params.agent_id as string | undefined);
          const nodeOrgId = (params.org_id as string | undefined) ?? context.orgId ?? orgId;
          acc.agenticUsages.push({
            agentId: nodeAgentId,
            orgId: nodeOrgId,
            objectiveMet: output?.objective_met === true,
            actionLog: fineGrainedLog,
          });
        }
      }

      if (!observation) return;

      try {
        await observationStore.append({
          orgId: context.orgId ?? orgId,
          taskId: resolveTaskId?.(context.correlationId),
          nodeId: node.id,
          workflowId: context.workflowId,
          correlationId: context.correlationId,
          observation,
        });
      } catch { /* hooks are non-fatal */ }

      // STUDY-REV SC#3 — AOCL audit-chain write (parallel channel, non-fatal)
      if (evidenceStore && observation) {
        try {
          const envelopeId = (result.envelopes && result.envelopes[0]?.id) || `obs-${ulid()}`;
          const req: CreateEvidenceRequest = {
            correlationId: context.correlationId,
            envelopeId,
            workflowId: context.workflowId,
            nodeId: node.id,
            type: observationTypeToEvidenceType(observation.type),
            contentType: 'application/json',
            content: JSON.stringify({
              summary: observation.summary,
              contentRef: observation.contentRef,
              contentHash: observation.contentHash,
              contentSizeBytes: observation.contentSizeBytes,
              imageMediaType: observation.imageMediaType,
              metadata: observation.metadata,
            }),
            metadata: {
              observationType: observation.type,
              nodeType: node.type,
              nodeName: node.name,
              org_id: context.orgId ?? orgId,
            },
            orgId: context.orgId ?? orgId, // QF-MT WP5: persist on the org_id column, not just metadata
          };
          await evidenceStore.store(req);
        } catch { /* hooks are non-fatal */ }
      }
    },

    async onNodeFail(_node, _error, _context) {
      // Mark the run as failed — referenced by onWorkflowComplete.
      // We don't have correlationId in onNodeFail's context (only attempt+ids),
      // so we mark via the most recent run accumulator if any. The pipeline
      // also passes the same correlation through afterNodeExecute on retry.
      // Conservatively, leave success as-is here; onWorkflowComplete is
      // authoritative via the `success` argument.
    },

    async onWorkflowComplete(success, summary) {
      const acc = runs.get(summary.correlationId);
      runs.delete(summary.correlationId);

      // QF-MT #111: attribute the completed run to its REAL org (captured from
      // context.orgId during node execution), not the hook's static closure org
      // (which is 'default' for the process-wide ExecutionService singleton). The
      // per-agentic-usage sweep below already uses usage.orgId and is unaffected.
      const runOrgId = acc?.orgId ?? orgId;

      const workflowId = acc?.workflowId || summary.workflowId;
      if (!workflowId) return;

      const record: ExecutionRecord = {
        id: ulid(),
        success,
        nodeTypes: acc?.nodeTypes ?? [],
        nodeCount: acc?.nodeCount ?? summary.nodesExecuted,
        durationMs: summary.durationMs,
        actionLog: acc?.actionLog ?? [],
      };

      try {
        await executionHistoryStore.record({ orgId: runOrgId, workflowId, record });
      } catch { return; }

      // ─── MEM-DECAY MD.3: lineage graph — parent pointer + failure lesson ────
      // Runs for every recorded execution (parent pointer), but only calls the
      // lineage-analyzer LLM on failure. Fully non-fatal: any error here must
      // never affect the crystallisation check below or the recorded history.
      try {
        const parentExecutionId = await executionHistoryStore.getMostRecentId({
          orgId: runOrgId,
          workflowId,
          excludeExecId: record.id,
        });

        if (!success && lineageLlmClient) {
          const motivation = deriveMotivation(acc?.actionLog ?? [], workflowId);
          const errorText = summary.errors.length > 0
            ? summary.errors.map(e => `${e.nodeId}: ${e.error}`).join('; ')
            : 'workflow did not complete successfully';

          let lesson: string | null = null;
          try {
            lesson = await analyzeLineage(
              { actionLog: acc?.actionLog ?? [], error: errorText, motivation },
              lineageLlmClient,
            );
          } catch (lineageErr: unknown) {
            console.warn(
              '[DurableHooks] lineage-analyzer analyzeLineage() failed (best-effort):',
              lineageErr,
            );
          }

          await executionHistoryStore.setLineage(record.id, { parentExecutionId, motivation, lesson });
        } else if (parentExecutionId) {
          await executionHistoryStore.setLineage(record.id, { parentExecutionId });
        }
      } catch { /* hooks are non-fatal */ }

      if (!success) return;

      // ─── MACHINERY: run-completion task-time crystal promotion sweep ────────
      // Independent of the post-hoc workflow crystallisation below — this closes
      // the gap where a successful run reuses a previously-drafted (experimental)
      // Crystal's action pattern without the LLM ever re-emitting propose_crystal.
      // Non-fatal: sweep failures must never affect the recorded execution history
      // or the post-hoc crystallisation check that follows.
      if (crystalTasktimePromotionEnabled && acc && acc.agenticUsages.length > 0) {
        for (const usage of acc.agenticUsages) {
          if (!usage.objectiveMet) continue;
          try {
            const sweepResult = await runTaskTimePromotionSweep(
              {
                orgId: usage.orgId,
                agentId: usage.agentId,
                executionId: summary.correlationId,
                actionLog: usage.actionLog,
              },
              {
                skillLibraryStore,
                firewall: skillFirewall ?? createSkillFirewall(),
                firewallLogStore: skillFirewallLogStore,
                promotionThreshold: crystalPromotionThreshold,
                enabled: true,
              },
            );
            if (sweepResult.promotedCrystalIds.length > 0) {
              sweepLog.debug(`sweep promoted ${sweepResult.promotedCrystalIds.length} Crystal(s) for agent=${usage.agentId} org=${usage.orgId}`);
            } else if (sweepResult.firewallBlocked) {
              sweepLog.debug(`sweep: firewall blocked promotion for agent=${usage.agentId} org=${usage.orgId} (attempt recorded)`);
            }
          } catch (err) {
            sweepLog.warn('task-time promotion sweep failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
          }
        }
      }

      // Crystallisation check: only promote workflows that don't already
      // have a skill in the library (idempotent under repeat runs).
      try {
        const existing = await skillLibraryStore.getLatest({ orgId: runOrgId, sourceWorkflowId: workflowId });
        if (existing) return;

        const recent = await executionHistoryStore.getRecent({ orgId: runOrgId, workflowId, limit: 50 });
        const analysis = analyseExecutionHistory(recent);
        if (!analysis.ready) return;

        const successful = recent.filter(r => r.success);
        const canonicalActions = successful[0]?.actionLog ?? [];
        const variables = extractVariables(recent);

        const candidate: CrystallisationCandidate = {
          workflowId,
          workflowName: workflowId,
          confidence: analysis.confidence,
          executionCount: analysis.executionCount,
          successRate: analysis.successRate,
          canonicalActions,
          variables,
        };

        const crystallised = crystallise(candidate);

        await skillLibraryStore.write({
          orgId: runOrgId,
          sourceWorkflowId: workflowId,
          name: crystallised.name,
          confidence: analysis.confidence,
          executionCount: analysis.executionCount,
          successRate: analysis.successRate,
          workflowJson: crystallised as unknown as Record<string, unknown>,
          tags: crystallised.tags,
          variables,
        });
      } catch { /* hooks are non-fatal */ }
    },
  };
}
