/**
 * The bare-`quox` splash (DEVSUITE-GLYPH follow-on): the horned Q in
 * truecolor half-blocks with the brand gradient, plus a one-glance verb map.
 * Bitmap generated from QuoxSymbols quoxQ (fontforge export at 26px); the
 * gradient stops mirror @quox/glyph. Colour gating matches the renderer:
 * QUOX_COLOR=0 off / 1|2 force on, else tty && !NO_COLOR.
 */
import { GRAD } from './quoxglyph.js';

const Q_BITMAP = [
  '          #   ',
  '  #       #   ',
  ' ##       #   ',
  ' ##       ##  ',
  '  #########   ',
  ' ###########  ',
  ' ###     ###  ',
  '###       ### ',
  '###       ### ',
  '###       ### ',
  '###       ### ',
  '###       ### ',
  '###   ### ### ',
  '###   ######  ',
  ' ###   #####  ',
  ' ############ ',
  '   ###########',
  '          ### ',
];

export function colorOn() {
  const env = process.env.QUOX_COLOR;
  if (env === '0') return false;
  if (env === '1' || env === '2') return true;
  return Boolean(process.stdout && process.stdout.isTTY) && !process.env.NO_COLOR;
}

const R = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

function gradFg(t) {
  const [a, b] = GRAD;
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * t));
  return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
}
function gradBg(t) {
  const [a, b] = GRAD;
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * t));
  return `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`;
}

/** Render the Q as half-block rows (2 bitmap rows per terminal row). */
export function qArt(col) {
  const cols = Q_BITMAP[0].length;
  const out = [];
  for (let y = 0; y < Q_BITMAP.length; y += 2) {
    const top = Q_BITMAP[y];
    const bot = Q_BITMAP[y + 1] || ' '.repeat(cols);
    let line = '';
    for (let x = 0; x < cols; x++) {
      const t = x / (cols - 1);
      const hasTop = top[x] === '#';
      const hasBot = bot[x] === '#';
      if (!col) {
        line += hasTop && hasBot ? '█' : hasTop ? '▀' : hasBot ? '▄' : ' ';
      } else if (hasTop && hasBot) {
        line += `${gradFg(t)}${gradBg(t)}▀${R}`;
      } else if (hasTop) {
        line += `${gradFg(t)}▀${R}`;
      } else if (hasBot) {
        line += `${gradFg(t)}▄${R}`;
      } else {
        line += ' ';
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * One frame of the intro sweep: the Q is revealed left to right with a bright
 * leading edge; progress >= 1 returns exactly qArt(col). Always the same
 * number of rows and columns, so the live region never changes height.
 */
export function qArtFrame(progress, col) {
  if (progress >= 1 || !col) return qArt(col);
  const cols = Q_BITMAP[0].length;
  const head = progress * (cols + 3) - 1.5;
  const px = (x, on) => (on && x <= head ? 1 : 0);
  const glow = (x, t) => {
    const d = head - x; // 0 at the leading edge, grows behind it
    const k = d < 3 ? 1 - d / 3 : 0;
    const [a, b] = GRAD;
    const base = a.map((v, j) => v + (b[j] - v) * t);
    const c = base.map(v => Math.round(v + (255 - v) * 0.7 * k));
    return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
  };
  const out = [];
  for (let y = 0; y < Q_BITMAP.length; y += 2) {
    const top = Q_BITMAP[y];
    const bot = Q_BITMAP[y + 1] || ' '.repeat(cols);
    let line = '';
    for (let x = 0; x < cols; x++) {
      const t = x / (cols - 1);
      const hasTop = px(x, top[x] === '#');
      const hasBot = px(x, bot[x] === '#');
      if (!hasTop && !hasBot) line += ' ';
      else if (hasTop && hasBot) line += `${glow(x, t)}${gradBg(t)}▀${R}`;
      else line += `${glow(x, t)}${hasTop ? '▀' : '▄'}${R}`;
    }
    out.push(line);
  }
  return out;
}

export function printBanner(version, { loggedIn = true } = {}) {
  const col = colorOn();
  const art = qArt(col);
  const b = (s) => (col ? `${BOLD}${s}${R}` : s);
  const d = (s) => (col ? `${DIM}${s}${R}` : s);
  const text = [
    '',
    `${b('Quox')} ${d('— the governed agent platform')}${version ? d(`  v${version}`) : ''}`,
    d('every action witnessed · every agent governed'),
    '',
    // quox#624: a logged-out first run starts at login, not at the auth wall.
    ...(loggedIn ? [] : [`🔑 ${b('quox login')}           ${d('start here: sign in to your instance')}`]),
    `🧭 ${b('quox plan focus')}      ${d('what matters now')}`,
    `🛰️ ${b('quox fleet status')}    ${d('the estate at a glance')}`,
    `📡 ${b('quox workflow list')}   ${d('governed automations')}`,
    `⛓ ${b('quox volt verify')}     ${d('the evidence chain')}`,
    '',
    d('quox --help for everything'),
  ];
  const lines = [];
  const rows = Math.max(art.length, text.length);
  for (let i = 0; i < rows; i++) {
    lines.push(`  ${art[i] || ' '.repeat(Q_BITMAP[0].length)}   ${text[i] || ''}`);
  }
  process.stdout.write('\n' + lines.join('\n') + '\n\n');
}
