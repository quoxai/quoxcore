/**
 * QSKL-2 — Agentic Skills Actions
 *
 * Three agentic action handlers that let an LLM agent discover, load, and
 * author skills mid-task:
 *   - skillsListHandler  → skills_list
 *   - skillViewHandler   → skill_view
 *   - skillManageHandler → skill_manage
 *
 * Each handler takes a context bag and returns a standardised result with an
 * envelopeShape for future AEE emission.
 */

import { queueHumanReview } from './skill-human-review.js';
import { ulid } from 'ulid';
import type { QuoxSkillsStore, QuoxSkillRecord } from '../store/quox-skills-store.js';
import type { QuoxSkillPatchesStore } from '../store/quox-skill-patches-store.js';
import type { SkillLibraryStore } from '../store/skill-library-store.js';
import type { EvidenceStore } from '../evidence/types.js';
import { SkillInvokedMetadataSchema } from '../evidence/types.js';
import type { ApprovalEngine } from '../approval/approval-engine.js';
import type { ToolsmithAdapter } from './toolsmith-adapter.js';
import type { ToolPresenceLookup } from './tool-presence-lookup.js';
import type { PatchRateLimiter } from './skill-patch-rate-limiter.js';
import type { QuoxSkillInvocationsStore } from '../store/quox-skill-invocations-store.js';
import { applySkillPatch } from './skill-patch-flow.js';
import { checkRequiredTools } from './skill-required-tools-check.js';
import type { RequiredToolSpec } from './skill-required-tools-types.js';
import { fileSkillRequiredToolHITL } from './skill-patch-hitl.js';
import {
  runPostInvocationAutoRevertCheck,
  type PostInvocationContext,
} from './skill-invocation-post-hook.js';
import { estimateCostUsd } from './model-pricing.js';
import { createSkillFirewall } from '../security/skill_firewall.js';
import type { SkillFirewall, SkillInput } from '../security/skill_firewall.js';
import type { SkillFirewallLogStore } from '../store/skill-firewall-log-store.js';
import type { SkillReviewQueueStore } from '../store/skill-review-queue-store.js';
import type { EnvelopeStore } from '../store/envelope-store.js';
import { EnvelopeFactory } from '../core/envelope.js';
import { logger } from '../logger.js';
import type { SkillOverridesStore } from '../store/skill-overrides-store.js';
import { mergeSkillOverridesForRead } from './skill-overrides-merge.js';

const viewLog = logger.for('skillViewHandler');
const manageLog = logger.for('skillManageHandler');
const managePatchLog = logger.for('skillManageHandler patch');
import { emitQsklSafetyAocl } from '../security/qskl-safety-aocl.js';

// Module-level factory for AOCL gate envelopes in this module
const _aoclFactory = new EnvelopeFactory('agent.qskl-skills-actions');

// ─── Shared types ──────────────────────────────────────────────────────────────

export interface SkillsActionContext {
  store: QuoxSkillsStore;
  /** QSKL-4.A: patch flow writes audit rows here. Required when action=patch with body_md. */
  patchesStore: QuoxSkillPatchesStore;
  /** QSKL-4.C: Crystal evaluator reads linked canonical Crystals from here. */
  skillLibraryStore?: SkillLibraryStore;
  /** QSKL-4.D: Evidence store for VOLT audit trail on every patch attempt. */
  evidenceStore?: EvidenceStore;
  /** QSKL-4.D: Approval engine for HITL inbox routing on Crystal regression. */
  approvalEngine?: ApprovalEngine;
  /** QSKL-6.4b: Toolsmith adapter for building missing tools at skill view time. */
  toolsmithAdapter?: ToolsmithAdapter;
  /** QSKL-6.4b: Tool presence lookup. Defaults to all-missing when absent (safe-by-default). */
  toolPresenceLookup?: ToolPresenceLookup;
  /** QSKL-14a: Per-agent patch rate-limiter. Passed through to applySkillPatch. */
  patchRateLimiter?: PatchRateLimiter;
  /**
   * QSKL-SAFETY.B: Firewall instance. Defaults to createSkillFirewall() when absent.
   * Override in tests to inject a custom firewall or a disabled one.
   */
  firewall?: SkillFirewall;
  /**
   * QSKL-SAFETY.B: Firewall log store. When provided, every scan result is
   * persisted to skill_firewall_log. When absent, no log row is written.
   */
  firewallLogStore?: SkillFirewallLogStore;
  /**
   * QSKL-SAFETY.E: Review queue store. When provided, the promotion gate
   * blocks experimental→stable transitions when a pending or rejected row exists.
   */
  reviewQueueStore?: SkillReviewQueueStore;
  /**
   * QSKL-SAFETY Gap 6: Envelope store for AOCL layer-5 gate emissions.
   * Fire-and-forget. When absent, no AOCL envelope is emitted (gate behavior unchanged).
   */
  envelopeStore?: EnvelopeStore;
  /** QSKL-7.3: Typed invocation telemetry store. Best-effort — writes skipped when absent. */
  invocationsStore?: QuoxSkillInvocationsStore;
  /**
   * QSKL-HARDEN HRD-1: Skill overrides store. When provided, skillViewHandler
   * merges org/user overrides (allowlisted display-ish fields) into the served
   * view BEFORE the load-time firewall scan runs, so overridden text can never
   * become an injection side-channel. When absent, no merge happens (unchanged
   * behavior).
   */
  overridesStore?: SkillOverridesStore;
  /**
   * QSKL-HARDEN HRD-1: user id for resolving the user-scope override layer.
   * Absent/null → only the org-scope override (if any) is applied.
   */
  userId?: string | null;
  /**
   * QSKL-7.5: Optional post-invocation hook for dependency injection.
   * Defaults to runPostInvocationAutoRevertCheck in production.
   * Override in tests to assert invocation without Postgres.
   */
  postInvocationHook?: (ctx: PostInvocationContext) => Promise<void>;
  /**
   * QSKL-7-FIX-A: Session ID for the current conversation / agentic execution.
   * Populated from the AEE correlation ID (context.correlationId) in the executor.
   * Written into the invocation row for cross-turn reconstruction by AGENT-HONESTY.
   * Absent → null stored (genuinely no session context).
   */
  sessionId?: string | null;
  /**
   * QSKL-7.fix2: ULID of the active Crystal when this skill_view was triggered
   * in a Crystal-served execution context. Null/absent when not in a Crystal context.
   */
  activeCrystalId?: string | null;
  /**
   * QSKL-7.fix2: Token usage from the LLM call that produced the skill_view
   * tool-call decision immediately preceding this handler. Used to populate
   * tokens_used and cost_usd in the skill_invoked telemetry envelope.
   * Absent → falls back to 0 (backward-compatible).
   */
  lastLlmUsage?: { model: string; input_tokens: number; output_tokens: number } | null;
  orgId: string;
  agentId?: string;
  params: Record<string, unknown>;
  /**
   * MEM-DECAY MD.2: env override for testing the retrieval-suppression filter
   * (QSKL_DECAY_RETRIEVAL_FILTER_ENABLED). Defaults to process.env. See
   * skillsListHandler for the flag's default-off behavior.
   */
  env?: NodeJS.ProcessEnv;
}

export interface SkillsActionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
  /** QSKL-6.4b: present on REQUIRED_TOOL_MISSING early-exit returns. */
  code?: string;
  /** QSKL-6.4b: true when a HITL notification was filed for this early exit. */
  hitl_filed?: boolean;
  /** QSKL-6.4b: list of missing tool specs on REQUIRED_TOOL_MISSING returns. */
  missing_tools?: unknown[];
  /** quox#748: the active review-queue row on SKILL_PENDING_REVIEW / SKILL_REVIEW_REJECTED returns. */
  review?: { queue_row_id: string; status: string };
  envelopeShape: Record<string, unknown>;
}

// ─── Minimal listing shape returned by skillsListHandler ──────────────────────

interface SkillListItem {
  id: string;
  name: string;
  description: string;
  version: string;
  edition: string;
  tags: string[];
  score?: number;
}

// ─── skillsListHandler ────────────────────────────────────────────────────────

/**
 * List skills from the catalog with keyword/category/edition/tags/agent_id
 * filtering and success-rate ordering.
 */
export async function skillsListHandler(ctx: SkillsActionContext): Promise<SkillsActionResult> {
  const {
    query,
    category,
    edition,
    tags,
    agent_id,
    top_k = 10,
    include_archived = false,
  } = ctx.params as {
    query?: string;
    category?: string;
    edition?: string;
    tags?: string[];
    agent_id?: string;
    top_k?: number;
    /** MEM-DECAY MD.2: escape hatch for the archive_candidate retrieval filter (see below). */
    include_archived?: boolean;
  };

  const envelopeShape = {
    type: 'agentic.skill.list',
    tool_name: 'skills_list',
    params_summary: { query, category, edition, tags, agent_id, top_k },
  };

  try {
    // Fetch all skills for this org (latest versions only)
    let records = await ctx.store.list({ orgId: ctx.orgId });

    // ── MEM-DECAY MD.2: retrieval-suppression filter ──
    // Default OFF (dark) — set QSKL_DECAY_RETRIEVAL_FILTER_ENABLED=true to exclude
    // decay_state='archive_candidate' skills from default retrieval. `include_archived: true`
    // always overrides, flag or no flag, so admin/audit callers can still see everything.
    // Never touches the underlying rows — read-time filter only, same shape as
    // memory's dark-launch pattern for MEMORY_FRESHNESS_RANKING.
    const retrievalFilterEnabled = (ctx.env ?? process.env).QSKL_DECAY_RETRIEVAL_FILTER_ENABLED === 'true';
    if (retrievalFilterEnabled && !include_archived) {
      records = records.filter(r => r.decayState !== 'archive_candidate');
    }

    // ── keyword filter ──
    if (query) {
      const q = query.toLowerCase();
      records = records.filter(r => {
        // Include hyphen-normalized name (github-pr-review → github pr review)
        const normalizedName = r.name.replace(/-/g, ' ');
        const searchable = [
          r.name,
          normalizedName,
          r.description,
          ...(Array.isArray(r.tags) ? r.tags : []),
        ].join(' ').toLowerCase();
        return searchable.includes(q);
      });
    }

    // ── category filter ──
    if (category) {
      records = records.filter(r => r.category === category);
    }

    // ── edition filter ──
    if (edition) {
      records = records.filter(r => r.edition === edition);
    }

    // ── tags intersect filter ──
    if (Array.isArray(tags) && tags.length > 0) {
      records = records.filter(r => {
        const skillTags = Array.isArray(r.tags) ? r.tags : [];
        return tags.every(t => skillTags.includes(t));
      });
    }

    // ── agent_id filter ──
    // Empty bestForAgents means "all agents"; non-empty means agent must be in the list.
    if (agent_id) {
      records = records.filter(r => {
        const best = Array.isArray(r.bestForAgents) ? r.bestForAgents : [];
        return best.length === 0 || best.includes(agent_id);
      });
    }

    // ── ordering: by success_rate_30d desc, then by createdAt desc ──
    records.sort((a, b) => {
      const rateA = typeof (a.evals as any)?.success_rate_30d === 'number'
        ? (a.evals as any).success_rate_30d as number
        : -1;
      const rateB = typeof (b.evals as any)?.success_rate_30d === 'number'
        ? (b.evals as any).success_rate_30d as number
        : -1;
      if (rateB !== rateA) return rateB - rateA;
      // Secondary sort: newest first
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    // ── top_k limit ──
    const limit = typeof top_k === 'number' && top_k > 0 ? top_k : 10;
    const sliced = records.slice(0, limit);

    // ── map to minimal listing shape ──
    const items: SkillListItem[] = sliced.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      version: r.version,
      edition: r.edition,
      tags: Array.isArray(r.tags) ? r.tags : [],
      score: typeof (r.evals as any)?.success_rate_30d === 'number'
        ? (r.evals as any).success_rate_30d as number
        : undefined,
    }));

    return { success: true, data: items, envelopeShape };
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      envelopeShape,
    };
  }
}

// ─── skillViewHandler ─────────────────────────────────────────────────────────

/**
 * Load a skill's full body or specific H2 sections.
 * Marks inject_kb=true in the envelope shape (tokens charged to caller).
 */
export async function skillViewHandler(ctx: SkillsActionContext): Promise<SkillsActionResult> {
  const { id_or_name, sections } = ctx.params as {
    id_or_name: string;
    sections?: string[];
  };

  const envelopeShape = {
    type: 'agentic.skill.view',
    tool_name: 'skill_view',
    inject_kb: true,
    params_summary: { id_or_name, sections },
  };

  if (!id_or_name) {
    return { success: false, error: 'id_or_name is required', envelopeShape };
  }

  try {
    // QSKL-7.3: Capture start time at the top of the try-block for latency measurement.
    const startTime = Date.now();

    // Try to find by ID first (org-scoped), then by name
    let record: QuoxSkillRecord | null = await ctx.store.findById(id_or_name, ctx.orgId);
    if (!record) {
      record = await ctx.store.findByName({ orgId: ctx.orgId, name: id_or_name });
    }

    if (!record) {
      // NOT an invocation — skill doesn't exist, infrastructure gap.
      return {
        success: false,
        error: `Skill "${id_or_name}" not found`,
        envelopeShape,
      };
    }

    // ── quox#748: human-review gate ───────────────────────────────────────────
    // A skill with an ACTIVE review-queue row (pending, or rejected) cannot be
    // loaded for an agent. Chat- and note-authored skills are queued for human
    // review at creation, so an agent can no longer write a skill and run it
    // in the same breath. No row (existing skills) or an approved row: runs.
    // NOT an invocation: nothing was executed.
    if (ctx.reviewQueueStore) {
      const active = await ctx.reviewQueueStore.findActiveBySkill(record.id);
      if (active) {
        const rejected = active.status === 'rejected';
        return {
          success: false,
          code: rejected ? 'SKILL_REVIEW_REJECTED' : 'SKILL_PENDING_REVIEW',
          error: rejected
            ? `Skill "${record.name}" was rejected in human review and cannot run.`
            : `Skill "${record.name}" is awaiting human review and cannot run until a person approves it (quox skills review list).`,
          review: { queue_row_id: active.id, status: active.status },
          envelopeShape,
        };
      }
    }

    // ── QSKL-HARDEN HRD-1: two-layer override merge ───────────────────────────
    // Merge BEFORE the firewall scan below so overridden text is scanned too —
    // an org/user override must not become an injection side-channel that
    // bypasses the load-time gate. Canonical `record` in the store is never
    // mutated; `record` here is reassigned to a merged shallow copy for the
    // remainder of this handler (firewall input + response body).
    const rawMergeInput: Record<string, unknown> = {
      description: record.description,
      notes: (record as unknown as Record<string, unknown>).notes,
      display_category: (record as unknown as Record<string, unknown>).display_category,
      default_params: (record as unknown as Record<string, unknown>).default_params,
    };
    const { merged: mergedFields, override_applied } = await mergeSkillOverridesForRead(rawMergeInput, {
      overridesStore: ctx.overridesStore,
      orgId: ctx.orgId,
      skillName: record.name,
      userId: ctx.userId,
    });
    if (override_applied) {
      record = { ...record, ...mergedFields } as QuoxSkillRecord;
    }

    // ── QSKL-SAFETY Gap 1: load-time firewall scan ────────────────────────────
    // Defends against post-publish drift: rows tampered via direct DB write,
    // migration backfill, or sideloaded import bypass the write-path firewall.
    // Scanning here closes the gap — a skill that bypassed publish never
    // reaches the LLM context.
    const loadFw = ctx.firewall ?? createSkillFirewall();
    const loadFwInput: SkillInput = {
      body_md: record.bodyMd,
      metadata: {
        name: record.name,
        description: record.description,
        tags: record.tags,
        author: record.author,
      } as Record<string, unknown>,
      author_id: record.author,
      tags: Array.isArray(record.tags) ? record.tags : [],
    };
    const loadFwReport = await loadFw.scan(loadFwInput);
    const loadFwVersionInt = parseInt(String(record.version).replace(/[^0-9]/g, '') || '1', 10);

    if (ctx.firewallLogStore) {
      try {
        await ctx.firewallLogStore.record({
          skill_id: record.id,
          pending_skill_name: null,
          version: loadFwVersionInt,
          org_id: ctx.orgId,
          author_id: record.author ?? null,
          scanned_at: loadFwReport.scanned_at,
          allow: loadFwReport.allow,
          findings: loadFwReport.findings,
          reason: loadFwReport.reason ?? null,
          rule_set_version: loadFwReport.rule_set_version,
          source: 'skill_view',
        });
      } catch (logErr) {
        viewLog.warn('firewallLogStore.record() failed (best-effort)', { error: logErr instanceof Error ? logErr.message : String(logErr) });
      }
    }

    if (!loadFwReport.allow && loadFwReport.reason !== 'disabled') {
      if (ctx.evidenceStore) {
        try {
          const blockMeta: Record<string, unknown> = {
            skill_id: record.id,
            skill_version: record.version,
            org_id: ctx.orgId,
            allow: false,
            finding_count: loadFwReport.findings.length,
            severity_max: loadFwReport.findings.reduce((max: string | null, f) => {
              const order = ['low', 'medium', 'high', 'block'];
              if (max === null) return f.severity;
              return order.indexOf(f.severity) > order.indexOf(max) ? f.severity : max;
            }, null),
            rule_set_version: loadFwReport.rule_set_version,
            source: 'skill_view',
            scanned_at: loadFwReport.scanned_at,
          };
          await ctx.evidenceStore.store({
            orgId: ctx.orgId,
            correlationId: record.id,
            envelopeId: ulid(),
            type: 'skill_firewall_scanned',
            contentType: 'application/json',
            content: JSON.stringify(blockMeta),
            metadata: blockMeta,
          });
        } catch (evErr) {
          viewLog.warn('evidenceStore.store(skill_firewall_scanned block) failed (best-effort)', { error: evErr instanceof Error ? evErr.message : String(evErr) });
        }
      }
      // QSKL-SAFETY Gap 6: emit AOCL layer-5 envelope for firewall block at load-time
      await emitQsklSafetyAocl({
        envelopeStore: ctx.envelopeStore,
        factory: _aoclFactory,
        correlationId: record.id,
        gate: 'skill_firewall',
        outcome: 'reject',
        skillId: record.id,
        skillName: record.name,
        orgId: ctx.orgId,
        extra: { source: 'skill_view', finding_count: loadFwReport.findings.length },
      });
      return {
        success: false,
        code: 'FIREWALL_BLOCKED',
        error: 'FIREWALL_BLOCKED',
        message: `Skill "${record.name}" body was rejected by the firewall at load (${loadFwReport.findings.length} finding(s)). Row may have drifted since publish.`,
        envelopeShape,
      };
    }

    // QSKL-SAFETY Gap 6: emit AOCL layer-5 complete envelope when firewall passes at load-time
    if (loadFwReport.allow) {
      await emitQsklSafetyAocl({
        envelopeStore: ctx.envelopeStore,
        factory: _aoclFactory,
        correlationId: record.id,
        gate: 'skill_firewall',
        outcome: 'complete',
        skillId: record.id,
        skillName: record.name,
        orgId: ctx.orgId,
        extra: { source: 'skill_view' },
      });
    }

    // ── QSKL-6.4b: Required-tools pre-flight ──────────────────────────────────
    const requiredTools = Array.isArray(record.requiredTools) && record.requiredTools.length > 0
      ? (record.requiredTools as RequiredToolSpec[])
      : null;

    if (requiredTools !== null) {
      // Default lookup: all tools missing (safe until Slice 8 wires a real registry)
      const lookup: ToolPresenceLookup = ctx.toolPresenceLookup ?? { isPresent: () => false };
      const edition = (record.edition === 'stable' ? 'stable' : 'experimental') as 'stable' | 'experimental';

      const check = await checkRequiredTools({
        requiredTools,
        edition,
        resolve: (spec) => lookup.isPresent(spec),
      });

      if (check.action === 'TRY_TOOLSMITH') {
        // Attempt to build only the first missing tool via the adapter
        const firstMissing = check.missing[0];
        const adapter = ctx.toolsmithAdapter;
        let toolBuilt = false;

        if (adapter) {
          const buildResult = await adapter.buildToolFromSkill(record.id, {
            name: firstMissing.name,
            version: firstMissing.version_constraint,
            policy: firstMissing.must_satisfy_policy,
          });

          if (buildResult.ok) {
            toolBuilt = true;
          } else {
            // Adapter failed — file HITL and return early (NOT an invocation)
            await fileSkillRequiredToolHITL({
              approvalEngine: ctx.approvalEngine,
              orgId: ctx.orgId,
              skillId: record.id,
              skillName: record.name,
              skillVersion: record.version,
              missingTools: check.missing,
              reason: buildResult.reason,
              detail: buildResult.detail,
            });
            return {
              success: false,
              code: 'REQUIRED_TOOL_MISSING',
              message: `Skill "${record.name}" requires a tool that is not yet available: ${check.missing.map(m => m.name).join(', ')}`,
              hitl_filed: true,
              missing_tools: check.missing,
              envelopeShape,
            };
          }
        }

        if (!toolBuilt) {
          // No adapter configured — file HITL and return early (NOT an invocation)
          await fileSkillRequiredToolHITL({
            approvalEngine: ctx.approvalEngine,
            orgId: ctx.orgId,
            skillId: record.id,
            skillName: record.name,
            skillVersion: record.version,
            missingTools: check.missing,
            reason: 'NOT_SHIPPED',
          });
          return {
            success: false,
            code: 'REQUIRED_TOOL_MISSING',
            message: `Skill "${record.name}" requires a tool that is not yet available: ${check.missing.map(m => m.name).join(', ')}`,
            hitl_filed: true,
            missing_tools: check.missing,
            envelopeShape,
          };
        }
      } else if (check.action === 'BLOCK_HITL') {
        // Stable edition + missing tools → BLOCK_HITL, no Toolsmith attempt (NOT an invocation)
        await fileSkillRequiredToolHITL({
          approvalEngine: ctx.approvalEngine,
          orgId: ctx.orgId,
          skillId: record.id,
          skillName: record.name,
          skillVersion: record.version,
          missingTools: check.missing,
          reason: 'BLOCKED_STABLE',
        });
        return {
          success: false,
          code: 'REQUIRED_TOOL_MISSING',
          message: `Skill "${record.name}" requires a tool that is not yet available: ${check.missing.map(m => m.name).join(', ')}`,
          hitl_filed: true,
          missing_tools: check.missing,
          envelopeShape,
        };
      }
      // action === 'PROCEED' → fall through to normal response
    }

    // Determine body to return
    let bodyMd: string;
    if (Array.isArray(sections) && sections.length > 0) {
      bodyMd = parseSections(record.bodyMd, sections);
    } else {
      bodyMd = record.bodyMd;
    }

    const data = {
      id: record.id,
      name: record.name,
      category: record.category,
      description: record.description,
      version: record.version,
      edition: record.edition,
      tags: record.tags,
      bestForAgents: record.bestForAgents,
      author: record.author,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      evals: record.evals,
      bodyMd,
      // QSKL-HARDEN HRD-1: present only when an org/user override was applied.
      ...(override_applied ? { override_applied } : {}),
    };

    // QSKL-7.3: Compute latency before telemetry writes so we can include it.
    const latencyMs = Date.now() - startTime;

    // QSKL-7.3: Build the typed invocation metadata payload.
    // QSKL-7.fix2: Populate tokens_used, cost_usd, and crystal_id from caller context.
    const llmUsage = ctx.lastLlmUsage ?? null;
    const tokensUsed = llmUsage ? llmUsage.input_tokens + llmUsage.output_tokens : 0;
    const costUsd = llmUsage
      ? estimateCostUsd(llmUsage.model, llmUsage.input_tokens, llmUsage.output_tokens)
      : 0;
    const crystalId = ctx.activeCrystalId ?? null;

    const invocationMetadata = {
      skill_id: record.id,
      skill_version: record.version,
      agent_id: ctx.agentId ?? 'unknown',
      session_id: ctx.sessionId ?? null,
      tokens_used: tokensUsed,
      cost_usd: costUsd,
      latency_ms: latencyMs,
      crystal_id: crystalId,
      success: true,
      drift_score: null as number | null,            // TODO QSKL-7: populate when Crystal reference snapshot computed
    };

    // Validate before emitting (fail fast if schema drifts; best-effort so catch below)
    SkillInvokedMetadataSchema.parse(invocationMetadata);

    const envelopeId = ulid();

    // Best-effort telemetry: failures here must NOT block the skill_view response.
    try {
      if (ctx.invocationsStore) {
        await ctx.invocationsStore.record({
          skillId: record.id,
          skillVersion: record.version,
          agentId: invocationMetadata.agent_id,
          sessionId: invocationMetadata.session_id ?? null,
          orgId: ctx.orgId,
          crystalId: invocationMetadata.crystal_id,
          tokensUsed: invocationMetadata.tokens_used,
          costUsd: invocationMetadata.cost_usd,
          latencyMs: invocationMetadata.latency_ms,
          success: invocationMetadata.success,
          driftScore: invocationMetadata.drift_score,
          envelopeId,
        });
      }
    } catch (telemetryErr: unknown) {
      viewLog.warn('invocationsStore.record() failed (best-effort)', { error: telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr) });
    }

    try {
      if (ctx.evidenceStore) {
        const correlationId = ctx.agentId ?? envelopeId;
        await ctx.evidenceStore.store({
            orgId: ctx.orgId,
          correlationId,
          envelopeId,
          type: 'skill_invoked',
          contentType: 'application/json',
          content: JSON.stringify(invocationMetadata),
          metadata: invocationMetadata as Record<string, unknown>,
        });
      }
    } catch (evidenceErr: unknown) {
      viewLog.warn('evidenceStore.store() failed (best-effort)', { error: evidenceErr instanceof Error ? evidenceErr.message : String(evidenceErr) });
    }

    // QSKL-7.5: Post-invocation auto-revert check. Fire-and-await (best-effort).
    // The hook defaults to runPostInvocationAutoRevertCheck; override via
    // ctx.postInvocationHook for test injection without Postgres.
    if (ctx.patchesStore && ctx.invocationsStore) {
      const postHookCtx: PostInvocationContext = {
        skillId: record.id,
        orgId: ctx.orgId,
        skillsStore: ctx.store,
        patchesStore: ctx.patchesStore,
        invocationsStore: ctx.invocationsStore,
        evidenceStore: ctx.evidenceStore,
        approvalEngine: ctx.approvalEngine,
      };
      const hook = ctx.postInvocationHook ?? runPostInvocationAutoRevertCheck;
      try {
        await hook(postHookCtx);
      } catch (hookErr: unknown) {
        viewLog.warn('postInvocationHook failed (best-effort)', { error: hookErr instanceof Error ? hookErr.message : String(hookErr) });
      }
    }

    // QSKL-11a: Mark this skill as recently used. Decay cron reads last_used_at.
    // Fire-and-await — sub-ms latency; failures are non-fatal.
    try {
      await ctx.store.setLastUsed(record.id, new Date().toISOString());
    } catch (touchErr: unknown) {
      viewLog.warn('setLastUsed() failed (non-fatal)', { error: touchErr instanceof Error ? touchErr.message : String(touchErr) });
    }

    // MEM-DECAY MD.2: any invocation resets decay_state to 'active' — a skill
    // that was dimmed ('cooling') or flagged ('archive_candidate') is, by
    // definition, back in active use. Idempotent no-op when already 'active'.
    // Fire-and-await, non-fatal — this must never block the skill_view response.
    try {
      if (record.decayState && record.decayState !== 'active') {
        await ctx.store.update(record.id, { decayState: 'active' });
      }
    } catch (decayResetErr: unknown) {
      viewLog.warn('decay_state reset on invocation failed (non-fatal)', { error: decayResetErr instanceof Error ? decayResetErr.message : String(decayResetErr) });
    }

    return { success: true, data, envelopeShape };
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      envelopeShape,
    };
  }
}

/**
 * Parse bodyMd by H2 headings and return only the requested sections
 * concatenated. If a section is not found, it contributes an empty string.
 */
function parseSections(bodyMd: string, sections: string[]): string {
  // Split on H2 headings
  const parts = bodyMd.split(/^(?=## )/m);

  const sectionMap = new Map<string, string>();
  for (const part of parts) {
    const headingMatch = part.match(/^## (.+)/);
    if (headingMatch) {
      const heading = headingMatch[1].trim();
      sectionMap.set(heading, part.trimEnd());
    }
  }

  const collected = sections
    .map(s => sectionMap.get(s) ?? '')
    .filter(Boolean)
    .join('\n');

  return collected;
}

// ─── skillManageHandler ───────────────────────────────────────────────────────

/**
 * Create, patch (metadata-only), or delete a skill.
 * Body-md patches are deferred to QSKL-4.
 */
export async function skillManageHandler(ctx: SkillsActionContext): Promise<SkillsActionResult> {
  const params = ctx.params as Record<string, unknown>;
  const action = params.action as string;

  const envelopeShape = {
    type: 'agentic.skill.manage',
    tool_name: 'skill_manage',
    params_summary: { action },
  };

  if (!action || !['create', 'patch', 'delete'].includes(action)) {
    return {
      success: false,
      error: `Unknown action "${action}". Valid actions: create, patch, delete`,
      envelopeShape,
    };
  }

  // ── CREATE ──────────────────────────────────────────────────────────────────
  if (action === 'create') {
    const {
      name,
      category,
      description,
      body_md: bodyMd,
      scopeId,
      author,
      tags,
      bestForAgents,
      requiredTools,
      relatedSkills,
      delegateTargets,
      llmPreference,
      modelDirectives,
      policySatisfies,
      policyRequired,
      kind,
      refs,
      scripts,
      tests,
    } = params as Record<string, unknown>;

    if (!name) {
      return { success: false, error: 'name is required for create', envelopeShape };
    }
    if (!category) {
      return { success: false, error: 'category is required for create', envelopeShape };
    }
    if (!description) {
      return { success: false, error: 'description is required for create', envelopeShape };
    }
    if (!bodyMd) {
      return { success: false, error: 'body_md is required for create', envelopeShape };
    }
    if (!scopeId) {
      return { success: false, error: 'scopeId is required for create', envelopeShape };
    }
    if (!author) {
      return { success: false, error: 'author is required for create', envelopeShape };
    }

    const authoringEnvelopeId = ulid();

    // ── QSKL-SAFETY.B: Firewall scan (pre-persist gate) ─────────────────────
    // QSKL-SAFETY Fix2: report lifted out of block scope so allow-path can
    // write the log row AFTER store.create() with the real skill_id.
    const fw = ctx.firewall ?? createSkillFirewall();
    const fwSkillInput: SkillInput = {
      body_md: bodyMd as string,
      references: refs as Record<string, string> | undefined,
      scripts: scripts as Record<string, string> | undefined,
      metadata: { name, description, tags, author } as Record<string, unknown>,
      author_id: typeof author === 'string' ? author : undefined,
      tags: Array.isArray(tags) ? tags as string[] : [],
    };
    const fwReport = await fw.scan(fwSkillInput);

    // ── QSKL-HARDEN HRD-2: dry_run short-circuit — BEFORE any write ─────────
    // No firewallLogStore row, no evidence envelope, no AOCL emission, no
    // ctx.store.create(). Returns the validated firewall verdict as a preview.
    const dryRun = Boolean((params as Record<string, unknown>).dry_run ?? (params as Record<string, unknown>).dryRun);
    if (dryRun) {
      return {
        success: fwReport.allow,
        ...(fwReport.allow ? {} : { code: 'FIREWALL_BLOCKED', error: 'FIREWALL_BLOCKED' }),
        message: fwReport.allow
          ? 'Dry run: skill would be created (firewall scan passed).'
          : `Dry run: skill body was rejected by the firewall (${fwReport.findings.length} finding(s))`,
        data: {
          dryRun: true,
          wouldCreate: fwReport.allow,
          findings: fwReport.findings,
          scanned_at: fwReport.scanned_at,
          rule_set_version: fwReport.rule_set_version,
        },
        envelopeShape,
      };
    }

    // BLOCK path: log with skill_id=null + pending_skill_name, emit evidence, then return early
    if (!fwReport.allow && fwReport.reason !== 'disabled') {
      if (ctx.firewallLogStore) {
        try {
          await ctx.firewallLogStore.record({
            skill_id: null,
            pending_skill_name: typeof name === 'string' ? name : null,
            version: 1,
            org_id: ctx.orgId,
            author_id: typeof author === 'string' ? author : null,
            scanned_at: fwReport.scanned_at,
            allow: false,
            findings: fwReport.findings,
            reason: fwReport.reason ?? null,
            rule_set_version: fwReport.rule_set_version,
            source: 'skill_manage',
          });
        } catch (logErr) {
          manageLog.warn('firewallLogStore.record() (block) failed (best-effort)', { error: logErr instanceof Error ? logErr.message : String(logErr) });
        }
      }
      // Best-effort evidence envelope for block-path (no real skill_id yet)
      if (ctx.evidenceStore) {
        try {
          const blockMeta: Record<string, unknown> = {
            skill_id: null,
            pending_skill_name: typeof name === 'string' ? name : null,
            org_id: ctx.orgId,
            allow: false,
            finding_count: fwReport.findings.length,
            severity_max: fwReport.findings.reduce((max: string | null, f) => {
              const order = ['low', 'medium', 'high', 'block'];
              if (max === null) return f.severity;
              return order.indexOf(f.severity) > order.indexOf(max) ? f.severity : max;
            }, null),
            rule_set_version: fwReport.rule_set_version,
            source: 'skill_manage',
            scanned_at: fwReport.scanned_at,
          };
          await ctx.evidenceStore.store({
            orgId: ctx.orgId,
            correlationId: authoringEnvelopeId,
            envelopeId: ulid(),
            type: 'skill_firewall_scanned',
            contentType: 'application/json',
            content: JSON.stringify(blockMeta),
            metadata: blockMeta,
          });
        } catch (evErr) {
          manageLog.warn('evidenceStore.store(skill_firewall_scanned block) failed (best-effort)', { error: evErr instanceof Error ? evErr.message : String(evErr) });
        }
      }
      // QSKL-SAFETY Gap 6: emit AOCL layer-5 envelope for firewall block on create
      await emitQsklSafetyAocl({
        envelopeStore: ctx.envelopeStore,
        factory: _aoclFactory,
        correlationId: authoringEnvelopeId,
        gate: 'skill_firewall',
        outcome: 'reject',
        skillName: typeof name === 'string' ? name : null,
        orgId: ctx.orgId,
        extra: { source: 'skill_manage_create', finding_count: fwReport.findings.length },
      });
      return {
        success: false,
        code: 'FIREWALL_BLOCKED',
        error: 'FIREWALL_BLOCKED',
        message: `Skill body was rejected by the firewall (${fwReport.findings.length} finding(s))`,
        data: {
          findings: fwReport.findings,
          scanned_at: fwReport.scanned_at,
          rule_set_version: fwReport.rule_set_version,
        },
        envelopeShape,
      };
    }

    try {
      const record = await ctx.store.create({
        orgId: ctx.orgId,
        scopeId: scopeId as string,
        name: name as string,
        category: category as string,
        description: description as string,
        bodyMd: bodyMd as string,
        author: author as string,
        authoringEnvelopeId,
        tags: Array.isArray(tags) ? tags as string[] : [],
        bestForAgents: Array.isArray(bestForAgents) ? bestForAgents as string[] : [],
        requiredTools: Array.isArray(requiredTools) ? requiredTools : undefined,
        relatedSkills: Array.isArray(relatedSkills) ? relatedSkills : undefined,
        delegateTargets: Array.isArray(delegateTargets) ? delegateTargets : undefined,
        llmPreference: llmPreference as Record<string, unknown> | undefined,
        modelDirectives: modelDirectives as Record<string, string> | undefined,
        policySatisfies: Array.isArray(policySatisfies) ? policySatisfies as string[] : undefined,
        policyRequired: Array.isArray(policyRequired) ? policyRequired as string[] : undefined,
        kind: kind as string | undefined,
        refs: refs as Record<string, string> | undefined,
        scripts: scripts as Record<string, string> | undefined,
        tests: tests as Record<string, unknown> | undefined,
      });

      // quox#748: an agent-written skill is queued for HUMAN review and cannot
      // be loaded by skill_view until a person approves it.
      await queueHumanReview(ctx.reviewQueueStore, {
        skillId: record.id, version: record.version, orgId: ctx.orgId,
        author: (author as string) ?? ctx.agentId ?? null, source: 'agentic_executor',
      });

      // ALLOW path: log with real skill_id after DB insert
      if (fwReport.reason !== 'disabled' && ctx.firewallLogStore) {
        try {
          await ctx.firewallLogStore.record({
            skill_id: record.id,
            pending_skill_name: null,
            version: 1,
            org_id: ctx.orgId,
            author_id: typeof author === 'string' ? author : null,
            scanned_at: fwReport.scanned_at,
            allow: true,
            findings: fwReport.findings,
            reason: fwReport.reason ?? null,
            rule_set_version: fwReport.rule_set_version,
            source: 'skill_manage',
          });
        } catch (logErr) {
          manageLog.warn('firewallLogStore.record() (allow) failed (best-effort)', { error: logErr instanceof Error ? logErr.message : String(logErr) });
        }
      }

      // Best-effort evidence envelope emission (use real skill id)
      if (fwReport.reason !== 'disabled' && ctx.evidenceStore) {
        try {
          const envelopeMeta: Record<string, unknown> = {
            skill_id: record.id,
            org_id: ctx.orgId,
            allow: fwReport.allow,
            finding_count: fwReport.findings.length,
            severity_max: fwReport.findings.reduce((max: string | null, f) => {
              const order = ['low', 'medium', 'high', 'block'];
              if (max === null) return f.severity;
              return order.indexOf(f.severity) > order.indexOf(max) ? f.severity : max;
            }, null),
            rule_set_version: fwReport.rule_set_version,
            source: 'skill_manage',
            scanned_at: fwReport.scanned_at,
          };
          await ctx.evidenceStore.store({
            orgId: ctx.orgId,
            correlationId: record.id,
            envelopeId: ulid(),
            type: 'skill_firewall_scanned',
            contentType: 'application/json',
            content: JSON.stringify(envelopeMeta),
            metadata: envelopeMeta,
          });
        } catch (evErr) {
          manageLog.warn('evidenceStore.store(skill_firewall_scanned) failed (best-effort)', { error: evErr instanceof Error ? evErr.message : String(evErr) });
        }
      }

      // QSKL-SAFETY Gap 6: emit AOCL layer-5 complete envelope on create allow-path
      if (fwReport.reason !== 'disabled') {
        await emitQsklSafetyAocl({
          envelopeStore: ctx.envelopeStore,
          factory: _aoclFactory,
          correlationId: record.id,
          gate: 'skill_firewall',
          outcome: 'complete',
          skillId: record.id,
          skillName: record.name,
          orgId: ctx.orgId,
          extra: { source: 'skill_manage_create' },
        });
      }

      return { success: true, data: record, envelopeShape };
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        envelopeShape,
      };
    }
  }

  // ── PATCH ────────────────────────────────────────────────────────────────────
  if (action === 'patch') {
    const { id, body_md } = params as { id?: string; body_md?: string };

    if (!id) {
      return { success: false, error: 'id is required for patch', envelopeShape };
    }

    // Verify the skill exists (org-scoped: 404 on cross-org)
    const existing = await ctx.store.findById(id, ctx.orgId);
    if (!existing) {
      return {
        success: false,
        error: `Skill "${id}" not found`,
        envelopeShape,
      };
    }

    // ── body_md patch: Crystal-eval → version bump → patches row ─────────────
    if (body_md !== undefined) {
      const { reason, step_diff } = params as { reason?: string; step_diff?: unknown };
      // QSKL-HARDEN HRD-2: dry_run threads through to applySkillPatch AND
      // suppresses the firewall log row / evidence envelope / AOCL emission
      // below — a preview must not write anything, even for the firewall gate.
      const dryRun = Boolean((params as Record<string, unknown>).dry_run ?? (params as Record<string, unknown>).dryRun);

      // ── QSKL-SAFETY.B: Firewall scan BEFORE rate-limiter check ────────────
      {
        const fw = ctx.firewall ?? createSkillFirewall();
        const skillInput: SkillInput = {
          body_md,
          metadata: existing ? { name: existing.name, description: existing.description } : {},
          author_id: ctx.agentId,
          tags: existing?.tags ?? [],
        };
        const report = await fw.scan(skillInput);

        if (report.reason !== 'disabled' && !dryRun) {
          if (ctx.firewallLogStore) {
            try {
              await ctx.firewallLogStore.record({
                skill_id: id,
                version: existing ? (parseInt(existing.version, 10) || 1) + 1 : 1,
                org_id: ctx.orgId,
                author_id: ctx.agentId ?? null,
                scanned_at: report.scanned_at,
                allow: report.allow,
                findings: report.findings,
                reason: report.reason ?? null,
                rule_set_version: report.rule_set_version,
                source: 'skill_manage',
              });
            } catch (logErr) {
              managePatchLog.warn('firewallLogStore.record() failed (best-effort)', { error: logErr instanceof Error ? logErr.message : String(logErr) });
            }
          }

          if (ctx.evidenceStore) {
            try {
              const envelopeMeta: Record<string, unknown> = {
                skill_id: id,
                org_id: ctx.orgId,
                allow: report.allow,
                finding_count: report.findings.length,
                severity_max: report.findings.reduce((max: string | null, f) => {
                  const order = ['low', 'medium', 'high', 'block'];
                  if (max === null) return f.severity;
                  return order.indexOf(f.severity) > order.indexOf(max) ? f.severity : max;
                }, null),
                rule_set_version: report.rule_set_version,
                source: 'skill_manage',
                scanned_at: report.scanned_at,
              };
              await ctx.evidenceStore.store({
            orgId: ctx.orgId,
                correlationId: id,
                envelopeId: ulid(),
                type: 'skill_firewall_scanned',
                contentType: 'application/json',
                content: JSON.stringify(envelopeMeta),
                metadata: envelopeMeta,
              });
            } catch (evErr) {
              managePatchLog.warn('evidenceStore.store(skill_firewall_scanned) failed (best-effort)', { error: evErr instanceof Error ? evErr.message : String(evErr) });
            }
          }
        }

        if (!report.allow) {
          // QSKL-SAFETY Gap 6: emit AOCL layer-5 envelope for firewall block on patch
          // (skipped in dry-run — a preview must not emit governance envelopes)
          if (!dryRun) {
            await emitQsklSafetyAocl({
              envelopeStore: ctx.envelopeStore,
              factory: _aoclFactory,
              correlationId: id,
              gate: 'skill_firewall',
              outcome: 'reject',
              skillId: id,
              skillName: existing?.name ?? null,
              orgId: ctx.orgId,
              extra: { source: 'skill_manage_patch', finding_count: report.findings.length },
            });
          }
          return {
            success: false,
            code: 'FIREWALL_BLOCKED',
            error: 'FIREWALL_BLOCKED',
            message: `Skill patch was rejected by the firewall (${report.findings.length} finding(s))`,
            data: {
              findings: report.findings,
              scanned_at: report.scanned_at,
              rule_set_version: report.rule_set_version,
            },
            envelopeShape,
          };
        }

        // QSKL-SAFETY Gap 6: emit AOCL layer-5 complete envelope when patch firewall passes
        if (report.allow && report.reason !== 'disabled' && !dryRun) {
          await emitQsklSafetyAocl({
            envelopeStore: ctx.envelopeStore,
            factory: _aoclFactory,
            correlationId: id,
            gate: 'skill_firewall',
            outcome: 'complete',
            skillId: id,
            skillName: existing?.name ?? null,
            orgId: ctx.orgId,
            extra: { source: 'skill_manage_patch' },
          });
        }
      }

      const result = await applySkillPatch({
        skillsStore: ctx.store,
        patchesStore: ctx.patchesStore,
        skillLibraryStore: ctx.skillLibraryStore,
        evidenceStore: ctx.evidenceStore,
        approvalEngine: ctx.approvalEngine,
        toolsmithAdapter: ctx.toolsmithAdapter,
        toolPresenceLookup: ctx.toolPresenceLookup,
        patchRateLimiter: ctx.patchRateLimiter,
        orgId: ctx.orgId,
        skillId: id,
        newBodyMd: body_md,
        patchedBy: ctx.agentId ?? 'system',
        reason: reason ?? null,
        stepDiff: step_diff,
        dryRun,
      });

      if (!result.ok) {
        if (result.code === 'CRYSTALS_REGRESSED') {
          return {
            success: false,
            error: 'PATCH_CRYSTALS_REGRESSED',
            message: `${result.crystalsFailed.length} Crystal(s) failed evaluation. Patch was not promoted.`,
            envelopeShape,
          };
        }
        if (result.code === 'RATE_LIMITED') {
          return {
            success: false,
            error: 'RATE_LIMITED',
            code: 'RATE_LIMITED',
            message: `Agent patch rate limit reached (${result.count}/${result.threshold}). Retry after ${result.retry_after}s.`,
            envelopeShape,
          };
        }
        if (result.code === 'TESTS_FAILED') {
          return {
            success: false,
            error: 'PATCH_TESTS_FAILED',
            message: `${result.testsFailed.length} of ${result.testsRun} author-written test(s) failed. Patch was not promoted.`,
            envelopeShape,
          };
        }
        if (result.code === 'REQUIRED_TOOL_MISSING') {
          return {
            success: false,
            error: 'REQUIRED_TOOL_MISSING',
            code: 'REQUIRED_TOOL_MISSING',
            message: result.message,
            hitl_filed: result.hitl_filed,
            missing_tools: result.missing_tools,
            envelopeShape,
          };
        }
        return {
          success: false,
          error: result.code === 'STORE_ERROR' ? result.message : `Skill "${id}" not found`,
          envelopeShape,
        };
      }

      // QSKL-HARDEN HRD-2: dry-run preview — no skill/patch was persisted.
      if ('dryRun' in result) {
        return {
          success: true,
          data: {
            dryRun: true,
            diff: result.diff,
            testsOutcome: result.testsOutcome,
            crystalEvalOutcome: result.crystalEvalOutcome,
            wouldPromote: result.wouldPromote,
          },
          envelopeShape,
        };
      }

      return {
        success: true,
        data: { skill: result.skill, patch: result.patch },
        envelopeShape,
      };
    }

    // ── metadata-only patch (no body_md) ─────────────────────────────────────
    const {
      description,
      tags,
      bestForAgents,
      requiredTools,
      relatedSkills,
      delegateTargets,
      llmPreference,
      modelDirectives,
      policySatisfies,
      policyRequired,
      edition,
      decayState,
      lastPatchedBy,
      lastPatchEnvelopeId,
    } = params as Record<string, unknown>;

    const patch: Record<string, unknown> = {};
    if (description !== undefined) patch.description = description;
    if (tags !== undefined) patch.tags = tags;
    if (bestForAgents !== undefined) patch.bestForAgents = bestForAgents;
    if (requiredTools !== undefined) patch.requiredTools = requiredTools;
    if (relatedSkills !== undefined) patch.relatedSkills = relatedSkills;
    if (delegateTargets !== undefined) patch.delegateTargets = delegateTargets;
    if (llmPreference !== undefined) patch.llmPreference = llmPreference;
    if (modelDirectives !== undefined) patch.modelDirectives = modelDirectives;
    if (policySatisfies !== undefined) patch.policySatisfies = policySatisfies;
    if (policyRequired !== undefined) patch.policyRequired = policyRequired;
    if (edition !== undefined) patch.edition = edition;
    if (decayState !== undefined) patch.decayState = decayState;
    if (lastPatchedBy !== undefined) patch.lastPatchedBy = lastPatchedBy;
    if (lastPatchEnvelopeId !== undefined) patch.lastPatchEnvelopeId = lastPatchEnvelopeId;

    // ── QSKL-SAFETY.E: Promotion gate ───────────────────────────────────────
    // Block experimental→stable when a pending or rejected review queue row exists.
    // This must fire BEFORE the store.update() call.
    if (edition === 'stable' && ctx.reviewQueueStore) {
      const activeRow = await ctx.reviewQueueStore.findActiveBySkill(id);
      if (activeRow) {
        // Emit promotion_gated envelope (best-effort)
        if (ctx.evidenceStore) {
          try {
            const gatedMeta: Record<string, unknown> = {
              skill_id: id,
              org_id: ctx.orgId,
              queue_row_id: activeRow.id,
              queue_status: activeRow.status,
              reason: 'PROMOTION_GATED_BY_REVIEW',
            };
            await ctx.evidenceStore.store({
            orgId: ctx.orgId,
              correlationId: id,
              envelopeId: ulid(),
              type: 'skill.promotion_gated',
              contentType: 'application/json',
              content: JSON.stringify(gatedMeta),
              metadata: gatedMeta,
            });
          } catch (evErr) {
            manageLog.warn('evidenceStore.store(skill.promotion_gated) failed (best-effort)', { error: evErr instanceof Error ? evErr.message : String(evErr) });
          }
        }
        // QSKL-SAFETY Gap 6: emit AOCL layer-5 envelope for promotion gate block
        await emitQsklSafetyAocl({
          envelopeStore: ctx.envelopeStore,
          factory: _aoclFactory,
          correlationId: id,
          gate: 'skill_promotion',
          outcome: 'reject',
          skillId: id,
          skillName: existing?.name ?? null,
          orgId: ctx.orgId,
          extra: { queue_row_id: activeRow.id, queue_status: activeRow.status },
        });
        return {
          success: false,
          code: 'PROMOTION_GATED_BY_REVIEW',
          error: 'PROMOTION_GATED_BY_REVIEW',
          message: `Skill cannot be promoted to stable: an active review queue entry exists (status=${activeRow.status}, id=${activeRow.id})`,
          data: { queue_row_id: activeRow.id, queue_status: activeRow.status },
          envelopeShape,
        };
      }
    }

    try {
      const updated = await ctx.store.update(id, patch as any);
      return { success: true, data: updated, envelopeShape };
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        envelopeShape,
      };
    }
  }

  // ── DELETE ───────────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const { id } = params as { id?: string };

    if (!id) {
      return { success: false, error: 'id is required for delete', envelopeShape };
    }

    // Verify existence first (org-scoped: cannot delete cross-org)
    const existing = await ctx.store.findById(id, ctx.orgId);
    if (!existing) {
      return {
        success: false,
        error: `Skill "${id}" does not exist`,
        envelopeShape,
      };
    }

    try {
      await ctx.store.delete(id);
      return { success: true, data: { deleted: true, id }, envelopeShape };
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        envelopeShape,
      };
    }
  }

  // Unreachable but TypeScript needs the return
  return { success: false, error: `Unknown action "${action}"`, envelopeShape };
}
