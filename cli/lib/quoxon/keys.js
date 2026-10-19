/**
 * Raw stdin tokeniser for the QUOXON composer. We own input parsing (instead of
 * Ink's useInput) because we need bracketed paste, Shift+Enter, Ctrl+_ and a
 * paste-burst heuristic, none of which Ink 6 exposes.
 *
 * parseChunk(chunk, state) -> { events, state }
 * Events: { type: 'text', text } | { type: 'paste', text } | { type: 'key', name, ctrl?, alt? } | { type: 'focus', focused }
 *   | { type: 'mouse', action: 'press'|'release'|'drag'|'move'|'wheel', button, x, y, shift, alt, ctrl } (SGR 1006, QUOXON-MOUSE)
 *   | { type: 'cursor', row, col } (a cursor position report, the answer to DSR ESC[6n)
 */

const BUTTONS = ['left', 'middle', 'right', 'none'];
const WHEEL = ['up', 'down', 'left', 'right'];
/** One SGR mouse report (ESC [ < b ; x ; y M|m) as an event. */
function mouseEvent(b, x, y, final) {
  const low = b & 3;
  const mods = { shift: Boolean(b & 4), alt: Boolean(b & 8), ctrl: Boolean(b & 16) };
  if (b & 64) return { type: 'mouse', action: 'wheel', button: WHEEL[low], x, y, ...mods };
  if (b & 32) return { type: 'mouse', action: low === 3 ? 'move' : 'drag', button: BUTTONS[low], x, y, ...mods };
  return { type: 'mouse', action: final === 'm' ? 'release' : 'press', button: BUTTONS[low], x, y, ...mods };
}

export const PASTE_ON = '\x1b[?2004h';
export const PASTE_OFF = '\x1b[?2004l';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export const initialKeyState = () => ({ inPaste: false, pasteBuf: '', partial: '' });
/** Time after which a dangling paste start / partial marker is flushed (app owns the timer). */
export const PASTE_DANGLING_MS = 1500;
/** Non-bracketed input arriving within this many ms of the previous chunk is a paste burst. */
export const BURST_MS = 20;

/** True when the key state holds something a timer must eventually flush. */
export const hasDangling = (st) => Boolean(st?.inPaste || st?.partial);

/**
 * Flush a dangling paste start or half marker after a timeout. Buffered paste text becomes a PASTE
 * event (inserted, never submitted); a half marker is dropped. Never produces Enter.
 */
export function flushDangling(state) {
  const events = [];
  if (state?.inPaste && state.pasteBuf) {
    let t = state.pasteBuf;
    for (let n = Math.min(PASTE_END.length - 1, t.length); n > 0; n--) { if (t.endsWith(PASTE_END.slice(0, n))) { t = t.slice(0, -n); break; } }
    if (t) events.push({ type: 'paste', text: t });
  }
  return { events, state: initialKeyState() };
}

const CSI_KEYS = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
  '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left',
  '\x1b[H': 'home', '\x1b[F': 'end', '\x1bOH': 'home', '\x1bOF': 'end',
  '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1b[7~': 'home', '\x1b[8~': 'end',
  '\x1b[3~': 'delete', '\x1b[Z': 'shift-tab',
  '\x1b[13;2u': 'shift-enter', '\x1b[27;2;13~': 'shift-enter', '\x1b\r': 'shift-enter', '\x1b\n': 'shift-enter',
  '\x1b[1;5D': 'word-left', '\x1b[1;5C': 'word-right', '\x1b[1;3D': 'word-left', '\x1b[1;3C': 'word-right',
  // COMPOSER-EDIT (owner 2026-10-17: edit like Claude Code's prompt box). Alt+B/F (macOS Option+Left/Right), iTerm2 Alt+arrows,
  // Alt+Backspace, Alt+D, Ctrl/Alt+Delete, and Shift (+Ctrl/Alt) arrows, Home and End for selection.
  '\x1bb': 'word-left', '\x1bf': 'word-right', '\x1b\x1b[D': 'word-left', '\x1b\x1b[C': 'word-right',
  '\x1b\x7f': 'delete-word', '\x1b\x08': 'delete-word', '\x1bd': 'delete-word-forward',
  '\x1b[3;5~': 'delete-word-forward', '\x1b[3;3~': 'delete-word-forward',
  '\x1b[1;2D': 'select-left', '\x1b[1;2C': 'select-right', '\x1b[1;2A': 'select-up', '\x1b[1;2B': 'select-down',
  '\x1b[1;2H': 'select-home', '\x1b[1;2F': 'select-end',
  '\x1b[1;6D': 'select-word-left', '\x1b[1;6C': 'select-word-right', '\x1b[1;4D': 'select-word-left', '\x1b[1;4C': 'select-word-right'
};
const CSI_LIST = Object.keys(CSI_KEYS).sort((a, b) => b.length - a.length);

const CTRL = {
  '\x01': 'home', '\x05': 'end', '\x03': 'ctrl-c', '\x04': 'ctrl-d', '\x07': 'ctrl-g',
  '\x0b': 'kill-line-forward', '\x0f': 'ctrl-o', '\x13': 'ctrl-s', '\x15': 'kill-line', '\x17': 'delete-word',
  '\x1f': 'undo', '\x19': 'redo', '\x0a': 'newline', '\x7f': 'backspace', '\x08': 'backspace',
  '\r': 'enter', '\t': 'tab', '\x02': 'left', '\x06': 'right'
};

/** `draft` = the composer text before this chunk (a burst split mid-line continues the line already typed). */
export function parseChunk(chunk, state = initialKeyState(), draft = '') {
  const events = [];
  let s = String(chunk);
  let st = { partial: '', ...state };
  if (st.partial) { s = st.partial + s; st.partial = ''; }

  while (s.length) {
    if (st.inPaste) {
      // search the joined buffer so an end marker split across chunks is still found
      const buf = st.pasteBuf + s;
      const end = buf.indexOf(PASTE_END);
      if (end === -1) { st.pasteBuf = buf; s = ''; break; }
      events.push({ type: 'paste', text: buf.slice(0, end) });
      st = { inPaste: false, pasteBuf: '', partial: '' };
      s = buf.slice(end + PASTE_END.length);
      continue;
    }
    if (s.startsWith(PASTE_START)) { st = { inPaste: true, pasteBuf: '', partial: '' }; s = s.slice(PASTE_START.length); continue; }
    // a half-received start marker (ESC [ 2 0 ...): hold it for the next chunk, never read it as Esc + text
    if (s.length >= 2 && s.length < PASTE_START.length && PASTE_START.startsWith(s)) { st.partial = s; s = ''; break; }
    if (s === '\x1b') { events.push({ type: 'key', name: 'escape' }); s = ''; continue; }
    if (s[0] === '\x1b') {
      // Focus reporting (CSI ?1004h, enabled by sound/index.js): CSI I = focus in, CSI O = focus out.
      if (s.startsWith('\x1b[I') || s.startsWith('\x1b[O')) { events.push({ type: 'focus', focused: s[2] === 'I' }); s = s.slice(3); continue; }
      // QUOXON-MOUSE: SGR mouse reports; a report split across chunks is held, never typed into the composer.
      const mm = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s);
      if (mm) { events.push(mouseEvent(Number(mm[1]), Number(mm[2]), Number(mm[3]), mm[4])); s = s.slice(mm[0].length); continue; }
      if (/^\x1b\[<[\d;]*$/.test(s)) { st.partial = s; s = ''; break; }
      const cr = /^\x1b\[(\d+);(\d+)R/.exec(s);
      if (cr) { events.push({ type: 'cursor', row: Number(cr[1]), col: Number(cr[2]) }); s = s.slice(cr[0].length); continue; }
      const hit = CSI_LIST.find(k => s.startsWith(k));
      if (hit) { events.push({ type: 'key', name: CSI_KEYS[hit] }); s = s.slice(hit.length); continue; }
      // Unknown escape sequence: swallow ESC [ ... final byte, or a bare ESC+char (alt-x).
      const m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(s) || /^\x1bO./.exec(s);
      if (m) { s = s.slice(m[0].length); continue; }
      if (s.length >= 2) { events.push({ type: 'key', name: 'escape' }); s = s.slice(1); continue; }
    }
    // Plain run: printable text up to the next control char.
    // Burst heuristic: text plus newlines delivered in ONE chunk, with content after
    // the first newline, is a paste (terminal without bracketed paste), not typing.
    const run = /^[^\x00-\x1f\x7f]+/.exec(s);
    if (run) { events.push({ type: 'text', text: run[0] }); s = s.slice(run[0].length); continue; }
    const c = s[0];
    if (CTRL[c]) { events.push({ type: 'key', name: CTRL[c] }); }
    s = s.slice(1);
  }
  return { events: coalesceBurst(events, draft), state: st };
}

/**
 * If a chunk produced text and then an Enter/newline FOLLOWED by more text, it is
 * a non-bracketed paste: fold it into one paste event. A trailing single Enter
 * (text then Enter at the end) stays as text + enter so fast typing still submits.
 *
 * Except a burst whose every line is a slash command (R3 D3): that is typed input batched by tmux,
 * SSH/mosh or a script ("/help" Enter "/model x" Enter), never a paste, so each Enter runs its line.
 * Folding it made a multi-line "/" draft that trapped every later Enter.
 */
const isEnter = (e) => e.type === 'key' && (e.name === 'enter' || e.name === 'newline');
function commandLines(events, draft = '') {
  let line = draft.includes('\n') ? '\n' : draft; // a multi-line draft is never a command line
  for (const e of events) {
    if (e.type === 'text') line += e.text;
    else if (e.name === 'enter') { if (!line.startsWith('/')) return false; line = ''; }
    else return false; // newline (Ctrl+J), tab or any other key: not plain typed commands
  }
  return line === '' || line.startsWith('/');
}
function coalesceBurst(events, draft = '') {
  const hasInner = events.some((e, i) =>
    isEnter(e) && i > 0 && i < events.length - 1 &&
    events.slice(i + 1).some(x => x.type === 'text'));
  if (!hasInner) return events;
  if (commandLines(events, draft)) return events;
  let text = '';
  const rest = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'text') text += e.text;
    else if (e.type === 'key' && (e.name === 'enter' || e.name === 'newline')) {
      // a trailing Enter after the burst is a submit, not part of the paste
      if (i === events.length - 1) rest.push(e); else text += '\n';
    } else if (e.type === 'key' && e.name === 'tab') text += '\t';
    else rest.push(e);
  }
  return [{ type: 'paste', text }, ...rest];
}
