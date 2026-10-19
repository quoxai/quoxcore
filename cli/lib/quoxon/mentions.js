/**
 * @mention completion in the composer (MENTIONS). Typing `@` at the start of a word suggests agents, fleet hosts,
 * tasks (objectives) and receipts (this session's own tool-call envelopes). The remote lists are fetched ONCE per
 * session on the first `@`, then every keystroke filters the cache: no request per key. A failed fetch is quiet
 * (that kind just has no rows) and is retried at most every RETRY_MS. Tab or Enter accepts, Esc closes.
 */
export const RETRY_MS = 30000;
export const KIND_ORDER = ['agent', 'host', 'task', 'receipt'];

/** The @word being typed at the end of the draft -> { start (index after '@'), partial } or null. */
export function mentionContext(draft) {
  const t = String(draft ?? '');
  const m = t.match(/(^|\s)@([^\s@]*)$/);
  if (!m) return null;
  return { start: t.length - m[2].length, partial: m[2] };
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** api -> [{ value, kind, label }] from the session's remote sources, never throwing; failures named per kind. */
export async function loadMentions(api) {
  const kinds = {
    agent: async () => (await api.agents()).map(a => ({ value: String(a.agent_id), kind: 'agent', label: a.name && a.name !== a.agent_id ? clean(a.name) : '' })),
    host: async () => {
      const none = { status: 'absent', value: [] };
      const [inv, beat] = await Promise.all([api.mentionHosts, api.objects?.fleetNames].map((fn, i) => (fn ? Promise.allSettled([i ? api.objects.fleetNames() : api.mentionHosts()]).then(r => r[0]) : none)));
      const tried = [inv, beat].filter(r => r.status !== 'absent');
      if (tried.length && tried.every(r => r.status === 'rejected')) throw tried[0].reason;
      const out = (inv.status === 'fulfilled' ? inv.value : []).map(h => ({ value: String(h.id), kind: 'host', label: clean([h.group, h.health].filter(Boolean).join(' · ')) }));
      for (const h of beat.status === 'fulfilled' ? beat.value || [] : []) if (!out.some(o => o.value === String(h.value))) out.push({ value: String(h.value), kind: 'host', label: clean(h.desc) });
      return out;
    },
    task: async () => ((await api.mentionTasks?.()) || []).map(o => ({ value: String(o.id), kind: 'task', label: clean(`${o.title || ''}${o.status ? ` (${o.status})` : ''}`) })),
  };
  const out = []; const failed = [];
  await Promise.all(Object.entries(kinds).map(async ([k, fn]) => {
    try { out.push(...(await fn()).filter(x => x.value && /^[\w.:-]+$/.test(x.value))); } catch { failed.push(k); }
  }));
  return { items: out, failed };
}

/** This session's tool calls that carry an envelope id: their receipts, newest first. Local, no request. */
export function receiptMentions(items) {
  const seen = new Set(); const out = [];
  for (const b of [...(items || [])].reverse()) {
    if (!b || b.kind !== 'tool' || !b.envelopeId || seen.has(b.envelopeId)) continue;
    seen.add(b.envelopeId);
    out.push({ value: String(b.envelopeId), kind: 'receipt', label: clean(`${b.tool || 'tool call'}${b.status ? ` ${b.status}` : ''}`) });
  }
  return out;
}

/** Prefix on the value first, then a substring of the value or its label; agents, hosts, tasks, receipts in that order. */
export function rankMentions(items, partial, max = 50) {
  const q = String(partial || '').toLowerCase();
  const seen = new Set();
  const uniq = (items || []).filter(i => i?.value && !seen.has(`${i.kind}:${i.value}`) && seen.add(`${i.kind}:${i.value}`));
  const order = (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  if (!q) return uniq.sort(order).slice(0, max);
  const pre = uniq.filter(i => i.value.toLowerCase().startsWith(q)).sort(order);
  const sub = uniq.filter(i => !i.value.toLowerCase().startsWith(q) && (i.value.toLowerCase().includes(q) || i.label.toLowerCase().includes(q))).sort(order);
  const out = [...pre, ...sub];
  return out.length === 1 && out[0].value.toLowerCase() === q ? [] : out.slice(0, max);
}

/** Accepting a mention: replace the partial word, add one space. */
export const applyMention = (draft, cx, value) => String(draft).slice(0, cx.start) + value + ' ';

/**
 * One cache for the session. items() returns what is loaded (never blocks) and starts the single load the first
 * time it is asked; a failed kind is retried no sooner than RETRY_MS. loads() counts fetches (tests, /status).
 */
export function createMentionCache({ load, refresh = () => {}, now = Date.now, retryMs = RETRY_MS }) {
  let items = []; let state = 'idle'; let failedAt = 0; let loads = 0;
  const start = () => {
    state = 'loading'; loads++;
    Promise.resolve().then(load).then(
      (r) => { items = r?.items || []; state = r?.failed?.length ? 'partial' : 'ready'; if (state === 'partial') failedAt = now(); },
      () => { state = 'failed'; failedAt = now(); }
    ).then(() => refresh());
  };
  return {
    items() {
      if (state === 'idle' || ((state === 'failed' || state === 'partial') && now() - failedAt >= retryMs)) start();
      return items;
    },
    state: () => state,
    loads: () => loads,
  };
}
