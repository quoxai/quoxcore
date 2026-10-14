'use strict';
/**
 * CLI-QUOXON Q2: SSE `trace` event payloads (docs/QUOXON_EVENTS_v1.md) built
 * only from protocol moments that really happened in the turn.
 *
 * Deliberately absent today, and not faked:
 *  - `chained (reply_to)`: no envelope this route emits sets reply_to.
 *  - `witnessed (WARD seq)`: storeAuditEnvelope hands the envelope to the WARD hook
 *    fire-and-forget; the seq does not exist yet at stream time. A client can
 *    verify later with the envelope id (`quox governance ward verify --envelope`).
 */

function aoclPreLlmTraces(aoclCtx) {
  if (!aoclCtx || !aoclCtx.layerResults) return [];
  const out = [];
  const ref = aoclCtx.corr || null;
  const l1 = aoclCtx.layerResults.L1;
  if (l1 && l1.allowed === true) {
    out.push({ protocol: 'aocl', label: 'L1 identity complete', ref, detail: `allowed · ${Number(l1.duration_ms) || 0}ms` });
  }
  const l3 = aoclCtx.layerResults.L3;
  if (l3 && l3.proceed === true) {
    out.push({ protocol: 'aocl', label: 'L3 policy gate complete', ref, detail: `proceed · ${Number(l3.duration_ms) || 0}ms` });
  }
  return out;
}

function traceForStoredEnvelope(result, { intent, corr }) {
  if (!result || result.stored !== true || !result.id) return null;
  return { protocol: 'aee', label: 'envelope opened', ref: result.id, detail: `${intent} · corr ${String(corr || '').slice(0, 8)}` };
}

module.exports = { aoclPreLlmTraces, traceForStoredEnvelope };
