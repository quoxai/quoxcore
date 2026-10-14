/**
 * Session usage ledger for /cost, /usage and /context. Fed the raw stream events of each turn; counts only
 * what the server reported (turn.finished.usage, or done.usage on a server that never sends turn.finished).
 * Nothing is estimated: a turn without usage is counted as "not reported", and cost stays blank unless the
 * server sent cost_usd.
 */
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export function readUsage(u) {
  const o = u && typeof u === 'object' ? u : {};
  const input = num(o.input_tokens ?? o.prompt_tokens);
  const output = num(o.output_tokens ?? o.completion_tokens);
  const cacheRead = num(o.cache_read_input_tokens);
  const cacheWrite = num(o.cache_creation_input_tokens);
  const cost = num(o.cost_usd);
  const costSource = typeof o.cost_source === 'string' ? o.cost_source : null; // 'claude-cli' = that CLI's own estimate
  return { input, output, cacheRead, cacheWrite, cost, costSource, reported: input != null || output != null };
}

export function createLedger() {
  const models = new Map(); // key -> row
  const convs = new Map(); // conversation id -> tokens
  let turn = null;
  const finalize = (usage, convId) => {
    if (!turn) return;
    const t = turn; turn = null;
    const raw = usage ?? t.doneUsage;
    const u = readUsage(t.viaCli && raw && !raw.cost_source ? { ...raw, cost_source: 'claude-cli' } : raw); // the claude CLI path, from a server that does not label it yet
    const key = `${t.provider || '?'}|${t.model || '?'}`;
    const r = models.get(key) || { provider: t.provider, model: t.model, turns: 0, reported: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costTurns: 0, estimate: 0, estimateTurns: 0 };
    r.turns++;
    if (u.reported) {
      r.reported++;
      r.input += u.input || 0; r.output += u.output || 0; r.cacheRead += u.cacheRead || 0; r.cacheWrite += u.cacheWrite || 0;
      const id = convId || t.conversationId;
      if (id) convs.set(id, (convs.get(id) || 0) + (u.input || 0) + (u.output || 0));
    }
    if (u.cost != null && u.costSource) { r.estimate += u.cost; r.estimateTurns++; } // reported by a tool, not a price
    else if (u.cost != null) { r.cost += u.cost; r.costTurns++; }
    models.set(key, r);
  };
  return {
    observe(ev) {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'turn.started') turn = { provider: ev.provider || null, model: ev.model || null, conversationId: ev.conversation_id || null, doneUsage: null };
      else if (ev.type === 'done' && turn) { turn.doneUsage = ev.usage || (ev.cost_usd != null ? { cost_usd: ev.cost_usd } : null); turn.viaCli = Boolean(ev.cli_session_id); }
      else if (ev.type === 'turn.finished') finalize(ev.usage, ev.conversation_id);
    },
    /** The stream closed: settle a turn whose turn.finished never came (legacy servers send only done). */
    end() { if (turn) finalize(null, null); },
    rows: () => [...models.values()],
    conversationTokens: (id) => (id ? convs.get(id) ?? 0 : 0),
    totals() {
      const t = { turns: 0, reported: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costTurns: 0, estimate: 0, estimateTurns: 0 };
      for (const r of models.values()) for (const k of Object.keys(t)) t[k] += r[k];
      return t;
    }
  };
}

const n = (v) => Number(v || 0).toLocaleString('en-US');
const usd = (v) => `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;

function line(r) {
  const parts = [`${r.turns} turn${r.turns === 1 ? '' : 's'}`];
  if (r.reported) {
    parts.push(`in ${n(r.input)}`, `out ${n(r.output)}`);
    if (r.cacheRead || r.cacheWrite) parts.push(`cache ${n(r.cacheRead)} read / ${n(r.cacheWrite)} written`);
  }
  if (r.reported < r.turns) parts.push(`${r.turns - r.reported} without usage from the server`);
  if (r.costTurns || !r.estimateTurns) parts.push(r.costTurns === r.turns && r.turns ? usd(r.cost) : r.costTurns ? `${usd(r.cost)} for ${r.costTurns} of ${r.turns} turns` : 'cost not reported');
  if (r.estimateTurns) parts.push(`${usd(r.estimate)} claude CLI's own estimate${r.estimateTurns < r.turns ? ` for ${r.estimateTurns} of ${r.turns} turns` : ''}`);
  return parts.join(' · ');
}

/** -> help model rows for /cost. */
export function costModel(ledger) {
  const rows = ledger.rows();
  const out = [{ kind: 'head', text: 'Cost and usage, this session' }];
  if (!rows.length) return [...out, { kind: 'plain', text: 'No turns yet in this session.' }];
  for (const r of rows) out.push({ kind: 'row', key: `${r.provider || '?'} ${r.model || ''}`.trim(), text: line(r) });
  const t = ledger.totals();
  if (rows.length > 1) out.push({ kind: 'row', key: 'Total', text: line(t) });
  if (t.costTurns + t.estimateTurns < t.turns) out.push({ kind: 'dim', text: 'Cost is blank where the server sent tokens but no cost_usd for that provider; Quox does not guess prices.' });
  if (t.estimateTurns) out.push({ kind: 'dim', text: "The Claude subscription path shows what the claude CLI reports: its own API-equivalent estimate, passed through as is. It is not a bill." });
  if (t.reported < t.turns) out.push({ kind: 'dim', text: 'Some turns ended without usage (an older server, or a turn that failed or was interrupted).' });
  return out;
}
