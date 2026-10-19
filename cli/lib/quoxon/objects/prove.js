/**
 * /prove: independently verify the last turn's tool calls. Two independent checks per call:
 *   1. the receipt chain (the same reads as /proof: AEE envelope, the server's own record of the call,
 *      the WARD inclusion receipt), and
 *   2. a TRUTH read: for a write whose effect we know how to read back (VERIFIERS below), read it back
 *      from the system of record and see whether it is really there.
 * Per call: proven (chain agrees and, for a mapped write, the effect is there), unproven (cannot be shown:
 * an unmapped write, a read that failed, no receipt) or contradicts (the stream said ok and the server or
 * the truth read disagrees, or the call failed). An unmapped write is never called proven.
 *
 * Extending: push an entry on VERIFIERS: { id, tools: [tool names], keys: [arg names to find in the call
 * summary], read: (reads, target) -> true | false | null, describe: (target, found) -> text }.
 */
import { seg, fit, fitRow, short, boxWidth } from './model.js';
import { chainLinks } from './proof.js';

export const VERIFIERS = [
  { id: 'slot_create', tools: ['slot_create'], keys: ['name', 'slot'], read: (r, t) => r.slotExists(t), describe: (t, f) => (f ? `slot "${t}" exists` : `slot "${t}" not found`) },
  { id: 'memory_save', tools: ['memory_save'], keys: ['content', 'text', 'fact'], read: (r, t) => r.memoryFind(t), describe: (t, f) => (f ? `memory "${fit(t, 24)}" is stored` : `memory "${fit(t, 24)}" not found`) }
];

export const verifierFor = (tool) => VERIFIERS.find(v => v.tools.includes(tool)) || null;

/** Tools that only read: their receipt chain is the whole proof (nothing changed to read back). */
const READ_RE = /_(list|read|get|search|stats|history|usage|brief|notes|roadmaps|streams|folders|zones|pending|accounts|blocked|proposals|latest|query|status|show)$/;
export const isReadTool = (tool) => READ_RE.test(String(tool || ''));

/** The thing to check, from the call summary: key=value, key: "value", else the first quoted string. */
export function targetOf(tool, summary) {
  const s = String(summary || '');
  const v = verifierFor(tool);
  for (const k of v?.keys || ['name']) {
    const m = new RegExp(`\\b${k}\\s*[=:]\\s*(?:"([^"]+)"|'([^']+)'|([\\w.\\-]+))`, 'i').exec(s);
    if (m) return m[1] || m[2] || m[3];
  }
  const q = /["“]([^"”]+)["”]/.exec(s);
  return q ? q[1] : null;
}

/** -> { mapped:false } | { mapped:true, found: true|false|null, what?, error?, noTarget? }. Never throws. */
export async function runTruth(call, reads) {
  const v = verifierFor(call.tool);
  if (!v) return { mapped: false };
  const target = targetOf(call.tool, call.summary);
  if (!target) return { mapped: true, found: null, noTarget: true };
  try {
    const found = await v.read(reads, target);
    return { mapped: true, found: found === true ? true : found === false ? false : null, what: v.describe(target, found === true) };
  } catch (e) {
    return { mapped: true, found: null, error: e?.status ? `HTTP ${e.status}` : e?.message || 'failed' };
  }
}

/** Settled tool calls after the last user message of `items` (history + live blocks). */
export function lastTurnCalls(items) {
  const list = items || [];
  let from = 0;
  for (let i = list.length - 1; i >= 0; i--) if (list[i]?.kind === 'user' && !list[i].echo) { from = i + 1; break; }
  return list.slice(from).filter(b => b && b.kind === 'tool' && b.status !== 'running');
}

const V = (state, why, call) => ({ state, mark: state === 'proven' ? '✔' : state === 'contradicts' ? '✖' : '⚠', why, envelopeId: call.envelopeId || null });

/** { call, proof, truth } -> { state, mark, why, envelopeId }. Pure. */
export function verdictFor({ call, proof, truth }) {
  const bad = !['ok', 'effect_unknown'].includes(call.status);
  if (bad) return V('contradicts', `the call ${call.status || 'did not finish'}, so the task did not get done`, call);
  if (!call.envelopeId) return V('unproven', 'no receipt id on this call', call);
  const links = proof ? chainLinks(proof) : [];
  const by = Object.fromEntries(links.map(l => [l.name, l]));
  if (by.TOOL?.ok === false) return V('contradicts', by.TOOL.sub, call);
  if (by.WARD?.ok === false) return V('contradicts', `WARD: ${by.WARD.sub}`, call);
  if (by.AEE?.ok !== true) return V('unproven', `receipt not confirmed (${by.AEE?.sub || 'not read'})`, call);
  if (by.TOOL?.ok !== true) return V('unproven', 'no server record of the call outcome', call);
  if (truth?.mapped) {
    if (truth.found === true) return V('proven', `${truth.what || 'effect found'} · server recorded success`, call);
    if (truth.found === false) return V('contradicts', `${truth.what || 'effect not found'}, though the call reported ok`, call);
    return V('unproven', truth.noTarget ? 'could not tell which thing to check from the call' : `effect not read back (${truth.error || 'no answer'})`, call);
  }
  if (isReadTool(call.tool)) return V('proven', 'read call · receipt chain checked', call);
  return V('unproven', `no read mapping for ${call.tool}: receipt checked, effect not independently read`, call);
}

/** d: { items: [{ call, proof, truth }] } -> view { box, rows } */
export function proveView(d, cols) {
  const w = boxWidth(cols, 90), inner = w - 4, nw = w < 60;
  const rows = [];
  const tally = { proven: 0, unproven: 0, contradicts: 0 };
  const items = d.items || [];
  for (const it of items) {
    const v = verdictFor(it);
    tally[v.state]++;
    const role = v.state === 'proven' ? 'ok' : v.state === 'contradicts' ? 'error' : 'warn';
    rows.push([seg(v.mark, role, true), seg(' '), seg(fit(it.call.tool || 'tool', 14).padEnd(15), 'value', true), seg(v.state.padEnd(12), role, true), ...(nw ? [] : [seg(fit(v.why, inner - 30), 'muted')])]);
    rows.push([seg('  '), ...(nw ? [seg(fit(v.why, inner - 2), 'muted')] : []), seg(v.envelopeId ? `${nw ? '' : '  '}receipt ${short(v.envelopeId, nw ? 12 : 22)}` : '  no receipt', 'muted')]);
  }
  if (!items.length) rows.push([seg('no tool calls to check', 'muted')]);
  rows.push([seg(`${tally.proven} proven · ${tally.unproven} unproven · ${tally.contradicts} contradicts`, tally.contradicts ? 'error' : tally.unproven ? 'warn' : 'ok', true)]);
  return { box: { width: w, title: 'Prove · last turn', titleRole: 'indigo', border: 'indigo' }, rows: rows.map(r => fitRow(r, inner)), tally };
}

/** Fetchers for createObjectsApi. deps: { self (the objects api, for proof), get, listOf, resolveEndpoint } */
export function proveFetchers({ self, get, listOf, resolveEndpoint }) {
  const reads = {
    async slotExists(name) {
      const ep = resolveEndpoint('v1.slots.list');
      const rows = listOf(await get('collector', ep.path, undefined, 10000), 'slots');
      return rows.some(s => String(s.name || '').toLowerCase() === String(name).toLowerCase());
    },
    async memoryFind(text) {
      const d = await get('memory', '/api/memory/search', { q: text, limit: 10 }, 10000);
      const want = String(text).toLowerCase().slice(0, 60);
      return listOf(d, 'results', 'memories', 'data').some(m => JSON.stringify(m).toLowerCase().includes(want));
    }
  };
  return {
    reads,
    /** calls: tool blocks { tool, status, summary, envelopeId, callId } -> { data: { items } } */
    async prove(calls) {
      const items = await Promise.all((calls || []).slice(-12).map(async (call) => {
        const [proof, truth] = await Promise.all([
          call.envelopeId ? self.proof({ tool: call.tool, status: call.status, envelopeId: call.envelopeId, callId: call.callId }).then(r => r.data).catch(() => null) : null,
          runTruth(call, reads)
        ]);
        return { call: { tool: call.tool, status: call.status, summary: call.summary, envelopeId: call.envelopeId || null }, proof, truth };
      }));
      return { data: { items } };
    }
  };
}
