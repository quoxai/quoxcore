/**
 * Dev transcript capture (opt-in, off by default). One JSONL line per client event so a local
 * review loop can analyse sessions without the owner pasting terminal output.
 *
 * On when QUOX_DEV_TRANSCRIPT=1 or the flag file ~/.config/quox/dev-transcripts exists;
 * QUOX_DEV_TRANSCRIPT=0 forces it off. Fields are ALLOWLISTED per event: objects are never
 * dumped wholesale, and every string passes a token scrubber as a second line of defence.
 */
import { mkdirSync, openSync, writeSync, closeSync, existsSync, chmodSync } from 'node:fs';
import { stripMarks } from './palette.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const MAX_FIELD = 4000;
export const SILENT_GAP_MS = 10000;
export const MAX_ANSWER = 8192;

export function transcriptEnabled({ env = process.env, home = homedir(), exists = existsSync } = {}) {
  if (env.QUOX_DEV_TRANSCRIPT === '0') return false;
  if (env.QUOX_DEV_TRANSCRIPT === '1') return true;
  return exists(join(home, '.config', 'quox', 'dev-transcripts'));
}

const SCRUBS = [
  [/eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)*/g, '[redacted-jwt]'],
  [/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted-key]'],
  [/\b(?:ghp|gho|ghs|xox[abp]|qsk|AKIA)[A-Za-z0-9_-]{12,}/g, '[redacted-key]'],
  [/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|service[_-]?key|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]']
];

export function scrub(s) {
  let out = String(s);
  for (const [re, rep] of SCRUBS) out = out.replace(re, rep);
  return out;
}

/** Strings are scrubbed and truncated; non-strings become a scrubbed JSON string (never a raw object). */
export function clean(v) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  let s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  s = stripMarks(scrub(s)); // ⟦⟧ colour markup never reaches a record
  return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…[truncated ${s.length - MAX_FIELD} chars]` : s;
}

// SSE event fields worth keeping, by name. Anything not listed is dropped.
const SSE_FIELDS = ['type', 'agent', 'model', 'provider', 'hat', 'conversation_id', 'session_id', 'stage', 'message',
  'content', 'call_id', 'tool', 'summary', 'status', 'result_summary', 'duration_ms', 'envelope_id', 'target', 'scope',
  'risk', 'describable', 'dashboard_url', 'inbox_item_id', 'approval_id', 'decision', 'text', 'protocol', 'label', 'ref',
  'detail', 'error', 'full_response'];
const RECEIPT_FIELDS = ['verified', 'ward_seq'];
// Metering only (numbers, never strings): lets a local eval loop sum the cost of interactive turns.
const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const num = (v) => typeof v === 'number' && Number.isFinite(v);

export function pickSse(ev) {
  const o = {};
  if (!ev || typeof ev !== 'object') return o;
  for (const k of SSE_FIELDS) if (ev[k] !== undefined) o[k] = clean(ev[k]);
  if (ev.receipt && typeof ev.receipt === 'object') {
    o.receipt = {};
    for (const k of RECEIPT_FIELDS) if (ev.receipt[k] !== undefined) o.receipt[k] = clean(ev.receipt[k]);
  }
  if (num(ev.cost_usd)) o.cost_usd = ev.cost_usd;
  if (ev.usage && typeof ev.usage === 'object') {
    const u = {};
    for (const k of USAGE_FIELDS) if (num(ev.usage[k])) u[k] = ev.usage[k];
    if (Object.keys(u).length) o.usage = u;
  }
  return o;
}

/** Map one app dispatch action to a transcript record (or null to skip). */
export function recordFor(a) {
  switch (a?.type) {
    case 'event': return { t: 'sse', ...pickSse(a.ev) };
    case 'user': return { t: 'user', mode: a.queued ? 'queue-drain' : 'send', text: clean(a.text) };
    case 'steer.add': return { t: 'user', mode: 'steer', id: clean(a.id), text: clean(a.text) };
    case 'queue.add': return { t: 'user', mode: 'queue', text: clean(a.text) };
    case 'steer.failed': case 'steer.converted': return { t: 'notice', kind: a.type, id: clean(a.id), text: clean(a.reason) };
    case 'note': return { t: 'notice', kind: 'note', tone: clean(a.tone), text: clean(a.text) };
    case 'error': return { t: 'error', text: clean(a.text) };
    case 'notify': return { t: 'notify', approvals: a.patch?.approvals ?? null, error: clean(a.patch?.error ?? null) };
    case 'turn.begin': return { t: 'turn.begin', turnId: clean(a.turnId) };
    case 'approval.sent': return { t: 'approval.sent', action: clean(a.action), callId: clean(a.callId), tool: clean(a.tool), target: clean(a.target) };
    case 'approval.result': return { t: 'approval.result', callId: clean(a.callId), outcome: clean(a.outcome), text: clean(a.text ?? null) };
    case 'verbose': return { t: 'verbose', mode: clean(a.mode) };
    case 'ctx': return { t: 'ctx', conversationId: clean(a.ctx?.conversationId ?? null) };
    // /connect: provider and last 4 only, by construction (the key is never in an action).
    case 'connect.started': return { t: 'connect.started', provider: clean(a.provider) };
    case 'connect.saved': return { t: 'connect.saved', provider: clean(a.provider), last4: clean(a.last4) };
    case 'help': return { t: 'action', type: 'help', rows: (Array.isArray(a.model) ? a.model : []).map(m => clean([m.key, m.text].filter(Boolean).join(' '))).slice(0, 80) };
    case 'inbox.sync': return null; // every 30 s, ids only: noise
    default: return { t: 'action', type: clean(a?.type) };
  }
}

/**
 * -> null when disabled. Otherwise { action(a), command(line), resize(cols, rows), end(reason), path }.
 * Never throws into the app: a write failure disables capture for the rest of the session.
 */
export function createTranscript({ env = process.env, home = homedir(), now = Date.now, exists = existsSync, meta = {} } = {}) {
  if (!transcriptEnabled({ env, home, exists })) return null;
  const dir = env.QUOX_DEV_TRANSCRIPT_DIR || join(home, '.local', 'share', 'quox', 'transcripts');
  let fd = null;
  const start = now();
  const path = join(dir, `${new Date(start).toISOString().replace(/[:.]/g, '-')}-${process.pid}.jsonl`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
    fd = openSync(path, 'a', 0o600);
    chmodSync(path, 0o600);
  } catch { return null; }
  const turn = { id: null, t0: 0, firstText: false, lastSse: 0, text: '', provider: null, model: null, offered: null, tokens: null, answered: false };
  const write = (rec) => {
    if (fd == null || !rec) return;
    try { writeSync(fd, JSON.stringify({ ts: new Date(now()).toISOString(), ...rec }) + '\n'); }
    catch { try { closeSync(fd); } catch { /* ignore */ } fd = null; }
  };
  write({ t: 'start', version: clean(meta.version ?? null), cols: meta.cols ?? null, rows: meta.rows ?? null,
    profile: clean(meta.profile ?? null), org: clean(meta.org ?? null), cwd: clean(meta.cwd ?? null), pid: process.pid });

  const action = (a) => {
    const t = now();
    const rec = recordFor(a);
    if (a?.type === 'turn.begin') Object.assign(turn, { id: a.turnId, t0: t, firstText: false, lastSse: t, text: '', provider: null, model: null, offered: null, tokens: null, answered: false });
    if (a?.type === 'event' && turn.id) {
      if (t - turn.lastSse > SILENT_GAP_MS) write({ t: 'gap', turnId: turn.id, ms: t - turn.lastSse, before: clean(a.ev?.type) });
      turn.lastSse = t;
    }
    write(rec);
    if (a?.type === 'event' && turn.id) {
      const ty = a.ev?.type;
      const ev = a.ev;
      if (ty === 'turn.started') {
        turn.provider = ev.provider ?? turn.provider; turn.model = ev.model ?? turn.model;
        const n = [ev.tools_offered, ev.tool_count, ev.tools_available].find(num);
        if (n !== undefined) turn.offered = n;
      }
      if ((ty === 'chunk' || ty === 'text.delta') && typeof ev.content === 'string' && turn.text.length <= MAX_ANSWER) turn.text += ev.content;
      if (ty === 'done' && !turn.text && typeof ev.full_response === 'string') turn.text = ev.full_response;
      if (ty === 'tool.finished') {
        const failed = ev.status === 'failed' || ev.status === 'denied';
        write({ t: 'tool', turnId: turn.id, name: clean(ev.tool ?? null), ok: ev.status === 'ok', ...(failed || ev.error ? { error: clean(ev.error ?? ev.result_summary ?? ev.status) } : {}), ms: num(ev.duration_ms) ? ev.duration_ms : null });
      }
      if (ty === 'error') write({ t: 'turn.error', turnId: turn.id, message: clean(ev.error ?? ev.message ?? 'stream error'), provider: clean(turn.provider), model: clean(turn.model) });
      if (!turn.firstText && (ty === 'chunk' || ty === 'text.delta') && a.ev?.content) {
        turn.firstText = true;
        write({ t: 'timing', turnId: turn.id, first_text_ms: t - turn.t0 });
      }
      if (ty === 'turn.finished') {
        if (ev.usage && typeof ev.usage === 'object') turn.tokens = { input: num(ev.usage.input_tokens) ? ev.usage.input_tokens : null, output: num(ev.usage.output_tokens) ? ev.usage.output_tokens : null };
        if (turn.text) {
          const raw = scrub(turn.text);
          const text = raw.length > MAX_ANSWER ? `${raw.slice(0, MAX_ANSWER)}…[truncated ${raw.length - MAX_ANSWER} chars]` : raw;
          write({ t: 'answer', turnId: turn.id, provider: clean(turn.provider), model: clean(turn.model), tokens: turn.tokens, duration_ms: t - turn.t0, tools_offered: turn.offered, text });
        }
        write({ t: 'timing', turnId: turn.id, finish_ms: t - turn.t0, status: clean(a.ev?.status ?? null), saw_text: turn.firstText });
        turn.id = null;
      }
    }
  };
  return {
    path,
    action,
    command: (line) => { const [cmd, ...rest] = String(line).trim().split(/\s+/); write({ t: 'command', cmd: clean(cmd), arg: clean(rest.join(' ') || null) }); },
    // Owner observation (/note): recorded verbatim (scrubbed, 2000 chars), never sent anywhere else.
    note: (text) => write({ t: 'note', text: clean(String(text).slice(0, 2000)), ts: new Date(now()).toISOString() }),
    // ! commands (QUOXON-FW8): the command line and exit code only, never the output.
    bang: (cmd, code) => write({ t: 'bang', cmd: clean(String(cmd).slice(0, 2000)), exit: clean(code) }),
    resize: (cols, rows) => write({ t: 'resize', cols: cols ?? null, rows: rows ?? null }),
    end: (reason = 'exit') => { write({ t: 'end', reason: clean(reason), duration_ms: now() - start }); if (fd != null) { try { closeSync(fd); } catch { /* ignore */ } fd = null; } }
  };
}
