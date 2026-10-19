'use strict';
/**
 * CUSTOM-HATS: tell the model when the hat changed mid-conversation.
 *
 * A resumed model session (Claude CLI --resume, or any provider fed the stored history) still
 * holds earlier turns that listed a DIFFERENT hat's agents. Without a word from the server, the
 * model compares its (correct) answer under the new hat with those earlier lists and calls its
 * own answer wrong (live proof, 2026-10-17: security hat vs default-hat turns).
 *
 * observeHat() remembers the hat each conversation's last turn ran under. When the hat differs
 * it returns a short server-authored note, ONCE: the turn that sees the change gets it, the
 * next turn (same hat) gets nothing. First sight of a conversation records and returns null.
 * Only ENFORCED hats are tracked: a preview hat changes nothing the model can do.
 *
 * State is per-process and bounded; after a collector restart the first turn records only (no
 * note), which is the safe direction (never a false note).
 */
const MAX_ENTRIES = 5000;
const TTL_MS = 24 * 3600 * 1000;
const _last = new Map(); // key -> { hatKey, agents|null, ts }

function keyOf({ orgId, userId, conversationId, agent }) {
  return [orgId || '', userId || '', conversationId || '', String(agent || '').toLowerCase()].join('|');
}

/** @param hat { hatKey, agents: string[]|null } agents null = unscoped (all authorized agents) */
function renderHatSwitchNote(prev, cur) {
  const list = Array.isArray(cur.agents) && cur.agents.length ? cur.agents.join(', ')
    : Array.isArray(cur.agents) ? 'none' : 'all agents your authorization allows';
  return `Hat changed: ${prev.hatKey} → ${cur.hatKey}. The agents and tools you can use are now: ${list}. Earlier turns used a different hat; don't treat their agent lists as current.`;
}

function sameHat(a, b) {
  if (a.hatKey !== b.hatKey) return false;
  const x = a.agents, y = b.agents;
  if (x === null || y === null) return x === y;
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * @param ctx { orgId, userId, conversationId, agent }
 * @param hatManifest the turn's hatManifest (as streamToolSet builds it) or null
 * @returns string|null the note for THIS turn
 */
function observeHat(ctx, hatManifest, { now = Date.now() } = {}) {
  try {
    if (!ctx || !ctx.conversationId || !hatManifest || hatManifest.enforced !== true || !hatManifest.hatKey) return null;
    const { hatAgentScope } = require('./delegationRoster.js');
    const sc = hatAgentScope(hatManifest);
    const cur = { hatKey: String(hatManifest.hatKey), agents: sc ? sc.agents : null };
    const k = keyOf(ctx);
    const prev = _last.get(k);
    _last.delete(k);
    _last.set(k, { ...cur, ts: now });
    if (_last.size > MAX_ENTRIES) {
      for (const [kk, v] of _last) { if (_last.size <= MAX_ENTRIES * 0.9 && now - v.ts < TTL_MS) break; _last.delete(kk); }
    }
    if (!prev || now - prev.ts > TTL_MS || sameHat(prev, cur)) return null;
    return renderHatSwitchNote(prev, cur);
  } catch { return null; } // presentation only, never the turn
}

/** The prompt block every injection site appends ('' when there is no note). */
function hatSwitchBlock(note) {
  return note ? `\n\n## Hat Change\n${note}` : '';
}

function _resetForTest() { _last.clear(); }

module.exports = { observeHat, hatSwitchBlock, renderHatSwitchNote, _resetForTest };
