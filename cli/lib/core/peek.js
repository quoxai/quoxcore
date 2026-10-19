/**
 * PEEK: look up one id without knowing what it is. `quox peek <id>` and the TUI /peek share this.
 *
 * The id's shape picks the kinds worth asking for (an envelope, inbox item, objective and workflow run
 * are all ULIDs, so a ULID asks all four at once; a WARD receipt is a UUID; an agent is a slug). Every
 * lookup reuses an existing read endpoint. A 404 means "not this kind"; any other failure is kept and
 * said, so an unknown id always names exactly what was tried and what each answered.
 */
import { resolveEndpoint } from '../api/endpoints.js';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z][a-z0-9_-]{0,63}$/i;

export const KIND_LABEL = { envelope: 'envelope', inbox: 'inbox item', objective: 'objective', run: 'workflow run', receipt: 'WARD receipt', agent: 'agent' };

/** -> { id (normalised), kinds: ordered kinds to try, shape: a plain word for the id's shape }. */
export function idShapes(raw) {
  const id = String(raw ?? '').trim();
  if (!id) return { id, kinds: [], shape: 'empty' };
  if (/^ENV_/i.test(id)) return { id, kinds: ['envelope'], shape: 'envelope id' };
  const obj = id.match(/^OBJ_([0-9A-HJKMNP-TV-Z]{26})$/i); // an objective's corr id
  if (obj) return { id: obj[1], kinds: ['objective'], shape: 'objective correlation id' };
  if (UUID.test(id)) return { id, kinds: ['receipt', 'inbox'], shape: 'UUID' };
  if (ULID.test(id)) return { id: id.toUpperCase(), kinds: ['envelope', 'inbox', 'objective', 'run'], shape: 'ULID' };
  if (SLUG.test(id)) return { id, kinds: ['agent', 'inbox'], shape: 'name' };
  return { id, kinds: [], shape: 'unrecognised' };
}

const unwrap = (d, ...keys) => { for (const k of keys) if (d && d[k] && typeof d[k] === 'object') return d[k]; return d; };

/**
 * One fetcher per kind on a CLI client. Each resolves to the object or throws the client's error
 * (with .status). orgId: a function returning the org the caller is acting in (the window org in the TUI).
 */
export function createPeekFetchers({ client, orgId }) {
  const org = () => { const o = typeof orgId === 'function' ? orgId() : orgId; return typeof o === 'string' && o ? o : null; };
  const get = (name, params, opts = {}) => { const ep = resolveEndpoint(name, params); return client.get(ep.path, { service: ep.service, retries: 0, timeout: 25000, ...opts }); };
  const needOrg = () => { const o = org(); if (!o) { const e = new Error('no org on this login'); e.status = 0; throw e; } return o; };
  return {
    envelope: async (id) => unwrap(await get('aee.get', { id: encodeURIComponent(id) }), 'envelope'),
    inbox: async (id) => unwrap(await get('inbox.get', { orgId: needOrg(), itemId: encodeURIComponent(id) }), 'item'),
    objective: async (id) => unwrap(await get('objectives.get', { id: encodeURIComponent(id) }), 'objective', 'data'),
    run: async (id) => {
      try { return unwrap(await get('executions.get', { executionId: encodeURIComponent(id) }), 'data', 'execution'); }
      catch (e) { if (e?.status !== 404) throw e; }
      return unwrap(await get('runs.get', { orgId: needOrg(), pollRunId: encodeURIComponent(id) }), 'run', 'data');
    },
    receipt: async (id) => unwrap(await get('ward.entries.get', { id: encodeURIComponent(id) }), 'entry'),
    agent: async (id) => {
      try { return unwrap(await get('agents.get', { orgId: needOrg(), agentId: encodeURIComponent(id) }), 'agent'); }
      catch (e) { if (e?.status !== 404) throw e; }
      const reg = await get('v1.agents.registry', {});
      const hit = (reg?.agents || []).find(r => r.agent_id === id || String(r.name || '').toLowerCase() === id.toLowerCase());
      if (!hit) { const e = new Error('Agent not found'); e.status = 404; throw e; }
      return { ...hit, source: 'registry' };
    },
  };
}

const failText = (e) => {
  if (e?.status === 404) return 'not found';
  if (e?.status === 401 || e?.status === 403) return `HTTP ${e.status} (not allowed for this login)`;
  if (e?.status) return `HTTP ${e.status}${e.message ? `: ${String(e.message).slice(0, 80)}` : ''}`;
  return String(e?.message || 'failed').slice(0, 80);
};

/**
 * Ask every candidate kind at once; the first hit in shape order wins, other hits are named.
 * -> { id, shape, hit: { kind, data } | null, also: [kind], tried: [{ kind, result }] }
 */
export async function peekId(raw, fetchers) {
  const { id, kinds, shape } = idShapes(raw);
  const settled = await Promise.all(kinds.map(async (kind) => {
    try {
      const data = await fetchers[kind](id);
      if (data == null || (typeof data === 'object' && !Object.keys(data).length)) return { kind, result: 'empty answer' };
      return { kind, data };
    } catch (e) { return { kind, result: failText(e) }; }
  }));
  const hits = settled.filter(s => 'data' in s);
  return {
    id, shape,
    hit: hits[0] ? { kind: hits[0].kind, data: hits[0].data } : null,
    also: hits.slice(1).map(s => s.kind),
    tried: settled.map(s => ({ kind: s.kind, result: 'data' in s ? 'found' : s.result })),
  };
}

const s = (v) => (v == null || v === '' ? null : String(v));
const short = (v, n = 16) => { const t = s(v); return t && t.length > n ? `${t.slice(0, n)}…` : t; };
const when = (v) => { const t = s(v); return t ? t.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : null; };
const parse = (v) => { if (v && typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };

export const MORE = { envelope: (id) => `quox aee get ${id}`, inbox: (id) => `quox inbox get ${id}`, objective: (id) => `quox objective get ${id}`, run: (id) => `quox run get ${id}`, receipt: () => 'quox governance ward entries', agent: (id) => `quox agent get ${id}` };

/** kind -> data -> [[label, value|null]]: the card fields, shared by peekLines and the TUI card. */
export const ROWS = {
  envelope: (d) => [['intent', s(d.intent)], ['from', s(d.from) && `${d.from} → ${d.to || '?'}`], ['type', s(d.type)], ['corr', s(d.corr)], ['at', when(d.ts || d.timestamp)]],
  inbox: (d) => { const p = parse(d.payload_json) || {}; return [['title', s(d.title)], ['kind', s(d.kind)], ['status', [d.status, d.priority && `${d.priority} priority`].filter(Boolean).join(', ') || null], ['from', s(p.agent || p.session || p.source || d.created_by)], ['created', when(d.created_at)]]; },
  objective: (d) => [['title', s(d.title)], ['status', s(d.status)], ['tasks', d.task_count != null ? `${d.tasks_completed ?? 0} of ${d.task_count} done${d.tasks_failed ? `, ${d.tasks_failed} failed` : ''}` : null], ['team', s(d.team_id)], ['created', when(d.created_at)]],
  run: (d) => [['workflow', s(d.workflowName || d.workflow_name || d.workflowId || d.workflow_id)], ['status', s(d.status)], ['trigger', s(d.triggerData?.trigger || d.trigger)], ['started', when(d.startedAt || d.started_at || d.createdAt || d.created_at)], ['finished', when(d.finishedAt || d.completedAt || d.completed_at)]],
  receipt: (d) => [['chain', d.chain_id ? `${d.chain_id} #${d.seq ?? '?'}` : null], ['witnessed', s(d.source_kind) && `${d.source_kind} ${d.source_id || ''}`.trim()], ['at', when(d.witnessed_at)], ['hash', short(d.chain_hash)]],
  agent: (d) => [['name', s(d.name)], ['role', [d.role, d.level != null && `level ${d.level}`].filter(Boolean).join(', ') || null], ['about', s(d.description)], ['tools', d.tool_count != null ? String(d.tool_count) : null], ['source', s(d.source)]],
};

/**
 * Plain lines for a peek result: [{ text, tone }] (tone ok | warn | dim | null). Width-agnostic; the caller clips.
 */
export function peekLines(r) {
  if (!r) return [];
  if (!r.hit) {
    if (r.shape === 'empty') return [{ text: 'Usage: peek <id>. An envelope, inbox item, objective, workflow run, WARD receipt or agent id.', tone: 'warn' }];
    if (!r.tried.length) return [{ text: `"${r.id}" does not look like any id Quox issues (envelope, inbox item, objective, run or agent ULID, WARD receipt UUID, agent name). Nothing was looked up.`, tone: 'warn' }];
    return [
      { text: `Nothing found for ${r.id}.`, tone: 'warn' },
      { text: `Tried (${r.shape}): ${r.tried.map(t => `${KIND_LABEL[t.kind]} ${t.result}`).join(' · ')}`, tone: 'dim' },
    ];
  }
  const { kind, data } = r.hit;
  const out = [{ text: `◇ ${KIND_LABEL[kind]} ${r.id}`, tone: 'ok' }];
  for (const [k, v] of ROWS[kind](data || {})) if (v) out.push({ text: `  ${k.padEnd(9)} ${v}`, tone: null });
  if (r.also.length) out.push({ text: `  ${'also'.padEnd(9)} an id of the same value: ${r.also.map(k => KIND_LABEL[k]).join(', ')}`, tone: 'dim' });
  out.push({ text: `  ${'more'.padEnd(9)} ${MORE[kind](r.id)}`, tone: 'dim' });
  return out;
}
