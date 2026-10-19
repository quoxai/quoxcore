/**
 * Data for the inline object views, from the real services only. Every read is bounded (timeouts are
 * short on purpose: an inline card must not hang the composer) and every failure comes back as a
 * reason string, never as an empty result. Status is checked before anything is parsed: the client
 * throws on non-2xx, and the throw is what becomes the reason.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { findSkill } from '../skills.js';
import { packFrom } from './ladder.js';
import { slotFor } from './agent.js';
import { listFailure } from '../session.js';
import { resolveEndpoint } from '../../api/endpoints.js';
import { fleetFetchers } from './fleet.js';
import { healthFetchers } from './health.js';
import { proveFetchers } from './prove.js';
import { replayFetchers } from './replay.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSISTANTS_DIR = path.resolve(HERE, '../../../../src/config/entities/assistants');
const listOf = (d, ...keys) => { for (const k of keys) if (Array.isArray(d?.[k])) return d[k]; return Array.isArray(d) ? d : []; };
const why = (e) => (e?.status ? `HTTP ${e.status}` : /timed out/i.test(e?.message || '') ? 'timed out' : e?.message || 'failed');

/** The shipped assistant identities: id -> { name, tagline, description }. */
export function bundledIdentities(dir = ASSISTANTS_DIR) {
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j?.id) out.set(j.id, { name: j.identity?.name || j.id, tagline: j.identity?.tagline || null, description: j.identity?.description || null });
    } catch { /* skip unreadable */ }
  }
  return out;
}

export function createObjectsApi({ client, orgId = () => null, home = os.homedir(), identities = bundledIdentities, profile = null }) {
  const get = (service, p, query, timeout = 12000) => client.get(p, { service, query, retries: 0, timeout });
  const post = (service, p, body, timeout = 8000) => client.post(p, { service, body, retries: 0, timeout });
  const org = () => { const o = orgId(); return typeof o === 'string' ? o : null; };
  let ids = null;
  const idents = () => (ids ??= identities());
  const nameOf = (id) => idents().get(id)?.name || id;

  async function verifyReceipt(envelopeId, timeoutS = 8) {
    try { const d = await post('collector', '/ward/verify-receipt', { source_id: envelopeId, source_kind: 'AEE' }, timeoutS * 1000); return { ok: true, result: d?.result || d }; }
    catch (e) { return { ok: false, error: why(e), timeout: /timed out/i.test(e?.message || '') ? timeoutS : null }; }
  }
  async function aeeGet(id) {
    try { const d = await get('collector', `/aee/${encodeURIComponent(id)}`, undefined, 10000); return { ok: true, env: d?.envelope || d }; }
    catch (e) { return { ok: false, status: e?.status, error: why(e) }; }
  }

  /** Workflow by id or display name (quoxflow GET /api/workflows). -> { id, name, definition } | null */
  async function findWorkflow(ref) {
    const r = String(ref || '').trim();
    try { const d = await get('quoxflow', `/api/workflows/${encodeURIComponent(r)}`); const w = d?.data || d; if (w?.id) return w; } catch (e) { if (e?.status && e.status !== 404) throw e; }
    const all = listOf(await get('quoxflow', '/api/workflows', { limit: 100 }), 'data', 'workflows', 'items');
    const lc = r.toLowerCase();
    return all.find(w => String(w.name || '').toLowerCase() === lc) || all.find(w => String(w.name || '').toLowerCase().includes(lc)) || null;
  }
  async function pageExecutions(workflowId, status, max = 500) {
    const out = [];
    for (let offset = 0; offset < max; offset += 100) {
      const rows = listOf(await get('quoxflow', '/api/executions', { workflowId, status, limit: 100, offset }), 'data', 'executions');
      out.push(...rows);
      if (rows.length < 100) break;
    }
    return out;
  }

  const self = {
    ...fleetFetchers({ get, org, listOf, why, resolveEndpoint }),
    ...healthFetchers({ get, org, listOf, why, resolveEndpoint }),
    ...replayFetchers({ get, listOf, why, verifyReceipt: (id, t) => verifyReceipt(id, t), aeeGet: (id) => aeeGet(id) }),
    ...proveFetchers({ get, listOf, resolveEndpoint, self: { proof: (t) => self.proof(t) } }),
    /** E1 */
    async skill(name) {
      const all = listOf(await get('collector', '/quoxflow/skills', { orgId: org() || undefined }), 'data', 'skills');
      const hit = findSkill(all, name);
      if (!hit) return { error: `No skill named "${name}". /skills lists them.`, tone: 'warn' };
      let skill = hit;
      try { const d = await get('collector', `/quoxflow/skills/${encodeURIComponent(hit.id)}`, { orgId: org() || undefined }); skill = d?.data || d || hit; } catch { /* the list row is the same record */ }
      let scoreboard = null;
      // The org-scoped per-skill route; 404 = no recorded runs. (The bulk /scoreboards list is not
      // org-filtered in quoxflow, so it is deliberately not used here.)
      try { const d = await get('quoxflow', `/api/quox-skills/${encodeURIComponent(skill.id)}/scoreboard`, undefined, 8000); scoreboard = { ok: true, row: d?.data || null }; }
      catch (e) { scoreboard = e?.status === 404 ? { ok: true, row: null } : { ok: false, error: why(e) }; }
      return { data: { skill, scoreboard, agentName: nameOf } };
    },

    /** E2: ref = execution id / correlation id, or a workflow id or name (its latest run). */
    async workflowRun(ref) {
      let execution = null;
      try { const d = await get('quoxflow', `/api/executions/${encodeURIComponent(ref)}`); execution = d?.data || d; } catch (e) { if (e?.status && e.status !== 404) throw e; }
      if (!execution?.id) {
        const wf = await findWorkflow(ref);
        if (!wf) return { error: `No workflow or run called "${ref}".`, tone: 'warn' };
        const rows = listOf(await get('quoxflow', '/api/executions', { workflowId: wf.id, limit: 1 }), 'data', 'executions');
        if (!rows.length) return { error: `${wf.name || wf.id} has never run.`, tone: 'warn' };
        execution = rows[0];
      }
      let envelopes = null, def = null;
      try { const d = await get('quoxflow', `/api/executions/${encodeURIComponent(execution.id)}/envelopes`); envelopes = listOf(d?.data || d, 'envelopes'); } catch { envelopes = null; }
      try { const d = await get('quoxflow', `/api/workflows/${encodeURIComponent(execution.workflowId)}`); def = (d?.data || d)?.definition || null; } catch { def = null; }
      return { data: { execution, envelopes, def } };
    },

    /** E3 */
    async crystal(ref) {
      const wf = await findWorkflow(ref);
      if (!wf) return { error: `No workflow called "${ref}".`, tone: 'warn' };
      const [completed, failed] = await Promise.all([pageExecutions(wf.id, 'completed'), pageExecutions(wf.id, 'failed')]);
      return { data: { workflow: { id: wf.id, name: wf.name }, executions: [...completed, ...failed], def: wf.definition || null } };
    },

    /** E4 */
    async agent(name) {
      const q = String(name || '').trim().toLowerCase();
      let toolMap = null, toolErr = null, toolFail = null;
      try { toolMap = (await client.get('/api/v1/tools/agents', { service: 'collector', retries: 0, timeout: 10000 }))?.agentTools || null; } catch (e) { toolErr = why(e); toolFail = e; }
      let orgAgents = [];
      try { if (org()) orgAgents = listOf(await get('auth', `/api/orgs/${org()}/agents`, { includeTools: 'false' }), 'agents', 'data'); } catch { /* optional */ }
      const known = new Set([...Object.keys(toolMap || {}), ...idents().keys(), ...orgAgents.map(a => a.agent_id)]);
      let id = [...known].find(k => k.toLowerCase() === q);
      if (!id) id = [...known].find(k => String(nameOf(k)).toLowerCase() === q) || orgAgents.find(a => String(a.name || '').toLowerCase() === q)?.agent_id;
      if (!id && toolFail) return { error: `Couldn't check agents: ${listFailure(toolFail, profile)}`, tone: 'warn' }; // a failed list is a failure, never "no such agent"
      if (!id) return { error: `No agent called "${name}".`, tone: 'warn' };
      const record = orgAgents.find(a => a.agent_id === id) || null;
      const ident = idents().get(id) || {};
      let slot = null;
      try { slot = slotFor(listOf(await get('collector', '/api/v1/slots', undefined, 10000), 'slots'), id); } catch { slot = null; }
      let last = null, lastErr = null, receipt = null;
      try { last = listOf(await get('collector', '/aee/query', { from: `agent.${id}`, limit: 1 }, 10000), 'envelopes')[0] || null; } catch (e) { lastErr = why(e); }
      if (last?.id) receipt = await verifyReceipt(last.id);
      return { data: { id, name: ident.name || record?.name || id, tagline: ident.tagline, description: record?.description || ident.description || null, status: record?.status || null, record, tools: toolMap ? (toolMap[id] || []) : null, toolsErr: toolErr, slot, last, lastErr, receipt } };
    },

    /** E6 */
    async memory(query) {
      const d = await get('memory', '/api/memory/search', { q: query, limit: 10 });
      return { data: { query, results: listOf(d, 'results', 'memories', 'data') } };
    },

    /** E7 */
    async rules() {
      let policies;
      const o = org();
      if (!o) policies = { ok: false, error: 'no org on this profile' };
      else {
        try { policies = { ok: true, list: listOf(await get('collector', `/orgs/${o}/governance/policies`, undefined, 15000), 'policies') }; }
        catch (e) { policies = { ok: false, error: why(e) }; }
      }
      const pack = packFrom((f) => fs.readFileSync(path.join(home, '.claude', 'skills', f), 'utf8'));
      return { data: { policies, pack } };
    },

    /** D1 */
    async proof(tool) {
      const envelope = await aeeGet(tool.envelopeId);
      let aocl = null;
      const corr = envelope.ok ? envelope.env?.corr : null;
      if (corr) {
        try { aocl = { ok: true, list: listOf(await get('collector', '/aee/query', { corr, limit: 50 }, 10000), 'envelopes').filter(e => /^aocl\./.test(String(e.intent || ''))) }; }
        catch (e) { aocl = { ok: false, error: why(e) }; }
      }
      const receipt = await verifyReceipt(tool.envelopeId);
      return { data: { tool, envelope, aocl, receipt } };
    },

    /** D3 */
    async reconcile(tools) {
      const items = [];
      for (const t of tools) items.push({ tool: t.tool, envelopeId: t.envelopeId || null, record: t.envelopeId ? await aeeGet(t.envelopeId) : null });
      return { data: { items } };
    }
  };
  return self;
}
