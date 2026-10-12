/**
 * CommanderQ calibration self-audit tool (COMMANDERQ P11 / B3).
 *
 * Lets CommanderQ inspect its OWN honesty calibration: over recent turns, what
 * fraction of live-state claims did it ground (cite) or honestly hedge vs
 * assert uncited? Read-only; self-fetches the governed /api/v1/commanderq/
 * calibration route. Never throws.
 */

'use strict';

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://localhost:9848';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

async function callCollector(path, ctx) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Service-Key': INTERNAL_SERVICE_KEY,
    ...(ctx && ctx.orgId ? { 'x-org-id': ctx.orgId } : {}),
    ...(ctx && ctx.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
  };
  try {
    const res = await fetch(`${COLLECTOR_URL}${path}`, { headers, signal: AbortSignal.timeout(15000) });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: `Collector unreachable (${err.message}).` } };
  }
}

const COMMANDERQ_CALIBRATION_TOOL = {
  calibration_self_audit: {
    name: 'calibration_self_audit',
    description: 'Self-audit your honesty calibration: over recent turns, how many live-state claims you made and what fraction were cited to a source, honestly hedged, or asserted uncited. Returns a grounding_score (cited+disclaimed over total) and an uncited_rate. Use to check whether you are staying grounded, or when the user asks how reliable your system-state claims are. Optionally pass since (ISO timestamp) to window it.',
    input_schema: {
      type: 'object',
      properties: { since: { type: 'string', description: 'Optional ISO8601 start of the window.' } },
    },
    async execute(input, ctx) {
      const qs = input && input.since ? `?since=${encodeURIComponent(input.since)}` : '';
      const r = await callCollector(`/api/v1/commanderq/calibration${qs}`, ctx);
      if (!r.ok) return { success: false, error: (r.data && r.data.error) || `calibration failed (status ${r.status})`, status: r.status };
      return { success: true, ...r.data };
    },
  },
};

module.exports = { COMMANDERQ_CALIBRATION_TOOL };
