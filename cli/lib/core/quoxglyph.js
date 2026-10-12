/**
 * @quox/glyph — the canonical JS implementation of the QuoxGlyph terminal
 * output language (DEVSUITE-GLYPH). Spec: quox-skills
 * quoxify/references/quoxglyph-spec.md. This package IS the spec's constants:
 * ports must consume it (or test against it), never re-type the values.
 *
 * Grammar:  <icon> NAME │ <verb object> │ <result> · <duration> [status]
 * Colour:   truecolor, degrades to plain when !isTTY or NO_COLOR.
 *           Brand gradient #38bdf8 -> #a855f7; rainbow RESERVED for completed.
 */

export const GRAD = [[56, 189, 248], [168, 85, 247]];
export const RAINBOW = [
  [255, 59, 48], [255, 149, 0], [255, 204, 0], [52, 199, 89],
  [0, 199, 190], [10, 132, 255], [94, 92, 230], [191, 90, 242]
];
export const STATUS = {
  ok: { glyph: '✔', rgb: [48, 209, 88] },
  fail: { glyph: '✖', rgb: [255, 69, 58] },
  busy: { glyph: '◐', rgb: [56, 189, 248] },
  warn: { glyph: '⚠', rgb: [255, 214, 10] },
  block: { glyph: '⛔', rgb: null }
};
export const ICONS = {
  repobrain: '🧠 REPOBRAIN', clarify: '🔍 CLARIFY', qlarity: '🔍 QLARITY',
  quoxplan: '🧭 QUOXPLAN', doneengine: '🏁 DONEENGINE', quoxbuild: '🔨 QUOXBUILD',
  quoxsignal: '📡 QUOXSIGNAL', bastion: '🛰️ BASTION', precompact: '🧿 PRECOMPACT',
  brain2: '🌌 QORTEX',
  watchtower: '📨 WATCHTOWER', metron: '⏳ METRON',
  quoxseo: '📈 QUOXSEO', reach: '💥 REACH', vulcan: '🌋 VULCAN',
  quoxvoice: '📞 QUOXVOICE', quoxsecurity: '🛡️ QUOXSECURITY', quoxpert: '🎓 QUOXPERT',
  quoxslots: '📍 QUOXSLOTS',
  quox: 'Ⓠ QUOX'
};
export const BUDGETS = { VERB_MAX: 48, RESULT_MAX: 40, LINE_MAX: 120, TREE_MAX: 6, TABLE_MAX: 6 };
export const PUA_Q = ''; // real horned Q, served by QuoxSymbols font

const R = '\x1b[0m', DIM = '\x1b[2m', BOLD = '\x1b[1m';
const fg = ([r, g, b]) => `\x1b[38;2;${r};${g};${b}m`;

let forced = null;
/** Force colour on/off (null = auto: isTTY && !NO_COLOR). */
export function setColor(v) { forced = v; }
function on() {
  if (forced !== null) return forced;
  const env = process.env.QUOX_COLOR;
  if (env === '0') return false;
  if (env === '1' || env === '2') return true;
  return Boolean(process.stdout && process.stdout.isTTY) && !process.env.NO_COLOR;
}

function iconFor(surface) {
  let name = ICONS[surface] || `Ⓠ ${String(surface).toUpperCase()}`;
  if (process.env.QUOX_BRAND_FONT === '1') name = name.replace('Ⓠ', PUA_Q);
  return name;
}

/** "<icon> NAME" with NAME painted in the brand gradient, bold, so a Quox
 *  line stands out in tool output (owner 2026-10-05). Plain when colour is off. */
export function brandName(label, col = on()) {
  if (!col) return label;
  const i = label.indexOf(' ');
  const icon = i > 0 ? label.slice(0, i) : '';
  const chars = [...(i > 0 ? label.slice(i + 1) : label)];
  const last = Math.max(chars.length - 1, 1);
  const painted = chars.map((c, k) => fg(GRAD[0].map((v, j) => Math.round(v + (GRAD[1][j] - v) * k / last))) + c).join('');
  return `${icon ? icon + ' ' : ''}${BOLD}${painted}${R}`;
}

const trunc = (s, max) => ([...s].length > max ? [...s].slice(0, max - 1).join('') + '…' : s);

/** The grammar event line. opts: {result, ms, status} */
export function line(surface, verb, opts = {}) {
  const col = on();
  const name = brandName(iconFor(surface), col);
  const sep = col ? `${DIM}│${R}` : '│';
  let tail = opts.result ? trunc(opts.result, BUDGETS.RESULT_MAX) : '';
  if (opts.ms !== undefined) {
    const d = col ? `${DIM}${opts.ms}ms${R}` : `${opts.ms}ms`;
    tail = tail ? `${tail} ${col ? DIM + '·' + R : '·'} ${d}` : d;
  }
  const s = opts.status && STATUS[opts.status];
  if (s) tail += ' ' + (col && s.rgb ? `${fg(s.rgb)}${s.glyph}${R}` : s.glyph);
  const v = trunc(verb, BUDGETS.VERB_MAX);
  return tail ? `${name} ${sep} ${v} ${sep} ${tail}` : `${name} ${sep} ${v}`;
}

/** Gradient progress meter: ▰▰▰▱ done/total (or pct when total omitted). */
export function meter(done, total, width = 8) {
  const col = on();
  const pct = total === undefined || total === null;
  const ratio = pct ? Math.min(100, Math.max(0, done)) / 100 : (total > 0 ? done / total : 0);
  const filled = Math.round(ratio * width);
  const last = Math.max(1, width - 1);
  let bar = '';
  for (let i = 0; i < filled; i++) {
    if (col) {
      const t = i / last;
      bar += fg(GRAD[0].map((v, k) => Math.round(v + (GRAD[1][k] - v) * t)));
    }
    bar += '▰';
  }
  if (col && filled) bar += R;
  bar += (col ? DIM : '') + '▱'.repeat(Math.max(0, width - filled)) + (col ? R : '');
  return pct ? `${bar} ${done}%` : `${bar} ${done}/${total}`;
}

/** Rainbow text. RESERVED for the `completed` lifecycle event. */
export function celebrate(text) {
  if (!on()) return text;
  const chars = [...text];
  const last = Math.max(1, chars.length - 1);
  return chars.map((ch, i) => {
    const t = (i / last) * (RAINBOW.length - 1);
    const seg = Math.min(RAINBOW.length - 2, Math.floor(t));
    const local = t - seg;
    return fg(RAINBOW[seg].map((v, k) => Math.round(v + (RAINBOW[seg + 1][k] - v) * local))) + ch;
  }).join('') + R;
}

/** WARD receipt footer. */
export function receipt(hash, ts) {
  const col = on();
  const chain = col ? `${fg([168, 85, 247])}⛓${R}` : '⛓';
  const label = col ? `${DIM}ward:${R}` : 'ward:';
  const t = ts ? (col ? ` ${DIM}· witnessed ${ts}${R}` : ` · witnessed ${ts}`) : '';
  return `${chain} ${label}${String(hash).slice(0, 12)}${t}`;
}

/**
 * Lifecycle events (spec section 4b): the contract every product emits.
 * Each returns a rendered line; the caller prints it.
 */
export const events = {
  created: (surface, thing, id) => line(surface, `${thing} created`, { result: id, status: 'ok' }),
  updated: (surface, thing, id, delta) =>
    line(surface, `${thing} updated`, { result: delta ? `${id} ${delta}` : id, status: 'ok' }),
  progressed: (surface, step, id, done, total) =>
    line(surface, step, { result: `${id} ${meter(done, total)}` }),
  completed: (surface, thing, text) => line(surface, thing, { result: celebrate(text) }),
  assigned: (surface, thing, holder) => line(surface, `${thing} assigned`, { result: holder, status: 'busy' }),
  released: (surface, thing, id) => line(surface, `${thing} released`, { result: id, status: 'ok' }),
  failed: (surface, thing, why) => line(surface, `${thing} failed`, { result: why, status: 'fail' }),
  warned: (surface, thing, risk) => line(surface, thing, { result: risk, status: 'warn' })
};

// ---- quoxcli integration (not part of the @quox/glyph copy above) ----
// VENDORED from quox-plugin-sdk packages/quox-glyph/index.js until the
// owner-gated npm publish lands; the lockstep test in quoxglyph.test.js
// fails if this copy drifts from the package.
import { getOutputFormat } from './output.js';

/** Print a rendered glyph line, respecting --output json/quiet. */
export function printEvent(rendered) {
  const format = getOutputFormat();
  if (format === 'json' || format === 'quiet') return;
  console.log(`  ${rendered}`);
}
