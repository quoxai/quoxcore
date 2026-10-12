/**
 * `quox contacts selftest [--agent]`: drives the ContactsQ READ path against a dedicated demo
 * contact and prints a pass/fail table. Never dials, sends or leases context (those file
 * approvals). With --agent the same checks run through the attached agent's tool scope
 * (POST /api/v1/tools/execute with the attach token, exactly like `quox agent exec`).
 */

import { QuoxApiError, QuoxError } from '../core/errors.js';
import { line as glyphLine, printEvent } from '../core/quoxglyph.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { ensureFreshAttachToken, execResultFailed } from './agentAttach.js';

export const DEMO_NAME = 'ContactsQ Selftest (demo)';
export const DEMO_PHONE = '+44 7911 123000';
export const DEMO_EMAIL = 'selftest@example.com';
export const DEMO_TAG = 'selftest';
const AGENT_ID = 'contactsq';

const errText = (e) => (e instanceof QuoxApiError ? `${e.status} ${(e.body && e.body.error) || e.message}` : (e && e.message) || String(e));

/** Find the demo contact or create it (human path). Idempotent. */
export async function ensureDemoContact(client) {
  const list = resolveEndpoint('contactsq.contacts.list');
  const found = await client.get(list.path, { service: list.service, query: { q: 'Selftest', limit: 50 } });
  const hit = (found.contacts || []).find((c) => c.display_name === DEMO_NAME);
  if (hit) return { id: hit.id, created: false };
  const create = resolveEndpoint('contactsq.contacts.create');
  const made = await client.post(create.path, {
    service: create.service,
    body: { display_name: DEMO_NAME, identifiers: [{ channel: 'phone', value: DEMO_PHONE, is_primary: true }, { channel: 'email', value: DEMO_EMAIL, is_primary: true }] },
  });
  const id = made.contact && made.contact.id;
  if (!id) throw new QuoxError('Could not create the selftest demo contact.', 1);
  const upd = resolveEndpoint('contactsq.contacts.update', { id });
  // Tagging is a human edit: an attached agent creates the demo contact but may not tag it (403 human_required).
  // The tag is a convenience for people browsing the book, so a refusal here never fails the selftest.
  try {
    await client.put(upd.path, { service: upd.service, body: { tags: [DEMO_TAG] } });
  } catch (e) {
    if (!(e && (e.status === 403 || e.statusCode === 403))) throw e;
  }
  return { id, created: true };
}

/** Direct (human) transport: the governed HTTP routes. */
function directOps(client, id) {
  const get = (key, params, query) => { const ep = resolveEndpoint(key, params); return client.get(ep.path, { service: ep.service, query }); };
  const post = (key, params, body) => { const ep = resolveEndpoint(key, params); return client.post(ep.path, { service: ep.service, body }); };
  return {
    search: (q) => get('contactsq.search', {}, { q }),
    find: (q) => get('contactsq.contacts.list', {}, { q }),
    resolve: (channel, value) => post('contactsq.resolve', {}, { channel, value }),
    // No HTTP route for best_channel: the policy check is the same engine, per channel.
    best_channel: async () => {
      const out = [];
      for (const channel of ['voice', 'email']) {
        const r = await post('contactsq.policy', { id }, { purpose: 'service', channel });
        out.push({ channel, decision: r.decision || (r.policy && r.policy.decision) || null });
      }
      return { alternatives: out };
    },
    timeline: () => get('contactsq.timeline', { id }, {}),
    log: () => post('contactsq.touchpoints.add', { id }, { surface: 'manual', direction: 'internal', outcome: 'selftest' }),
    brief: () => get('contactsq.brief', {}, {}),
  };
}

/** Agent transport: the attached agent's own tool scope through /api/v1/tools/execute. */
async function agentOps(client, id, orgId) {
  const token = await ensureFreshAttachToken(client, AGENT_ID);
  const ep = resolveEndpoint('v1.tools.execute');
  const exec = async (tool, input) => {
    let data;
    try {
      data = await client.post(ep.path, { service: ep.service, noAuth: true, headers: { Authorization: `Bearer ${token}` }, body: { tool_name: tool, input, org_id: orgId } });
    } catch (e) {
      if (e instanceof QuoxApiError && (e.status === 401 || e.status === 403)) {
        throw new Error(`${tool}: attach token for "${AGENT_ID}" refused (${e.status}). Re-attach with \`quox agent attach ${AGENT_ID}\`.`);
      }
      throw e;
    }
    // Tool envelopes vary: unwrap { result } if present, then require success.
    const res = data && typeof data.result === 'object' && data.result ? data.result : data;
    if (execResultFailed(res) || execResultFailed(data)) throw new Error(`${tool}: ${res.error || data.error || 'tool reported failure'}`);
    return res;
  };
  return {
    search: (q) => exec('contacts_search', { q }),
    find: (q) => exec('contacts_find', { q }),
    resolve: (channel, value) => exec('contacts_resolve', { channel, value }),
    best_channel: () => exec('contacts_best_channel', { contact_id: id }),
    timeline: () => exec('contacts_timeline', { contact_id: id }),
    log: () => exec('contacts_log_touchpoint', { contact_id: id, surface: 'manual', direction: 'internal', outcome: 'selftest' }),
    brief: () => exec('contacts_brief', {}),
  };
}

const idsOf = (r) => [...(r.candidates || []), ...(r.contacts || [])].map((c) => c.id);

/** The checks, transport-agnostic. Each returns a short result string or throws. */
export function buildChecks(ops, id) {
  return [
    ['search', async () => { const r = await ops.search('ContactsQ Selftest'); if (!idsOf(r).includes(id)) throw new Error('demo contact not in results'); return `${idsOf(r).length} hit(s)`; }],
    ['search (sound-alike)', async () => { const r = await ops.search('Selftast'); if (!idsOf(r).includes(id)) throw new Error('sound-alike did not reach the demo contact'); return 'Selftast -> Selftest'; }],
    ['find', async () => { const r = await ops.find('Selftest'); if (!idsOf(r).includes(id)) throw new Error('demo contact not found'); return `${idsOf(r).length} hit(s)`; }],
    ['resolve by email', async () => { const r = await ops.resolve('email', DEMO_EMAIL); if (!r.match || r.match.id !== id) throw new Error('email did not resolve to the demo contact'); return 'matched'; }],
    ['best_channel', async () => { const r = await ops.best_channel(); const n = (r.alternatives || []).length; if (!n) throw new Error('no channel evaluation returned'); return r.channel ? `chose ${r.channel}` : `${n} evaluated`; }],
    ['timeline', async () => { const r = await ops.timeline(); if (!Array.isArray(r.timeline)) throw new Error('no timeline array'); return `${r.timeline.length} entr(ies)`; }],
    ['log touchpoint', async () => { const r = await ops.log(); const t = r.touchpoint || r; if (!t.id) throw new Error('no touchpoint id returned'); return t.id; }],
    ['brief', async () => { const r = await ops.brief(); if (typeof r.candidates_to_review !== 'number' || !Array.isArray(r.sync)) throw new Error('brief shape wrong'); return `${r.candidates_to_review} candidates, ${r.duplicates} dupes`; }],
  ];
}

export async function runSelftest({ client, auth, program, options, orgId, print = console.log }) {
  auth.requireAuth();
  const demo = await ensureDemoContact(client);
  const mode = options.agent ? 'agent' : 'direct';
  const ops = options.agent ? await agentOps(client, demo.id, orgId) : directOps(client, demo.id);
  const rows = [];
  for (const [name, fn] of buildChecks(ops, demo.id)) {
    try { rows.push({ check: name, ok: true, detail: await fn() }); } catch (e) { rows.push({ check: name, ok: false, detail: errText(e) }); }
  }
  const failed = rows.filter((r) => !r.ok).length;
  if (program.opts().output === 'json') {
    print(JSON.stringify({ mode, demo_contact: demo.id, created: demo.created, passed: rows.length - failed, failed, checks: rows }, null, 2));
  } else {
    for (const r of rows) print(`${r.ok ? '✔' : '✖'} ${r.check.padEnd(22)} ${r.detail}`);
    printEvent(glyphLine('contactsq', `selftest (${mode})`, { result: `${rows.length - failed}/${rows.length} passed`, status: failed ? 'fail' : 'ok' }));
  }
  if (failed) process.exitCode = 1;
  return { rows, failed };
}
