/**
 * gdprErasureCascade.js: account erasure beyond the collector's own stores
 * (FND_01M4HZQ5P004YSXH0BWY04YSXH). DELETE /api/v1/users/:id/data used to purge
 * only AEE envelopes and chat turns; the user's QuoxMemory rows and Qortex
 * notes (plus the brain copies of their conversations) stayed searchable.
 * Each leg is reported separately and `complete` is true only when every leg
 * confirmed, so a partial erasure is never presented as done.
 */
'use strict';

const DEFAULT_MEMORY_URL = `http://${process.env.MEMORY_HOST || 'memory'}:${process.env.MEMORY_PORT || '3103'}`;
const DEFAULT_BRAIN_URL = (process.env.QUOXBRAIN_URL || 'http://quoxbrain:3106').replace(/\/$/, '');
const DEFAULT_TASKS_URL = (process.env.TASKS_SERVICE_URL || 'http://tasks:3104').replace(/\/$/, '');
const TIMEOUT_MS = 30000;

/** Envelope rows {org_id, corr} -> [{orgId, relPaths}] in the conversation feed's relPath scheme. */
function conversationsFromRows(rows = []) {
  const byOrg = new Map();
  for (const r of rows) {
    if (!r || typeof r.org_id !== 'string' || !r.org_id || typeof r.corr !== 'string' || !r.corr) continue;
    if (!byOrg.has(r.org_id)) byOrg.set(r.org_id, []);
    byOrg.get(r.org_id).push(`conversation/${r.corr}.md`);
  }
  return [...byOrg].map(([orgId, relPaths]) => ({ orgId, relPaths }));
}

async function callErase(url, body, { fetchImpl, serviceKey }) {
  if (!serviceKey) return { ok: false, error: 'INTERNAL_SERVICE_KEY not configured' };
  try {
    const res = await fetchImpl(`${url}/internal/erase-user`, {
      method: 'POST',
      headers: { 'X-Service-Key': serviceKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => null);
    if (!data || data.erased !== true) return { ok: false, error: 'erase not confirmed' };
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function runErasureCascade(userId, { conversations = [] } = {}, deps = {}) {
  const ctx = { fetchImpl: deps.fetchImpl || fetch, serviceKey: deps.serviceKey !== undefined ? deps.serviceKey : (process.env.INTERNAL_SERVICE_KEY || '') };
  // QUOXMIND #1110: the tasks leg erases the user's stored focus asks, focus and open loops.
  const [memory, brain, tasks] = await Promise.all([
    callErase(deps.memoryUrl || DEFAULT_MEMORY_URL, { userId }, ctx),
    callErase(deps.brainUrl || DEFAULT_BRAIN_URL, { userId, conversations }, ctx),
    callErase(deps.tasksUrl || DEFAULT_TASKS_URL, { userId }, ctx),
  ]);
  return { complete: memory.ok && brain.ok && tasks.ok, memory, brain, tasks };
}

module.exports = { conversationsFromRows, runErasureCascade };
