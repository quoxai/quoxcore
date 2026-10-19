import { graphemes } from './textBuffer.js';
import { createScreenMirror, MOUSE_ON, MOUSE_OFF, DSR } from './mouse.js';
/**
 * The terminal as Ink sees it.
 *
 * Ink 6.8 has a bookkeeping defect on its "frame was as tall as the screen" path (ink.js onRender): it
 * repaints with clearTerminal + all static output + the frame WITHOUT a trailing newline, then records the
 * frame WITH one (log.sync(outputToRender)). log-update then believes the cursor is one row lower than it
 * is, so its next erase removes one extra row: the last line of whatever <Static> printed last. On
 * 2026-10-12 that silently deleted "status writeup that's supposed to accompany completion." from a LUCID
 * answer at 64x34 (test/quoxon/dropped.test.jsx replays it).
 *
 * Fix: Ink is told the screen has unlimited rows, so it never takes that path (only the fullscreen and
 * repaint checks read stdout.rows). The app reads the real height from termRows() and keeps its live
 * region shorter than the screen itself (app.js), so log-update can always erase it.
 */
export function inkStdout(out, { tap = null } = {}) {
  if (!out || out.__quoxInk) return out;
  // QUOXON-MOUSE: what Ink has drawn, as plain lines, for click hit-testing (mouse.js). Fed the same writes.
  const mirror = out.isTTY ? createScreenMirror({ columns: () => out.columns }) : null;
  // SCREEN-FRAMES: the same feed goes to the screen recorder's tap (screenFrames.js), which only queues it.
  const feed = mirror && tap ? {
    write: (c) => { mirror.write(c); try { tap.write(c); } catch { /* never break a frame */ } },
    reset: () => { mirror.reset(); try { tap.reset(); } catch { /* ignore */ } }
  } : mirror;
  const diff = out.isTTY ? createLineDiff({ columns: () => out.columns, mirror: feed }) : null;
  // One frame = one write: Ink brackets each frame in separate synchronized-update writes (?2026h ... ?2026l);
  // they are held and sent together with the (diffed) frame, and a frame that changed nothing sends nothing.
  // A write that sends nothing (or is held for the frame) must still call its callback: Ink's unmount waits
  // on write('', cb) before waitUntilExit() resolves, and a dropped callback let the event loop drain, so
  // the process exited without running anything after the app (/restart never started the new client).
  let held = null;
  let waiting = [];
  const settle = () => { const cbs = waiting; waiting = []; for (const cb of cbs) cb(); };
  const flush = () => {
    if (held == null) return;
    const body = held; held = null;
    if (body) out.write(SYNC_ON + body + SYNC_OFF, settle); else if (waiting.length) out.write('', settle);
  };
  const write = diff ? (chunk, ...rest) => {
    if (typeof chunk !== 'string') { flush(); diff.reset(); return out.write(chunk, ...rest); }
    const cb = rest.find(a => typeof a === 'function');
    if (chunk === SYNC_ON) { flush(); held = ''; setImmediate(flush); if (cb) waiting.push(cb); return true; }
    if (chunk === SYNC_OFF && held != null) { if (cb) waiting.push(cb); flush(); return true; }
    const d = diff(chunk);
    if (held != null) { held += d; if (cb) waiting.push(cb); return true; }
    if (d) return out.write(d, ...rest);
    if (cb) out.write('', cb); // nothing to send: still a barrier behind the earlier writes
    return true;
  } : null;
  return new Proxy(out, {
    get(target, prop) {
      if (prop === 'write' && write) return write;
      if (prop === 'rows') return Infinity;
      if (prop === 'termRows') return target.rows;
      if (prop === 'frameRows') { const n = diff?.rows(); return n == null ? null : Math.min(n, Math.max(0, (target.rows || n + 1) - 1)); }
      if (prop === '__quoxInk') return true;
      if (prop === 'screen') return mirror;
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
    set(target, prop, value) { return Reflect.set(target, prop, value, target); }
  });
}

/** Real terminal height, or null when unknown (not a TTY, tests). */
export function termRows(stdout) {
  const r = stdout?.__quoxInk ? stdout.termRows : stdout?.rows;
  return Number.isFinite(r) && r > 0 ? r : null;
}

/**
 * Line-diffed live frames (so native text selection survives animation).
 *
 * Ink repaints its live region as ONE write: eraseLines(previous line count) followed by the whole frame. A 12 fps
 * ring or activity word would then rewrite the input line, and the user's selection on it, every frame. This
 * transform recognises exactly that shape; when the new frame has the same height as the last one it moves up
 * and rewrites only the lines that changed, leaving the cursor where Ink expects it (start of the line after the
 * frame). Anything else (static history, clears, a height change, a resize, a write it did not see) passes
 * through untouched and resets the diff, so the next frame is drawn in full. Cursor moves never scroll.
 * (Ink's own incrementalRendering was tried first and duplicates lines on the dropped-text replay.)
 */
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const visibleWidth = (line) => graphemes(String(line).replace(ANSI_RE, '')).length;
const FRAME_RE = /^((?:\x1b\[2K\x1b\[1A)*\x1b\[2K\x1b\[G)([\s\S]*)$/;
const SYNC_ON = '\x1b[?2026h', SYNC_OFF = '\x1b[?2026l';
const TRANSPARENT = new Set(['\x1b[?2026h', '\x1b[?2026l', '\x1b[?25l', '\x1b[?25h', '', MOUSE_ON, MOUSE_OFF, DSR]); // + QUOXON-MOUSE mode switches and the click's cursor query
export function createLineDiff({ columns = () => null, mirror = null } = {}) {
  let prev = null; // lines of the last frame, trailing '' included
  const bodyLines = (body) => (body && body.endsWith('\n') && !body.includes('\x1b[2J') ? body.split('\n') : null);
  const diff = (chunk) => {
    if (TRANSPARENT.has(chunk)) return chunk;
    mirror?.write(chunk); // synchronized-update brackets and cursor hide/show around a frame
    const m = FRAME_RE.exec(chunk);
    // Not an erase+frame: a frame Ink drew after clearing (no erase prefix), static history, or something else.
    // The last such write before the next erase is the frame on screen (Ink writes static output, then the frame).
    if (!m) { prev = bodyLines(chunk); return chunk; }
    const erased = (m[1].match(/\x1b\[2K/g) || []).length;
    const cols = columns();
    if (prev && cols > 0) {
      // R3 D2: after a resize the terminal has reflowed the old frame (a narrower screen wraps each line onto more
      // rows), and Ink's erase counts lines, not rows: ghost composers, or history reprinted to cover them. Count
      // the rows the frame really occupies at this width; when that differs, go to its top and clear down.
      const rows = prev.slice(0, -1).reduce((n, l) => n + Math.max(1, Math.ceil(visibleWidth(l) / cols)), 0);
      if (rows !== erased - 1) {
        prev = bodyLines(m[2]);
        return `\r${rows ? `\x1b[${rows}A` : ''}\x1b[J${m[2]}`;
      }
    }
    if (!m[2].endsWith('\n') || m[2].includes('\x1b[2J')) { prev = null; return chunk; }
    const next = m[2].split('\n');
    if (!prev || erased !== prev.length || next.length !== prev.length || next.length < 2) { prev = next; return chunk; }
    const body = next.length - 1;
    let out = body > 1 ? `\x1b[${body}A` : (body === 1 ? '\x1b[1A' : '');
    let changed = 0;
    for (let i = 0; i < body; i++) {
      if (next[i] !== prev[i]) { out += `\r${next[i]}\x1b[K`; changed++; }
      out += '\x1b[1B';
    }
    out += '\r';
    prev = next;
    return changed ? out : '';
  };
  diff.reset = () => { prev = null; mirror?.reset(); };
  /** Rows the live frame occupies on screen (wrapped at the current width), or null when unknown. SLOT-RUN hand-over. */
  diff.rows = () => {
    if (!prev) return null;
    const cols = columns();
    return prev.slice(0, -1).reduce((n, l) => n + (cols > 0 ? Math.max(1, Math.ceil(visibleWidth(l) / cols)) : 1), 0);
  };
  return diff;
}

/**
 * Ink render options for the interactive client. Standard rendering (Ink's incrementalRendering duplicated lines on
 * the dropped-text replay); the stdout proxy line-diffs same-height frames instead. Never the alternate screen, and
 * no mouse tracking unless the user turns it on (/mouse on, QUOXON-MOUSE): native selection keeps working by default.
 */
export function inkRenderOptions(stdout, { tap = null } = {}) {
  return { exitOnCtrlC: false, stdout: inkStdout(stdout, { tap }) };
}
