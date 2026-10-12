'use strict';

/**
 * notesqWisdom.js - AQ-9D P5: the wisdom loop on NotesQ agent-edit approvals.
 *
 * recordOutcome: every terminal approval of a NotesQ propose tool teaches the
 * tasks wisdom store (accepted / rejected / expired), keyed by agent + tool so
 * occurrence counts show which suggestions humans reject. No note content or
 * titles are ever sent. outcomeStats reads the counts back for the card advisor.
 * Everything is fail-soft and never throws.
 */

const { NOTESQ_PROPOSE_TOOLS } = require('./notesqProposeTools.js');

const TASKS_URL = () => `http://${process.env.TASKS_HOST || 'tasks'}:${process.env.TASKS_PORT || '3104'}`;
const INTERNAL_SERVICE_KEY = () => process.env.INTERNAL_SERVICE_KEY || '';
const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 60000;
const LOG_EVERY_MS = 60000;

const OUTCOME = { approved: 'accepted', denied: 'rejected', expired: 'expired' };
const OUTCOMES = ['accepted', 'rejected', 'expired'];

let failureCount = 0;
let lastLogAt = 0;
const cache = new Map();

function noteFailure(what, err) {
  failureCount += 1;
  const now = Date.now();
  if (now - lastLogAt >= LOG_EVERY_MS) {
    lastLogAt = now;
    console.warn(`[NotesqWisdom] ${what} failed (non-fatal, ${failureCount} total): ${err && err.message ? err.message : err}`);
  }
}

const headers = (orgId) => ({
  'Content-Type': 'application/json',
  'X-Service-Key': INTERNAL_SERVICE_KEY(),
  'X-Org-Id': orgId || 'default',
});

const patternName = (agentId, toolName, outcome) => `notesq-agent-edit:${agentId || 'agent'}:${toolName}:${outcome}`;

function modeOf(row) {
  try {
    const input = JSON.parse(row.input_json || '{}');
    if (row.tool_name !== 'notesq_update' || !input) return '';
    if (input.markdown !== undefined) return 'replace';
    if (input.append) return 'append';
  } catch (_) { /* no mode */ }
  return '';
}

async function recordOutcome(row, status) {
  try {
    if (!row || !NOTESQ_PROPOSE_TOOLS.has(row.tool_name)) return false;
    const outcome = OUTCOME[status];
    if (!outcome || !INTERNAL_SERVICE_KEY()) return false;
    const mode = modeOf(row);
    const verb = outcome === 'accepted' ? 'approved' : outcome === 'rejected' ? 'rejected' : 'let expire';
    const res = await fetch(`${TASKS_URL()}/api/wisdom`, {
      method: 'POST',
      headers: headers(row.org_id),
      body: JSON.stringify({
        org_id: row.org_id || 'default',
        pattern_name: patternName(row.agent_id, row.tool_name, outcome),
        category: 'notesq',
        lesson: `A human ${verb} an agent ${row.tool_name} proposal${mode ? ` (${mode})` : ''}.`,
        directive: outcome === 'rejected'
          ? `Proposals of this kind are often declined. Prefer a smaller, clearer change, or ask the user first.`
          : `Track how often humans accept this kind of proposal before making similar changes.`,
        severity: outcome === 'rejected' ? 'low' : 'info',
        tags: ['notesq', row.tool_name, outcome],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) { noteFailure('record outcome', new Error(`HTTP ${res.status}`)); return false; }
    cache.clear();
    return true;
  } catch (err) {
    noteFailure('record outcome', err);
    return false;
  }
}

async function outcomeStats({ orgId, agentId, toolName }) {
  try {
    if (!INTERNAL_SERVICE_KEY() || !toolName) return null;
    const key = `${orgId}|${agentId}|${toolName}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const prefix = `notesq-agent-edit:${agentId || 'agent'}:${toolName}:`;
    const res = await fetch(`${TASKS_URL()}/api/wisdom?q=${encodeURIComponent(prefix)}&limit=10`, {
      headers: headers(orgId),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) { noteFailure('outcome stats', new Error(`HTTP ${res.status}`)); return null; }
    const data = await res.json().catch(() => null);
    const entries = Array.isArray(data && data.wisdom) ? data.wisdom : [];
    const value = { accepted: 0, rejected: 0, expired: 0 };
    for (const o of OUTCOMES) {
      const e = entries.find((w) => w.pattern_name === prefix + o);
      if (e) value[o] = Number(e.occurrence_count) || 0;
    }
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    noteFailure('outcome stats', err);
    return null;
  }
}

function _reset() { cache.clear(); failureCount = 0; lastLogAt = 0; }
function _failureCount() { return failureCount; }

module.exports = { recordOutcome, outcomeStats, _reset, _failureCount };
