/**
 * Inline object views: one entry point for app.js. `runObjectCommand` fetches and returns either an
 * object item ({ type, data }) that history renders with <ObjectView/>, or a note ({ text, tone }).
 * The view itself is rebuilt from data at render width (resize reprints history), so items stay
 * pure data.
 */
import { skillCard } from './skill.js';
import { stepFlow } from './workflow.js';
import { crystalCard } from './crystal.js';
import { agentCard } from './agent.js';
import { memoryFacts } from './memory.js';
import { rulesLadder } from './ladder.js';
import { proofChain, reconcileView } from './proof.js';
import { awayCard } from './away.js';
import { sitrepCard } from './sitrep.js';

export { skillCard, stepFlow, crystalCard, agentCard, memoryFacts, rulesLadder, proofChain, reconcileView, awayCard, sitrepCard };
export { createObjectsApi } from './fetch.js';
export { decodeRow, arrivalSeconds } from './model.js';

export const BUILDERS = { skill: skillCard, workflow: stepFlow, crystal: crystalCard, agent: agentCard, memory: memoryFacts, rules: rulesLadder, proof: proofChain, reconcile: reconcileView, away: awayCard, sitrep: sitrepCard };

/** -> view { box?, rows } for an object item at this width (now injected for tests). */
export function buildObject(obj, cols, now = Date.now()) {
  const b = BUILDERS[obj?.type];
  if (!b) return { rows: [] };
  return b({ now, ...obj.data }, cols);
}

/** Tool blocks of this session that carry an envelope id, newest last. */
export function toolCalls(items) {
  return (items || []).filter(b => b && b.kind === 'tool' && b.status !== 'running');
}

const USAGE = {
  '/workflow': 'Usage: /workflow <name | workflow id | run id>',
  '/crystal': 'Usage: /crystal <workflow name or id>',
  '/memory': 'Usage: /memory <query>',
  '/agents': 'Usage: /agents <name>'
};

/**
 * cmd: '/skills' (with a name), '/workflow', '/crystal', '/agents' (with a name), '/memory', '/rules',
 * '/proof', '/reconcile'. ctx: { objects (createObjectsApi), rules, rulesOn, items (history + live
 * blocks) }. -> { object: { type, data } } | { note: text, tone } | null (not ours).
 */
export async function runObjectCommand(cmd, arg, ctx) {
  const o = ctx.objects;
  const a = String(arg || '').trim();
  // A bare /skills or /agents is a list, not an object: leave it to its own handler.
  if (!['/workflow', '/crystal', '/memory', '/rules', '/proof', '/reconcile'].includes(cmd) && !((cmd === '/skills' || cmd === '/agents') && a)) return null;
  if (!o) return cmd === '/rules' || cmd === '/skills' ? null : { note: 'Object views are not available in this mode.', tone: 'warn' };
  const wrap = async (type, fn) => {
    try {
      const r = await fn();
      if (r?.error) return { note: r.error, tone: r.tone || 'warn' };
      return { object: { type, data: r.data } };
    } catch (e) {
      return { note: `${type}: ${e?.status ? `HTTP ${e.status}: ` : ''}${e?.message || 'failed'}`, tone: 'warn' };
    }
  };
  switch (cmd) {
    case '/skills': return a ? wrap('skill', () => o.skill(a)) : null;
    case '/agents': return a ? wrap('agent', () => o.agent(a)) : null;
    case '/workflow': return a ? wrap('workflow', () => o.workflowRun(a)) : { note: USAGE['/workflow'], tone: 'warn' };
    case '/crystal': return a ? wrap('crystal', () => o.crystal(a)) : { note: USAGE['/crystal'], tone: 'warn' };
    case '/memory': return a ? wrap('memory', () => o.memory(a)) : { note: USAGE['/memory'], tone: 'warn' };
    case '/rules': {
      return wrap('rules', async () => {
        const r = await o.rules();
        return { data: { ...r.data, quoxmd: ctx.rules || null, enabled: ctx.rulesOn !== false } };
      });
    }
    case '/proof': {
      const calls = toolCalls(ctx.items).filter(b => b.envelopeId);
      const t = a ? calls.find(b => b.envelopeId === a || b.callId === a) : calls[calls.length - 1];
      if (!t) return { note: a ? `No tool call "${a}" with an envelope in this session.` : 'No tool call with an envelope id in this session yet.', tone: 'warn' };
      return wrap('proof', () => o.proof({ tool: t.tool, status: t.status, envelopeId: t.envelopeId, callId: t.callId }));
    }
    case '/reconcile': {
      const unk = toolCalls(ctx.items).filter(b => b.status === 'effect_unknown');
      if (!unk.length) return { note: 'Nothing to reconcile: no tool call in this session ended with effect unknown.' };
      return wrap('reconcile', () => o.reconcile(unk.map(b => ({ tool: b.tool, envelopeId: b.envelopeId }))));
    }
    default: return null;
  }
}
