'use strict';
/**
 * QUOXON-ENGINE lane N, class 4 (quox#830): raw tool errors never reach the user.
 *
 * Applied once at the tool-result boundary (governedToolDispatch.dispatchGovernedToolCall,
 * the non-stream Anthropic dispatcher and /api/v1/tools/execute), so the model reads a plain
 * message and the UI's tool.finished event shows the same one. Raw bodies, JSON blobs,
 * stacks, internal addresses and driver codes are dropped; the server log keeps the raw.
 *
 * Successes and approval holds are returned as the same object. A plain error keeps its
 * words; only raw-looking text is rewritten.
 */

const STRIP_FIELDS = ['stack', 'body', 'raw', 'response', 'details', 'trace', 'cause', 'stderr'];

const LABELS = {
  calendar: 'Calendar', inbox: 'Mail', email: 'Mail', twilio: 'Twilio', voice: 'QuoxVoice', github: 'GitHub',
  notesq: 'NotesQ', contacts: 'ContactsQ', quoxseo: 'QuoxSEO', quoxplan: 'QuoxPlan', qlarity: 'Qlarity', security: 'QuoxSecurity',
  docker: 'Docker', proxmox: 'Proxmox', fleet: 'Fleet', vault: 'Vault', x: 'X', slot: 'Slots',
};
function labelFor(toolName) {
  const p = String(toolName || '').split('_')[0].toLowerCase();
  return LABELS[p] || (p ? p.charAt(0).toUpperCase() + p.slice(1) : 'This tool');
}

/** Pull the human part out of a raw error: inner JSON message, no stack, no addresses. */
function cleanText(raw) {
  let s = typeof raw === 'string' ? raw : (() => { try { return JSON.stringify(raw); } catch { return String(raw); } })();
  // inner JSON body: prefer its error/message field
  const j = s.match(/\{[\s\S]*\}/);
  if (j) {
    try {
      const o = JSON.parse(j[0]);
      const inner = (o && (typeof o.error === 'string' && o.error.length > 3 && !/^internal$/i.test(o.error) ? o.error : null)) || (o && typeof o.message === 'string' ? o.message : null) || (o && typeof o.error === 'string' ? o.error : '');
      s = `${s.slice(0, j.index)}${inner}${s.slice(j.index + j[0].length)}`;
    } catch {
      s = s.replace(/\{[\s\S]*\}/, '').trim();
    }
  }
  s = s
    .replace(/\n\s*at\s+[^\n]*/g, '') // stack frames
    .replace(/\(?\/?(?:app|home|usr|srv|var)\/[^\s)]*:\d+(?::\d+)?\)?/g, '') // file:line
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '') // addresses
    .replace(/\b(?:SQLITE_\w+|E[A-Z]{3,}|ERR_[A-Z_]+)\b:?/g, '')
    .replace(/^\s*(?:error|Error|TypeError|RangeError)\s*:\s*/, '')
    .replace(/[{}[\]"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 200) s = `${s.slice(0, 199).trimEnd()}…`;
  return s;
}

const RULES = [
  ['approval_required', /approval required|requires? (?:human )?approval|risky under approval mode/i,
    () => 'Refused: this needs approval under the current approval mode, so nothing ran. No approval card exists unless a tool returned an approval id; say it was refused.'],
  ['not_connected', /connection not found|not connected|no (?:\w+ )?(?:connections?|accounts?|credentials?|mailbox(?:es)?) (?:found|configured|connected|linked)|credentials? not found|no (?:\w+ )?(?:connection|account) for/i,
    (label) => `${label} has no connected account for this org yet, so there is nothing to read. This is a setup state, not a fault: say nothing is connected and that it is connected from the dashboard Connections page.`],
  ['unauthorized', /\b401\b|unauthori[sz]ed|not authenticated|invalid token|jwt expired/i,
    (label) => `${label} refused the read: this session is not signed in or lacks permission. Nothing ran.`],
  ['forbidden', /\b403\b|forbidden|permission denied|access denied/i,
    (label) => `${label} refused this by policy (403). Nothing ran.`],
  ['rate_limited', /\b429\b|rate.?limit|too many requests/i,
    (label) => `${label} is rate limiting requests right now; try again shortly.`],
  ['timeout', /timed? ?out|timeout|aborted due to timeout|ETIMEDOUT/i,
    (label) => `${label} did not answer in time, so the result is unknown.`],
  ['unreachable', /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|socket hang up|\b50[234]\b|service unavailable|bad gateway|unreachable/i,
    (label) => `${label} could not be reached right now (the service is down or unreachable).`],
  ['not_found', /\b404\b|not found|no such/i,
    (label, clean) => (clean && !/\b404\b/.test(clean) && clean.length < 160 ? clean : `${label} found nothing by that reference.`)],
];

function looksRaw(s) {
  const t = String(s || '');
  // Driver codes (ECONNREFUSED, SQLITE_BUSY) are upper case: matched case-sensitively, or
  // every plain word starting with e ("empty", "exited") reads as raw (quox#882).
  // A bare HTTP status line ("HTTP 401 Unauthorized") and the AbortSignal text ("The operation was
  // aborted due to timeout") are transport output, not words a tool wrote for a person.
  return /[{}]|\n\s*at\s|\.js:\d|<html|^\s*(?:Type|Range)?Error:/i.test(t) || /\bE[A-Z]{3,}\b|SQLITE_/.test(t)
    || /^\s*HTTP\/?\d?(?:\.\d)?\s*\d{3}\b/i.test(t) || /^\s*(?:AbortError:\s*)?The operation was aborted(?: due to timeout)?\.?\s*$/i.test(t);
}

/** -> the result the model and the UI see. Never throws. */
function plainToolResult(toolName, result) {
  try {
    if (!result || typeof result !== 'object') return result;
    if (result._approval || result.status === 'pending_approval' || result.status === 'held') return result;
    const failed = result.success === false || (result.error && result.success !== true);
    if (!failed) return result;
    const raw = result.error != null ? result.error : (result.message || 'failed');
    const rawText = typeof raw === 'string' ? raw : (() => { try { return JSON.stringify(raw); } catch { return String(raw); } })();
    const out = { ...result };
    for (const f of STRIP_FIELDS) delete out[f];
    const clean = cleanText(rawText);
    if (result.status === 'effect_unknown') {
      const m = rawText.match(/threw after dispatch \(([\s\S]*)\);\s*the effect may have been applied/);
      const why = cleanText(m ? m[1] : rawText.replace(/^effect_unknown:\s*/, '')) || 'error';
      out.error = `${toolName} failed after it was dispatched (${why}); the effect may have been applied, verify before retrying.`;
      out.error_code = 'effect_unknown';
      if (out.message && looksRaw(out.message)) delete out.message;
      return out;
    }
    const label = labelFor(toolName);
    const hit = RULES.find(([, re]) => re.test(rawText));
    // An already-plain message keeps its words (it may name the host or item); it gains a
    // category. Only raw-looking text, and the two cases models misread (nothing connected,
    // refused for approval), are rewritten.
    if (typeof raw === 'string' && !looksRaw(rawText) && !(hit && (hit[0] === 'not_connected' || hit[0] === 'approval_required'))) {
      return result; // unchanged: callers deep-compare result shapes
    }
    if (hit) {
      out.error = hit[2](label, clean);
      out.error_code = hit[0];
    } else if (looksRaw(rawText) || typeof raw !== 'string') {
      out.error = clean ? `${label} failed: ${clean}` : `${label} failed.`;
      out.error_code = 'tool_error';
    } else {
      return result; // already plain
    }
    if (out.message && looksRaw(out.message)) delete out.message;
    if (out.error !== rawText) {
      try { console.warn(`[ToolErrorPlain] ${toolName} ${out.error_code}: ${rawText.slice(0, 300)}`); } catch { /* log only */ }
    }
    return out;
  } catch {
    return result;
  }
}

module.exports = { plainToolResult, cleanText, labelFor };
