/**
 * Agentic Executor — The Brain
 *
 * Implements the observe-think-act loop for goal-driven execution.
 * Instead of following a pre-defined step sequence, this executor:
 *
 * 1. Executes the initial action from the node config
 * 2. OBSERVES the result (via observation registry)
 * 3. THINKS about what to do next (LLM call)
 * 4. ACTS on the decision (dispatches to other executors)
 * 5. Loops until the objective is met or max iterations reached
 *
 * The node config provides:
 *   - objective: what we're trying to achieve
 *   - initial_action: first action to take (optional)
 *   - agent_id: which agent's persona/tools to use
 *   - max_iterations: safety limit (default 10)
 *   - observation_type: what kind of observation to capture
 *   - available_actions: which action types the agent can use
 *
 * Every decision is evidenced via AOCL envelopes.
 */

import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, EnvelopeFactory, Intents } from '../core/envelope.js';
import { processValue } from '../expression/engine.js';
import { ObservationRegistry, createDefaultObservationRegistry } from '../pipeline/observation-registry.js';
import { Observation } from '../pipeline/lifecycle-hooks.js';
import { BudgetEvaluator } from '../budget/budget-evaluator.js';
import { BudgetScopeKind } from '../budget/budget-store.js';
import { computeCostUsdMicro } from '../budget/model-pricing.js';
import { SkillLibraryStore } from '../store/skill-library-store.js';
import { analyseDraft } from '../pipeline/crystalliser.js';
import { runContradictionGate } from '../pipeline/contradiction-gate.js';
import type { ExecutionHistoryStore } from '../store/execution-history-store.js';
import { QuoxSkillsStore } from '../store/quox-skills-store.js';
import { QuoxSkillPatchesStore } from '../store/quox-skill-patches-store.js';
import { skillsListHandler, skillViewHandler, skillManageHandler } from '../agentic/skills-actions.js';
import { sessionSearchHandler } from '../agentic/session-search-actions.js';
import type { SessionSearchStore } from '../agentic/session-search-actions.js';
import type { ToolsmithAdapter } from '../agentic/toolsmith-adapter.js';
import type { ToolPresenceLookup } from '../agentic/tool-presence-lookup.js';
import type { QuoxSkillInvocationsStore } from '../store/quox-skill-invocations-store.js';
import type { PatchRateLimiter } from '../agentic/skill-patch-rate-limiter.js';
import { buildNonBrowserPlatformSuffix } from '../agentic/agent-platform-prompt.js';
import { createSkillFirewall } from '../security/skill_firewall.js';
import type { SkillFirewall } from '../security/skill_firewall.js';
import type { SkillFirewallLogStore } from '../store/skill-firewall-log-store.js';
import type { SkillReviewQueueStore } from '../store/skill-review-queue-store.js';
import { fetchPersona } from '../agentic/persona-fetcher.js';
import { buildLlmUsagePayload } from './lib/llm-envelope.js';
import { combineAbortSignals } from './lib/abort-utils.js';
import { logger } from '../logger.js';
import { hashSnapshot } from '../store/crystal-canonical-hash.js';
import { verifyCrystalSignature } from '../store/crystal-signature-verify.js';
import { enforcePrecedentCitation } from '../pipeline/precedent-gate.js';
import type { PrecedentRecord, PrecedentStore } from '../store/precedent-store.js';

const log = logger.for('AgenticExecutor');
const bqSmartLog = logger.for('BQ-SMART');

const DEFAULT_MAX_ITERATIONS = 10;
const THINK_TIMEOUT_MS = 90000; // 90s — CLI path takes 20-30s per call

/**
 * QSKL-3: Default interval for the skill creation nudge.
 * Every N agentic-loop iterations after the first LLM call, prepend a one-liner
 * prompting the LLM to consider saving a skill via skill_manage(action='create').
 * Per-node config (skills_creation_nudge_interval) or per-agent override can
 * change this, or set it to 'off' to disable entirely.
 */
const DEFAULT_CREATION_NUDGE_INTERVAL = 15;

/**
 * QSKL-3: Agents for which the nudge is disabled by default.
 * SENTINEL is included because it runs deterministic health-check loops and
 * the nudge would distract from the structured pattern.
 */
const NUDGE_DISABLED_AGENTS = new Set(['sentinel']);

interface AgenticConfig {
  /** The goal to achieve */
  objective: string;
  /** Which agent's persona to use for thinking */
  agent_id?: string;
  /** Max observe-think-act iterations */
  max_iterations?: number;
  /** First action to take (optional — if omitted, the thinker decides) */
  initial_action?: { type: string; config: Record<string, unknown> };
  /** Action types available to this agent */
  available_actions?: string[];
  /** URL of the collector for LLM calls */
  collector_url?: string;
  /** Service key for internal API calls */
  service_key?: string;
  /** URL of the screencap service for direct browser actions */
  screencap_url?: string;
  /** URL for progress callbacks (tasks service) */
  progress_callback_url?: string;
  /** Objective ID for progress callbacks */
  objective_id?: string;
  /** P8.B: Budget scope ID for iteration budget checks */
  budget_scope_id?: string;
  /** P8.B: Org ID for budget scoping */
  org_id?: string;
  /** P9.1: Pre-loop crystal retrieval config */
  crystal_retrieval?: {
    enabled: boolean;
    max_crystals: number;
    match: 'agent_id' | 'objective_keyword' | 'both';
  };
  /**
   * REPLAY-ONLY .A1 (G5): Deterministic pinned Crystal binding — a
   * `workflow node -> crystal_id (+version)` mapping. Under replay-only mode
   * this REPLACES fuzzy findApplicable() matching entirely: it is the only
   * legal Crystal resolution path (fuzzy matching is forbidden under
   * replay-only — a rephrased objective could miss, or worse, the wrong
   * crystal could win the match and replay the wrong action sequence,
   * signed and verified and incorrect). Outside replay-only this field is
   * ignored; the fuzzy findApplicable() path remains the (unchanged)
   * optimisation used there.
   */
  crystal_binding?: {
    crystal_id: string;
    /** Optional version pin — if the resolved record's version differs, abort (drift). */
    version?: number;
  };
  /** P9.2: Mid-loop crystal drafting config */
  crystal_drafting?: {
    enabled: boolean;
    min_iteration: number;
  };
  /** P9.3: Observation-diff refinement config */
  crystal_refinement?: {
    enabled: boolean;
    max_refines: number;
  };
  /**
   * QSKL-3: Per-node override for the skill creation nudge interval.
   * - Number: nudge every N iterations.
   * - 'off': disable the nudge entirely for this node (overrides agent default).
   * - Omitted: use agent-level default (SENTINEL → 'off', all others → 15).
   */
  skills_creation_nudge_interval?: number | 'off';
  /** P9.4: Task-time promotion threshold config */
  crystal_promotion_threshold?: {
    confidence: number;
    consecutive_success: number;
    /**
     * AGH-1.fix-2: minimum number of real tool actions (excluding done /
     * propose_crystal / refine_crystal) the LLM must complete before the
     * engine accepts a 'done' decision. Default = 3 (matches the typical
     * canonical pattern length). Set to 0 to disable. Catches LLM
     * hallucination ("I made 3 calls" after 1) by rejecting premature
     * done and injecting an engine_nudge.
     */
    min_actions_before_done?: number;
  };
}

interface ThinkDecision {
  reasoning: string;
  action: string;
  params: Record<string, unknown>;
  objective_met: boolean;
  confidence?: number;
}

/**
 * REPLAY-ONLY .B3: the shape returned by auth's crystal public-key oracle
 * (GET /api/internal/crystals/public-key/:orgId, shipped in .B1a). Mirrors
 * CrystalSignerResult in skill-library-store.ts — quoxflow only ever sees
 * the public key material, never the private CSK.
 */
export interface OrgPublicKeyResult {
  public_key_hex: string;
  key_id: string;
  algorithm: string;
}

/**
 * REPLAY-ONLY .B3: optional dependency-injected public-key fetcher, mirroring
 * how CrystalSigner (skill-library-store.ts) is threaded through config in
 * server.ts. Must never throw — the real implementation logs and resolves to
 * null on any failure (non-2xx, network error) so the replay gate can
 * fail-closed with `replay_only_signature_invalid` rather than crashing.
 */
export type FetchOrgPublicKey = (orgId: string) => Promise<OrgPublicKeyResult | null>;

export class AgenticExecutor implements NodeExecutor {
  readonly nodeTypes = ['agent:agentic'];
  readonly hasExternalEffect = true;
  private observationRegistry: ObservationRegistry;
  private budgetEvaluator?: BudgetEvaluator;
  private skillLibraryStore?: SkillLibraryStore;
  /** MEM-DECAY MD.3: lineage graph store. When set, the P9.1 crystal-retrieval
   * site also forward-feeds the last N failure lessons for this workflow. */
  private executionHistoryStore?: ExecutionHistoryStore;
  /**
   * REPLAY-ONLY .B3: injected org public-key fetcher (wired to auth's
   * crystals/public-key oracle from server.ts). Undefined in tests that
   * don't wire it — the signature-verify gate then aborts
   * `replay_only_signature_invalid` (fail-closed, never throws).
   */
  private fetchOrgPublicKey?: FetchOrgPublicKey;
  /**
   * REPLAY-ONLY .B3: in-process per-org cache of the fetched public key.
   * Public key material is public and low-churn (rotation is rare) — this
   * avoids one HTTP round-trip per replay. Cleared only by process restart
   * (a follow-up can add TTL/invalidation if rotation needs to take effect
   * without a restart — out of scope for B3, see docs/STREAM_REPLAY_ONLY_FABLE_REVIEW.md).
   */
  private orgPublicKeyCache: Map<string, OrgPublicKeyResult> = new Map();
  private quoxSkillsStore?: QuoxSkillsStore;
  private quoxSkillPatchesStore?: QuoxSkillPatchesStore;
  private evidenceStore?: import('../evidence/types.js').EvidenceStore;
  private approvalEngine?: import('../approval/approval-engine.js').ApprovalEngine;
  private toolsmithAdapter?: ToolsmithAdapter;
  private toolPresenceLookup?: ToolPresenceLookup;
  private quoxSkillInvocationsStore?: QuoxSkillInvocationsStore;
  /** QSKL-13: Session search store. Enables session_search action in the agentic loop. */
  private sessionSearchStore?: SessionSearchStore;
  /** QSKL-14a: Per-agent patch rate-limiter. */
  private patchRateLimiter?: PatchRateLimiter;
  /** QSKL-SAFETY.B: Firewall instance injected from server.ts. Defaults to createSkillFirewall(). */
  private skillFirewall?: SkillFirewall;
  /** QSKL-SAFETY.B: Firewall log store injected from server.ts. */
  private skillFirewallLogStore?: SkillFirewallLogStore;
  /** QSKL-SAFETY.E: Review queue store injected from server.ts. */
  private skillReviewQueueStore?: SkillReviewQueueStore;
  /** QSKL-SAFETY Gap 6: Envelope store for AOCL gate emissions, injected from server.ts. */
  private _envelopeStore?: import('../store/envelope-store.js').EnvelopeStore;
  /**
   * PRECEDENT wiring: judgment-call precedent store, injected from server.ts.
   * When set (and the org has active precedents matching this run's fact
   * pattern) the terminal 'done' branch requires the decision reasoning to
   * follow or distinguish one of them. Unset, or an empty store, leaves the
   * loop behaving exactly as it did before.
   */
  private precedentStore?: PrecedentStore;
  /**
   * QSKL-12: Persona fetcher — injectable for production wiring.
   * Defaults to a no-op (null) so existing tests that don't wire this
   * store are unaffected. In production, server.ts calls setPersonaFetcher
   * to provide the real fetchPersona implementation.
   */
  private _personaFetcher: (opts: { collectorUrl: string; agentId: string }) => Promise<string | null>
    = async () => null;

  /** Wire the real persona fetcher (called from server.ts after startup). */
  setPersonaFetcher(fn: (opts: { collectorUrl: string; agentId: string }) => Promise<string | null>): void {
    this._personaFetcher = fn;
  }

  /**
   * QSKL-7.fix2: Captures the token usage from the most-recent think() call.
   * Set inside thinkNonBrowser() / think() after each LLM response.
   * Read when building skillsCtx to populate lastLlmUsage for skillViewHandler.
   * Scoped per-execution (reset at think() entry) — no cross-execution leakage.
   */
  private _lastThinkUsage: { model: string; input_tokens: number; output_tokens: number; provider?: string } | null = null;

  constructor(
    observationRegistry?: ObservationRegistry,
    budgetEvaluator?: BudgetEvaluator,
    skillLibraryStore?: SkillLibraryStore,
  ) {
    this.observationRegistry = observationRegistry || createDefaultObservationRegistry();
    this.budgetEvaluator = budgetEvaluator;
    this.skillLibraryStore = skillLibraryStore;
  }

  /**
   * P9 wiring: called from server.ts after skillLibraryStore is constructed,
   * so the module-level singleton receives the store before any execution fires.
   */
  setSkillLibraryStore(store: SkillLibraryStore): void {
    this.skillLibraryStore = store;
  }

  /**
   * MEM-DECAY MD.3 wiring: called from server.ts after executionHistoryStore
   * is constructed. Enables the lineage forward-feed (last N failure lessons
   * for this workflow) at the P9.1 crystal-retrieval injection site. Best-
   * effort: if not set, priorLessons is always empty and the prompt block
   * is simply omitted.
   */
  setExecutionHistoryStore(store: ExecutionHistoryStore): void {
    this.executionHistoryStore = store;
  }

  /**
   * REPLAY-ONLY .B3 wiring: called from server.ts with a closure hitting
   * auth's GET /api/internal/crystals/public-key/:orgId (X-Service-Key
   * gated), mirroring the crystalSigner injection pattern from .B2. Enables
   * the executor's replay-only signature-verify gate; if never set, the
   * gate fails closed with `replay_only_signature_invalid`.
   */
  setFetchOrgPublicKey(fn: FetchOrgPublicKey): void {
    this.fetchOrgPublicKey = fn;
  }

  /**
   * P8.B wiring: called from server.ts after budgetEvaluator is constructed,
   * so the per-iteration budget check at line 320 actually fires in production.
   */
  setBudgetEvaluator(evaluator: BudgetEvaluator): void {
    this.budgetEvaluator = evaluator;
  }

  /**
   * QSKL-2 wiring: called from server.ts after quoxSkillsStore is constructed.
   * Enables skills_list / skill_view / skill_manage actions in the agentic loop.
   */
  setQuoxSkillsStore(store: QuoxSkillsStore): void {
    this.quoxSkillsStore = store;
  }

  /**
   * QSKL-4.A wiring: called from server.ts after quoxSkillPatchesStore is constructed.
   * Required for skill_manage(action='patch') with body_md to write audit rows.
   * If not set when skill_manage(patch+body_md) is called, the handler will throw.
   */
  setQuoxSkillPatchesStore(store: QuoxSkillPatchesStore): void {
    this.quoxSkillPatchesStore = store;
  }

  /**
   * QSKL-4.D wiring: called from server.ts after evidenceStore is constructed.
   * Enables VOLT evidence emission on every skill patch attempt.
   */
  setEvidenceStore(store: import('../evidence/types.js').EvidenceStore): void {
    this.evidenceStore = store;
  }

  /**
   * QSKL-4.D wiring: called from server.ts after approvalEngine is constructed.
   * Enables HITL inbox routing on Crystal regression failures.
   */
  setApprovalEngine(engine: import('../approval/approval-engine.js').ApprovalEngine): void {
    this.approvalEngine = engine;
  }

  /**
   * QSKL-6 wiring: called from server.ts after the Toolsmith adapter is
   * constructed (createCollectorToolsmithAdapter — real collector-backed
   * implementation; agentic/toolsmith-adapter.ts's stubToolsmithAdapter
   * remains available for tests/fallback).
   * The skill_view / skill_manage pre-flight check uses this to attempt
   * building missing required tools before falling back to HITL.
   */
  setToolsmithAdapter(adapter: ToolsmithAdapter): void {
    this.toolsmithAdapter = adapter;
  }

  /**
   * QSKL-6 wiring: optional tool-presence resolver injected from server.ts.
   * Until a registry-backed lookup ships, this stays unset and the pre-flight
   * check treats every required_tool as missing (safe default).
   */
  setToolPresenceLookup(lookup: ToolPresenceLookup): void {
    this.toolPresenceLookup = lookup;
  }

  /**
   * QSKL-7.8 wiring: called from server.ts after quoxSkillInvocationsStore is
   * constructed. Enables per-invocation telemetry writes in skillViewHandler.
   * Best-effort: if not set, skillViewHandler silently skips the telemetry write.
   */
  setSkillInvocationsStore(store: QuoxSkillInvocationsStore): void {
    this.quoxSkillInvocationsStore = store;
  }

  /**
   * QSKL-13 wiring: called from server.ts after sessionSearchStore is constructed.
   * Enables session_search action in the agentic loop. Degrades gracefully
   * (in-memory no-op) if not set — the action returns a zero-hits hint.
   */
  setSessionSearchStore(store: SessionSearchStore): void {
    this.sessionSearchStore = store;
  }

  /**
   * QSKL-14a wiring: called from server.ts after patchRateLimiter is constructed.
   * Enables per-agent patch rate-limiting in the skill_manage patch path.
   */
  setPatchRateLimiter(rl: PatchRateLimiter): void {
    this.patchRateLimiter = rl;
  }

  /**
   * QSKL-SAFETY.B wiring: called from server.ts after firewall is constructed.
   * When not set, skillManageHandler defaults to createSkillFirewall() internally.
   */
  setSkillFirewall(firewall: SkillFirewall): void {
    this.skillFirewall = firewall;
  }

  /**
   * QSKL-SAFETY.B wiring: called from server.ts after firewallLogStore is constructed.
   * When not set, no firewall log rows are written (best-effort — no log noise in
   * in-memory / test modes without a log store configured).
   */
  setSkillFirewallLogStore(store: SkillFirewallLogStore): void {
    this.skillFirewallLogStore = store;
  }

  /**
   * QSKL-SAFETY.E wiring: called from server.ts after reviewQueueStore is constructed.
   * Enables the promotion gate in skillManageHandler (blocks experimental→stable
   * when a pending/rejected review queue row exists).
   */
  setSkillReviewQueueStore(store: SkillReviewQueueStore): void {
    this.skillReviewQueueStore = store;
  }

  /**
   * QSKL-SAFETY Gap 6: inject envelope store for AOCL layer-5 gate emissions.
   * Mirrors the setSkillFirewall / setSkillReviewQueueStore pattern.
   */
  setEnvelopeStore(store: import('../store/envelope-store.js').EnvelopeStore): void {
    this._envelopeStore = store;
  }

  /**
   * PRECEDENT wiring: called from server.ts after precedentStore is
   * constructed, mirroring setExecutionHistoryStore. Enables the terminal
   * done-gate. Never set (or an empty store) means the gate is a no-op.
   */
  setPrecedentStore(store: PrecedentStore): void {
    this.precedentStore = store;
  }

  async execute(node: Node, input: unknown, context: ExecutionContext): Promise<ExecutorResult> {
    const config = (node as any).config as AgenticConfig || {};
    const exprContext = context.createExpressionContext(node.id, input);
    const envelopes: Envelope[] = [];
    const factory = context.envelopes;

    // Resolve config expressions
    // Schema drift compat: dashboard fieldSchema + WEAVER write `goal`,
    // engine historically read `objective`. Accept both. Same for the
    // `tools` ↔ `available_actions` and `maxIterations` ↔ `max_iterations`
    // pairs — the dashboard uses one casing, the engine the other, and
    // before this aliasing the executor silently fell back to defaults
    // (objective="Complete the task" → agent paused immediately because
    // it had no idea what to do).
    const cfgAny = config as unknown as Record<string, unknown>;
    const goalRaw = (typeof cfgAny.goal === 'string' ? cfgAny.goal : undefined)
      ?? (typeof config.objective === 'string' ? config.objective : undefined);
    const objective = typeof goalRaw === 'string' && goalRaw.trim().length > 0
      ? (processValue(goalRaw, exprContext) as string)
      : 'Complete the task';
    const maxIterationsRaw = (cfgAny.maxIterations as number | undefined)
      ?? config.max_iterations;
    const maxIterations = maxIterationsRaw || DEFAULT_MAX_ITERATIONS;
    const agentId = (cfgAny.agent as string | undefined)
      || (cfgAny.agentId as string | undefined)
      || config.agent_id
      || 'quox';
    const collectorUrl = config.collector_url || process.env.COLLECTOR_URL || 'http://collector:9848';
    const serviceKey = config.service_key || process.env.INTERNAL_SERVICE_KEY || '';
    const screencapUrl = config.screencap_url || process.env.SCREENCAP_URL || 'http://screencap:3300';
    const progressCallbackUrl = config.progress_callback_url || process.env.TASKS_URL || '';
    const objectiveId = config.objective_id || '';
    const isBrowserAgent = agentId === 'browser-q';
    // Extract org_id from trigger data (passed as input from the trigger node)
    const triggerOrgId = (input && typeof input === 'object') ? (input as any).orgId || (input as any).org_id || '' : '';
    // P8.E.2 / QF-MT #111: Resolved org_id for extraction auto-save + downstream
    // attribution. Precedence now matches the proven budgetOrgId sibling (~:1078,
    // `config.org_id || context.orgId || ''`): author config first, then the run's
    // AUTHENTICATED org (context.orgId), and only then the trigger-payload org.
    // triggerOrgId comes from client-controlled input and must never win over the
    // authenticated context org — otherwise the ~10 downstream `agentOrgId ||
    // 'default'` sites could be steered to (or defaulted away from) the wrong tenant.
    const agentOrgId = config.org_id || context.orgId || triggerOrgId;

    // Browser session ID — persistent across all iterations
    const sessionId = isBrowserAgent ? `agentic_${context.correlationId}_${node.id}` : '';

    // Available action types for the thinker
    // Schema drift compat: dashboard + WEAVER write `tools`, engine reads
    // `available_actions`. Either is honoured. Default list is the safe
    // browser-action set; for non-browser agents pass tools explicitly.
    const availableActions = (cfgAny.tools as string[] | undefined)
      || config.available_actions
      || [
        'navigate', 'click', 'type', 'fill_form', 'scroll', 'wait',
        'screenshot', 'extract', 'ssh_exec', 'http_call', 'done',
      ];

    // Emit start envelope
    const taskEnv = factory.task(
      'agentic', Intents.NODE.STARTED, context.correlationId,
      { nodeId: node.id, objective, agentId, maxIterations },
    );
    envelopes.push(taskEnv);

    const actionLog: Array<{
      iteration: number;
      reasoning: string;
      action: string;
      params: Record<string, unknown>;
      observation: string;
      success: boolean;
      durationMs: number;
    }> = [];

    // ─── REPLAY-ONLY .A-1b Gate 2 (G3): Browser-Q is structurally replay-incapable ───
    // The deterministic replay branch below always excludes browser agents
    // (`!isBrowserAgent`, see the replayCandidate gate). Under replay-only a
    // Browser-Q objective therefore has no legal path forward — it must
    // ABORT here, before ANY fetch (session cleanup, wisdom lookup, or the
    // vision/LLM loop), rather than silently proceeding.
    if (context.effectiveReplayOnly && isBrowserAgent) {
      return this.buildReplayOnlyAbort(
        factory, taskEnv, 'replay_only_browser_unsupported',
        'Browser-Q agents cannot satisfy replay-only mode: there is no deterministic replay path for browser actions',
        envelopes, actionLog,
      );
    }

    // Clean up any stale browser session before starting (fresh state)
    if (isBrowserAgent && sessionId) {
      await this.cleanupBrowserSession(sessionId, screencapUrl, serviceKey);
    }

    // QSKL-4.B: Track skills loaded via skill_view within this session.
    // When a Crystal is promoted, the most-recently loaded skill becomes
    // the source_skill_id in the Crystal's metadata (last-loaded heuristic:
    // the active skill context for the actions that followed).
    const loadedSkills: Array<{
      id: string;
      name: string;
      version: string;
      loadedAt: string;
    }> = [];

    // Vision token budget tracking (BQ Phase 6)
    // Each vision call costs ~1600 tokens for image. Track to prevent runaway costs.
    const MAX_VISION_TOKENS = 50000;
    let visionTokensUsed = 0;

    let lastObservation: Observation | null = null;
    let lastActionOutput: unknown = input;

    // If there's an initial action, the first observation comes from input
    if (input != null) {
      lastObservation = {
        type: 'generic',
        summary: typeof input === 'string' ? input : JSON.stringify(input).substring(0, 300),
      };
    }

    // BQ-SMART: Query wisdom store for what we already know about this domain
    let domainWisdom = '';
    if (isBrowserAgent) {
      try {
        const targetUrl = objective.match(/https?:\/\/[^\s,)]+/)?.[0] || '';
        const targetDomain = targetUrl ? new URL(targetUrl).hostname : '';
        if (targetDomain) {
          const tasksUrl = progressCallbackUrl || process.env.TASKS_URL || 'http://tasks:3104';
          const wisdomRes = await fetch(
            `${tasksUrl}/api/wisdom?q=${encodeURIComponent(targetDomain)}&limit=5`,
            { headers: { 'x-service-key': serviceKey, 'X-Org-Id': triggerOrgId || 'default', 'X-User-Id': 'service' }, signal: AbortSignal.timeout(5000) }
          );
          if (wisdomRes.ok) {
            const data = await wisdomRes.json() as any;
            const entries = data.wisdom || [];
            if (entries.length > 0) {
              domainWisdom = entries.map((w: any) => `- ${w.pattern_name || w.lesson || ''}`).join('\n');
            }
          }
        }
      } catch { /* wisdom query is best-effort */ }
    }

    // ─── P9.1: Pre-loop crystal retrieval ────────────────────────
    // Generalises BQ-SMART domainWisdom beyond browser/hostname.
    // Retrieves applicable Crystals from the skill library keyed on
    // (orgId, agentId, objectiveKeywords) and injects them into the
    // think prompt as a PROVEN PATTERNS block (2KB hard cap).
    const crystalRetrievalCfg = config.crystal_retrieval ?? {
      enabled: true, max_crystals: 3, match: 'both' as const,
    };

    let provenPatterns = '';
    // AGH-5: hoisted outside the try block so the replay branch can access them.
    let retrievedCrystals: import('../store/skill-library-store.js').SkillLibraryRecord[] = [];
    let replayCandidate: import('../store/skill-library-store.js').SkillLibraryRecord | undefined;
    /** MEM-DECAY MD.3: lineage forward-feed — last N failure lessons for this
     * workflow, populated below at the same site as P9.1 crystal retrieval. */
    let priorLessons: string[] = [];

    // ─── PRECEDENT: fact-pattern context keys for this run ───────────────
    // PrecedentStore.findApplicable() fuzzy-matches on the top-level KEY
    // NAMES of a stored fact pattern (see its doc comment), so the keys the
    // approval-side recorder writes are namespaced tokens
    // (src/approval/precedent-recorder.ts) and the keys asked for here have
    // to use the same namespaces. The workflow token is the precise binding;
    // the objective keywords are the fuzzy bridge.
    const precedentContextKeys: string[] = [
      ...(context.workflow?.id ? [`workflow:${context.workflow.id}`] : []),
      `node_type:${node.type}`,
      ...objective.toLowerCase().split(/[^a-z0-9_]+/).filter(w => w.length > 3).slice(0, 10)
        .map(w => `kw:${w}`),
    ];
    /** Rendered PRECEDENTS prompt block — populated only once the gate has
     * actually retrieved applicable precedents, so an empty store never
     * changes the prompt. */
    let precedentsBlock = '';

    if (context.effectiveReplayOnly) {
      // ─── REPLAY-ONLY .A1 Gate 2 (G5): deterministic pinned-crystal binding ───
      // Fuzzy keyword matching (findApplicable, the P9.1 block below) is
      // FORBIDDEN under replay-only: a rephrased objective could miss
      // (surprise abort) or — worse — a WRONG crystal could win the match
      // and replay the wrong action sequence, signed and verified and
      // INCORRECT. This REPLACES the fuzzy path entirely for replay-only
      // runs: crystal_retrieval config (enabled/match/max_crystals) is not
      // consulted here — only the explicit node -> crystal_id(+version)
      // binding is a legal resolution path.
      const binding = config.crystal_binding;
      if (!binding || !binding.crystal_id) {
        return this.buildReplayOnlyAbort(
          factory, taskEnv, 'replay_only_no_binding',
          'No pinned crystal_binding configured for this node under replay-only mode: fuzzy Crystal matching is forbidden — a deterministic node -> crystal_id binding is required',
          envelopes, actionLog,
        );
      }

      if (!this.skillLibraryStore || !agentOrgId) {
        return this.buildReplayOnlyAbort(
          factory, taskEnv, 'replay_only_binding_unresolved',
          'Cannot resolve the pinned crystal_binding under replay-only mode: no skill library store or org_id configured for this run',
          envelopes, actionLog,
        );
      }

      let boundRecord: import('../store/skill-library-store.js').SkillLibraryRecord | null = null;
      try {
        boundRecord = await this.skillLibraryStore.getById(binding.crystal_id, agentOrgId);
      } catch (err) {
        return this.buildReplayOnlyAbort(
          factory, taskEnv, 'replay_only_binding_unresolved',
          `Failed to resolve pinned crystal_binding "${binding.crystal_id}": ${err instanceof Error ? err.message : String(err)}`,
          envelopes, actionLog,
        );
      }

      if (!boundRecord) {
        return this.buildReplayOnlyAbort(
          factory, taskEnv, 'replay_only_binding_unresolved',
          `Pinned crystal_binding "${binding.crystal_id}" did not resolve to any Crystal (wrong org, or the Crystal no longer exists)`,
          envelopes, actionLog,
        );
      }

      if (binding.version !== undefined && boundRecord.version !== binding.version) {
        return this.buildReplayOnlyAbort(
          factory, taskEnv, 'replay_only_binding_version_drift',
          `Pinned crystal_binding "${binding.crystal_id}" expected version ${binding.version} but resolved to version ${boundRecord.version}: the signed Crystal was superseded — refusing to replay a different version`,
          envelopes, actionLog,
        );
      }

      const isCanonical = boundRecord.metadata?.stage === 'canonical';
      const hasSnapshot = Array.isArray((boundRecord.workflowJson as any)?.action_log_snapshot) &&
        (boundRecord.workflowJson as any).action_log_snapshot.length > 0;

      if (!isCanonical || !hasSnapshot) {
        return this.buildReplayOnlyAbort(
          factory, taskEnv, 'replay_only_no_canonical',
          `Pinned crystal_binding "${binding.crystal_id}" did not resolve to a canonical Crystal with a replayable action snapshot`,
          envelopes, actionLog,
        );
      }

      // ─── REPLAY-ONLY .B3 (docs/STREAM_REPLAY_ONLY_FABLE_REVIEW.md §4 gate 2,
      // §5 ".B"): a pinned canonical Crystal may be replayed ONLY IF its
      // signature cryptographically verifies over its (recomputed) canonical
      // snapshot hash. Anything less -> fail-closed abort, ZERO LLM.

      // Gate 1 — signature-status: a pending/unsigned Crystal is not
      // trustworthy for compliance replay, regardless of why it's unsigned.
      if (boundRecord.signatureStatus !== 'signed' || !boundRecord.signature) {
        return this.buildReplayOnlyAbort(
          factory, taskEnv, 'replay_only_unsigned_crystal',
          `Pinned crystal_binding "${binding.crystal_id}" is not signed (signature_status=${boundRecord.signatureStatus ?? 'unsigned'}): a pending/unsigned Crystal cannot be replayed under replay-only compliance mode`,
          envelopes, actionLog,
        );
      }

      // Gate 2 — snapshot-integrity: recompute the canonical hash of the
      // snapshot about to be replayed and compare against what was actually
      // signed at promotion time. A mismatch means the stored snapshot no
      // longer matches the signature (tamper, or a code-path drift bug) —
      // the signature would verify against a hash that isn't this snapshot.
      const snapshotForHash = (boundRecord.workflowJson as any)?.action_log_snapshot;
      const recomputedHash = hashSnapshot(snapshotForHash);
      if (recomputedHash !== boundRecord.canonicalHash) {
        return this.buildReplayOnlyAbort(
          factory, taskEnv, 'replay_only_snapshot_tampered',
          `Pinned crystal_binding "${binding.crystal_id}" action snapshot no longer matches its signed canonical_hash (tamper or drift) — refusing to replay`,
          envelopes, actionLog,
        );
      }

      // Gate 3 — signature-verify: fetch (or reuse the cached) org public
      // key and verify locally. A rotated key (signed_by no longer matches
      // the org's current active key_id) is treated the same as a bad
      // signature — the signature is no longer trusted.
      const orgPublicKey = await this.getOrgPublicKey(agentOrgId);
      if (!orgPublicKey) {
        return this.buildReplayOnlyAbort(
          factory, taskEnv, 'replay_only_signature_invalid',
          `Could not resolve org "${agentOrgId}"'s Crystal-signing public key — refusing to replay a signature that cannot be verified`,
          envelopes, actionLog,
        );
      }
      if (boundRecord.signedBy !== orgPublicKey.key_id) {
        return this.buildReplayOnlyAbort(
          factory, taskEnv, 'replay_only_signature_invalid',
          `Pinned crystal_binding "${binding.crystal_id}" was signed by key "${boundRecord.signedBy}" but org "${agentOrgId}"'s current active key is "${orgPublicKey.key_id}" (key rotated) — refusing to replay a signature that is no longer trusted`,
          envelopes, actionLog,
        );
      }
      const signatureVerified = verifyCrystalSignature(recomputedHash, boundRecord.signature, orgPublicKey.public_key_hex);
      if (!signatureVerified) {
        return this.buildReplayOnlyAbort(
          factory, taskEnv, 'replay_only_signature_invalid',
          `Pinned crystal_binding "${binding.crystal_id}" signature failed cryptographic verification against org "${agentOrgId}"'s Crystal-signing public key — refusing to replay`,
          envelopes, actionLog,
        );
      }

      // Positive compliance evidence: the signature-verify gate passed —
      // record that a signature-verified snapshot is about to replay. This
      // is the audit-trail counterpart to the abort envelopes above (§4 end).
      envelopes.push(factory.event(
        Intents.AGENTIC.SIGNATURE_VERIFIED,
        context.correlationId,
        {
          nodeId: node.id,
          crystalId: boundRecord.id,
          keyId: orgPublicKey.key_id,
          canonicalHash: recomputedHash,
        },
      ));

      replayCandidate = boundRecord;
    } else if (crystalRetrievalCfg.enabled && this.skillLibraryStore && agentOrgId) {
      // ─── P9.1: Pre-loop crystal retrieval (fuzzy — optimisation only) ────
      // Generalises BQ-SMART domainWisdom beyond browser/hostname. Retrieves
      // applicable Crystals from the skill library keyed on (orgId, agentId,
      // objectiveKeywords) and injects them into the think prompt as a
      // PROVEN PATTERNS block (2KB hard cap). This path is UNCHANGED by
      // .A1 — it only runs outside replay-only mode; crystal_binding (if
      // present) is not consulted here.
      try {
        const objectiveKeywords = objective
          .toLowerCase()
          .split(/\s+/)
          .filter(w => w.length > 3)
          .slice(0, 10);

        const matchAgentId = crystalRetrievalCfg.match === 'agent_id' || crystalRetrievalCfg.match === 'both'
          ? agentId : undefined;
        const matchKeywords = crystalRetrievalCfg.match === 'objective_keyword' || crystalRetrievalCfg.match === 'both'
          ? objectiveKeywords : [];

        const crystals = await this.skillLibraryStore.findApplicable({
          orgId: agentOrgId,
          agentId: matchAgentId,
          objectiveKeywords: matchKeywords,
          maxCrystals: crystalRetrievalCfg.max_crystals,
        });
        retrievedCrystals = crystals;

        if (crystals.length > 0) {
          // Serialise crystals, hard-cap at 2KB total
          const serialised = crystals
            .map(c => {
              const wj = c.workflowJson as Record<string, unknown>;
              return `[${c.name}] (success_rate=${c.successRate.toFixed(2)}) action_pattern=${JSON.stringify(wj.action_pattern ?? wj)}`;
            })
            .join('\n');
          // Truncate to 2048 bytes
          const encoder = new TextEncoder();
          const bytes = encoder.encode(serialised);
          provenPatterns = bytes.length <= 2048
            ? serialised
            : new TextDecoder().decode(bytes.slice(0, 2048)) + '...';

          // Emit retrieval envelope
          const retrievalEnv = factory.event(
            Intents.AGENTIC.SKILL_RETRIEVED,
            context.correlationId,
            {
              nodeId: node.id,
              orgId: agentOrgId,
              agentId,
              crystalCount: crystals.length,
              crystalIds: crystals.map(c => c.id),
            },
          );
          envelopes.push(retrievalEnv);
        }
      } catch {
        /* crystal retrieval is best-effort outside replay-only */
      }

      // ─── AGH-5: Deterministic Crystal replay (fuzzy-matched candidate) ──
      // If a canonical Crystal with an action_log_snapshot exists, bypass the
      // LLM loop entirely and execute the actions directly. Falls back to
      // the LLM loop if any action fails during replay.
      replayCandidate = retrievedCrystals.find(c =>
        c.metadata?.stage === 'canonical' &&
        Array.isArray((c.workflowJson as any)?.action_log_snapshot) &&
        (c.workflowJson as any).action_log_snapshot.length > 0
      );

      // ─── Contradiction gate: pause auto-fire on divergent track records ──
      // Runs only for this fuzzy-matched candidate — a pinned crystal_binding
      // replay (handled in the branch above) is signed/deterministic and not
      // subject to this gate. Best-effort: any failure here must never block
      // the run, so it falls through to the ordinary replay/LLM-loop path.
      if (replayCandidate && this.approvalEngine && this.skillLibraryStore && agentOrgId) {
        try {
          const gateKeywords = objective
            .toLowerCase()
            .split(/\s+/)
            .filter(w => w.length > 3)
            .slice(0, 10);

          const gateResult = await runContradictionGate(
            {
              orgId: agentOrgId,
              agentId,
              objectiveKeywords: gateKeywords,
              candidate: {
                id: replayCandidate.id,
                name: replayCandidate.name,
                successRate: replayCandidate.successRate,
                executionCount: replayCandidate.executionCount,
                objectiveKeywords: (replayCandidate.metadata?.objectiveKeywords as string[] | undefined) ?? [],
              },
              correlationId: context.correlationId,
              workflowId: context.workflow?.id ?? '',
              workflowName: context.workflow?.name,
              executionId: context.id,
              nodeId: node.id,
            },
            { skillLibraryStore: this.skillLibraryStore, approvalEngine: this.approvalEngine },
          );

          if (gateResult.paused) {
            const resultEnv = factory.result(
              taskEnv, Intents.NODE.COMPLETED,
              {
                nodeId: node.id,
                paused: true,
                pauseReason: 'contradiction_gate',
                approvalId: gateResult.approvalId,
                divergentCrystalIds: gateResult.divergentNeighbors.map(d => d.id),
              },
            );
            envelopes.push(resultEnv);
            return {
              success: true,
              output: {
                paused: true,
                pauseReason: 'contradiction_gate',
                approval_id: gateResult.approvalId,
                divergent_crystals: gateResult.divergentNeighbors,
                candidate_crystal_id: replayCandidate.id,
              },
              envelopes,
            };
          }
        } catch (err) {
          log.warn(`contradiction-gate: best-effort check failed, proceeding without it: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // ─── MEM-DECAY MD.3: lineage forward-feed ───────────────────────────
    // Same site as the P9.1 Crystal retrieval above: a workflow's own prior
    // failures (recorded by durable-hooks.ts's onWorkflowComplete via
    // lineage-analyzer.ts) feed forward into its next run's think-prompt
    // context, independent of Crystal/replay state. Best-effort — an absent
    // store or a lookup failure simply leaves priorLessons empty.
    if (this.executionHistoryStore && agentOrgId && context.workflow?.id) {
      try {
        priorLessons = await this.executionHistoryStore.getRecentLessons({
          orgId: agentOrgId,
          workflowId: context.workflow.id,
          limit: 3,
        });
      } catch {
        /* lineage lesson retrieval is best-effort */
      }
    }

    if (replayCandidate && !isBrowserAgent && (context.effectiveReplayOnly || crystalRetrievalCfg.enabled !== false)) {
      const snapshot = (replayCandidate.workflowJson as any).action_log_snapshot as Array<{ action: string; params: Record<string, unknown> }>;
      log.debug(`AGH-5: deterministic replay of Crystal "${replayCandidate.name}" (${snapshot.length} actions)`);

      const replayStart = Date.now();
      let replayFailed = false;
      let replayFailReason = '';

      // Emit start envelope
      envelopes.push(factory.event(
        Intents.AGENTIC.SKILL_EXECUTED,
        context.correlationId,
        {
          nodeId: node.id,
          crystalId: replayCandidate.id,
          crystalName: replayCandidate.name,
          executionMode: 'deterministic',
          actionCount: snapshot.length,
          phase: 'start',
        },
      ));

      for (let i = 0; i < snapshot.length; i++) {
        const step = snapshot[i];
        const actionNode: Node = {
          id: `${node.id}_replay_${i}`,
          type: this.mapActionToNodeType(step.action) as any,
          name: `${step.action} (replay ${i + 1}/${snapshot.length})`,
          config: step.params,
        } as any;

        let stepResult: ExecutorResult;
        try {
          const stepExecutor = context.executors?.get(actionNode.type);
          if (stepExecutor) {
            stepResult = await stepExecutor.execute(actionNode, lastActionOutput, context);
          } else {
            stepResult = {
              success: false, output: null,
              error: { code: 'NO_EXECUTOR', message: `No executor for action type: ${step.action}` },
              envelopes: [],
            };
          }
        } catch (err: any) {
          stepResult = {
            success: false, output: null,
            error: { code: 'REPLAY_ACT_ERROR', message: err.message },
            envelopes: [],
          };
        }

        envelopes.push(...(stepResult?.envelopes || []));
        lastActionOutput = stepResult?.output;

        const stepObservation = this.observationRegistry.produce(actionNode, stepResult);
        lastObservation = stepObservation;

        actionLog.push({
          iteration: i,
          reasoning: `[REPLAY] Crystal "${replayCandidate.name}" step ${i + 1}/${snapshot.length}`,
          action: step.action,
          params: step.params,
          observation: (stepObservation?.summary || stepResult.error?.message || 'no observation').substring(0, 200),
          success: stepResult.success,
          durationMs: 0,
        });

        if (!stepResult.success) {
          replayFailed = true;
          replayFailReason = stepResult.error?.message || `Step ${i + 1} failed`;
          log.debug(`AGH-5: replay step ${i + 1} failed — falling back to LLM loop. Reason: ${replayFailReason}`);
          // Inject a note into provenPatterns so the LLM knows replay was attempted
          provenPatterns = `[REPLAY ATTEMPTED for "${replayCandidate.name}" but failed at step ${i + 1}: ${replayFailReason}. Continue with LLM-driven approach.]\n${provenPatterns}`;
          break;
        }
      }

      if (!replayFailed) {
        const replayDurationMs = Date.now() - replayStart;

        // Increment execution_count on the canonical Crystal
        if (this.skillLibraryStore) {
          try {
            await this.skillLibraryStore.recordSuccessfulRun({
              agentId,
              orgId: agentOrgId || 'default',
              actionPattern: (replayCandidate.workflowJson as any).action_pattern ?? '',
              completedActionPattern: (replayCandidate.workflowJson as any).action_pattern ?? '',
            });
          } catch { /* non-critical */ }
        }

        // Emit completion envelope
        envelopes.push(factory.event(
          Intents.AGENTIC.SKILL_EXECUTED,
          context.correlationId,
          {
            nodeId: node.id,
            crystalId: replayCandidate.id,
            crystalName: replayCandidate.name,
            executionMode: 'deterministic',
            actionCount: snapshot.length,
            phase: 'complete',
            status: 'success',
            durationMs: replayDurationMs,
          },
        ));

        const resultEnv = factory.result(
          taskEnv, Intents.NODE.COMPLETED,
          {
            nodeId: node.id,
            objective_met: true,
            iterations: 1,
            actions_taken: actionLog.length,
            final_reasoning: `[AGH-5] Deterministic replay of Crystal "${replayCandidate.name}" completed in ${replayDurationMs}ms`,
          },
        );
        envelopes.push(resultEnv);

        return {
          success: true,
          output: {
            objective_met: true,
            iterations: 1,
            actions_taken: actionLog.length,
            action_log: actionLog,
            last_observation: lastObservation?.summary,
            final_reasoning: `[AGH-5] Deterministic replay of Crystal "${replayCandidate.name}"`,
            crystal_id: replayCandidate.id,
            execution_mode: 'deterministic',
          },
          envelopes,
        };
      }
      // REPLAY-ONLY .A-1b Gate 2 (THE critical change): a replay failure
      // must ABORT under replay-only — it must NEVER fall through to the
      // LLM loop below. That fallthrough is exactly the compliance boundary
      // this stream exists to close (docs/STREAM_REPLAY_ONLY_FABLE_REVIEW.md
      // §2 P2, §4). Outside replay-only, behaviour is unchanged: fall
      // through to the LLM loop with the failed steps already in actionLog.
      if (context.effectiveReplayOnly) {
        return this.buildReplayOnlyAbort(
          factory, taskEnv, 'replay_only_replay_failed',
          `Crystal replay failed and cannot fall back to the LLM under replay-only mode: ${replayFailReason}`,
          envelopes, actionLog,
        );
      }
      // If replay failed (and not replay-only), fall through to the LLM loop below.
      // actionLog already has the failed steps — LLM will see them and can adapt.
    }

    // Browser agents: auto-dismiss cookie banners before the main loop
    if (isBrowserAgent && sessionId) {
      // Navigate to the target URL first (extract from objective)
      const urlMatch = objective.match(/https?:\/\/[^\s,)]+/);
      if (urlMatch) {
        await this.executeBrowserAction('navigate', { url: urlMatch[0] }, sessionId, screencapUrl, serviceKey, triggerOrgId, agentOrgId, objectiveId);
        // Try clicking common cookie accept buttons (best-effort, don't fail if not found)
        for (const btnText of ['Accept All', 'Accept all', 'Accept', 'I agree', 'Got it', 'OK']) {
          const clickResult = await this.executeBrowserAction('click', { text: btnText }, sessionId, screencapUrl, serviceKey, triggerOrgId, agentOrgId, objectiveId);
          if (clickResult.success) {
            await new Promise(r => setTimeout(r, 1000)); // wait for banner to dismiss
            break;
          }
        }
        // Take initial screenshot for the first observation
        const ssResult = await this.executeBrowserAction('screenshot', {}, sessionId, screencapUrl, serviceKey, triggerOrgId, agentOrgId, objectiveId);
        if (ssResult.output) {
          lastObservation = this.observationRegistry.produce(
            { id: `${node.id}_init`, type: 'browser:navigate' as any, config: {} } as any, ssResult);
          lastActionOutput = ssResult.output;
        }
      }
    }

    // Extract budget scope config (P8.B)
    const budgetScopeId = config.budget_scope_id || node.id;
    const budgetOrgId = config.org_id || context.orgId || '';

    // ─── QSKL-2: Pre-loop skills catalog summary for system prompt ────────
    // Build a one-liner like "Skills catalog (github: 3, security: 5): call skills_list..."
    // Omit entirely when no skills exist (no noise).
    let skillsCatalogLine = '';
    if (this.quoxSkillsStore && agentOrgId) {
      try {
        const allSkills = await this.quoxSkillsStore.list({ orgId: agentOrgId });
        if (allSkills.length > 0) {
          const categoryMap = new Map<string, number>();
          for (const s of allSkills) {
            categoryMap.set(s.category, (categoryMap.get(s.category) ?? 0) + 1);
          }
          const categorySummary = Array.from(categoryMap.entries())
            .map(([cat, count]) => `${cat}: ${count}`)
            .join(', ');
          skillsCatalogLine = `Skills catalog (${categorySummary}): call skills_list to discover, skill_view to load, skill_manage to author/patch.`;
        }
      } catch { /* non-critical — catalog line is best-effort */ }
    }

    // P9.3: Refinement hint injected into the next think() call when an act fails with a draft active
    let refinementHint = '';

    // Sentinel-4 Fix1: when propose_crystal is accepted, the agent's pattern-recognition task is done.
    // Don't burn another think() call — the next iteration will auto-synthesize 'done'.
    let proposeAcceptedThisRun = false;

    // ─── QSKL-3: Skill creation nudge setup ──────────────────────
    // Resolve the effective nudge interval for this execution.
    // Priority: per-node config > per-agent override > DEFAULT_CREATION_NUDGE_INTERVAL.
    const cfgNudgeInterval = (config as any).skills_creation_nudge_interval as number | 'off' | undefined;
    let effectiveNudgeInterval: number | 'off';
    if (cfgNudgeInterval !== undefined) {
      // Per-node config wins unconditionally (even for SENTINEL).
      effectiveNudgeInterval = cfgNudgeInterval;
    } else if (NUDGE_DISABLED_AGENTS.has(agentId)) {
      effectiveNudgeInterval = 'off';
    } else {
      effectiveNudgeInterval = DEFAULT_CREATION_NUDGE_INTERVAL;
    }

    // Counter tracking how many LLM-driven iterations have elapsed since last nudge.
    let iterationsSinceLastNudge = 0;
    // The nudge text to prepend when the interval fires.
    const NUDGE_TEXT = "Consider saving a skill (skill_manage(action='create')) from what you just learned, if the procedure could recur.\n\n";

    // QSKL-12: Fetch persona once before the loop (stable within a single run).
    // Uses this._personaFetcher so tests can inject a no-op without touching global.fetch.
    const agentPersonaContent = !isBrowserAgent
      ? await this._personaFetcher({ collectorUrl, agentId })
      : null;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // ─── P8.B: Per-iteration budget check ────────────────────
      // Pass the current iteration number as projected.iterations so the evaluator
      // compares the total cumulative iterations (existing usage + current iteration)
      // against max_iterations without needing a write-per-iteration.
      if (this.budgetEvaluator) {
        const budgetResult = await this.budgetEvaluator.evaluate({
          scope: 'iteration',
          scopeId: budgetScopeId,
          orgId: budgetOrgId,
          projected: { tokens_in: 0, tokens_out: 0, cost_usd_micro: 0, tool_calls: 0, duration_ms: 0, iterations: iteration + 1 },
        });
        if (!budgetResult.allowed) {
          const exhaustedEnv = factory.error(taskEnv, Intents.BUDGET.EXHAUSTED, {
            code: 'BUDGET_EXHAUSTED',
            message: budgetResult.reason ?? 'Iteration budget exhausted',
            details: { iteration, exceeded: budgetResult.exceeded, scope: 'iteration', scopeId: budgetScopeId },
          });
          envelopes.push(exhaustedEnv);
          if (isBrowserAgent) await this.cleanupBrowserSession(sessionId, screencapUrl, serviceKey);
          return {
            success: false,
            output: {
              objective_met: false,
              iterations: iteration,
              actions_taken: actionLog.length,
              action_log: actionLog,
              last_observation: lastObservation?.summary,
              budget_exhausted: true,
            },
            error: { code: 'BUDGET_EXHAUSTED', message: budgetResult.reason ?? 'Iteration budget exhausted' },
            envelopes,
          };
        }
      }

      // ─── Sentinel-4 Fix1: Auto-done after propose_crystal accepted ────
      // If the previous iteration accepted a crystal draft, the pattern-recognition
      // task is complete. Skip think() and synthesize a 'done' decision directly.
      // This prevents the LLM from re-iterating and emitting propose_crystal again
      // (which gets rejected as "draft_already_exists" until MAX_ITERATIONS).
      if (proposeAcceptedThisRun) {
        const autoDone: ThinkDecision = {
          reasoning: 'Crystal draft saved. Pattern proposed; engine auto-terminating so the done-branch can evaluate task-time promotion.',
          action: 'done',
          params: {},
          objective_met: true,
          confidence: 1.0,
        };

        // Emit the engine-terminated envelope for audit.
        const autoTermEnv = factory.event(
          'quox.agentic.engine_terminated_after_propose' as any,
          context.correlationId,
          { nodeId: node.id, executionId: context.correlationId, iteration },
        );
        envelopes.push(autoTermEnv);

        log.debug(`Fix1: auto-done after propose_crystal accepted (iteration ${iteration})`);

        // Jump directly to the done-branch by injecting the autoDone as the decision.
        // We fall through to the done-check below (decision.action === 'done').
        // Skip cache lookup and think().
        const decision = autoDone;

        // ─── DONE BRANCH (copy of the main done-branch logic for autoDone) ────
        // Note: we jump straight here — no ACT phase for autoDone.
        {
          if (isBrowserAgent) await this.cleanupBrowserSession(sessionId, screencapUrl, serviceKey);

          const promotionThreshold = config.crystal_promotion_threshold ?? {
            confidence: 0.8, consecutive_success: 3,
          };
          if (this.skillLibraryStore) {
            const activeDraft = this.skillLibraryStore.getDraftByExecution(context.correlationId);
            if (activeDraft) {
              // In the auto-done branch, the agent accepted its own crystal draft as the description
              // of what it did. The draft's action_pattern IS the completed pattern — compare the
              // draft against itself to always increment (the LLM wouldn't have proposed if incorrect).
              const completedPattern = activeDraft.actionPattern;

              const newConsecCount = this.skillLibraryStore.recordSuccessfulRun({
                agentId: activeDraft.agentId || agentId || '',
                orgId: activeDraft.orgId || agentOrgId || 'default',
                actionPattern: activeDraft.actionPattern,
                completedActionPattern: completedPattern,
              });
              log.debug(`Fix1+Fix2: Draft "${activeDraft.name}" consecutiveSuccess → ${newConsecCount} (threshold: ${promotionThreshold.consecutive_success})`);

              const updatedDraft = this.skillLibraryStore.getDraftByExecution(context.correlationId) ?? activeDraft;
              const draftAnalysis = analyseDraft(updatedDraft, actionLog, promotionThreshold);
              log.debug(`Fix1+Fix2: analyseDraft: ready=${draftAnalysis.ready} confidence=${draftAnalysis.recomputedConfidence.toFixed(2)} consecutiveSuccess=${draftAnalysis.consecutiveSuccess}/${promotionThreshold.consecutive_success}${draftAnalysis.reason ? ' reason=' + draftAnalysis.reason : ''}`);

              if (draftAnalysis.ready) {
                try {
                  // Sentinel-5 Fix2: promote as canonical (not candidate) on threshold met.
                  // promoteCanonical() also resets the counter so run 4 doesn't re-promote.
                  // AGH-5: pass actionLogSnapshot so the canonical row can be replayed deterministically.
                  // QSKL-4.B: if skill_view was called this session, stamp the most-recently
                  // loaded skill onto the Crystal's metadata so Phase 4.C's evaluator can find
                  // affected Crystals when that skill is patched. Last-loaded is the active
                  // skill context for the actions that followed (best-available heuristic).
                  const lastLoadedSkill = loadedSkills.length > 0
                    ? loadedSkills[loadedSkills.length - 1]
                    : undefined;
                  const skillLinkback: Record<string, unknown> | undefined = lastLoadedSkill
                    ? { source_skill_id: lastLoadedSkill.id, source_skill_version: lastLoadedSkill.version }
                    : undefined;
                  const promoted = await this.skillLibraryStore.promoteCanonical({
                    orgId: updatedDraft.orgId || agentOrgId || 'default',
                    executionId: context.correlationId,
                    name: updatedDraft.name,
                    summary: updatedDraft.summary,
                    actionPattern: updatedDraft.actionPattern,
                    confidence: draftAnalysis.recomputedConfidence,
                    agentId: updatedDraft.agentId,
                    objectiveKeywords: updatedDraft.objectiveKeywords,
                    actionLogSnapshot: updatedDraft.actionLogSnapshot,
                  }, skillLinkback);

                  this.skillLibraryStore.clearDraft(context.correlationId);

                  const promotedEnv = factory.event(
                    Intents.AGENTIC.SKILL_PROMOTED,
                    context.correlationId,
                    {
                      nodeId: node.id,
                      executionId: context.correlationId,
                      crystalId: promoted.id,
                      name: promoted.name,
                      stage: 'canonical',
                      recomputedConfidence: draftAnalysis.recomputedConfidence,
                      consecutiveSuccess: draftAnalysis.consecutiveSuccess,
                    },
                  );
                  envelopes.push(promotedEnv);
                } catch { /* promotion is best-effort */ }
              }
            }
          }

          const resultEnv = factory.result(
            taskEnv, Intents.NODE.COMPLETED,
            {
              nodeId: node.id,
              objective_met: true,
              iterations: iteration + 1,
              actions_taken: actionLog.length,
              final_reasoning: decision.reasoning,
            },
          );
          envelopes.push(resultEnv);

          return {
            success: true,
            output: {
              objective_met: true,
              iterations: iteration + 1,
              actions_taken: actionLog.length,
              action_log: actionLog,
              last_observation: lastObservation?.summary,
              final_reasoning: decision.reasoning,
              session_id: sessionId || undefined,
            },
            envelopes,
          };
        }
      }

      // ─── CACHE LOOKUP (BQ-SMART) ─────────────────────────────
      const observationUrl = (lastObservation?.metadata as any)?.url || '';
      const urlOrigin = observationUrl ? new URL(observationUrl).origin : '';
      let decision: ThinkDecision | null = null;
      let cacheId: string | undefined;

      if (isBrowserAgent && urlOrigin && iteration > 0) {
        try {
          const cacheResult = await this.executeBrowserAction(
            'action_cache_lookup' as any,
            { org_id: triggerOrgId, url_origin: urlOrigin, objective, observation_summary: lastObservation?.summary || '' },
            sessionId, screencapUrl, serviceKey, triggerOrgId, agentOrgId, objectiveId
          );
          const cached = (cacheResult.output as any)?.result?.decision || (cacheResult.output as any)?.decision;
          // Reject observation-only cached actions — they cause infinite loops
          const UNCACHEABLE_ACTIONS = ['screenshot', 'extract', 'a11y_snapshot', 'analyze_forms', 'find_element', 'wait'];
          if (cached && cached.action && !UNCACHEABLE_ACTIONS.includes(cached.action)) {
            // Prevent consecutive duplicate cached actions (causes loops)
            const lastAction = actionLog.length > 0 ? actionLog[actionLog.length - 1] : null;
            const prevPrevAction = actionLog.length > 1 ? actionLog[actionLog.length - 2] : null;
            const isDuplicate = lastAction?.action === cached.action &&
              JSON.stringify(lastAction?.params) === JSON.stringify(cached.params);
            const isTriplicate = isDuplicate && prevPrevAction?.action === cached.action;

            if (isTriplicate) {
              // 3 identical cached actions in a row — definitely stuck, skip cache
              bqSmartLog.debug(`Cache loop detected: ${cached.action} × 3, skipping cache`);
            } else {
              decision = cached as ThinkDecision;
              cacheId = cached._cacheId;
            }
          }
        } catch { /* cache lookup is best-effort */ }
      }

      // ─── QSKL-3: Skill creation nudge check (before think()) ────
      // Increment counter for every LLM-driven iteration (not auto-done or cache-hit).
      // Counter is incremented at the top of each iteration so it counts the
      // iteration that is ABOUT TO fire think(), not the completed one.
      let nudgeTextForThisIteration = '';
      if (effectiveNudgeInterval !== 'off') {
        iterationsSinceLastNudge++;
        if (iterationsSinceLastNudge >= effectiveNudgeInterval) {
          nudgeTextForThisIteration = NUDGE_TEXT;
          iterationsSinceLastNudge = 0; // reset counter

          // Emit audit envelope
          const nudgeEnv = factory.event(
            'agentic.skill.creation_nudged' as any,
            context.correlationId,
            {
              nodeId: node.id,
              session_id: context.correlationId,
              agent_id: agentId,
              iteration_count: iteration + 1,
              interval: effectiveNudgeInterval,
            },
          );
          envelopes.push(nudgeEnv);
        }
      }

      // ─── THINK (skip if cache hit) ──────────────────────────
      if (!decision) {
        // Vision budget check
        const observationForThink = lastObservation && lastObservation.imageBase64 && visionTokensUsed < MAX_VISION_TOKENS
          ? lastObservation
          : lastObservation
            ? { ...lastObservation, imageBase64: undefined, imageMediaType: undefined }
            : lastObservation;

        if (lastObservation?.imageBase64 && visionTokensUsed < MAX_VISION_TOKENS) {
          visionTokensUsed += 1600;
        }

        // AEE-FULL Gap 3 SD-2: emit quox.flow.llm.invoked BEFORE the LLM call
        // (auditable pre-call record — fired immediately via context flush).
        const llmInvokedEnv = factory.task(
          `agent.${agentId}`,
          'quox.flow.llm.invoked',
          context.correlationId,
          {
            nodeId: node.id,
            nodeName: node.name ?? node.id,
            nodeType: node.type,
            agent_id: agentId,
            parameters: {
              timeout_ms: 30000,
              has_output_schema: false,
            },
            iteration_index: iteration,
            startedAt: new Date().toISOString(),
          }
        );
        envelopes.push(llmInvokedEnv);
        context.emitImmediate(llmInvokedEnv);

        const llmStartMs = Date.now();
        decision = await this.think({
          objective,
          agentId,
          iteration,
          maxIterations,
          lastObservation: observationForThink,
          actionLog,
          availableActions,
          collectorUrl,
          serviceKey,
          domainWisdom,
          provenPatterns,
          priorLessons,
          // PRECEDENT: empty until the done-gate retrieves applicable
          // precedents, so an empty store leaves the prompt untouched.
          precedents: precedentsBlock || undefined,
          isBrowserAgent,
          skillsCatalogLine,
          creationNudge: nudgeTextForThisIteration,
          personaContent: agentPersonaContent,
          cancellationSignal: context.cancellationSignal,  // AEE-FULL Gap 4
          // REPLAY-ONLY .A0: run identity threaded to the collector on every LLM call
          orgId: agentOrgId || undefined,
          workflowId: context.workflow?.id,
          executionId: context.id,
          // REPLAY-ONLY .A-1a: effective replay_only resolved once at run
          // start (control-pipeline.ts execute()) so a collector-side gate
          // (future work) can identify replay-only runs. Foundation only —
          // no gate reads this field yet.
          effectiveReplayOnly: context.effectiveReplayOnly,
        });
        const llmDurationMs = Date.now() - llmStartMs;

        // AEE-FULL Gap 3: emit quox.flow.llm.completed / .failed after think() returns.
        if (decision) {
          const usagePayload = buildLlmUsagePayload(
            this._lastThinkUsage
              ? {
                  input_tokens: this._lastThinkUsage.input_tokens,
                  output_tokens: this._lastThinkUsage.output_tokens,
                  model: this._lastThinkUsage.model,
                }
              : undefined,
            // Collector's /api/internal/agents/invoke is policy-driven — use the
            // actual provider it served, falling back to 'anthropic' as the
            // historical default when the response didn't carry one.
            this._lastThinkUsage?.provider ?? 'anthropic'
          );
          const llmCompletedEnv = factory.result(
            llmInvokedEnv,
            'quox.flow.llm.completed',
            {
              nodeId: node.id,
              nodeName: node.name ?? node.id,
              nodeType: node.type,
              agent_id: agentId,
              tool_calls: [],
              finish_reason: 'stop',
              iteration_index: iteration,
              ...usagePayload,
              cancelled: false,
              partial_output: null,
              cancelled_at: null,
              cancelled_by: null,
              duration_ms: llmDurationMs,
            }
          );
          envelopes.push(llmCompletedEnv);

          if (usagePayload.tokens_unknown) {
            envelopes.push(factory.event(
              'quox.flow.llm.usage_unavailable',
              context.correlationId,
              {
                nodeId: node.id,
                agent_id: agentId,
                reason: 'collector_response_missing_usage_block',
              }
            ));
          }
        } else {
          // think() returned null — LLM call failed
          envelopes.push(factory.error(
            llmInvokedEnv,
            'quox.flow.llm.failed',
            {
              code: 'AGENTIC_LLM_THINK_FAILED',
              message: 'LLM think() returned null — collector failed or parse error',
              details: {
                nodeId: node.id,
                agent_id: agentId,
                iteration_index: iteration,
                cancelled: false,
                partial_output: null,
                cancelled_at: null,
                cancelled_by: null,
              },
            }
          ));
        }
      }

      if (!decision) {
        // LLM failed — exponential backoff (5s, 10s, 20s...)
        const failCount = actionLog.filter(a => a.reasoning === 'LLM call failed').length;
        const backoffMs = Math.min(3000 * Math.pow(1.5, Math.min(failCount, 4)), 15000);
        actionLog.push({
          iteration, reasoning: 'LLM call failed', action: 'wait',
          params: {}, observation: '', success: false, durationMs: 0,
        });
        // After 5 consecutive LLM failures, give up
        const consecutiveFailures = actionLog.slice(-5).filter(a => a.reasoning === 'LLM call failed').length;
        if (consecutiveFailures >= 5) {
          if (isBrowserAgent) await this.cleanupBrowserSession(sessionId, screencapUrl, serviceKey);
          return {
            success: false,
            output: { objective_met: false, iterations: iteration + 1, action_log: actionLog, last_observation: lastObservation?.summary },
            error: { code: 'LLM_UNAVAILABLE', message: `LLM failed ${consecutiveFailures} consecutive times` },
            envelopes,
          };
        }
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }

      // Emit thinking envelope (the decision is now evidenced)
      const thinkEnv = factory.task(
        'agentic.think', Intents.NODE.STARTED, context.correlationId,
        {
          nodeId: node.id, iteration,
          reasoning: decision.reasoning,
          action: decision.action,
          confidence: decision.confidence,
          objective_met: decision.objective_met,
        },
      );
      envelopes.push(thinkEnv);

      // P8.B: Fire-and-forget budget usage ingestion after each think() call.
      // Token usage is now captured in the quox.flow.llm.completed envelope
      // via _lastThinkUsage. Budget store records actual tokens when available
      // (AEE-FULL Gap 3 closes the "future Stage 3 work" debt).
      // Fix (Sentinel-2 Fix3): bypass HTTP — call the budget store directly so
      // the POST can't fail due to a wrong URL or SSRF guard issues.
      if (budgetOrgId && this.budgetEvaluator) {
        const budgetStore = this.budgetEvaluator.getStore();
        const now = new Date().toISOString();
        const effectiveScopeId = budgetScopeId || budgetOrgId;
        // Capture decision in a local const so the closure's type is narrowed to non-null.
        const decisionForBudget = decision;
        // Capture workflowId for closure (workflow-level scope_id fallback).
        // ExecutionContext exposes workflow.id (not a top-level workflowId field).
        const workflowScopeId = context.workflow?.id ?? '';
        Promise.resolve().then(async () => {
          try {
            let matchingBudgets = await budgetStore.listBudgets(budgetOrgId, {
              scope_kind: 'iteration' as BudgetScopeKind,
              scope_id: effectiveScopeId,
              active_at: now,
            });
            // If node-level scope_id (e.g. "health-check") finds nothing, try the workflow
            // ID (e.g. "sentinel-heartbeat") — budgets are typically registered by workflow.
            if (matchingBudgets.length === 0 && workflowScopeId && workflowScopeId !== effectiveScopeId) {
              matchingBudgets = await budgetStore.listBudgets(budgetOrgId, {
                scope_kind: 'iteration' as BudgetScopeKind,
                scope_id: workflowScopeId,
                active_at: now,
              });
            }
            if (matchingBudgets.length === 0) {
              matchingBudgets = await budgetStore.listBudgets(budgetOrgId, {
                scope_kind: 'org' as BudgetScopeKind,
                scope_id: budgetOrgId,
                active_at: now,
              });
            }
            if (matchingBudgets.length > 0) {
              await budgetStore.recordUsage({
                budget_id: matchingBudgets[0].id,
                ts: now,
                tokens_in: 0,
                tokens_out: 0,
                model: 'default/unknown',
                cost_usd_micro: computeCostUsdMicro(0, 0, 'default/unknown'),
                tool_calls: decisionForBudget.action !== 'done' ? 1 : 0,
                duration_ms: 0,
                iteration_count: 1,
                source_kind: 'iteration',
                source_id: context.correlationId,
              });
            }
          } catch (err: unknown) {
            log.warn('Budget usage record failed (non-blocking)', { error: err instanceof Error ? err.message : String(err) });
          }
        });
      }

      // ─── P9.2 / P9.3: Crystal drafting + refinement config (hoisted for post-act use) ──
      const crystalDraftingCfg = config.crystal_drafting ?? { enabled: true, min_iteration: 2 };
      const crystalRefinementCfg = config.crystal_refinement ?? { enabled: true, max_refines: 2 };
      if (
        crystalDraftingCfg.enabled &&
        this.skillLibraryStore &&
        decision.action === 'propose_crystal' &&
        iteration + 1 >= crystalDraftingCfg.min_iteration
      ) {
        const draftParams = decision.params as {
          name?: string; summary?: string; action_pattern?: string; confidence?: number;
        };

        // ─── Sentinel-4 Fix3: Reject propose_crystal when action_pattern claims N actions
        // but fewer than N real tool calls have been completed in this run.
        // This prevents the LLM from short-cutting (e.g. proposing a 3-call pattern after
        // only 2 calls) and guarantees the pattern reflects what was actually observed.
        //
        // This guard is ONLY active for agents whose available_actions include http_call or
        // ssh_exec — those are network/infra-call agents where the pattern strictly requires
        // N endpoint calls before proposing. Browser/generic agents may propose aspirational
        // patterns (e.g. 'navigate,extract') before completing all steps.
        const proposedPatternRaw = String(draftParams.action_pattern || '');
        const isNetworkCallAgent = availableActions.some(a => a === 'http_call' || a === 'ssh_exec');

        // Terminal/meta action names that the LLM may include in the pattern but which
        // are NOT real tool calls (they are the done-trigger or meta-actions).
        const TERMINAL_ACTIONS = new Set(['done', 'complete', 'finished', 'propose_crystal', 'refine_crystal', 'needs_human']);
        const proposedActionNames = proposedPatternRaw
          .split(/[,→|;\/\-]+/)
          .map(s => s.trim())
          .filter(Boolean);
        // Count only the non-terminal actions in the proposed pattern.
        const proposedRealActionCount = proposedActionNames.filter(a => !TERMINAL_ACTIONS.has(a)).length;
        const META_ACT_SET = new Set(['done', 'propose_crystal', 'refine_crystal']);
        const completedRealActionCount = actionLog.filter(a => !META_ACT_SET.has(a.action) && a.success).length;

        // Enforce the guard only for network-call agents and when the LLM proposed more real
        // actions than have been completed.
        if (isNetworkCallAgent && proposedRealActionCount > 0 && proposedRealActionCount > completedRealActionCount) {
          const missingCount = proposedRealActionCount - completedRealActionCount;
          const rejectionMsg =
            `Your propose_crystal was rejected: action_pattern claims ${proposedRealActionCount} tool-call actions ` +
            `but only ${completedRealActionCount} have been completed in this run. ` +
            `Complete the remaining ${missingCount} action(s) before proposing the Crystal.`;

          log.debug(`Fix3: propose_crystal rejected — pattern has ${proposedRealActionCount} real actions, only ${completedRealActionCount} completed`);

          const incompleteEnv = factory.event(
            'quox.agentic.skill.draft_rejected_incomplete_pattern' as any,
            context.correlationId,
            {
              nodeId: node.id,
              executionId: context.correlationId,
              proposedPatternLength: proposedRealActionCount,
              completedActionCount: completedRealActionCount,
              missingCount,
            },
          );
          envelopes.push(incompleteEnv);

          lastObservation = { type: 'generic', summary: rejectionMsg };
          actionLog.push({
            iteration,
            reasoning: decision.reasoning.substring(0, 300),
            action: 'propose_crystal',
            params: decision.params,
            observation: rejectionMsg,
            success: false,
            durationMs: 0,
          });
          await new Promise(r => setTimeout(r, 300));
          continue;
        }

        // AGH-5: build actionLogSnapshot from the real tool calls completed so far.
        // Filter to non-meta actions and strip params to the essentials needed for replay.
        const META_ACT_NAMES = new Set(['done', 'propose_crystal', 'refine_crystal', 'engine_nudge']);
        const actionLogSnapshotForDraft = actionLog
          .filter(a => !META_ACT_NAMES.has(a.action) && a.success)
          .map(a => {
            let snapshotParams: Record<string, unknown> = {};
            if (a.action === 'http_call') {
              const p = a.params as any;
              snapshotParams = { url: p.url, method: p.method ?? 'GET' };
              if (p.headers && Object.keys(p.headers).length > 0) snapshotParams.headers = p.headers;
              if (p.body !== undefined) snapshotParams.body = p.body;
            } else if (a.action === 'ssh_exec') {
              const p = a.params as any;
              snapshotParams = { command: p.command, host: p.host };
            } else {
              // Generic fallback — pass params through (already limited at log time)
              snapshotParams = { ...a.params };
            }
            return { action: a.action, params: snapshotParams };
          });

        const draft = this.skillLibraryStore.createDraft({
          executionId: context.correlationId,
          orgId: agentOrgId || 'default',
          name: String(draftParams.name || 'Unnamed Crystal'),
          summary: String(draftParams.summary || ''),
          actionPattern: proposedPatternRaw,
          confidence: Number(draftParams.confidence ?? 0.7),
          agentId,
          objectiveKeywords: objective.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 10),
          actionLogSnapshot: actionLogSnapshotForDraft,
        });

        if (draft) {
          const draftedEnv = factory.event(
            Intents.AGENTIC.SKILL_DRAFTED,
            context.correlationId,
            { nodeId: node.id, executionId: context.correlationId, name: draft.name, confidence: draft.confidence },
          );
          envelopes.push(draftedEnv);
          // Sentinel-4 Fix1: mark that a crystal was accepted so the NEXT iteration auto-dones.
          proposeAcceptedThisRun = true;
        } else {
          // Draft already exists for this execution — reject
          const rejectedEnv = factory.event(
            Intents.AGENTIC.SKILL_DRAFT_REJECTED,
            context.correlationId,
            { nodeId: node.id, executionId: context.correlationId, reason: 'draft_already_exists' },
          );
          envelopes.push(rejectedEnv);
        }

        // propose_crystal is handled as a meta-action — continue loop with 'screenshot' observation
        actionLog.push({
          iteration,
          reasoning: decision.reasoning.substring(0, 300),
          action: 'propose_crystal',
          params: decision.params,
          observation: draft ? 'Crystal draft created' : 'Draft rejected: already exists',
          success: !!draft,
          durationMs: 0,
        });
        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      // ─── P9.3: REFINEMENT ACTION ─────────────────────────────
      if (
        crystalRefinementCfg.enabled &&
        this.skillLibraryStore &&
        decision.action === 'refine_crystal'
      ) {
        const refinePatch = decision.params as {
          summary?: string; action_pattern?: string; confidence?: number;
        };
        const existingDraft = this.skillLibraryStore.getDraftByExecution(context.correlationId);
        if (existingDraft && existingDraft.refineCount < crystalRefinementCfg.max_refines) {
          const updated = this.skillLibraryStore.updateDraft(context.correlationId, {
            summary: refinePatch.summary ? String(refinePatch.summary) : undefined,
            actionPattern: refinePatch.action_pattern ? String(refinePatch.action_pattern) : undefined,
            confidence: refinePatch.confidence != null ? Number(refinePatch.confidence) : undefined,
          });
          if (updated) {
            const refinedEnv = factory.event(
              Intents.AGENTIC.SKILL_REFINED,
              context.correlationId,
              {
                nodeId: node.id,
                executionId: context.correlationId,
                refineCount: updated.refineCount,
                newActionPattern: updated.actionPattern,
              },
            );
            envelopes.push(refinedEnv);
            refinementHint = ''; // Clear hint after successful refinement
          }
        }

        // refine_crystal is handled as a meta-action
        actionLog.push({
          iteration,
          reasoning: decision.reasoning.substring(0, 300),
          action: 'refine_crystal',
          params: decision.params,
          observation: 'Crystal draft refined',
          success: true,
          durationMs: 0,
        });
        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      // ─── CHECK: OBJECTIVE MET? ──────────────────────────────
      // Engine-level guard: for agents with http_call/ssh_exec available, block 'done'
      // if no real tool calls have been made yet. The LLM sometimes hallucinates tool
      // results at iteration 0 (claims to have checked services it hasn't actually called).
      // Only applies when http_call or ssh_exec is in the available action set — those are
      // the signals that real tool execution is expected.
      const hasToolActionsAvailable = availableActions.some(a => a === 'http_call' || a === 'ssh_exec');
      if (hasToolActionsAvailable && (decision.action === 'done' || decision.objective_met)) {
        const realActionsCount = actionLog.filter(
          a => a.action !== 'done' && a.action !== 'propose_crystal' && a.action !== 'refine_crystal'
        ).length;
        // AGH-1.fix-2: extend the existing 0-call guard to also block done
        // when the LLM has completed *some* but fewer than the expected
        // pattern length. Default min = 3 (canonical pattern length); can
        // be overridden via crystal_promotion_threshold.min_actions_before_done
        // and disabled by setting it to 0.
        const minActionsThreshold = config.crystal_promotion_threshold?.min_actions_before_done
          ?? config.crystal_promotion_threshold?.consecutive_success
          ?? 3;
        const minRequired = Math.max(0, minActionsThreshold);
        if (realActionsCount < minRequired) {
          log.debug(`Blocking premature 'done' (${realActionsCount}/${minRequired} tool calls made). Injecting engine nudge observation.`);
          // Sentinel-3 Fix1: inject a synthetic observation instead of dispatching a blank
          // http_call({}) which was producing SSRF_BLOCKED and confusing the LLM.
          // The observation is injected as the LATEST entry the next think() call will see.
          // AGH-1.fix-2: nudge text adapts to whether ANY actions have been made
          // and what's still needed (vs the original Sentinel-only URL list).
          const nudgeAction = availableActions.find(a => a === 'http_call' || a === 'ssh_exec') || 'http_call';
          const remaining = Math.max(0, minRequired - realActionsCount);
          const nudgeSummary = realActionsCount === 0
            ? `[ENGINE NOTICE] You tried to complete with 0 tool calls. The objective requires at ` +
              `least ${minRequired} ${nudgeAction}(s) per the ORDER OF OPERATIONS in your system ` +
              `prompt. Pick ${nudgeAction} as your NEXT action with the FIRST URL listed. ` +
              `Do NOT claim you have made calls you have not actually made.`
            : `[ENGINE NOTICE] You claimed 'done' after ${realActionsCount} tool call(s), but the ` +
              `pattern requires at least ${minRequired}. ${remaining} more call(s) remain. Continue ` +
              `with the NEXT URL in your ORDER OF OPERATIONS. The previous observations are visible ` +
              `in your action log — do NOT fabricate calls you have not actually made.`;
          lastObservation = { type: 'generic', summary: nudgeSummary };

          // Emit engine_nudge envelope for audit trail
          const nudgeEnv = factory.event(
            'quox.agentic.engine_nudge' as any,
            context.correlationId,
            {
              nodeId: node.id,
              iteration,
              reason: realActionsCount === 0 ? 'premature_done_no_tool_calls' : 'premature_done_incomplete_pattern',
              actionsCompleted: realActionsCount,
              actionsRequired: minRequired,
            },
          );
          envelopes.push(nudgeEnv);

          // Re-loop immediately — skip the action phase entirely.
          // The next iteration will call think() with the nudge observation.
          continue;
        }
      }

      // ─── PRECEDENT GATE: cite before you finish ─────────────────
      // A human ruling recorded against this fact pattern binds: the agent
      // must either follow it or explicitly distinguish it before its 'done'
      // is accepted (src/pipeline/precedent-gate.ts is the fail-closed
      // enforcement, this is the judgment-call boundary its header asked a
      // wiring pass to pick). Empty store, no matching precedent, no store
      // wired, or a store failure all leave the branch below untouched — the
      // gate only ever adds a requirement when a ruling actually exists.
      if (this.precedentStore && agentOrgId && (decision.action === 'done' || decision.objective_met)) {
        let applicable: PrecedentRecord[] = [];
        try {
          applicable = await this.precedentStore.findApplicable({
            orgId: agentOrgId,
            contextKeys: precedentContextKeys,
            maxResults: 3,
          });
        } catch (err) {
          log.warn(`precedent-gate: retrieval failed, proceeding without it: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (applicable.length > 0) {
          // Retrieved this iteration, so the next think() prompt shows them.
          precedentsBlock = this.renderPrecedentsBlock(applicable);

          let verdict: Awaited<ReturnType<typeof enforcePrecedentCitation>> | null = null;
          try {
            verdict = await enforcePrecedentCitation(
              {
                orgId: agentOrgId,
                contextKeys: precedentContextKeys,
                reasoningTrace: decision.reasoning,
              },
              this.precedentStore,
            );
          } catch (err) {
            log.warn(`precedent-gate: enforcement failed, proceeding without it: ${err instanceof Error ? err.message : String(err)}`);
          }

          if (verdict && !verdict.allowed) {
            const top = applicable[0];
            const blockedId = verdict.matchedPrecedentId ?? top.id;
            log.debug(`Blocking uncited 'done' — active precedent ${blockedId} applies. Injecting engine nudge observation.`);
            lastObservation = {
              type: 'generic',
              summary:
                `[ENGINE NOTICE] You tried to complete while an active precedent applies to this task. ` +
                `Precedent ${blockedId}: ${top.ratio} ` +
                `Before declaring done, your reasoning MUST contain either follows_precedent:${blockedId} ` +
                `or distinguishes_precedent:{"id":"${blockedId}","factual_delta":"<how this case differs>"}. ` +
                `Do NOT claim done again without one of those markers.`,
            };

            envelopes.push(factory.event(
              'quox.agentic.precedent_blocked' as any,
              context.correlationId,
              {
                nodeId: node.id,
                iteration,
                reason: 'done_without_precedent_citation',
                precedentId: blockedId,
                precedentCount: applicable.length,
              },
            ));

            // Re-loop — the next think() call carries the PRECEDENTS block.
            continue;
          }

          if (verdict?.allowed && verdict.citation?.cited && verdict.matchedPrecedentId) {
            // Citation count tracks both modes: the store's own contract is
            // "incremented when a precedent is followed OR distinguished".
            try {
              await this.precedentStore.recordCitation(verdict.matchedPrecedentId, agentOrgId);
            } catch (err) {
              log.warn(`precedent-gate: recordCitation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
            }

            envelopes.push(factory.event(
              'quox.agentic.precedent_cited' as any,
              context.correlationId,
              {
                nodeId: node.id,
                iteration,
                precedentId: verdict.matchedPrecedentId,
                citedId: verdict.citation.precedentId,
                mode: verdict.citation.mode,
                factualDelta: verdict.citation.factualDelta,
              },
            ));
          }
        }
      }

      if (decision.action === 'done' || decision.objective_met) {
        // BQ-SMART Phase 5: Extract wisdom + PERSIST to wisdom store
        if (isBrowserAgent && urlOrigin) {
          try {
            const wisdomResult = await this.executeBrowserAction('browser_extract_wisdom' as any,
              { action_log: actionLog, url_origin: urlOrigin },
              sessionId, screencapUrl, serviceKey, triggerOrgId, agentOrgId, objectiveId);
            const rawWisdom = wisdomResult.output as any;
            const wisdomEntries = rawWisdom?.result?.wisdom || rawWisdom?.wisdom || rawWisdom?.result?.result?.wisdom || [];
            if (wisdomEntries.length > 0) {
              bqSmartLog.debug(`Extracted ${wisdomEntries.length} wisdom entries for ${urlOrigin}`);
            }
            // Persist each wisdom entry to the tasks service wisdom store
            const tasksUrl = progressCallbackUrl || process.env.TASKS_URL || 'http://tasks:3104';
            for (const w of wisdomEntries) {
              try {
                await fetch(`${tasksUrl}/api/wisdom`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
                  body: JSON.stringify({
                    org_id: triggerOrgId || 'default',
                    pattern_name: w.pattern,
                    category: w.category || 'browser',
                    lesson: w.details || w.pattern,
                    directive: `Browser automation learned: ${w.pattern}`,
                    severity: w.confidence > 0.8 ? 'medium' : 'low',
                    tags: ['browser-q', 'bq-smart', w.category],
                  }),
                  signal: AbortSignal.timeout(5000),
                });
              } catch { /* per-entry save is best-effort */ }
            }
          } catch { /* wisdom is best-effort */ }
        }

        // Clean up browser session
        if (isBrowserAgent) await this.cleanupBrowserSession(sessionId, screencapUrl, serviceKey);

        // ─── P9.4: Task-time crystallisation (done branch) ───────
        // If a draft exists and confidence threshold met, promote it to a candidate Crystal.
        // Tier gating is enforced at the HTTP promote-draft endpoint — the executor path
        // creates the candidate unconditionally (the draft only exists if crystal_drafting=enabled).
        const promotionThreshold = config.crystal_promotion_threshold ?? {
          confidence: 0.8, consecutive_success: 3,
        };
        if (this.skillLibraryStore) {
          const activeDraft = this.skillLibraryStore.getDraftByExecution(context.correlationId);
          if (activeDraft) {
            // Sentinel-4 Fix2: compute completed action pattern from the real tool calls
            // (exclude meta-actions like propose_crystal/refine_crystal/done).
            // If the decision action that triggered done is not the literal 'done' action
            // (e.g. 'complete', 'http_call', etc.), include it as the final action in the pattern
            // because the LLM correctly lists it in action_pattern but the ACT phase never
            // fires for it (done-branch short-circuits before ACT).
            const META_ACTIONS = new Set(['done', 'propose_crystal', 'refine_crystal']);
            const realActions = actionLog.filter(a => !META_ACTIONS.has(a.action));
            const doneAction = (!META_ACTIONS.has(decision.action)) ? [decision.action] : [];
            const completedPattern = [...realActions.map(a => a.action), ...doneAction].join(',');

            // Increment cross-execution consecutive-success counter (resets if pattern diverged).
            const newConsecCount = this.skillLibraryStore.recordSuccessfulRun({
              agentId: activeDraft.agentId || agentId || '',
              orgId: activeDraft.orgId || agentOrgId || 'default',
              actionPattern: activeDraft.actionPattern,
              completedActionPattern: completedPattern,
            });
            log.debug(`Draft "${activeDraft.name}" consecutiveSuccess → ${newConsecCount} (threshold: ${promotionThreshold.consecutive_success})`);

            // Re-fetch draft so it reflects the updated consecutiveSuccess
            const updatedDraft = this.skillLibraryStore.getDraftByExecution(context.correlationId) ?? activeDraft;

            const draftAnalysis = analyseDraft(
              updatedDraft,
              actionLog,
              promotionThreshold,
            );
            log.debug(`analyseDraft: ready=${draftAnalysis.ready} confidence=${draftAnalysis.recomputedConfidence.toFixed(2)} consecutiveSuccess=${draftAnalysis.consecutiveSuccess}/${promotionThreshold.consecutive_success}${draftAnalysis.reason ? ' reason=' + draftAnalysis.reason : ''}`);

            if (draftAnalysis.ready) {
              try {
                // Sentinel-5 Fix2: promote as canonical (not candidate) on threshold met.
                // promoteCanonical() also resets the counter so run 4 doesn't re-promote.
                // AGH-5: pass actionLogSnapshot so the canonical row can be replayed deterministically.
                // QSKL-4.B: stamp source_skill_id if a skill was loaded this session.
                const lastLoaded = loadedSkills.length > 0
                  ? loadedSkills[loadedSkills.length - 1]
                  : undefined;
                const skillMeta: Record<string, unknown> | undefined = lastLoaded
                  ? { source_skill_id: lastLoaded.id, source_skill_version: lastLoaded.version }
                  : undefined;
                const promoted = await this.skillLibraryStore.promoteCanonical({
                  orgId: updatedDraft.orgId || agentOrgId || 'default',
                  executionId: context.correlationId,
                  name: updatedDraft.name,
                  summary: updatedDraft.summary,
                  actionPattern: updatedDraft.actionPattern,
                  confidence: draftAnalysis.recomputedConfidence,
                  agentId: updatedDraft.agentId,
                  objectiveKeywords: updatedDraft.objectiveKeywords,
                  actionLogSnapshot: updatedDraft.actionLogSnapshot,
                }, skillMeta);

                this.skillLibraryStore.clearDraft(context.correlationId);

                const promotedEnv = factory.event(
                  Intents.AGENTIC.SKILL_PROMOTED,
                  context.correlationId,
                  {
                    nodeId: node.id,
                    executionId: context.correlationId,
                    crystalId: promoted.id,
                    name: promoted.name,
                    stage: 'canonical',
                    recomputedConfidence: draftAnalysis.recomputedConfidence,
                    consecutiveSuccess: draftAnalysis.consecutiveSuccess,
                  },
                );
                envelopes.push(promotedEnv);
              } catch { /* promotion is best-effort */ }
            }
          }
        }

        const resultEnv = factory.result(
          taskEnv, Intents.NODE.COMPLETED,
          {
            nodeId: node.id,
            objective_met: true,
            iterations: iteration + 1,
            actions_taken: actionLog.length,
            final_reasoning: decision.reasoning,
          },
        );
        envelopes.push(resultEnv);

        return {
          success: true,
          output: {
            objective_met: true,
            iterations: iteration + 1,
            actions_taken: actionLog.length,
            action_log: actionLog,
            last_observation: lastObservation?.summary,
            final_reasoning: decision.reasoning,
            session_id: sessionId || undefined,
          },
          envelopes,
        };
      }

      // ─── STUCK DETECTION ─────────────────────────────────────
      // If the last 3 actions are identical (same action + same observation), agent is stuck
      if (actionLog.length >= 3) {
        const last3 = actionLog.slice(-3);
        const allSameAction = last3.every(a => a.action === decision.action);
        const allSameObs = last3.every(a => a.observation === last3[0].observation);
        if (allSameAction && allSameObs) {
          // Force the agent to try 'done' with a failure explanation
          if (isBrowserAgent) await this.cleanupBrowserSession(sessionId, screencapUrl, serviceKey);
          const stuckReason = `Agent stuck: repeated ${decision.action} × ${last3.length + 1} with same observation. Exiting to prevent token waste.`;
          return {
            success: false,
            output: {
              objective_met: false, iterations: iteration + 1,
              actions_taken: actionLog.length, action_log: actionLog,
              last_observation: lastObservation?.summary,
              stuck_reason: stuckReason,
            },
            error: { code: 'STUCK_LOOP', message: stuckReason },
            envelopes,
          };
        }
      }

      // ─── ACT ────────────────────────────────────────────────
      const actStart = Date.now();
      let actResult: ExecutorResult;

      try {
        if (isBrowserAgent && this.isBrowserAction(decision.action)) {
          // Direct screencap call for browser actions (bypasses node executor registry)
          actResult = await this.executeBrowserAction(
            decision.action, decision.params, sessionId, screencapUrl, serviceKey, triggerOrgId, agentOrgId, objectiveId
          );
        } else if (decision.action === 'needs_human') {
          // HITL pause — return immediately, execution will be resumed later
          const resultEnv = factory.result(
            taskEnv, Intents.NODE.COMPLETED,
            { nodeId: node.id, paused: true, pauseReason: decision.params?.reason || 'Human assistance required',
              iterations: iteration + 1, actions_taken: actionLog.length },
          );
          envelopes.push(resultEnv);
          return {
            success: true,
            output: { paused: true, pauseReason: decision.params?.reason, iterations: iteration + 1,
              action_log: actionLog, session_id: sessionId },
            envelopes,
          };
        } else if (
          this.quoxSkillsStore &&
          (decision.action === 'skills_list' || decision.action === 'skill_view' || decision.action === 'skill_manage')
        ) {
          // ─── QSKL-2/4.A: Skills catalog actions ──────────────────────────
          // patchesStore is required for skill_manage(action='patch') with body_md.
          // Throw early if it's missing in that specific case — wiring contract
          // violation, not a fallback case.
          const isBodyMdPatch =
            decision.action === 'skill_manage' &&
            (decision.params as Record<string, unknown>).action === 'patch' &&
            (decision.params as Record<string, unknown>).body_md !== undefined;
          if (isBodyMdPatch && !this.quoxSkillPatchesStore) {
            throw new Error(
              '[AgenticExecutor] quoxSkillPatchesStore is not wired. ' +
              'Call setQuoxSkillPatchesStore() during server setup before executing ' +
              'skill_manage(action=patch) with body_md.'
            );
          }
          // For non-patch or non-body_md cases, fall back to an empty in-memory
          // instance (patchesStore is not accessed for create/delete/metadata-patch).
          const patchesStore = this.quoxSkillPatchesStore ?? new QuoxSkillPatchesStore();
          // QSKL-7.fix2: Use last-loaded Crystal's id when retrievedCrystals is non-empty.
          // This matches the heuristic described in agentic.executor.ts:297-301 — the most
          // recently retrieved Crystal is the active one for the current execution turn.
          const activeCrystalId = retrievedCrystals.length > 0
            ? retrievedCrystals[retrievedCrystals.length - 1].id
            : null;
          const skillsCtx = {
            store: this.quoxSkillsStore,
            patchesStore,
            skillLibraryStore: this.skillLibraryStore,
            evidenceStore: this.evidenceStore,
            approvalEngine: this.approvalEngine,
            toolsmithAdapter: this.toolsmithAdapter,
            toolPresenceLookup: this.toolPresenceLookup,
            invocationsStore: this.quoxSkillInvocationsStore,  // QSKL-7.8
            patchRateLimiter: this.patchRateLimiter,           // QSKL-14a
            // QSKL-SAFETY.B: Firewall gate on skill_manage create/patch writes
            firewall: this.skillFirewall ?? createSkillFirewall(),
            firewallLogStore: this.skillFirewallLogStore,
            // QSKL-SAFETY.E: Promotion gate (blocks experimental→stable when review row exists)
            reviewQueueStore: this.skillReviewQueueStore,
            // QSKL-SAFETY Gap 6: AOCL layer-5 gate emissions
            envelopeStore: this._envelopeStore,
            orgId: agentOrgId || 'default',
            agentId: agentId,
            params: decision.params,
            // QSKL-7.fix2: Pass Crystal context and LLM usage for skill telemetry attribution.
            activeCrystalId,
            lastLlmUsage: this._lastThinkUsage,
            // QSKL-7-FIX-A: AEE correlation ID is the live session identifier in the executor.
            // context.correlationId is set by the caller (workflow engine) for every execution.
            sessionId: context.correlationId || null,
          };
          const handler =
            decision.action === 'skills_list' ? skillsListHandler :
            decision.action === 'skill_view'  ? skillViewHandler  :
            skillManageHandler;

          const skillsResult = await handler(skillsCtx as any);

          // QSKL-4.B: When skill_view succeeds, track the loaded skill so Crystal
          // promotion can stamp source_skill_id onto the Crystal's metadata.
          if (decision.action === 'skill_view' && skillsResult.success && skillsResult.data) {
            const d = skillsResult.data as Record<string, unknown>;
            const loadedId = typeof d.id === 'string' ? d.id : '';
            const loadedName = typeof d.name === 'string' ? d.name : '';
            const loadedVersion = d.version !== undefined ? String(d.version) : '';
            if (loadedId) {
              const existing = loadedSkills.findIndex(s => s.id === loadedId);
              const entry = { id: loadedId, name: loadedName, version: loadedVersion, loadedAt: new Date().toISOString() };
              if (existing >= 0) {
                loadedSkills[existing] = entry; // update loadedAt for de-dupe
              } else {
                loadedSkills.push(entry);
              }
            }
          }

          // Emit an envelope capturing the action
          const skillsEnv = factory.event(
            `quox.agentic.skills.${decision.action}` as any,
            context.correlationId,
            {
              nodeId: node.id,
              iteration,
              action: decision.action,
              envelopeShape: skillsResult.envelopeShape,
              success: skillsResult.success,
            },
          );
          envelopes.push(skillsEnv);

          actResult = {
            success: skillsResult.success,
            output: skillsResult.success
              ? { result: skillsResult.data, envelopeShape: skillsResult.envelopeShape }
              : null,
            error: !skillsResult.success
              ? { code: skillsResult.error ?? 'SKILLS_ACTION_ERROR', message: skillsResult.message ?? skillsResult.error ?? 'Skills action failed' }
              : undefined,
            envelopes: [],
          };
        } else if (decision.action === 'session_search') {
          // ─── QSKL-13: Session FTS search action ──────────────────────────
          const { InMemorySessionSearchStore } = await import('../store/session-search-store.js');
          const searchStore = this.sessionSearchStore ?? new InMemorySessionSearchStore();
          const searchResult = await sessionSearchHandler({
            orgId: agentOrgId || 'default',
            params: decision.params,
            searchStore,
          });
          const sessionSearchEnv = factory.event(
            'quox.agentic.session.search' as any,
            context.correlationId,
            {
              nodeId: node.id,
              iteration,
              action: 'session_search',
              ok: searchResult.ok,
            },
          );
          envelopes.push(sessionSearchEnv);
          actResult = {
            success: searchResult.ok,
            output: searchResult.ok ? { result: searchResult } : null,
            error: !searchResult.ok
              ? { code: (searchResult as any).error_code ?? 'SESSION_SEARCH_ERROR', message: (searchResult as any).reason ?? 'session_search failed' }
              : undefined,
            envelopes: [],
          };
        } else {
          // Non-browser actions: use the node executor registry
          const actionNode: Node = {
            id: `${node.id}_act_${iteration}`,
            type: this.mapActionToNodeType(decision.action) as any,
            name: decision.reasoning.substring(0, 60),
            config: decision.params,
          } as any;
          const actionExecutor = context.executors?.get(actionNode.type);
          if (actionExecutor) {
            actResult = await actionExecutor.execute(actionNode, lastActionOutput, context);
          } else {
            actResult = {
              success: false, output: null,
              error: { code: 'NO_EXECUTOR', message: `No executor for action type: ${decision.action}` },
              envelopes: [],
            };
          }
        }
      } catch (err: any) {
        actResult = {
          success: false, output: null,
          error: { code: 'ACT_ERROR', message: err.message },
          envelopes: [],
        };
      }

      const actDuration = Date.now() - actStart;
      envelopes.push(...(actResult?.envelopes || []));

      // ─── OBSERVE ────────────────────────────────────────────
      // For browser actions, observation comes from the screencap response (includes screenshot_base64)
      if (isBrowserAgent && actResult?.output) {
        const output = actResult.output as Record<string, unknown>;
        lastObservation = this.observationRegistry.produce(
          { id: `${node.id}_act_${iteration}`, type: 'browser:navigate' as any, config: {} } as any,
          actResult,
        );
      } else {
        const actionNode: Node = {
          id: `${node.id}_act_${iteration}`,
          type: this.mapActionToNodeType(decision.action) as any,
          config: decision.params,
        } as any;
        lastObservation = this.observationRegistry.produce(actionNode, actResult);
      }
      lastActionOutput = actResult?.output;

      // Log the action
      actionLog.push({
        iteration,
        reasoning: (decision.reasoning || '').substring(0, 300),
        action: decision.action,
        params: Object.fromEntries(Object.entries(decision.params || {}).map(([k, v]) => [k, typeof v === 'string' && v.length > 200 ? v.substring(0, 200) + '...' : v])),
        observation: (lastObservation?.summary || actResult.error?.message || 'no observation').substring(0, 200),
        success: actResult.success,
        durationMs: actDuration,
      });

      // ─── P9.3: POST-ACT REFINEMENT HINT ─────────────────────
      // If the act failed and a draft exists within refine budget, inject a hint
      // for the next think() call so the thinker can emit refine_crystal.
      if (!actResult.success && this.skillLibraryStore && crystalRefinementCfg.enabled) {
        const activeDraft = this.skillLibraryStore.getDraftByExecution(context.correlationId);
        if (activeDraft && activeDraft.refineCount < crystalRefinementCfg.max_refines) {
          const observedSummary = lastObservation?.summary || actResult.error?.message || 'unknown';
          refinementHint =
            `You proposed pattern "${activeDraft.name}" with action_pattern="${activeDraft.actionPattern}". ` +
            `The last act FAILED with observation: "${observedSummary}". ` +
            `Emit refine_crystal { summary, action_pattern, confidence } to update the pattern, ` +
            `or discard_crystal to abandon it.`;
        } else {
          refinementHint = ''; // Draft at cap or no draft — clear hint
        }
      } else if (actResult.success) {
        refinementHint = ''; // Success — clear any pending refinement hint
      }

      // ─── CACHE UPDATE (BQ-SMART) ────────────────────────────
      if (isBrowserAgent && urlOrigin) {
        try {
          if (actResult.success && !cacheId) {
            // Cache hit didn't exist — store this successful decision
            await this.executeBrowserAction(
              'action_cache_store' as any,
              { org_id: triggerOrgId, url_origin: urlOrigin, objective, observation_summary: lastObservation?.summary || '', decision },
              sessionId, screencapUrl, serviceKey, triggerOrgId, agentOrgId, objectiveId
            );
          } else if (!actResult.success && cacheId) {
            // Cached action failed — record miss (self-heal will happen on next think)
            await this.executeBrowserAction(
              'action_cache_miss' as any,
              { cache_id: cacheId },
              sessionId, screencapUrl, serviceKey, triggerOrgId, agentOrgId, objectiveId
            );
          } else if (actResult.success && cacheId) {
            // Cached action succeeded with a DIFFERENT decision (healed) — update cache
            // Only if the action was re-resolved by think() after a miss
          }
        } catch { /* cache is best-effort */ }
      }

      // Emit act result envelope
      const actEnv = factory.result(
        thinkEnv, Intents.NODE.COMPLETED,
        {
          nodeId: node.id, iteration,
          action: decision.action,
          success: actResult.success,
          observation: lastObservation?.summary,
          durationMs: actDuration,
        },
      );
      envelopes.push(actEnv);

      // ─── PROGRESS CALLBACK (BQ Phase 4) ─────────────────────
      if (progressCallbackUrl && objectiveId) {
        this.emitProgressEvent(progressCallbackUrl, objectiveId, serviceKey, {
          type: 'agentic_iteration',
          iteration,
          phase: 'act',
          reasoning: decision.reasoning,
          action: decision.action,
          params: decision.params,
          success: actResult?.success ?? false,
          observation: lastObservation?.summary || '',
          confidence: decision.confidence,
          durationMs: actDuration,
        }).catch(() => { /* non-critical */ });
      }

      // Brief pause between iterations
      await new Promise(r => setTimeout(r, 300));
    }

    // Max iterations reached — clean up browser session
    if (isBrowserAgent) await this.cleanupBrowserSession(sessionId, screencapUrl, serviceKey);

    const errorEnv = factory.error(taskEnv, Intents.NODE.FAILED, {
      code: 'MAX_ITERATIONS',
      message: `Objective not met after ${maxIterations} iterations`,
      details: { iterations: maxIterations, actions_taken: actionLog.length },
    });
    envelopes.push(errorEnv);

    return {
      success: false,
      output: {
        objective_met: false,
        iterations: maxIterations,
        actions_taken: actionLog.length,
        action_log: actionLog,
        last_observation: lastObservation?.summary,
      },
      error: {
        code: 'MAX_ITERATIONS',
        message: `Objective not met after ${maxIterations} iterations`,
      },
      envelopes,
    };
  }

  /**
   * PRECEDENT: serialise retrieved precedents for the think prompt, one per
   * line, hard-capped at 2KB the same way provenPatterns is.
   */
  private renderPrecedentsBlock(precedents: PrecedentRecord[]): string {
    const serialised = precedents
      .map(p => `[${p.id}] (${p.authority}, cited ${p.citationCount}x) ratio: ${p.ratio}`)
      .join('\n');
    const bytes = new TextEncoder().encode(serialised);
    return bytes.length <= 2048
      ? serialised
      : new TextDecoder().decode(bytes.slice(0, 2048)) + '...';
  }

  /**
   * THINK: Ask the LLM what to do next given the current observation.
   * Uses Claude Vision when a screenshot is available (BQ Phase 3).
   */
  private async think(ctx: {
    objective: string;
    agentId: string;
    iteration: number;
    maxIterations: number;
    lastObservation: Observation | null;
    actionLog: Array<{ action: string; reasoning: string; observation: string; success: boolean }>;
    availableActions: string[];
    collectorUrl: string;
    serviceKey: string;
    domainWisdom?: string;
    provenPatterns?: string;
    /** MEM-DECAY MD.3: last N failure lessons for this workflow (see durable-hooks.ts / lineage-analyzer.ts). */
    priorLessons?: string[];
    /** PRECEDENT: rendered PRECEDENTS block — present only once the done-gate
     * has retrieved active precedents for this run's fact pattern. */
    precedents?: string;
    refinementHint?: string;
    isBrowserAgent?: boolean;
    /** QSKL-2: skills catalog summary line injected into the system prompt */
    skillsCatalogLine?: string;
    /** QSKL-3: skill creation nudge text to prepend to the prompt (empty string = no nudge) */
    creationNudge?: string;
    /** QSKL-12: persona content fetched once per run (null if unavailable) */
    personaContent?: string | null;
    /** AEE-FULL Gap 4: workflow-level cancellation signal */
    cancellationSignal?: AbortSignal;
    /** REPLAY-ONLY .A0: run identity threaded to the collector on every LLM call */
    orgId?: string;
    workflowId?: string;
    executionId?: string;
    /** REPLAY-ONLY .A-1a: effective replay_only resolved once at run start */
    effectiveReplayOnly?: boolean;
  }): Promise<ThinkDecision | null> {
    // QSKL-7.fix2: Reset per-iteration usage so stale data isn't reused if the
    // LLM response doesn't include a usage block this call.
    this._lastThinkUsage = null;
    const hasImage = !!ctx.lastObservation?.imageBase64;
    const isBrowser = ctx.isBrowserAgent ?? false;

    // Non-browser agents (http_call, ssh_exec, etc.) use a different prompt
    // that doesn't reference browser concepts and properly explains tool params.
    if (!isBrowser) {
      return this.thinkNonBrowser(ctx);
    }

    const prompt = `${ctx.creationNudge ?? ''}You are an autonomous browser agent working toward an objective. ${hasImage ? 'You can SEE the current page in the attached screenshot.' : ''}
${ctx.skillsCatalogLine ? `\n${ctx.skillsCatalogLine}\n` : ''}
OBJECTIVE: ${ctx.objective}
${ctx.provenPatterns ? `
PROVEN PATTERNS (from prior successful runs — use these to shortcut your approach):
${ctx.provenPatterns}
` : ''}${ctx.precedents ? `
PRECEDENTS (binding human rulings for this fact pattern — you must follow or distinguish one before finishing):
${ctx.precedents}
` : ''}${ctx.priorLessons && ctx.priorLessons.length > 0 ? `
LESSONS FROM PRIOR FAILED RUNS OF THIS WORKFLOW:
${ctx.priorLessons.map((l, i) => `${i + 1}. ${l}`).join('\n')}
` : ''}${ctx.domainWisdom ? `
WHAT WE ALREADY KNOW ABOUT THIS SITE (from previous runs):
${ctx.domainWisdom}
Use this knowledge to avoid repeating mistakes and take shortcuts.
` : ''}${ctx.refinementHint ? `
CRYSTAL REFINEMENT NEEDED:
${ctx.refinementHint}
` : ''}
CURRENT STATE:
${ctx.lastObservation ? `Last observation: ${ctx.lastObservation.summary}` : 'No observation yet (first iteration)'}
${ctx.lastObservation?.metadata ? `Page info: ${JSON.stringify(ctx.lastObservation.metadata).substring(0, 500)}` : ''}

ACTIONS TAKEN SO FAR:
${ctx.actionLog.length > 0
  ? ctx.actionLog.map((a, i) => `${i + 1}. ${a.action}: ${a.reasoning} → ${a.success ? 'OK' : 'FAILED'} | Observed: ${a.observation}`).join('\n')
  : 'None yet'}

ITERATION: ${ctx.iteration + 1}/${ctx.maxIterations}

AVAILABLE ACTIONS:
${ctx.availableActions.map(a => `- ${a}${a === 'click' ? ' (params: { text: "button text" } OR { selector: "css selector" })' : a === 'type' ? ' (params: { selector: "css selector", text: "text to type" })' : a === 'navigate' ? ' (params: { url: "..." })' : a === 'fill_form' ? ' (params: { fields: { "Label": "value", ... }, submit: true/false })' : a === 'extract' ? ' (params: { format: "text"|"links"|"tables" })' : a === 'scroll' ? ' (params: { direction: "down"|"up", amount: 500 })' : a === 'wait' ? ' (params: { selector: "css selector", timeout: 5000 })' : a === 'select' ? ' (params: { selector: "select css", value: "option value" })' : ''}`).join('\n')}
- needs_human: request human help (params: { reason: "why" }) — use for CAPTCHAs, 2FA
- done: objective is COMPLETE

RULES:
- IMPORTANT: The page TITLE can be the same on both the login page and the dashboard. Check the URL and page content to verify your actual state.
- If the URL contains "/login" or the observation says "LOGIN PAGE", you are NOT logged in yet.
- After login, use extract (format: "text") to verify you see dashboard content (not "Sign in" or "Email/Password" forms).
- For login: use login action with params { credential_id: "cred-bq-dash" }. The system handles HITL approval automatically.
${hasImage ? `- LOOK at the screenshot carefully before deciding
- If you see a cookie/consent banner or popup, click "Accept All" or equivalent to dismiss it FIRST
- If you see a CAPTCHA or "I am not a robot" challenge, use needs_human
- Describe what you see on the page before stating your action` : ''}
- If an action failed, try a different approach (different selector, different text)
- Do NOT declare "done" until you have VERIFIED the objective by extracting content or confirming the URL is correct
- When the objective is fully achieved and VERIFIED, use action "done" with confidence 1.0
- Be concise in reasoning
- For click: prefer { text: "visible button text" } over CSS selectors
${ctx.precedents ? `- A PRECEDENTS block is present above. When you choose action "done", your "reasoning" MUST contain either follows_precedent:<id> (you are applying that ruling) or distinguishes_precedent:{"id":"<id>","factual_delta":"<how this case differs>"} (it does not apply here). A "done" without one of those markers is rejected by the engine.
` : ''}
Respond with ONLY valid JSON:
{ "reasoning": "I see [what's on the page]. I will [action] because [why].", "action": "...", "params": {...}, "objective_met": false, "confidence": 0.0-1.0 }`;

    try {
      // Try vision endpoint first if image available, then fallback to text-only
      const endpoints = hasImage
        ? [
            { url: `${ctx.collectorUrl}/api/internal/agents/vision-invoke`, images: [{ base64: ctx.lastObservation!.imageBase64!, media_type: ctx.lastObservation!.imageMediaType || 'image/jpeg' }] },
            { url: `${ctx.collectorUrl}/api/internal/agents/invoke`, images: undefined }, // fallback: text-only
          ]
        : [
            { url: `${ctx.collectorUrl}/api/internal/agents/invoke`, images: undefined },
          ];

      for (const ep of endpoints) {
        try {
          const res = await fetch(ep.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-service-key': ctx.serviceKey,
            },
            body: JSON.stringify({
              agent_id: ctx.agentId,
              task: prompt,
              no_tools: true,
              ...(ep.images ? { images: ep.images } : {}),
              context: 'You are a JSON-only agentic executor. Output valid JSON and nothing else. Never output markdown, explanations, or anything besides the JSON object.',
              // REPLAY-ONLY .A0: run identity so a collector-side gate can
              // identify the run (docs/STREAM_REPLAY_ONLY_FABLE_REVIEW.md §5 .A0)
              ...(ctx.orgId ? { org_id: ctx.orgId } : {}),
              ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
              ...(ctx.executionId ? { execution_id: ctx.executionId } : {}),
              // REPLAY-ONLY .A-1a: effective replay_only for this run, always
              // sent (not conditionally spread) so a collector-side gate can
              // distinguish "false" from "unset".
              effective_replay_only: ctx.effectiveReplayOnly ?? false,
            }),
            signal: combineAbortSignals(AbortSignal.timeout(THINK_TIMEOUT_MS), ctx.cancellationSignal),
          });

          if (!res.ok) continue; // try next endpoint

          const data = await res.json() as any;
          if (!data.success) continue;

          const text = (data.result || '').trim();
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (!jsonMatch) continue;

          const parsed = JSON.parse(jsonMatch[0]) as ThinkDecision;
          if (!parsed.action) continue;

          // QSKL-7.fix2: Capture token usage for skill telemetry if present.
          if (data.usage) {
            this._lastThinkUsage = {
              model: (data.usage as any).model ?? ctx.agentId,
              input_tokens: (data.usage as any).input_tokens ?? 0,
              output_tokens: (data.usage as any).output_tokens ?? 0,
              provider: (data as any).provider ?? (data.usage as any).provider,
            };
          }

          return parsed;
        } catch {
          continue; // try next endpoint
        }
      }

      return null; // all endpoints failed
    } catch {
      return null;
    }
  }

  // ─── Browser action dispatch (BQ Phase 3) ──────────────────────────

  /** Screencap tool_id mapping for browser actions */
  private static readonly SCREENCAP_TOOLS: Record<string, string> = {
    navigate: 'browser_navigate',
    click: 'browser_click',
    type: 'browser_type',
    fill_form: 'browser_fill_form',
    scroll: 'browser_scroll',
    screenshot: 'browser_screenshot',
    extract: 'browser_extract',
    select: 'browser_select',
    wait: 'browser_wait',
    find_element: 'browser_find_element',
    analyze_forms: 'browser_analyze_forms',
    login: 'browser_login',
    // BQ-SMART Phase 2: Accessibility tree snapshot
    a11y_snapshot: 'browser_a11y_snapshot',
    // BQ-SMART Phase 3: Schema extraction
    extract_schema: 'browser_extract_schema',
    extract_parse: 'browser_extract_parse',
    extract_templates: 'browser_extract_templates',
    // BQ-SMART Phase 4: DOM diff
    dom_diff: 'browser_dom_diff',
    // BQ-SMART Phase 5: Wisdom + crystallisation
    browser_extract_wisdom: 'browser_extract_wisdom',
    browser_check_crystallisation: 'browser_check_crystallisation',
    // BQ-SMART: Action cache tools (passthrough — tool_id = action name)
    action_cache_lookup: 'action_cache_lookup',
    action_cache_store: 'action_cache_store',
    action_cache_miss: 'action_cache_miss',
  };

  private isBrowserAction(action: string): boolean {
    return action in AgenticExecutor.SCREENCAP_TOOLS;
  }

  /**
   * THINK (non-browser path): prompt for agents that use http_call / ssh_exec / done.
   * Uses a task-agent framing instead of the browser-agent framing.
   */
  private async thinkNonBrowser(ctx: {
    objective: string;
    agentId: string;
    iteration: number;
    maxIterations: number;
    lastObservation: Observation | null;
    actionLog: Array<{ action: string; reasoning: string; observation: string; success: boolean }>;
    availableActions: string[];
    collectorUrl: string;
    serviceKey: string;
    domainWisdom?: string;
    provenPatterns?: string;
    /** MEM-DECAY MD.3: last N failure lessons for this workflow (see durable-hooks.ts / lineage-analyzer.ts). */
    priorLessons?: string[];
    /** PRECEDENT: rendered PRECEDENTS block — present only once the done-gate
     * has retrieved active precedents for this run's fact pattern. */
    precedents?: string;
    refinementHint?: string;
    skillsCatalogLine?: string;
    /** QSKL-3: skill creation nudge text to prepend to the prompt */
    creationNudge?: string;
    /** QSKL-12: persona content fetched once per run (null if unavailable) */
    personaContent?: string | null;
    /** AEE-FULL Gap 4: workflow-level cancellation signal */
    cancellationSignal?: AbortSignal;
    /** REPLAY-ONLY .A0: run identity threaded to the collector on every LLM call */
    orgId?: string;
    workflowId?: string;
    executionId?: string;
    /** REPLAY-ONLY .A-1a: effective replay_only resolved once at run start */
    effectiveReplayOnly?: boolean;
  }): Promise<ThinkDecision | null> {
    const actionHints: Record<string, string> = {
      http_call: ' (params: { url: "http://hostname:port/path", method: "GET"|"POST", headers: {}, body?: ... }) — use http:// for internal services; internal Docker hostnames are fully supported',
      ssh_exec:  ' (params: { host: "...", command: "..." })',
      done:      ' — objective is complete; include a summary in reasoning',
      propose_crystal: ' (params: { name: "...", summary: "...", action_pattern: ["action1","action2",...], confidence: 0.0-1.0 })',
    };

    // Count real tool calls (not meta-actions like propose_crystal/done)
    const realToolActions = ctx.actionLog.filter(
      a => a.action !== 'done' && a.action !== 'propose_crystal' && a.action !== 'refine_crystal'
    );
    const noDoneTaken = realToolActions.length === 0;

    // QSKL-12: persona content is pre-fetched once per run and passed in via ctx.
    const personaContent = ctx.personaContent ?? null;

    const prompt = `${ctx.creationNudge ?? ''}You are an autonomous task agent. Your job is to achieve the objective by calling tool actions, then declaring done ONLY after you have real evidence from those calls.
${ctx.skillsCatalogLine ? `\n${ctx.skillsCatalogLine}\n` : ''}
OBJECTIVE: ${ctx.objective}
${ctx.provenPatterns ? `\nPROVEN PATTERNS (the action SEQUENCE to follow for this type of task):\n${ctx.provenPatterns}\nIMPORTANT: The sequence ends with "done" — but you must execute ALL preceding actions first before reaching done.\n` : ''}${ctx.precedents ? `\nPRECEDENTS (binding human rulings for this fact pattern — you must follow or distinguish one before finishing):\n${ctx.precedents}\n` : ''}${ctx.priorLessons && ctx.priorLessons.length > 0 ? `\nLESSONS FROM PRIOR FAILED RUNS OF THIS WORKFLOW:\n${ctx.priorLessons.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n` : ''}${ctx.refinementHint ? `\nCRYSTAL REFINEMENT NEEDED:\n${ctx.refinementHint}\n` : ''}
ACTIONS TAKEN SO FAR (${realToolActions.length} real tool calls):
${realToolActions.length > 0
  ? realToolActions.map((a, i) => `${i + 1}. ${a.action}: ${a.reasoning.substring(0, 100)} → ${a.success ? 'SUCCESS' : 'FAILED'} | Observed: ${a.observation.substring(0, 150)}`).join('\n')
  : 'NONE — you have not called any tools yet. You MUST call a tool now.'}

ITERATION: ${ctx.iteration + 1}/${ctx.maxIterations}

AVAILABLE ACTIONS:
${ctx.availableActions.map(a => `- ${a}${actionHints[a] ?? ''}`).join('\n')}

RULES:
- You MUST call a tool action (e.g. http_call) for EACH thing you need to verify or collect data about.
- DO NOT assume, guess, or use prior knowledge about what the result will be — you MUST actually call the tool.
- Use "done" ONLY after you have sufficient real observations from tool calls to confirm the objective.
${noDoneTaken ? '- CRITICAL: You have taken 0 tool calls. Choosing "done" now is FORBIDDEN. You MUST call a tool first.' : ''}
- Be concise in reasoning. Report what the tool actually returned, not what you think it will return.
- http_call supports internal service hostnames (e.g. http://collector:9848/health, http://auth:3101/health, http://memory:3103/health). These ARE reachable — do not skip them.
${buildNonBrowserPlatformSuffix(ctx.agentId)}

PATTERN RECOGNITION:
After each successful run, your task structure may match a reusable pattern.
If you have completed an objective using the same actions in the same order
that you'd recommend running again next time, your final action SHOULD be
propose_crystal — not done.

propose_crystal({
  name: 'service-health-check',
  summary: 'Check the 3 service /health endpoints in order: collector, auth, memory',
  action_pattern: ['http_call', 'http_call', 'http_call'],
  confidence: 0.85
})

Then on the next iteration, use done. The system will save your proposal as a
draft Crystal. After 3 consecutive runs match this pattern, the system
auto-promotes it to a canonical reusable Skill.
${ctx.precedents ? `
PRECEDENT CITATION (required because a PRECEDENTS block is present above):
When you choose action "done", your "reasoning" MUST contain either
follows_precedent:<id> (you are applying that ruling) or
distinguishes_precedent:{"id":"<id>","factual_delta":"<how this case differs>"}
(it does not apply here). A "done" without one of those markers is rejected by
the engine and you will be asked again.
` : ''}

Use propose_crystal when:
- The same task is likely to repeat regularly (recurring health checks, monitors).
- The action sequence is stable (same tool, same order each time).
- You're confident the pattern will succeed for similar future tasks.
- You have completed ALL required tool calls and verified the objective.

Respond with ONLY valid JSON:
{ "reasoning": "I will call X because Y. I have not yet checked Z.", "action": "...", "params": {...}, "objective_met": false, "confidence": 0.0-1.0 }${personaContent ? `\n\n## Persona\n${personaContent}` : ''}`;

    try {
      const res = await fetch(`${ctx.collectorUrl}/api/internal/agents/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-service-key': ctx.serviceKey,
        },
        body: JSON.stringify({
          agent_id: ctx.agentId,
          task: prompt,
          no_tools: true,
          context: 'You are a JSON-only task agent. Output valid JSON and nothing else. Never output markdown, explanations, or anything besides the JSON object.',
          // REPLAY-ONLY .A0: run identity so a collector-side gate can
          // identify the run (docs/STREAM_REPLAY_ONLY_FABLE_REVIEW.md §5 .A0)
          ...(ctx.orgId ? { org_id: ctx.orgId } : {}),
          ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
          ...(ctx.executionId ? { execution_id: ctx.executionId } : {}),
          // REPLAY-ONLY .A-1a: effective replay_only for this run, always
          // sent (not conditionally spread) so a collector-side gate can
          // distinguish "false" from "unset".
          effective_replay_only: ctx.effectiveReplayOnly ?? false,
        }),
        signal: combineAbortSignals(AbortSignal.timeout(THINK_TIMEOUT_MS), ctx.cancellationSignal),
      });

      if (!res.ok) return null;

      const data = await res.json() as { result?: string; response?: string; provider?: string; usage?: { model?: string; input_tokens?: number; output_tokens?: number; provider?: string } };
      const raw = (data.result ?? data.response ?? '').trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      // QSKL-7.fix2: Capture token usage from the LLM response for skill telemetry.
      if (data.usage) {
        this._lastThinkUsage = {
          model: data.usage.model ?? ctx.agentId,
          input_tokens: data.usage.input_tokens ?? 0,
          output_tokens: data.usage.output_tokens ?? 0,
          provider: data.provider ?? data.usage.provider,
        };
      }

      const parsed = JSON.parse(jsonMatch[0]) as Partial<ThinkDecision>;
      return {
        action: String(parsed.action || 'done'),
        params: (parsed.params || {}) as Record<string, unknown>,
        reasoning: String(parsed.reasoning || ''),
        objective_met: Boolean(parsed.objective_met),
        confidence: Number(parsed.confidence ?? 0.5),
      };
    } catch {
      return null;
    }
  }

  /**
   * Execute a browser action directly via the screencap service.
   * This bypasses the node executor registry for precise tool control.
   *
   * P8.E.2 (DEFERRED): When AGENTIC_BROWSER_Q === 'true' (default: disabled),
   * org_id and objective_id are injected into every screencap /execute input
   * body so that screencap's BQ-CA-1 extraction auto-save fires with the
   * correct context.
   *
   * Per master plan (STREAM_STUDY_REV_2_PLAN.md L18, Adam's directive
   * "forget BrowserQ until the engine underneath it all is 100%"), the
   * Browser-Q migration onto agent:agentic is gated to follow-up stream
   * BQ-AGENTIC-MIGRATION. It unlocks once: engine validation suite green
   * 14 nights + P9 shipped + P8.D harness done. Default flag flipped to
   * opt-in (`=== 'true'`) so the legacy direct-dispatch path stays live
   * until then.
   */
  private async executeBrowserAction(
    action: string,
    params: Record<string, unknown>,
    sessionId: string,
    screencapUrl: string,
    serviceKey: string,
    galleryOrgId?: string,
    /** P8.E.2: org_id for extraction auto-save context */
    orgId?: string,
    /** P8.E.2: objective_id to link extracted data to this agentic run */
    objectiveId?: string,
  ): Promise<ExecutorResult> {
    const toolId = AgenticExecutor.SCREENCAP_TOOLS[action];
    if (!toolId) {
      return {
        success: false, output: null, envelopes: [],
        error: { code: 'UNKNOWN_BROWSER_ACTION', message: `Unknown browser action: ${action}` },
      };
    }

    // Feature flag: AGENTIC_BROWSER_Q controls org_id/objective_id injection.
    // DEFAULT FLIPPED TO OPT-IN per master plan — Adam: "forget BrowserQ
    // until the engine underneath is 100%". Set AGENTIC_BROWSER_Q=true to
    // enable while the BQ-AGENTIC-MIGRATION follow-up stream is in flight.
    const agenticBrowserQEnabled = process.env.AGENTIC_BROWSER_Q === 'true';

    // Force critical params for specific actions
    const input: Record<string, unknown> = { ...params, session_id: sessionId };
    if (action === 'login') {
      input.hitl_approved = true; // HITL is handled at objective level, not per-action
      // QF-MT #111: prefer the real resolved org (executeBrowserAction's orgId
      // param) over 'default'. The later `input.org_id ?? orgId` (~:2873) could
      // never correct this, since setting 'default' here made input.org_id
      // truthy — so login actions always reported to screencap as 'default'.
      input.org_id = input.org_id || orgId || 'default';
    }

    // P8.E.2: Inject org_id and objective_id so screencap's extraction auto-save
    // fires with the correct context (BQ-CA-1 in screencap/server.js reads
    // input?.org_id to link the saved extraction record to the right tenant/run).
    if (agenticBrowserQEnabled && orgId) {
      input.org_id = input.org_id ?? orgId;
      if (objectiveId) {
        input.objective_id = objectiveId;
      }
    }

    try {
      const res = await fetch(`${screencapUrl}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-service-key': serviceKey,
        },
        body: JSON.stringify({
          tool_id: toolId,
          input,
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown');
        return {
          success: false, output: null, envelopes: [],
          error: { code: 'SCREENCAP_ERROR', message: `Screencap ${toolId} failed (${res.status}): ${text.substring(0, 200)}` },
        };
      }

      const result = await res.json() as any;

      // Save screenshots to gallery (so they're visible in the UI)
      const innerResult = result.result || result;
      if (innerResult?.screenshot_base64 && (action === 'screenshot' || action === 'navigate')) {
        try {
          await fetch(`${screencapUrl}/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
            body: JSON.stringify({
              tool_id: 'browser_gallery_save',
              input: {
                image_data: innerResult.screenshot_base64,
                org_id: galleryOrgId || 'default',
                title: `${action}: ${innerResult.title || innerResult.url || 'Browser screenshot'}`,
                url: innerResult.url || '',
              },
            }),
            signal: AbortSignal.timeout(10000),
          });
        } catch { /* gallery save is best-effort */ }
      }

      return {
        success: result.success !== false,
        output: result,
        envelopes: [],
        ...(result.success === false ? { error: { code: 'TOOL_FAILED', message: result.error || 'Action failed' } } : {}),
      };
    } catch (err: any) {
      return {
        success: false, output: null, envelopes: [],
        error: { code: 'SCREENCAP_NETWORK', message: err.message },
      };
    }
  }

  /**
   * Clean up browser session after execution completes.
   */
  private async cleanupBrowserSession(sessionId: string, screencapUrl: string, serviceKey: string): Promise<void> {
    if (!sessionId) return;
    try {
      await fetch(`${screencapUrl}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
        body: JSON.stringify({ tool_id: 'browser_session_close', input: { session_id: sessionId } }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* best effort cleanup */ }
  }

  /**
   * Emit a progress event to the tasks service SSE system (BQ Phase 4).
   */
  private async emitProgressEvent(
    callbackUrl: string, objectiveId: string, serviceKey: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    try {
      await fetch(`${callbackUrl}/api/internal/progress/${objectiveId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-service-key': serviceKey,
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* fire-and-forget */ }
  }

  /**
   * REPLAY-ONLY .A-1b Gate 2: build a fail-closed abort result. Used for
   * every replay-only abort path (browser-unsupported, retrieval-disabled,
   * retrieval-failed, no-canonical, replay-failed). Emits a NODE.FAILED
   * envelope on taskEnv and returns success:false — the pipeline's normal
   * node-failure surfacing takes it from there. Never touches the LLM.
   */
  private buildReplayOnlyAbort(
    factory: EnvelopeFactory,
    taskEnv: Envelope,
    code: string,
    message: string,
    envelopes: Envelope[],
    actionLog: unknown[],
  ): ExecutorResult {
    const errorEnv = factory.error(taskEnv, Intents.NODE.FAILED, { code, message });
    envelopes.push(errorEnv);
    return {
      success: false,
      output: {
        objective_met: false,
        iterations: 0,
        actions_taken: actionLog.length,
        action_log: actionLog,
      },
      error: { code, message },
      envelopes,
    };
  }

  /**
   * REPLAY-ONLY .B3: resolve the org's Crystal-signing public key, using the
   * in-process cache when available. Never throws — a missing injection or
   * a fetch failure both resolve to null, which the caller (the signature-
   * verify gate) treats as a fail-closed abort.
   */
  private async getOrgPublicKey(orgId: string): Promise<OrgPublicKeyResult | null> {
    const cached = this.orgPublicKeyCache.get(orgId);
    if (cached) return cached;

    if (!this.fetchOrgPublicKey) return null;

    try {
      const result = await this.fetchOrgPublicKey(orgId);
      if (!result) return null;
      this.orgPublicKeyCache.set(orgId, result);
      return result;
    } catch {
      // Defence in depth: the injected fetcher is contracted not to throw
      // (server.ts's real implementation catches network/HTTP errors and
      // returns null), but a broken/test fetcher must not crash the run.
      return null;
    }
  }

  /**
   * Map a high-level action name to a QuoxFlow node type (for non-browser actions).
   */
  private mapActionToNodeType(action: string): string {
    const mapping: Record<string, string> = {
      wait: 'util:wait',
      // call executor registers as 'call', not 'action:call'
      ssh_exec: 'call',
      http_call: 'call',
    };
    return mapping[action] || `action:${action}`;
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const config = (node as any).config as AgenticConfig || {};
    const errors: string[] = [];

    if (!config.objective) {
      errors.push('agent:agentic requires an objective');
    }

    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }
}

export const agenticExecutor = new AgenticExecutor();
