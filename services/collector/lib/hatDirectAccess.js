'use strict';
/**
 * QUOXON-ASK J2 (quox#868): a direct human ask is not turned into a hat-switch card for a
 * non-privileged tool (house rule: a direct user action IS the authorization).
 *
 * directHatAccess(tool, ctx) -> the human, or null. Non-null only when ALL hold:
 *  - the hat is enforced and actually resolved (a fail-closed manifest never opens);
 *  - the tool is in the agent's own grant (never wider than the grant ceiling);
 *  - the tool is NOT privileged-only: some non-privileged hat template carries it;
 *  - a verified human is driving this conversation (untainted), the call is theirs, and it
 *    comes from the agent they are talking to (not delegated: _delegationDepth on API paths,
 *    agent mismatch on the CLI path).
 * Only the hat membership check is skipped; the approval gate after it is unchanged.
 * If the hat templates cannot be loaded, every out-of-hat tool counts as privileged.
 */
const path = require('node:path');
const registry = require('./directRequestRegistry.js');

let _privileged = null;
async function privilegedOnlyTools() {
  if (_privileged) return _privileged;
  const candidates = [
    path.join(__dirname, '..', 'shared', 'quoxhat', 'templates.js'),            // collector image (/app/shared)
    path.join(__dirname, '..', '..', '..', 'shared', 'quoxhat', 'templates.js'), // repo checkout
  ];
  for (const file of candidates) {
    try {
      const { HAT_TEMPLATES } = await import(file);
      const open = new Set();
      for (const h of Object.values(HAT_TEMPLATES || {})) {
        const d = h.definition;
        const members = [...(d.tools.explicit || []), ...(d.tools.bundles || []).flatMap((b) => b.tools || [])];
        for (const n of members) if (!d.transitions?.privileged) open.add(n);
      }
      _privileged = { has: (n) => !open.has(n) }; // unknown or privileged-only -> privileged
      return _privileged;
    } catch { /* try the next location */ }
  }
  console.warn('[QUOXHAT] hat templates not loadable; no direct-request hat access (every out-of-hat tool treated as privileged)');
  return { has: () => true };
}

async function directHatAccess(toolName, ctx = {}) {
  const m = ctx.hatManifest;
  if (!m || !m.enforced || m.resolveFailed) return null;
  if (!m.grantToolNames || !m.grantToolNames.has(toolName)) return null;
  if (Number(ctx._delegationDepth) > 0) return null;
  const human = registry.isDirectRequest(ctx.conversationId || ctx.session_id, ctx.orgId);
  if (!human || !ctx.userId || String(ctx.userId) !== human.userId) return null;
  const agent = String(ctx.agentId || '').trim().toLowerCase();
  if (human.agentId && agent && agent !== human.agentId) return null;
  if ((await privilegedOnlyTools()).has(toolName)) return null;
  return human;
}

module.exports = { directHatAccess, privilegedOnlyTools, _reset: () => { _privileged = null; } };
