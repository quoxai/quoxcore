/**
 * /replay [run | conversation id] [page]: reconstruct a previous agent run from the audit trail, in order:
 * the decisions (turn messages), each tool with an args summary, its output and its receipt. Read-only:
 * nothing is re-executed (sandbox re-execution is not available). Default is the last turn of this
 * conversation. Sources: the conversation's saved turns, this session's tool calls, and AEE envelopes
 * (GET /aee/:id, GET /aee/query?corr=). A conversation id replays the messages only: the server does not link
 * tool envelopes to a conversation, so the view says so and points at /replay <envelope id> for a tool run.
 */
import { seg, fit, fitRow, short, dur, boxWidth, parseTs } from './model.js';

export const PAGE = 6;

/** '' | '2' | 'abc' | 'abc 3' | 'abc page 3' | 'page 3' -> { ref, page } */
export function parseReplayArg(arg) {
  let t = String(arg || '').trim();
  let page = 1;
  const m = /(?:^|\s)(?:page\s+)?(\d{1,4})$/i.exec(t);
  const pm = /(?:^|\s)page\s+(\d{1,4})$/i.exec(t);
  if (pm) { page = Number(pm[1]); t = t.slice(0, pm.index).trim(); }
  else if (m && (m.index > 0 || t === m[1]) && !/^\d{5,}$/.test(t)) { page = Number(m[1]); t = t.slice(0, m.index).trim(); }
  return { ref: t || null, page: Math.max(1, page) };
}

const receiptOf = (c) => `${c.envelopeId ? `receipt ${c.envelopeId}` : 'no receipt id'}${c.receipt?.verified && c.receipt.ward_seq != null ? ` · WARD seq ${c.receipt.ward_seq}` : ''}`;

/** { messages: [{ role, content }], calls: [tool blocks] } -> steps: the question, each tool, then the answer. */
export function buildTurnSteps({ messages = [], calls = [] }) {
  const steps = [];
  const users = messages.filter(m => m.role === 'user'), agents = messages.filter(m => m.role !== 'user');
  for (const m of users) steps.push({ kind: 'user', text: String(m.content ?? '') });
  for (const c of calls) steps.push({ kind: 'tool', tool: c.tool, args: c.summary || '', status: c.status, out: c.resultSummary || '', ms: c.durationMs, receipt: receiptOf(c), id: c.envelopeId || null });
  for (const m of agents) steps.push({ kind: 'agent', text: String(m.content ?? '') });
  return steps;
}

/** AEE envelopes of one correlation id -> steps in time order. */
export function buildEnvelopeSteps(envs = []) {
  const sorted = [...envs].sort((a, b) => (parseTs(a.ts) ?? 0) - (parseTs(b.ts) ?? 0));
  return sorted.map((e) => {
    const p = e.payload || {};
    const intent = String(e.intent || '');
    if (/^ops\.tool\./.test(intent)) {
      const ok = p.success !== false && !/\.failed$|\.denied$/.test(intent);
      return { kind: 'tool', id: e.id, tool: p.tool_name || intent, args: p.input_summary || p.summary || '', status: /\.denied$/.test(intent) ? 'denied' : ok ? 'ok' : 'failed', out: ok ? (p.result_summary || '') : (p.error || intent), ms: p.duration_ms, receipt: `receipt ${e.id}` };
    }
    if (intent === 'aocl.policy.evaluated') return { kind: 'policy', id: e.id, text: p.allPassed === false ? 'policy blocked' : 'policy passed', receipt: `receipt ${e.id}` };
    if (intent === 'aocl.identity.verified') return { kind: 'policy', id: e.id, text: 'identity verified', receipt: `receipt ${e.id}` };
    return { kind: 'event', id: e.id, text: `${intent || 'envelope'}${e.from ? ` from ${e.from}` : ''}`, receipt: `receipt ${e.id}` };
  });
}

const MARK = { ok: ['✔', 'ok'], failed: ['✖', 'error'], denied: ['✖', 'error'] };

/** d: { steps, page, size, title, notes } -> view { box, rows } */
export function replayView(d, cols) {
  const w = boxWidth(cols, 96), inner = w - 4, nw = w < 60;
  const size = d.size || PAGE;
  const steps = d.steps || [];
  const pages = Math.max(1, Math.ceil(steps.length / size));
  const page = Math.min(Math.max(1, d.page || 1), pages);
  const rows = [];
  if (!steps.length) rows.push([seg('nothing recorded for this run', 'muted')]);
  const base = (page - 1) * size;
  steps.slice(base, base + size).forEach((s, i) => {
    const n = String(base + i + 1).padStart(2);
    const label = s.kind === 'user' ? 'you' : s.kind === 'agent' ? 'agent' : s.kind === 'tool' ? 'tool' : s.kind === 'policy' ? 'guard' : 'event';
    const lrole = s.kind === 'user' ? 'sky' : s.kind === 'agent' ? 'violet' : s.kind === 'tool' ? 'indigo' : 'muted';
    if (s.kind === 'tool') {
      const [m, mr] = MARK[s.status] || ['○', 'muted'];
      rows.push([seg(n + ' ', 'muted'), seg(label.padEnd(6), lrole, true), seg(`${s.tool} `, 'value', true), seg(m, mr), seg(` ${s.status || 'unknown'}${s.ms != null ? ` ${dur(s.ms)}` : ''}`, mr)]);
      if (s.args) rows.push([seg('     args    ', 'muted'), seg(s.args, 'value')]);
      if (s.out) rows.push([seg('     output  ', 'muted'), seg(s.out, s.status === 'ok' ? 'value' : 'warn')]);
      rows.push([seg('     ', 'muted'), seg(s.receipt || 'no receipt id', 'muted')]);
    } else {
      rows.push([seg(n + ' ', 'muted'), seg(label.padEnd(6), lrole, true), seg(s.text || '', s.kind === 'event' ? 'muted' : 'value')]);
      if (s.receipt && s.kind !== 'user' && s.kind !== 'agent') rows.push([seg('     ', 'muted'), seg(s.receipt, 'muted')]);
    }
  });
  for (const n of d.notes || []) rows.push([seg(`note: ${n}`, 'warn')]);
  rows.push([seg(`page ${page} of ${pages}`, 'value', true), seg(page < pages ? `${nw ? '' : ' · '}${nw ? ' ' : ''}/replay${d.ref ? ` ${short(d.ref, 12)}` : ''} ${page + 1} for the next` : '', 'muted')]);
  rows.push([seg('read-only: rebuilt from the audit trail, nothing is re-run', 'muted')]);
  return { box: { width: w, title: `Replay · ${d.title || 'last turn'}`, titleRole: 'violet', border: 'violet' }, rows: rows.map(r => fitRow(r, inner)) };
}

/** Fetchers for createObjectsApi. deps: { get, listOf, why, verifyReceipt, aeeGet } */
export function replayFetchers({ get, listOf, why, verifyReceipt, aeeGet }) {
  const turns = async (id) => listOf(await get('collector', `/api/v1/conversations/${encodeURIComponent(id)}/turns`, { limit: 200 }, 12000), 'turns');
  const corrList = async (corr) => listOf(await get('collector', '/aee/query', { corr, limit: 100 }, 12000), 'envelopes');
  return {
    /** a: { ref, page, conversationId, calls } -> { data } | { error, tone } */
    async replay(a) {
      const page = a.page || 1;
      if (!a.ref) {
        const calls = await Promise.all((a.calls || []).slice(-12).map(async (c) => {
          if (!c.envelopeId || (c.receipt?.verified && c.receipt.ward_seq != null)) return c;
          const r = await verifyReceipt(c.envelopeId, 6);
          const res = r.ok ? r.result : null;
          return res?.status === 'WITNESSED' ? { ...c, receipt: { verified: true, ward_seq: res.entry?.seq } } : c;
        }));
        let messages = [], notes = [];
        try {
          const rows = await turns(a.conversationId);
          let from = 0;
          for (let i = rows.length - 1; i >= 0; i--) if (rows[i].role === 'user') { from = i; break; }
          messages = rows.slice(from).filter(r => r.role === 'user' || r.role === 'assistant');
        } catch (e) { notes.push(`the saved turn messages could not be read (${why(e)}); showing tool calls only`); }
        return { data: { steps: buildTurnSteps({ messages, calls }), page, title: 'last turn', notes } };
      }
      let rows = null;
      try { rows = await turns(a.ref); } catch (e) { if (e?.status && e.status !== 404 && e.status !== 400) return { error: `replay: ${why(e)}`, tone: 'warn' }; }
      if (rows && rows.length) {
        const steps = rows.filter(r => r.role === 'user' || r.role === 'assistant').map(r => ({ kind: r.role === 'user' ? 'user' : 'agent', text: String(r.content ?? '') }));
        return { data: { steps, page, ref: a.ref, title: `conversation ${short(a.ref, 12)}`, notes: ['tool calls are not linked to a conversation id on the server: /replay <envelope id> replays a tool run'] } };
      }
      let corr = a.ref, seen = null;
      const env = await aeeGet(a.ref);
      if (env.ok && env.env) { seen = env.env; corr = env.env.corr || a.ref; }
      let list = [];
      try { list = await corrList(corr); } catch (e) { return { error: `replay: ${why(e)}`, tone: 'warn' }; }
      if (seen && !list.some(e => e.id === seen.id)) list = [...list, seen];
      if (!list.length) return { error: `No run, conversation or envelope called "${a.ref}".`, tone: 'warn' };
      return { data: { steps: buildEnvelopeSteps(list), page, ref: a.ref, title: `run ${short(corr, 14)}`, notes: [] } };
    }
  };
}
