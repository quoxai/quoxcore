/**
 * QUOXON-MESH: slot chat in the quox TUI. Owner, 2026-10-14: "it would be cool if session to session messaging
 * was faster, more responsive... instant... like chat". A window holding a slot listens on the collector's slot
 * stream (GET /api/v1/slots/:name/stream, SSE, pushed from the same notify bus as `quox slot wait`) and renders
 * each message as a chat line above the composer. `@slot text`, `/say` and `/send` post without a model turn.
 *
 * Pure helpers and the listener live here; app.js wires them.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, renameSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, resolve, isAbsolute } from 'node:path';
import { scrub } from './transcript.js';
import { looksLikeKey } from './connect.js';
import { addressLabel } from './session.js';

// ---- outbound ------------------------------------------------------------------------------------
const AT_RE = /^@([A-Za-z0-9][A-Za-z0-9-]{0,31}):?[ \t]+(\S[\s\S]*)$/;
// The server's own leading-address forms (devSlotMessagesStore parseAddressedTo) stay message text.
const RESERVED = /^(all|S\d+|M\d+)$/i;

/** `@quox2 hello` -> { slot: 'quox2', text: 'hello' }; anything else -> null. */
export function parseAtSend(text) {
  const m = AT_RE.exec(String(text || ''));
  if (!m || RESERVED.test(m[1])) return null;
  const body = m[2].replace(/\s+$/, '');
  return body ? { slot: m[1].toLowerCase(), text: body } : null;
}

const labelSafe = (s) => String(s || '').replace(/[^A-Za-z0-9._@:\- ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);

/** What a window signs its lines as: "quox1 (Adam)", the slot alone, the name alone, or null (server derives). */
export function senderLabel({ slot, display }) {
  const d = labelSafe(display);
  if (slot) return d ? `${slot} (${d})` : slot;
  return d || null;
}

// ---- files ---------------------------------------------------------------------------------------
export const FILE_CAP = 64 * 1024;
const FILE_HEAD = '📎 ';
const FENCE = '~~~~~~'; // a fence a pasted Markdown file is very unlikely to contain

/** The wire form of a file: one header line, then the body inside a long tilde fence (renders as a block in Discord/Matrix too). */
export function fileMessage({ name, body, size }) {
  const lines = String(body).split('\n').length;
  return `${FILE_HEAD}${basename(String(name))} (${fmtSize(size ?? Buffer.byteLength(String(body)))}, ${lines} line${lines === 1 ? '' : 's'})\n${FENCE}\n${body}\n${FENCE}`;
}

/** -> { name, meta, body } for a file message, else null. */
export function parseFileMessage(text) {
  const t = String(text || '');
  if (!t.startsWith(FILE_HEAD)) return null;
  const m = /^📎 (.+?) \(([^)\n]*)\)\n~~~~~~\n([\s\S]*)\n~~~~~~$/.exec(t);
  return m ? { name: m[1], meta: m[2], body: m[3] } : null;
}

function fmtSize(n) { return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`; }

const EXTRA_SECRETS = [/\bgsk_[A-Za-z0-9]{20,}/g, /\bhf_[A-Za-z0-9]{20,}/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g];

/** The CLI redactor (transcript.js scrub) plus the paste guard's key shapes. -> { text, hits }. */
export function redactSecrets(text) {
  const src = String(text);
  let out = scrub(src);
  for (const re of EXTRA_SECRETS) out = out.replace(re, '[redacted-key]');
  const count = (s) => (s.match(/\[redacted[^\]]*\]/g) || []).length;
  let hits = count(out) - count(src);
  if (!hits && looksLikeKey(src)) hits = 1; // a key shape the patterns above missed: never call it clean
  return { text: out, hits };
}

/**
 * Read a local file for /send. Text up to FILE_CAP goes inline; larger or binary files are refused with the cap
 * (slots have no attachment store). -> { ok, name, path, body, redacted, hits, size } | { ok:false, message }.
 */
export function prepareFile(p, { cwd = process.cwd() } = {}) {
  const raw = String(p || '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return { ok: false, message: 'Usage: /send <slot> <file>' };
  const full = isAbsolute(raw) ? raw : resolve(cwd, raw.replace(/^~(?=\/)/, homedir()));
  let st;
  try { st = statSync(full); } catch { return { ok: false, message: `No such file: ${raw}` }; }
  if (st.isDirectory()) return { ok: false, message: `${raw} is a directory; /send takes one file.` };
  if (st.size > FILE_CAP) return { ok: false, message: `${raw} is ${fmtSize(st.size)}; /send sends text files up to 64 KB inline (slots have no attachment store yet).` };
  const buf = readFileSync(full);
  if (buf.subarray(0, 8192).includes(0)) return { ok: false, message: `${raw} looks binary; /send sends text files only (up to 64 KB).` };
  const body = buf.toString('utf8');
  const { text, hits } = redactSecrets(body);
  return { ok: true, name: basename(full), path: full, body, redacted: text, hits, size: st.size };
}

/** Tab completion for /send's path argument: entries of the typed directory, directories with a trailing slash. */
export function pathItems(partial, { cwd = process.cwd(), max = 200 } = {}) {
  const p = String(partial || '');
  const slash = p.lastIndexOf('/');
  const dirPart = slash >= 0 ? p.slice(0, slash + 1) : '';
  const base = dirPart.startsWith('~/') ? join(homedir(), dirPart.slice(2)) : isAbsolute(dirPart) ? dirPart : resolve(cwd, dirPart || '.');
  let names = [];
  try { names = readdirSync(base, { withFileTypes: true }); } catch { return []; }
  const showHidden = p.slice(slash + 1).startsWith('.');
  return names.filter(d => showHidden || !d.name.startsWith('.')).slice(0, max)
    .map(d => ({ value: dirPart + d.name + (d.isDirectory() ? '/' : ''), desc: d.isDirectory() ? 'dir' : '' }));
}

// ---- inbound -------------------------------------------------------------------------------------
const hhmm = (iso) => { const d = new Date(iso || Date.now()); return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** Slot text arrives HTML-escaped from the Matrix bridge ("&amp;&amp;"); decode for display. Never renders HTML. */
export function decodeEntities(t) {
  return String(t ?? '').replace(/&(amp|lt|gt|quot|apos|#39|#x27);/gi, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'" })[e.toLowerCase()]);
}

/** The slot a session name currently holds (from api.slots() rows), or null. Lets a broadcast show its reply address. */
export function slotOfHolder(rows, name) {
  const n = String(name || '').replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase(); if (!n) return null;
  const r = (Array.isArray(rows) ? rows : []).find(x => x?.name && x.state !== 'free' && String(x.holder_session || '').toLowerCase() === n);
  return r ? r.name : null;
}

/** A slot message as a chat line: { glyph, who, time, text, file }. */
export function slotLine(m) {
  m = m && typeof m.text === 'string' ? { ...m, text: decodeEntities(m.text) } : m;
  const f = parseFileMessage(m?.text);
  const file = f ? { name: f.name, meta: f.meta, body: f.body, lines: f.body.split('\n').length, preview: f.body.split('\n').slice(0, 3) } : null;
  // SLOTS-REPLY: the slot is the address, so it leads; the session/display name follows in brackets. A sender
  // with no verified slot keeps its name and is flagged as having no reply address.
  const from = m?.from || m?.author_identity || 'someone';
  const who = m?.from_slot ? addressLabel(m.from_slot, m?.from) : from;
  return { glyph: '◆', who, noReply: !m?.from_slot, time: hhmm(m?.created_at), text: file ? `📎 ${f.name} (${f.meta})` : String(m?.text ?? ''), file };
}

/**
 * Keep a slot's stream open: reconnect with the cursor, count failures distinctly, back off on failures (capped),
 * and fall back to the wait long-poll on a server without the stream route. Never polls while the stream is up.
 * open(query, signal) -> async iterable of SSE events; wait({ since, signal }) -> { messages, cursor }.
 */
// A slot cursor names a message ('<created_at>|<seq>'), not just a time: resuming from a bare timestamp skipped a
// second message in the same millisecond (collector devSlotMessagesStore parseCursor/cursorOf/isAfterCursor).
export function slotCursorOf(m) { return m.seq == null ? m.created_at : `${m.created_at}|${m.seq}`; }
export function isAfterSlotCursor(m, cursor) {
  if (!cursor) return true;
  const x = /^(.*)\|(\d+)$/.exec(String(cursor));
  const ts = x ? (x[1] || null) : String(cursor); const seq = x ? Number(x[2]) : null;
  if (seq != null && !ts) return m.seq != null && m.seq > seq;
  if (m.created_at !== ts) return m.created_at > ts;
  return seq == null ? true : (m.seq != null && m.seq > seq);
}

export function createSlotListener({ open, wait = null, onMessage, onState = () => {}, delays = [1000, 2000, 5000, 10000, 30000] }) {
  const st = { running: false, failures: 0, mode: 'stream', cursor: null, connected: false };
  let ac = null;
  const seen = new Set();
  const deliver = (m) => {
    if (!m) return;
    if (m.created_at && isAfterSlotCursor(m, st.cursor)) st.cursor = slotCursorOf(m);
    if (m.id) { if (seen.has(m.id)) return; seen.add(m.id); if (seen.size > 1000) seen.delete(seen.values().next().value); }
    try { onMessage(m); } catch { /* a render failure never kills the listener */ }
  };
  const sleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
  const setConn = (v) => { if (st.connected !== v) { st.connected = v; onState({ ...st }); } };

  async function loop(signal, since) {
    st.cursor = since || null;
    let streak = 0;
    while (!signal.aborted) {
      try {
        if (st.mode === 'stream') {
          for await (const ev of open({ since: st.cursor }, signal)) {
            if (signal.aborted) break;
            if (ev?.type === 'connected') { streak = 0; if (ev.cursor && !st.cursor) st.cursor = ev.cursor; setConn(true); }
            else if (ev?.type === 'slot.message') { streak = 0; deliver(ev.message); }
          }
          setConn(false);
          if (signal.aborted) break;
          await sleep(delays[0], signal); // a clean end (lifetime) reconnects promptly
          continue;
        }
        const r = await wait({ since: st.cursor, signal });
        if (signal.aborted) break;
        streak = 0; setConn(true);
        for (const m of r?.messages || []) deliver(m);
        if (r?.cursor) st.cursor = r.cursor;
      } catch (e) {
        if (signal.aborted) break;
        setConn(false);
        if (st.mode === 'stream' && wait && e?.status === 404 && e?.code !== 'unknown slot') { st.mode = 'wait'; onState({ ...st }); continue; }
        st.failures += 1; streak += 1;
        onState({ ...st, error: e?.message || 'failed' });
        await sleep(delays[Math.min(streak - 1, delays.length - 1)], signal);
      }
    }
  }
  return {
    start({ since } = {}) {
      if (st.running) return;
      st.running = true; ac = new AbortController();
      const sig = ac.signal;
      loop(sig, since).finally(() => { st.running = false; st.connected = false; });
    },
    stop() { if (ac) ac.abort(); ac = null; st.running = false; st.connected = false; },
    state: () => ({ ...st }),
  };
}

/** SLOTS-REPLY2: is this line in slot X from X's own holder (verified from_slot, else the sender name)? */
export function isHolderLine(m, slot) {
  const x = String(slot || '').toLowerCase(); if (!x) return false;
  if (String(m?.from_slot || '').toLowerCase() === x) return true;
  const f = String(m?.from || '').toLowerCase();
  return f === x || f.startsWith(`${x} (`);
}

/**
 * SLOTS-REPLY2: after this window sends into slot X it also watches X (not just its own slot) for lines from
 * X's holder, from the sent message's cursor on, until `ttlMs` after the last send or stop(). A reply posted
 * in X (a sender with no reply address) is then still shown. onReply(slot, message) fires once per line.
 * open/wait are api.slotStream / api.slotWait shaped, bound per slot by the caller: open(slot, q, signal).
 */
export function createReplyWatches({ open, wait = null, onReply, ttlMs = 30 * 60 * 1000, now = Date.now, isMine = () => false, skipSlot = () => false, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const watches = new Map();
  const drop = (slot) => { const w = watches.get(slot); if (!w) return; clearTimer(w.timer); w.l.stop(); watches.delete(slot); };
  const arm = (slot, sent) => {
    if (!slot || skipSlot(slot)) return false;
    const until = now() + ttlMs;
    const ex = watches.get(slot);
    if (ex) { clearTimer(ex.timer); ex.timer = setTimer(() => drop(slot), ttlMs); ex.timer.unref?.(); ex.until = until; return true; }
    const w = { until, timer: null, l: null };
    w.l = createSlotListener({
      open: (q, signal) => open(slot, q, signal),
      wait: wait ? ({ since, signal }) => wait(slot, { since, signal }) : null,
      onMessage: (m) => {
        if (now() > w.until) { drop(slot); return; }
        if (isMine(m) || !isHolderLine(m, slot)) return;
        onReply(slot, m);
      },
    });
    w.timer = setTimer(() => drop(slot), ttlMs); w.timer.unref?.();
    watches.set(slot, w);
    w.l.start({ since: sent && sent.created_at ? slotCursorOf(sent) : undefined });
    return true;
  };
  return { arm, stop: () => { for (const s of [...watches.keys()]) drop(s); }, has: (s) => watches.has(s), size: () => watches.size };
}

// ---- reattach record -------------------------------------------------------------------------------
export const lastSlotPath = () => join(homedir(), '.config', 'quox', 'quoxon-slots.json');
const readAll = (path) => { try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) || {} : {}; } catch { return {}; } };
const keyOf = (profile, cwd) => `${profile || 'default'}|${cwd || ''}`;
function writeAll(all, path) {
  try { mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(all, null, 2)); renameSync(tmp, path); } catch { /* best effort */ }
}
/** The slot this profile last held in this directory, or null. */
export function loadLastSlot({ profile, cwd, path = lastSlotPath() }) {
  const e = readAll(path)[keyOf(profile, cwd)];
  return e && typeof e.slot === 'string' ? e : null;
}
export function saveLastSlot({ profile, cwd, slot, session, path = lastSlotPath() }) {
  const all = readAll(path); all[keyOf(profile, cwd)] = { slot, session: session || null, at: new Date().toISOString() }; writeAll(all, path);
}
export function forgetLastSlot({ profile, cwd, path = lastSlotPath() }) {
  const all = readAll(path); const k = keyOf(profile, cwd);
  if (k in all) { delete all[k]; writeAll(all, path); }
}

// ---- QUOXON-ROOMS: a slot as a group room ----------------------------------------------------------
const ROOM_RE = /^#([A-Za-z0-9][A-Za-z0-9-]{0,31}):?(?:[ \t]+(\S[\s\S]*))?$/;
/** `#group-chat hello` -> { room, text }; bare `#group-chat` -> { room, text: null }; `# heading` or anything else -> null. */
export function parseRoomSend(text) {
  const m = ROOM_RE.exec(String(text || '').replace(/\s+$/, ''));
  return m ? { room: m[1].toLowerCase(), text: m[2] ? m[2] : null } : null;
}
/** `#group-chat` / `group-chat` -> 'group-chat'; junk -> null. */
export function roomName(arg) {
  const m = /^#?([A-Za-z0-9][A-Za-z0-9-]{0,31})$/.exec(String(arg || '').trim());
  return m ? m[1].toLowerCase() : null;
}
/** "QUOXON (resident)" -> "QUOXON": the sender as a chat name. */
export function senderName(from) { return String(from || 'someone').replace(/\s*\(.*$/, '').trim() || 'someone'; }
const SENDER_ROLES = ['sky', 'teal', 'ok', 'warn', 'indigo', 'violet'];
/** A stable colour role per sender (same name, same colour, every time and every window). */
export function senderColor(name) {
  let h = 0; for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return SENDER_ROLES[h % SENDER_ROLES.length];
}
/** A room message as a chat line: `#group-chat  QUOXON: text`. */
export function roomLine(room, m, { out = false } = {}) {
  const base = slotLine(m);
  const who = senderName(m?.from);
  return { ...base, glyph: '#', room, who, color: senderColor(who), text: base.text, out, roomLine: true };
}
/** The text form of a room line, for /rooms backlog tests and plain output. */
export const roomLineText = (l) => `#${l.room}  ${l.who}: ${l.text}`;

/** QUOXON-MESH: what a send to a slot tells the user about the recipient. null when the server sent no presence. */
export function presenceLine(slot, presence, agoText) {
  if (!presence || !presence.state) return null;
  if (presence.state === 'listening') return { text: `✔ delivered to ${slot} (listening now)`, tone: 'ok', listening: true };
  if (presence.state === 'nobody_holds') return { text: `✔ delivered to ${slot} · nobody holds this slot`, tone: 'ok', listening: false };
  const seen = presence.last_checked_in_at ? `last checked in ${agoText(presence.last_checked_in_at)}` : 'no check-in on record';
  return { text: `✔ delivered to ${slot} · not listening right now (${seen}); it sees this when it next checks`, tone: 'ok', listening: false };
}
