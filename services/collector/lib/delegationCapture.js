'use strict';

/**
 * SITE-CLI redesign plan, step 1 (observe only), 2026-10-17. The wrong_holder delegation guard was reverted after it
 * misrouted three live proof cases; its offline tests never saw the live inputs (the delegation log clipped the brief
 * at 80 chars, and the user's words were not recorded on /chat/stream until quox#1266). Each delegation appends one
 * record here: the full brief, the user's turn text, the live hint pool, and what the unwired guard functions WOULD
 * have done. Observe only: nothing is refused or rerouted, and a capture failure never touches the delegation.
 *
 * Stored on the collector's data volume next to the other feed logs, capped (one rotated file kept). Prompt text is
 * never written to the console log (quox#782); it is written only here, as it already is in the conversation store.
 */

const fs = require('fs');

const CAPTURE_PATH = '/var/lib/quox/delegation-capture.jsonl';
const MAX_BYTES = 4 * 1024 * 1024;
const TASK_MAX = 4000;
const USER_MAX = 500;

const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) : t; };

/**
 * -> the RAW capture record. Cheap (no tool selection: that costs 130-320 ms of event-loop time under load), so it is
 * safe on the request path. The live pool is kept as tool NAMES, the part the offline tests never saw.
 */
function buildCaptureRecord({ orgId = null, conversationId = null, from = 'quox', to = '', task = '', userText = '', expectTool = '' } = {}) {
  const parent = String(from || 'quox').toLowerCase();
  let pool = [];
  try { pool = require('./agentTools.js').getToolsForAgent(parent, { orgId: orgId || 'capture' }).map((t) => t && t.name).filter(Boolean); } catch { pool = []; }
  return {
    v: 1,
    ts: new Date().toISOString(),
    org_id: orgId,
    conversation_id: conversationId,
    from: parent,
    to: String(to || '').toLowerCase(),
    expect_tool: expectTool || null,
    task: clip(task, TASK_MAX),
    user_text: clip(userText, USER_MAX),
    user_text_present: !!String(userText || '').trim(),
    pool,
  };
}

/**
 * OFFLINE: what the live hints were and what each (unwired) guard function WOULD have done, from a raw record and its
 * captured pool. Never called on the request path.
 */
function analyzeCaptureRecord(rec) {
  const g = require('./delegationHolderGuard.js');
  const at = require('./agentTools.js');
  const names = new Set(Array.isArray(rec.pool) ? rec.pool : []);
  const all = at.getToolsForAgent(rec.from || 'quox', { orgId: rec.org_id || 'capture' });
  const pool = names.size ? all.filter((t) => names.has(t.name)) : all;
  let hints = [];
  try {
    hints = (require('./turnToolSelection.js').selectTurnTools({ pool, message: String(rec.task || ''), agent: rec.from || 'quox' }).delegationHints || [])
      .map((h) => ({ tool: h.tool, holders: h.holders, pin: !!h.pin, named_in_task: g.taskNamesTool(rec.task, h.tool) }));
  } catch { hints = []; }
  const args = { task: rec.task, targetId: rec.to, parentId: rec.from || 'quox', expectTool: rec.expect_tool || '', orgId: rec.org_id || 'capture', userText: rec.user_text || '' };
  let refusal = null; let reroute = null; let named = false;
  try { named = g.userNamedTarget(rec.to, rec.user_text || ''); } catch { named = false; }
  try { refusal = g.delegationHolderRefusal(args); } catch { refusal = null; }
  try { reroute = g.delegationReroute(args); } catch { reroute = null; }
  return {
    hints,
    pool_size: names.size || all.length,
    user_named_target: named,
    would: { refuse: !!refusal, refuse_holders: refusal ? refusal.holders : [], reroute: reroute ? { to: reroute.to, reason: reroute.reason } : null },
  };
}

function writeLine(file, line, maxBytes) {
  try {
    const st = fs.statSync(file);
    if (st.size + line.length > maxBytes) fs.renameSync(file, `${file}.1`);
  } catch { /* no file yet */ }
  fs.appendFileSync(file, line);
}

/** Record one delegation. Never throws; off the request path unless sync (tests). */
function captureDelegation(args, { file = CAPTURE_PATH, sync = false, maxBytes = MAX_BYTES } = {}) {
  const run = () => {
    try {
      const line = `${JSON.stringify(buildCaptureRecord(args || {}))}\n`;
      writeLine(file, line, maxBytes);
    } catch (err) {
      try { console.warn(`[DelegationCapture] not recorded (non-fatal): ${err && err.message}`); } catch { /* ignore */ }
    }
  };
  if (sync) run(); else setImmediate(run);
}

module.exports = { buildCaptureRecord, analyzeCaptureRecord, captureDelegation, CAPTURE_PATH };
