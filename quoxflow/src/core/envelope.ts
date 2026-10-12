/**
 * AEE (Agent Envelope Exchange) Envelope Types
 *
 * Every action in Quoxflow emits an envelope, creating immutable causality chains.
 * "Causality should be computable, not inferred."
 */

import { ulid } from 'ulid';
import { z } from 'zod';

// Envelope types
export type EnvelopeType = 'task' | 'result' | 'event' | 'error' | 'stream';

// Priority levels
export type Priority = 'low' | 'normal' | 'high' | 'urgent';

// Trace context for distributed tracing
export interface TraceContext {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
}

// Requirements that must be met before processing
export interface EnvelopeRequirements {
  timeout_ms?: number;
  approval?: string;        // Agent/role that must approve
  evidence?: boolean;       // Must collect evidence
  policy?: string[];        // Policies that must pass
  decision_evidence?: 'none' | 'minimal' | 'standard' | 'full';  // AEE §13 decision evidence level
}

/**
 * The core AEE Envelope structure
 * 14 fields that capture everything needed for auditability
 */
export interface Envelope<T = unknown> {
  v: '1';                           // Protocol version
  id: string;                       // ULID - sortable, unique
  from: string;                     // Sender address
  to: string;                       // Recipient address
  type: EnvelopeType;               // Message type
  intent: string;                   // What action is being requested/reported
  corr: string;                     // Correlation ID - groups related envelopes
  reply_to: string | null;          // Parent envelope ID - causality chain
  ts: string;                       // ISO 8601 timestamp
  trace?: TraceContext;             // Distributed tracing context
  priority?: Priority;              // Message priority
  requires?: EnvelopeRequirements;  // Pre-conditions
  payload: T;                       // The actual message content
  sig?: string;                     // Cryptographic signature
  evidence_refs?: string[];         // References to collected evidence
}

// Zod schema for validation
export const EnvelopeSchema = z.object({
  v: z.literal('1'),
  id: z.string().length(26),
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(['task', 'result', 'event', 'error', 'stream']),
  intent: z.string().min(1),
  corr: z.string().min(1),
  reply_to: z.string().length(26).nullable(),
  ts: z.string().datetime(),
  trace: z.object({
    trace_id: z.string(),
    span_id: z.string(),
    parent_span_id: z.string().optional(),
  }).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  requires: z.object({
    timeout_ms: z.number().positive().optional(),
    approval: z.string().optional(),
    evidence: z.boolean().optional(),
    policy: z.array(z.string()).optional(),
    decision_evidence: z.enum(['none', 'minimal', 'standard', 'full']).optional(),
  }).optional(),
  payload: z.unknown(),
  sig: z.string().optional(),
  evidence_refs: z.array(z.string()).optional(),
});

/**
 * Intent namespaces used in Quoxflow
 */
export const Intents = {
  // AOCL Control Layer intents
  AOCL: {
    INGRESS_RECEIVED: 'aocl.ingress.received',
    INGRESS_REJECTED: 'aocl.ingress.rejected',
    IDENTITY_VERIFIED: 'aocl.identity.verified',
    IDENTITY_FAILED: 'aocl.identity.failed',
    POLICY_EVALUATED: 'aocl.policy.evaluated',
    POLICY_DENIED: 'aocl.policy.denied',
    POLICY_BYPASSED: 'aocl.policy.bypassed',
    CONTEXT_RETRIEVED: 'aocl.context.retrieved',
    VERIFY_PASSED: 'aocl.verify.passed',
    VERIFY_FAILED: 'aocl.verify.failed',
    ASSEMBLE_COMPLETE: 'aocl.assemble.complete',
  },

  // Workflow intents (quox.flow.* — ecosystem-aligned)
  WORKFLOW: {
    STARTED: 'quox.flow.started',
    COMPLETED: 'quox.flow.completed',
    FAILED: 'quox.flow.failed',
    PAUSED: 'quox.flow.paused',
    RESUMED: 'quox.flow.resumed',
    CANCELLED: 'quox.flow.cancelled',  // AEE-FULL Gap 4
  },

  // Node execution intents (aligned with dashboard QUOXFLOW_INTENTS)
  NODE: {
    STARTED: 'quox.flow.node.started',
    COMPLETED: 'quox.flow.node.completed',
    FAILED: 'quox.flow.node.failed',
    SKIPPED: 'quox.flow.node.skipped',
  },

  // Human-in-the-loop intents (ops.approval.* — matches QuoxCORE)
  APPROVAL: {
    REQUESTED: 'ops.approval.request',
    GRANTED: 'ops.approval.grant',
    DENIED: 'ops.approval.deny',
    EXPIRED: 'ops.approval.expire',
    BATCH_EXPIRED: 'ops.approval.batch_expired',
  },

  // Policy CRUD intents
  POLICY: {
    CREATED: 'ops.policy.created',
    UPDATED: 'ops.policy.updated',
    DELETED: 'ops.policy.deleted',
    // R5.low: gate-event intents registered in AOCL aee-binding.md §10
    REJECTED: 'quox.policy.rejected',
    GATE_ERROR: 'quox.policy.gate_error',
  },

  // Schedule mutation intents
  SCHEDULE: {
    UPDATED: 'quox.flow.schedule.updated',
    PAUSED: 'quox.flow.schedule.paused',
    RESUMED: 'quox.flow.schedule.resumed',
  },

  // Workflow lifecycle intents (supplements existing WORKFLOW.STARTED/COMPLETED/etc.)
  LIFECYCLE: {
    ACTIVATED: 'quox.flow.activated',
    DEACTIVATED: 'quox.flow.deactivated',
    DELETED: 'quox.flow.deleted',
  },

  // Evidence CRUD intents
  EVIDENCE: {
    DELETED: 'ops.evidence.deleted',
    CLEANED: 'ops.evidence.cleaned',
  },

  // Budget / cost control intents — STUDY-REV-2 P8.B
  BUDGET: {
    EXHAUSTED: 'quox.budget.exhausted',
    WARNING: 'quox.budget.warning',
  },

  // Agentic skill loop intents — STUDY-REV-2 P9
  AGENTIC: {
    SKILL_RETRIEVED: 'agentic.skill.retrieved',
    SKILL_DRAFTED: 'agentic.skill.drafted',
    SKILL_REFINED: 'agentic.skill.refined',
    SKILL_PROMOTED: 'agentic.skill.promoted',
    SKILL_DRAFT_REJECTED: 'agentic.skill.draft_rejected_already_exists',
    /** AGH-5: emitted when a canonical Crystal with snapshot is replayed deterministically */
    SKILL_EXECUTED: 'agentic.skill.executed',
    /** QSKL-3: emitted every N iterations to nudge the LLM to consider saving a skill */
    SKILL_CREATION_NUDGED: 'agentic.skill.creation_nudged',
    /** REPLAY-ONLY .B3: emitted when a pinned Crystal's signature verifies over its recomputed canonical hash, immediately before deterministic replay executes — the positive compliance-evidence counterpart to the abort envelopes. */
    SIGNATURE_VERIFIED: 'agentic.crystal.signature_verified',
  },

  // MEM-DECAY sweep intents — knowledge-primitive decay (never envelopes/evidence tables)
  DECAY: {
    /** Emitted once per sweep run with batch counts + affected skill ids. */
    SWEPT: 'quox.decay.swept',
  },

  // Toolsmith webhook intents — QSKL-6.6
  TOOLSMITH: {
    /** Emitted when POST /api/internal/tool-published is received (stub or real adapter). */
    TOOL_PUBLISHED_RECEIVED: 'agentic.toolsmith.tool_published_received',
  },

  // QUOXTRUST-B3: durable-intent-before-effect for outward executors (call,
  // agent/team invoke, tool/browser action, HITL-approval creation, ...).
  // See control-pipeline.ts's dispatchExecutor() and
  // pipeline/dispatch-intent-reconciliation.ts.
  DISPATCH: {
    /** Recorded BEFORE the executor's external effect fires. */
    INTENT: 'quox.flow.dispatch.intent',
    /** Recorded after the effect resolves (success or thrown). Best-effort. */
    SETTLED: 'quox.flow.dispatch.settled',
    /** Boot-time reconciliation: an intent with no settled counterpart found
     * after the crash-recovery threshold. Never re-fires the effect. */
    OUTCOME_UNKNOWN: 'quox.flow.dispatch.outcome_unknown',
  },
} as const;

/**
 * Factory for creating envelopes
 */
export class EnvelopeFactory {
  private defaultFrom: string;

  constructor(defaultFrom: string = 'agent.quoxflow') {
    this.defaultFrom = defaultFrom;
  }

  /**
   * Create a new envelope with a fresh ID and timestamp
   */
  create<T>(params: {
    to: string;
    type: EnvelopeType;
    intent: string;
    corr: string;
    payload: T;
    from?: string;
    reply_to?: string | null;
    trace?: TraceContext;
    priority?: Priority;
    requires?: EnvelopeRequirements;
    evidence_refs?: string[];
  }): Envelope<T> {
    return {
      v: '1',
      id: ulid(),
      from: params.from ?? this.defaultFrom,
      to: params.to,
      type: params.type,
      intent: params.intent,
      corr: params.corr,
      reply_to: params.reply_to ?? null,
      ts: new Date().toISOString(),
      trace: params.trace,
      priority: params.priority,
      requires: params.requires,
      payload: params.payload,
      evidence_refs: params.evidence_refs,
    };
  }

  /**
   * Create a reply envelope that chains to a parent
   */
  reply<T>(parent: Envelope, params: {
    to?: string;
    type: EnvelopeType;
    intent: string;
    payload: T;
    from?: string;
    evidence_refs?: string[];
  }): Envelope<T> {
    return this.create({
      to: params.to ?? parent.from,
      type: params.type,
      intent: params.intent,
      corr: parent.corr,
      reply_to: parent.id,
      payload: params.payload,
      from: params.from,
      trace: parent.trace ? {
        trace_id: parent.trace.trace_id,
        span_id: ulid().slice(-16),
        parent_span_id: parent.trace.span_id,
      } : undefined,
      evidence_refs: params.evidence_refs,
    });
  }

  /**
   * Create a task envelope (request to do something)
   */
  task<T>(to: string, intent: string, corr: string, payload: T, options?: {
    reply_to?: string;
    requires?: EnvelopeRequirements;
  }): Envelope<T> {
    return this.create({
      to,
      type: 'task',
      intent,
      corr,
      payload,
      reply_to: options?.reply_to,
      requires: options?.requires,
    });
  }

  /**
   * Create a result envelope (successful completion)
   */
  result<T>(parent: Envelope, intent: string, payload: T, evidence_refs?: string[]): Envelope<T> {
    return this.reply(parent, {
      type: 'result',
      intent,
      payload,
      evidence_refs,
    });
  }

  /**
   * Create an error envelope
   */
  error(parent: Envelope, intent: string, error: { code: string; message: string; details?: unknown }): Envelope<typeof error> {
    return this.reply(parent, {
      type: 'error',
      intent,
      payload: error,
    });
  }

  /**
   * Create an event envelope (notification, no response expected)
   */
  event<T>(intent: string, corr: string, payload: T): Envelope<T> {
    return this.create({
      to: 'quox.audit',
      type: 'event',
      intent,
      corr,
      payload,
    });
  }
}

/**
 * Traverse causality chain by following reply_to references
 */
export function* walkCausalityChain(
  envelopes: Map<string, Envelope>,
  startId: string
): Generator<Envelope> {
  let current = envelopes.get(startId);
  while (current) {
    yield current;
    if (current.reply_to) {
      current = envelopes.get(current.reply_to);
    } else {
      break;
    }
  }
}

/**
 * Group envelopes by correlation ID
 */
export function groupByCorrelation(envelopes: Envelope[]): Map<string, Envelope[]> {
  const groups = new Map<string, Envelope[]>();
  for (const env of envelopes) {
    const group = groups.get(env.corr) ?? [];
    group.push(env);
    groups.set(env.corr, group);
  }
  return groups;
}

// Default factory instance
export const envelopes = new EnvelopeFactory();
