/**
 * QSKL-SAFETY Gap 6 — AOCL layer envelope emission for skill governance gates
 *
 * Fire-and-forget helper that appends an AOCL layer-5 (AUTHZ) envelope to the
 * envelope store whenever a skill governance gate fires. The wardHookAOCL filter
 * in the dashboard picks up intents prefixed with `aocl.layer.` or `aocl.run.`.
 *
 * Never throws — gate behavior is unchanged when envelopeStore is absent or
 * when the append call itself fails.
 */

import type { EnvelopeStore } from '../store/envelope-store.js';
import type { EnvelopeFactory } from '../core/envelope.js';

// ─── Public API ───────────────────────────────────────────────────────────────

export type QsklSafetyGate =
  | 'skill_firewall'
  | 'skill_safety_judge'
  | 'skill_review'
  | 'skill_promotion';

export type QsklSafetyOutcome = 'complete' | 'reject';

export interface EmitQsklSafetyAoclOpts {
  /** Optional — fire-and-forget no-op if absent. */
  envelopeStore?: EnvelopeStore;
  /** Envelope factory used to build the envelope (pattern: envelopes from core/envelope.ts). */
  factory: EnvelopeFactory;
  /** AEE correlation ID — groups related envelopes in the audit chain. */
  correlationId: string;
  /** The governance gate that fired. */
  gate: QsklSafetyGate;
  /** Outcome of the gate decision. */
  outcome: QsklSafetyOutcome;
  /** Optional skill identifiers — included in the payload when provided. */
  skillId?: string | null;
  skillName?: string | null;
  orgId?: string | null;
  /** Any extra key-value pairs to merge into the payload. */
  extra?: Record<string, unknown>;
}

/**
 * Emit an `aocl.layer.5.<outcome>` envelope to the envelope store.
 *
 * Layer 5 = AUTHZ (matches the wardHookAOCL filter in the dashboard).
 * Intent is strictly `aocl.layer.5.complete` or `aocl.layer.5.reject`.
 */
export async function emitQsklSafetyAocl(opts: EmitQsklSafetyAoclOpts): Promise<void> {
  const { envelopeStore, factory, correlationId, gate, outcome, skillId, skillName, orgId, extra } = opts;

  if (!envelopeStore) return;

  const intent = `aocl.layer.5.${outcome}` as const;

  const payload: Record<string, unknown> = {
    layer: 5,
    layer_name: 'SKILL_GATE',
    gate,
    route: gate,
    skill_id: skillId ?? null,
    skill_name: skillName ?? null,
    org_id: orgId ?? null,
    outcome,
    ...(extra ?? {}),
  };

  // For reject outcomes use type 'error'; for complete use 'event'.
  // factory.event() creates an event-type envelope. For error, we build via
  // factory.event() and override the type — matches the pattern used elsewhere
  // in the codebase (factory.error() requires a parent envelope).
  const envelope = factory.event(intent, correlationId, payload);
  if (outcome === 'reject') {
    // Override type to 'error' for reject outcomes
    (envelope as { type: string }).type = 'error';
  }

  try {
    // QF-MT WP5: thread the real org through — falls to envelope-store's
    // SYSTEM_SCOPE default when the caller didn't resolve one.
    await envelopeStore.append(envelope, orgId ?? undefined);
  } catch (err) {
    console.warn(
      `[emitQsklSafetyAocl] envelopeStore.append() failed (gate=${gate}, outcome=${outcome}):`,
      err instanceof Error ? err.message : err
    );
    // Never rethrow — fire-and-forget
  }
}
