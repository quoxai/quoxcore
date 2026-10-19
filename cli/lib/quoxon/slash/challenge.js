/**
 * /challenge [focus]: brutaloop on demand. One read-only adversarial review turn over the last answer and the
 * last turn's tool calls, on a different provider when one is connected (else another model on the same
 * provider, and it says which). Costs one extra model turn. "Resolve these? y/N" sends the findings back to
 * the original agent as a normal turn.
 *
 * deps: api, say(text, tone), getState() -> the events state, sendTurn(text) -> a normal turn to the original agent.
 */
import { askText } from '../ask.js';
import { connectedChoices } from '../model.js';
import { lastOutput } from '../dragonModes.js';
import { textGate } from '../events.js';

const MAX_FINDING_LINES = 40;
const newTurnId = () => `QXN_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/** Tool items of the last turn: everything after the last user item. */
export function collectTools(s) {
  const all = [...(s?.history || []), ...(s?.blocks || [])];
  let from = 0;
  for (let i = all.length - 1; i >= 0; i--) if (all[i].kind === 'user' && !all[i].echo) { from = i + 1; break; }
  return all.slice(from).filter((it) => it.kind === 'tool');
}

const toolLine = (t) => {
  const r = t.receipt?.ward_seq != null ? ` receipt ward:${t.receipt.ward_seq}` : '';
  return `- ${t.tool}${t.target ? ` ${t.target}` : ''} [${t.status || 'unknown'}]${t.resultSummary || t.summary ? ` ${String(t.resultSummary || t.summary).slice(0, 200)}` : ''}${r}`;
};

export function reviewPrompt({ answer, tools = [], focus = '' }) {
  return [
    'You are an adversarial reviewer. Another agent gave the answer below. Review it; do not call tools.',
    'Find: factual errors, unsupported claims, missed failures, unsafe actions.',
    'Output one finding per line as: SEVERITY | finding | evidence it rests on. SEVERITY is HIGH, MEDIUM or LOW.',
    'Every finding must cite its evidence (a tool call, a receipt, or the text of the answer). Do not rewrite the answer.',
    'If you find nothing, say "No findings" and why.',
    focus ? `Focus especially on: ${focus}` : '',
    '',
    'ANSWER UNDER REVIEW:', answer, '',
    tools.length ? `TOOL CALLS AND RECEIPTS FROM THAT TURN:\n${tools.map(toolLine).join('\n')}` : 'No tool calls in that turn.',
  ].filter((x) => x !== '').join('\n');
}

export const resolvePrompt = (findings) => `An independent reviewer challenged your last answer. For each finding below, fix it or rebut it with evidence, one by one:\n\n${findings}`;

/** -> { provider, model?, note } | null. connected: [{ provider }]; models: ids on the answering provider. */
export function pickReviewer({ connected, answered, models = [] }) {
  const other = (connected || []).find((c) => c.provider && c.provider !== answered?.provider);
  if (other) return { provider: other.provider, note: `Reviewer: ${other.provider} (a different provider from ${answered?.provider || 'the answerer'}).` };
  const same = (connected || []).some((c) => c.provider === answered?.provider);
  const alt = same ? (models || []).find((m) => m && m !== answered?.model) : null;
  if (alt) return { provider: answered.provider, model: alt, note: `Reviewer: ${answered.provider} ${alt} (same provider, different model: no other provider is connected).` };
  return null;
}

export function createChallengeCmd({ api, say, getState, sendTurn, now = Date.now }) {
  const st = { pending: null, busy: false };

  async function run(focus = '') {
    const s = getState();
    if (st.busy) return say('A challenge is already running.', 'warn');
    if (s.turn) return say('Wait for the current turn or press Esc first.', 'warn');
    const o = lastOutput(s);
    if (!o || o.kind !== 'answer') return say('Nothing to challenge yet: ask something first.', 'warn');
    if (!api.connections) return say('/challenge is not available in this mode.', 'warn');
    st.pending = null;
    const answered = { provider: s.ctx?.provider || null, model: s.ctx?.model || null };
    const res = await api.connections();
    const caps = api.capabilities ? await api.capabilities() : null;
    const connected = connectedChoices(res, caps);
    let models = [];
    if (!connected.some((c) => c.provider !== answered.provider) && api.providerModels && answered.provider) {
      const r = await api.providerModels(answered.provider);
      models = r?.ok ? (r.models || []).map((m) => m.id || m) : [];
    }
    const pick = pickReviewer({ connected, answered, models });
    if (!pick) return say('No other provider or model is connected to review with, so /challenge would only ask the same model. /connect another provider first.', 'warn');
    say(`${pick.note} One extra model turn.`, 'dim');
    st.busy = true;
    let text = '', gate = null, failed = null;
    try {
      for await (const ev of api.stream({ turnId: newTurnId(), message: reviewPrompt({ answer: o.text, tools: collectTools(s), focus: String(focus || '').trim() }), agent: 'quox', provider: pick.provider, ...(pick.model ? { model: pick.model } : {}) })) {
        if (ev.type === 'chunk' || ev.type === 'text.delta' || ev.type === 'turn.started') { const g = textGate(gate, ev); gate = g.st; if (g.append) text += ev.content; }
        else if (ev.type === 'done' && !text && ev.full_response) text = ev.full_response;
        else if (ev.type === 'error') failed = ev.error || 'stream error';
      }
    } catch (e) { failed = e?.message || 'failed'; }
    finally { st.busy = false; }
    if (failed && !text.trim()) return say(`Challenge failed: ${failed}`, 'warn');
    const body = text.trim();
    if (!body) return say('The reviewer returned nothing.', 'warn');
    const lines = body.split('\n').map((l) => l.trimEnd()).filter(Boolean);
    for (const l of lines.slice(0, MAX_FINDING_LINES)) say(l, /^high\b/i.test(l) ? 'error' : /^medium\b/i.test(l) ? 'warn' : undefined);
    if (lines.length > MAX_FINDING_LINES) say(`... ${lines.length - MAX_FINDING_LINES} more lines not shown.`, 'dim');
    if (/^no findings/i.test(body)) return undefined;
    st.pending = { findings: body, at: now() };
    return say(askText('Resolve these?'), 'ask');
  }

  /** y/N to the resolve offer. true when the input was consumed. */
  function answer(text) {
    const p = st.pending;
    if (!p) return false;
    const t = String(text || '').trim();
    if (t.startsWith('/')) { st.pending = null; return false; }
    st.pending = null;
    if (now() - p.at > 600000) return false;
    if (/^y(es)?$/i.test(t)) { sendTurn(resolvePrompt(p.findings)); return true; }
    say('Left the findings alone.', 'dim');
    return /^no?$/i.test(t) ? true : false;
  }

  return { run, answer, get pending() { return st.pending; } };
}
