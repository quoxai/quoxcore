'use strict';
/**
 * Z2H-7B: a turn that asks for live data a tool must supply, when that tool cannot be used in
 * this turn (licence-gated, plan mode, not held), is answered by the SERVER with a fixed reply.
 * No model call: a model with no tool for the question invents the facts (qwen2.5 7B invented a
 * host list 5/5 on a free install). Provider-independent: it runs before the model loop.
 *
 * Reuses, not reinvents: the need table and routing live in turnToolSelection.js
 * (liveDataNeeds), plan mode in planMode.js (isPlanBlocked), and the licence verdict for fleet
 * is the very gate the /fleet routes enforce (fleetFreeAllowance.js: licensed, or within the
 * free host band), so the chat can never disagree with the route.
 */

const UNLOCK = 'See what this install has with `quox license status`; upgrade with `quox license` (https://quox.ai/pricing).';

/** Run an Express-style gate middleware against a bare request. -> 'ok' | 'denied' | 'unavailable' */
function runGate(gate, orgId) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const res = {
      status(code) { this._c = code; return this; },
      json() { fin(this._c === 402 ? 'denied' : 'unavailable'); return this; }, // only 402 is a licence ask; any other refusal is not ours to call a licence
    };
    Promise.resolve(gate({ user: { org_id: orgId }, method: 'GET', path: '/' }, res, () => fin('ok'))).catch(() => fin('unavailable'));
  });
}

/**
 * @param {object} a
 * @param {string} a.message
 * @param {Array}  a.pool       tools the turn holds
 * @param {boolean} [a.plan]
 * @param {string} [a.orgId]
 * @param {object} deps  { liveDataNeeds, isPlanBlocked, licenseVerdict(orgId, plugin), gateFor(plugin) -> middleware|null }
 * @returns {Promise<null | {reply:string, reason:string, need:string}>}
 */
async function unavailableLiveDataReply({ message, pool, plan = false, orgId = null }, deps) {
  const needs = deps.liveDataNeeds(message);
  if (!needs.length) return null;
  const held = new Set((Array.isArray(pool) ? pool : []).map((t) => t && t.name));
  for (const need of needs) {
    const have = need.tools.filter((n) => held.has(n));
    if (have.length === 0) {
      // a pool that can delegate or widen may still reach the holder: not ours to refuse.
      if (held.has('delegate_to_agent') || held.has('more_tools')) continue;
      return { need: need.id, reason: 'not_installed', reply: `${need.label} is not available to this assistant on this install; nothing was looked up.` };
    }
    if (plan && have.every((n) => deps.isPlanBlocked(n, {}))) {
      return { need: need.id, reason: 'plan_mode', reply: `${need.label} is not on the plan-mode read list, so it was not looked up. Leave plan mode (/mode ask) and ask again.` };
    }
    if (need.plugin && orgId) {
      let verdict = 'ok';
      const gate = typeof deps.gateFor === 'function' ? deps.gateFor(need.plugin) : null;
      try {
        if (gate) verdict = await runGate(gate, orgId);
        else if (typeof deps.licenseVerdict === 'function') {
          const v = await deps.licenseVerdict(orgId, need.plugin);
          verdict = v && v.unavailable ? 'unavailable' : (v && v.licensed ? 'ok' : 'denied');
        }
      } catch { verdict = 'unavailable'; }
      if (verdict === 'denied') {
        return { need: need.id, reason: 'license_required', reply: `${need.label} needs the ${need.plugin} licence on this install; nothing was looked up. ${UNLOCK}` };
      }
      if (verdict === 'unavailable') {
        return { need: need.id, reason: 'license_unavailable', reply: `${need.label} could not be looked up: the licence check did not answer, so nothing was looked up. Try again shortly.` };
      }
    }
  }
  return null;
}

module.exports = { unavailableLiveDataReply, runGate, UNLOCK };
