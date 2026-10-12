/**
 * LUCID presentation helpers shared by `quox lucid --sitrep` and the deck TUI.
 * Pure functions, no I/O. Colour is a parameter, never read from globals, so
 * renderers are deterministic under test.
 */

export const GLYPH = { ok: '✔', attention: '⚠', unknown: '?', blind: '✖' };
export const STATE_HEX = { ok: '#22C55E', attention: '#FBBF24', unknown: '#A1A1AA', blind: '#EF4444' };
export const URGENCY = {
  now: { label: 'NOW', hex: '#EF4444' },
  today: { label: 'TODAY', hex: '#FBBF24' },
  'this week': { label: 'THIS WEEK', hex: '#38BDF8' },
  whenever: { label: 'WHENEVER', hex: '#71717A' },
  fyi: { label: 'FYI', hex: '#71717A' },
};
export const PALETTE = {
  brand: '#38BDF8', accent: '#C084FC', text: '#E4E4E7', muted: '#A1A1AA', dim: '#71717A', code: '#7DD3FC',
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s) => String(s).replace(ANSI_RE, '');
export const vlen = (s) => [...stripAnsi(s)].length;

/** Truncate a plain string to max visible chars with an ellipsis. */
export function clip(s, max) {
  const a = [...String(s ?? '')];
  if (a.length <= max) return a.join('');
  return max <= 1 ? a.slice(0, max).join('') : a.slice(0, max - 1).join('') + '…';
}

/** Word-wrap plain text to width; hard-breaks over-long words. Returns lines. */
export function wrap(text, width) {
  width = Math.max(4, width);
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    let cur = '';
    for (let w of para.split(/\s+/).filter(Boolean)) {
      while ([...w].length > width) {
        if (cur) { out.push(cur); cur = ''; }
        out.push([...w].slice(0, width).join(''));
        w = [...w].slice(width).join('');
      }
      if (!cur) cur = w;
      else if ([...cur].length + 1 + [...w].length <= width) cur += ' ' + w;
      else { out.push(cur); cur = w; }
    }
    out.push(cur);
  }
  return out.length ? out : [''];
}

export function padEnd(s, width) {
  const n = width - vlen(s);
  return n > 0 ? s + ' '.repeat(n) : s;
}

/** "3m", "2h", "4d" from a ms timestamp (relative to now). */
export function ageOf(ms, now = Date.now()) {
  if (ms == null) return '';
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** ▰▰▰▰▱ meter, `cells` wide, filled proportionally (never rounds a gap to full). */
export function meter(live, expected, cells = 5) {
  if (!expected) return '▱'.repeat(cells);
  let f = Math.round((live / expected) * cells);
  if (live < expected && f >= cells) f = cells - 1;
  if (live > 0 && f === 0) f = 1;
  return '▰'.repeat(f) + '▱'.repeat(cells - f);
}

export function clockLondon(ms = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ms));
  } catch { return new Date(ms).toISOString().slice(11, 16); }
}

/** Plain-words account of a measure for the "do" line. */
export function firstMeasure(item) {
  const ms = (item && item.L2 && item.L2.measures) || [];
  return ms[0] || null;
}

export function whenText(w, now = Date.now()) {
  if (!w) return '';
  const parts = [];
  if (w.clock) parts.push(w.clock);
  else if (w.since) parts.push(`${ageOf(w.since, now)} ago`);
  if (w.waited_ms != null && !w.clock) parts.push(`waiting ${ageOf(now - w.waited_ms, now)}`);
  return parts.join(' · ');
}

/** Label for a changed[] entry in plain words. */
export function changedWords(c) {
  const o = c.outcome ? `${c.outcome}` : (c.to ? `${c.from ? c.from + ' → ' : ''}${c.to}` : '');
  return o;
}

/** Blind spot sentence list from cannot_see, names not counts where we have names. */
export function blindSpots(cs) {
  cs = cs || {};
  const nm = (x) => (typeof x === 'string' ? x : x && (x.feed || x.name || x.id || x.label)) || '';
  const parts = [];
  const silent = (cs.silent || []).map(nm).filter(Boolean);
  const failing = (cs.failing || []).map(nm).filter(Boolean);
  const stale = (cs.stale || []).map(nm).filter(Boolean);
  const unwired = (cs.unwired || []).map(nm).filter(Boolean);
  if (failing.length) parts.push({ k: 'failing', text: `failing: ${failing.join(', ')}` });
  if (silent.length) parts.push({ k: 'silent', text: `silent: ${silent.join(', ')}` });
  if (stale.length) parts.push({ k: 'stale', text: `stale: ${stale.join(', ')}` });
  if (unwired.length) parts.push({ k: 'unwired', text: `not wired up: ${unwired.join(', ')}` });
  return parts;
}

/** HH:MM:SS London clock for the living deck header. */
export function clockLondonSec(ms = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(ms));
  } catch { return new Date(ms).toISOString().slice(11, 19); }
}

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Whether the startup intro should play. Pure so it is testable. */
export function shouldIntro({ noIntro = false, env = process.env, isTTY = true } = {}) {
  if (noIntro || !isTTY) return false;
  if (env.NO_COLOR || env.QUOX_TUI_LITE) return false;
  return true;
}
