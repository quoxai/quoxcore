/**
 * QUOXON-STEPUP: /authenticate, /authorise and /override. Logic only; app.js wires the three entries.
 *
 *   /authenticate            PIN once: "human present" for 10 minutes (gold bar), so approvals and overrides
 *                            in that window do not ask again
 *   /authorise <n>           approve item n from /approvals with a PIN (prompts when no live step-up)
 *   /override <id|last> <reason>   a person with a fresh PIN overrides ONE blocked action; recorded and
 *                            witnessed server-side. Honest about block types no gate honours yet.
 */
import { mmss, NEEDS_PERSON } from './stepUp.js';

export const BLOCK_TYPES = ['safety', 'budget', 'aocl', 'ward'];
export const MIN_REASON = 8;
export const overrideUsage = '/override <block id|last> <reason>  (a person must confirm with a PIN; the reason is recorded)';

/** "safety:org:agent:RED" -> "safety". Anything that does not start with a known block type -> null. */
export const blockTypeOf = (id) => { const t = String(id || '').split(':')[0].toLowerCase(); return BLOCK_TYPES.includes(t) ? t : null; };

/** -> { ok:true, blockId, reason } | { ok:false, error } */
export function parseOverride(args, last = null) {
  const words = String(args || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { ok: false, error: `Usage: ${overrideUsage}` };
  let blockId = words[0];
  if (blockId.toLowerCase() === 'last') {
    if (!last?.blockId) return { ok: false, error: 'No policy block has stopped anything in this window yet. Pass the block id: /override <block id> <reason>' };
    blockId = last.blockId;
  }
  const reason = words.slice(1).join(' ').trim();
  if (reason.length < MIN_REASON) return { ok: false, error: `Give a reason (at least ${MIN_REASON} characters): it is recorded with your name. Usage: ${overrideUsage}` };
  if (!blockTypeOf(blockId)) return { ok: false, error: `"${blockId}" is not a block id (expected ${BLOCK_TYPES.map((t) => `${t}:...`).join(', ')}). Use "last" for the most recent block.` };
  return { ok: true, blockId, blockType: blockTypeOf(blockId), reason };
}

/** What a failed step-up means to the person, in one line. */
export function declinedText(reason) {
  switch (reason) {
    case 'agent_login': return NEEDS_PERSON;
    case 'cancelled': return 'PIN cancelled, nothing was sent';
    case 'locked': return 'PIN entry is locked: use your phone or a human session';
    case 'nopin': return 'no PIN set: set one in the dashboard (Settings > Account > Approval PIN)';
    case 'busy': return 'a PIN prompt is already open';
    default: return 'a person has not confirmed this';
  }
}

export function createStepUpCmds({ api, stepUp, say, lastBlock = () => null, orgOf = () => null }) {
  return {
    async authenticate() {
      const r = await stepUp.request({ window: true, orgId: orgOf(), subject: { line1: 'confirm a person is at this keyboard' } });
      if (!r.ok) return say(`Not authenticated: ${declinedText(r.reason)}.`, 'warn');
      return say(`✔ AUTHORISED · human present for ${mmss(stepUp.presentMs())}. Approvals and /override will not ask again in that window.`, 'ok');
    },
    /** One override. Returns the server answer or null. */
    async override(args) {
      const p = parseOverride(args, lastBlock());
      if (!p.ok) return say(p.error, 'warn');
      const lb = lastBlock();
      const body = { blockId: p.blockId, blockType: p.blockType, reason: p.reason, agentId: lb?.blockId === p.blockId ? lb.agentId : null, action: lb?.blockId === p.blockId ? lb.text : null };
      const subject = { line1: `override ${p.blockId}`, raisedBy: lb?.agentId ? `${lb.agentId} (blocked)` : null, risk: p.blockType === 'safety' ? 'high' : null };
      const go = () => api.override({ ...body, stepUp: stepUp.headers('override') });
      const ask = async () => {
        const r = await stepUp.request({ scope: 'override', orgId: orgOf(), subject, title: 'OVERRIDE REQUIRES A PERSON' });
        return r.ok ? null : declinedText(r.reason);
      };
      let res;
      try {
        if (!stepUp.token('override')) { const no = await ask(); if (no) return say(`Override not made: ${no}.`, 'warn'); }
        try { res = await go(); }
        catch (e) {
          if (e?.status === 403 && e?.body?.error === 'step_up_required') { stepUp.drop('override'); const no = await ask(); if (no) return say(`Override not made: ${no}.`, 'warn'); res = await go(); }
          else throw e;
        }
      } catch (e) { return say(`Override failed: ${e?.body?.message || e?.message || e}`, 'error'); }
      say(`✔ Override ${res.override_id} recorded for ${p.blockId} by you, reason witnessed (AEE/WARD). ${res.note || ''}`.trim(), res.enforced ? 'ok' : 'warn');
      return res;
    }
  };
}
