/**
 * AEE Bridge
 *
 * Lossless round-trip conversion between QuoxCORE and QuoxFlow envelope formats.
 *
 * Key differences between the two systems:
 * - requires.approval: QuoxCORE uses boolean, QuoxFlow uses string (approver ID)
 * - AOCL events: QuoxCORE uses 'aocl.layer.start', QuoxFlow uses 'aocl.ingress.received' etc.
 * - evidence_refs: QuoxFlow adds this field (optional, backward compatible)
 * - Intent namespaces: quox.chat.* (QuoxCORE) vs quox.flow.* (QuoxFlow) — no conflict
 */

import type { Envelope, EnvelopeRequirements } from '../core/envelope.js';

/**
 * QuoxCORE envelope shape (JavaScript object from frontend lib/aee/)
 * Less strict — uses plain objects, boolean approval, no evidence_refs
 */
export interface QuoxCOREEnvelope {
  v: '1';
  id: string;
  ts: string;
  type: 'task' | 'result' | 'event' | 'error' | 'stream';
  from: string;
  to: string;
  intent: string;
  corr: string;
  reply_to: string | null;
  payload: unknown;
  trace?: { trace_id: string; span_id: string; parent_span_id?: string };
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  requires?: {
    timeout_ms?: number;
    evidence?: boolean;
    approval?: boolean | string;  // QuoxCORE = boolean, QuoxFlow = string
  };
  sig?: string | null;
  evidence_refs?: string[];
}

/**
 * Convert a QuoxCORE envelope to QuoxFlow format
 *
 * Normalizes:
 * - requires.approval: boolean → string ('any' if true, undefined if false)
 * - sig: null → undefined
 */
export function coreToFlow(envelope: QuoxCOREEnvelope): Envelope {
  const result: Envelope = {
    v: '1',
    id: envelope.id,
    from: envelope.from,
    to: envelope.to,
    type: envelope.type,
    intent: envelope.intent,
    corr: envelope.corr,
    reply_to: envelope.reply_to,
    ts: envelope.ts,
    payload: envelope.payload,
  };

  if (envelope.trace) {
    result.trace = envelope.trace;
  }

  if (envelope.priority) {
    result.priority = envelope.priority;
  }

  if (envelope.requires) {
    const req: EnvelopeRequirements = {};
    if (envelope.requires.timeout_ms !== undefined) {
      req.timeout_ms = envelope.requires.timeout_ms;
    }
    if (envelope.requires.evidence !== undefined) {
      req.evidence = envelope.requires.evidence;
    }
    // Normalize boolean approval → string
    if (envelope.requires.approval !== undefined) {
      if (typeof envelope.requires.approval === 'boolean') {
        req.approval = envelope.requires.approval ? 'any' : undefined;
      } else {
        req.approval = envelope.requires.approval;
      }
    }
    if (Object.keys(req).length > 0) {
      result.requires = req;
    }
  }

  if (envelope.sig) {
    result.sig = envelope.sig;
  }

  if (envelope.evidence_refs) {
    result.evidence_refs = envelope.evidence_refs;
  }

  return result;
}

/**
 * Convert a QuoxFlow envelope to QuoxCORE format
 *
 * Normalizes:
 * - requires.approval: string → boolean (truthy string → true)
 * - Preserves evidence_refs (QuoxCORE typedef now supports it)
 */
export function flowToCore(envelope: Envelope): QuoxCOREEnvelope {
  const result: QuoxCOREEnvelope = {
    v: '1',
    id: envelope.id,
    ts: envelope.ts,
    type: envelope.type,
    from: envelope.from,
    to: envelope.to,
    intent: envelope.intent,
    corr: envelope.corr,
    reply_to: envelope.reply_to,
    payload: envelope.payload,
  };

  if (envelope.trace) {
    result.trace = envelope.trace;
  }

  if (envelope.priority) {
    result.priority = envelope.priority;
  }

  if (envelope.requires) {
    const req: QuoxCOREEnvelope['requires'] = {};
    if (envelope.requires.timeout_ms !== undefined) {
      req.timeout_ms = envelope.requires.timeout_ms;
    }
    if (envelope.requires.evidence !== undefined) {
      req.evidence = envelope.requires.evidence;
    }
    // Normalize string approval → boolean for backward compat
    if (envelope.requires.approval !== undefined) {
      req.approval = !!envelope.requires.approval;
    }
    if (Object.keys(req).length > 0) {
      result.requires = req;
    }
  }

  if (envelope.sig) {
    result.sig = envelope.sig;
  }

  if (envelope.evidence_refs) {
    result.evidence_refs = envelope.evidence_refs;
  }

  return result;
}

/**
 * AOCL intent mapping between QuoxCORE and QuoxFlow
 *
 * QuoxCORE AOCL uses generic layer events: aocl.layer.start, aocl.layer.complete
 * QuoxFlow AOCL uses specific layer intents: aocl.ingress.received, aocl.policy.evaluated
 *
 * The bridge translates by looking at the payload.layer field.
 */
const QUOXFLOW_AOCL_INTENTS: Record<string, string> = {
  'aocl.ingress.received': 'aocl.layer.start',
  'aocl.ingress.validated': 'aocl.layer.complete',
  'aocl.identity.resolved': 'aocl.layer.complete',
  'aocl.policy.evaluated': 'aocl.layer.complete',
  'aocl.policy.rejected': 'aocl.layer.reject',
  'aocl.context.loaded': 'aocl.layer.complete',
  'aocl.execute.started': 'aocl.layer.start',
  'aocl.execute.completed': 'aocl.layer.complete',
  'aocl.verify.passed': 'aocl.layer.complete',
  'aocl.verify.failed': 'aocl.layer.reject',
  'aocl.assemble.completed': 'aocl.layer.complete',
};

/**
 * Translate a QuoxFlow-specific AOCL intent to the QuoxCORE generic form.
 * Returns the original intent if no mapping exists (passthrough).
 */
export function translateAOCLIntent(quoxflowIntent: string): string {
  return QUOXFLOW_AOCL_INTENTS[quoxflowIntent] || quoxflowIntent;
}

/**
 * Check if an envelope is from QuoxFlow (vs QuoxCORE)
 */
export function isQuoxFlowEnvelope(envelope: QuoxCOREEnvelope | Envelope): boolean {
  return envelope.intent.startsWith('quox.flow.') ||
    envelope.from.startsWith('quoxflow.') ||
    !!envelope.evidence_refs;
}

/**
 * Batch convert envelopes from QuoxFlow → QuoxCORE format
 * Useful for merging QuoxFlow execution audit trails into the dashboard view
 */
export function batchFlowToCore(envelopes: Envelope[]): QuoxCOREEnvelope[] {
  return envelopes.map(flowToCore);
}

/**
 * Batch convert envelopes from QuoxCORE → QuoxFlow format
 */
export function batchCoreToFlow(envelopes: QuoxCOREEnvelope[]): Envelope[] {
  return envelopes.map(coreToFlow);
}
