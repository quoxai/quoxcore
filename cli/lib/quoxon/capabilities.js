/**
 * /capabilities and the K2 offer helper. Pure: everything comes from the server's
 * GET /api/v1/capabilities answer (QUOXON E1), which derives each availability from
 * real health, licence, install and provider signals. This module never decides a
 * capability exists; when the server cannot answer it says so and claims nothing.
 *
 * `res` is { ok:true, capabilities } or { ok:false, status?, missing?, error? }.
 */

import { capabilityName, statusUnreadable } from './providers.js';

const norm = (s) => String(s || '').trim().toLowerCase();

/** -> the capability matching an id, a provider short name, or a display name; else null. */
export function findCapability(query, res) {
  if (!res?.ok || !Array.isArray(res.capabilities)) return null;
  const q = norm(query);
  if (!q) return null;
  return res.capabilities.find(c => norm(c.id) === q)
    || res.capabilities.find(c => norm(c.id) === `provider.${q}`)
    || res.capabilities.find(c => norm(c.name) === q || norm(c.name).split(/\s+\(/)[0] === q)
    || null;
}

/**
 * K2: the honest one-line offer for a gap, or null when there is no gap (or we cannot tell).
 * Offers a place to set it up; never asks for a secret in the conversation.
 */
export function offerFor(capabilityId, res) {
  const c = findCapability(capabilityId, res);
  if (!c) return null;
  const name = capabilityName(c);
  switch (c.availability) {
    case 'installed': return null;
    case 'planned': return `Ⓠ ${name} is planned, not built yet.`;
    case 'requires_setup': {
      const why = c.reason ? ` (${c.reason})` : '';
      if (!c.setup) return `Ⓠ ${name} isn't set up yet${why}.`;
      if (c.permissions_ok === false) return `Ⓠ ${name} isn't set up yet${why}. An org admin can set it up: ${String(c.setup).replace(/ \(ask an org admin\)$/, '')}`;
      return `Ⓠ ${name} isn't set up yet${why}. Set it up now? ${c.setup}`;
    }
    case 'unavailable':
      return `Ⓠ ${name} isn't available on this Quox${c.reason ? `: ${c.reason}` : ''}.`;
    default: return null;
  }
}

/** -> [[text, tone?]] for /capabilities. */
export function capabilityLines(res) {
  if (!res?.ok || !Array.isArray(res.capabilities)) {
    if (res?.missing) return [['This Quox does not report its capabilities yet (no /api/v1/capabilities route). Nothing is assumed.', 'warn']];
    return [[`Could not read capabilities: ${res?.error || 'no answer'}. Nothing is assumed.`, 'warn']];
  }
  const caps = res.capabilities;
  const of = (a) => caps.filter(c => c.availability === a);
  const out = [['What this Quox can do here:']];
  const installed = of('installed');
  for (const c of installed) out.push([`● ${capabilityName(c)}  ${c.intent}`, 'ok']);
  if (!installed.length) out.push(['  nothing is ready yet']);
  const setup = of('requires_setup');
  if (setup.length) {
    out.push(['Needs setup:']);
    for (const c of setup) out.push([`◐ ${capabilityName(c)}  ${c.reason || 'needs setup'}${c.setup ? ` · ${c.setup}` : ''}`, 'warn']);
  }
  const unk = caps.filter(statusUnreadable);
  if (unk.length) {
    out.push(['Unknown (status could not be read):']);
    for (const c of unk) out.push([`? ${capabilityName(c)}  ${c.reason}`, 'warn']);
  }
  const off = of('unavailable').filter(c => !statusUnreadable(c));
  if (off.length) {
    out.push(['Not available here:']);
    for (const c of off) out.push([`○ ${capabilityName(c)}  ${c.reason || 'unavailable'}${c.setup ? ` · ${c.setup}` : ''}`]);
  }
  const planned = of('planned');
  if (planned.length) {
    out.push(['Planned (not built yet):']);
    for (const c of planned) out.push([`· ${capabilityName(c)}  ${c.intent}`]);
  }
  out.push(['  /capabilities <name> for one, e.g. /capabilities workflows']);
  return out;
}
