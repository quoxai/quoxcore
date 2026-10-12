/**
 * `quox lucid --sitrep`: a one-shot, width-aware ANSI snapshot of the LUCID
 * situation, built to read well in a terminal and when pasted into a chat.
 * Pure: renderSitrep(situation, opts) -> string. Colour is explicit (opts.color).
 */
import {
  GLYPH, STATE_HEX, URGENCY, PALETTE, wrap, clip, padEnd, vlen, ageOf, meter,
  clockLondon, firstMeasure, whenText, changedWords, blindSpots,
} from './fmt.js';

const R = '\x1b[0m';

export function makePainter(color) {
  const rgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
  };
  const wrapSeq = (seq, s) => (color && s !== '' ? `${seq}${s}${R}` : s);
  return {
    color,
    fg: (hex, s) => wrapSeq(rgb(hex), s),
    bold: (s) => wrapSeq('\x1b[1m', s),
    dim: (s) => wrapSeq(rgb(PALETTE.dim), s),
    muted: (s) => wrapSeq(rgb(PALETTE.muted), s),
    boldFg: (hex, s) => wrapSeq(`\x1b[1m${rgb(hex)}`, s),
    pill: (hex, s) => (color ? `\x1b[48;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m\x1b[38;2;17;24;39m\x1b[1m[${s}]${R}` : `[${s}]`),
  };
}

function tile(area, w, p, now) {
  const inner = w - 4;
  const hex = STATE_HEX[area.state] || STATE_HEX.unknown;
  const glyph = GLYPH[area.state] || GLYPH.unknown;
  const label = clip(area.label || area.area, inner - 3);
  const topPlain = `─ ${glyph} ${label} `;
  const top = p.fg(PALETTE.dim, '╭') + p.fg(PALETTE.dim, '─ ') + p.boldFg(hex, glyph) + ' ' + p.bold(label) + ' '
    + p.fg(PALETTE.dim, '─'.repeat(Math.max(0, w - 2 - [...topPlain].length)) + '╮');
  let body = wrap(area.L0 || 'No signal yet.', inner);
  if (body.length > 3) body = [...body.slice(0, 2), clip(body[2] + ' ' + body.slice(3).join(' '), inner)];
  const rows = body.map((l) => p.fg(area.state === 'ok' ? PALETTE.muted : PALETTE.text, l));
  const last = area.last;
  if (last) {
    const tail = `${last.outcome ? ` (${last.outcome})` : ''} ${ageOf(last.ts, now)} ago`;
    rows.push(p.dim(`last: ${clip(last.L0, Math.max(6, inner - 6 - [...tail].length))}${tail}`));
  } else rows.push(p.dim('nothing yet'));
  const v = p.fg(PALETTE.dim, '│');
  const mid = rows.map((r) => `${v} ${padEnd(r, inner)} ${v}`);
  const bot = p.fg(PALETTE.dim, '╰' + '─'.repeat(w - 2) + '╯');
  return [top, ...mid, bot];
}

function grid(tiles, width, p, now) {
  const gap = 1;
  const tw = Math.floor((width - gap) / 2);
  const out = [];
  for (let i = 0; i < tiles.length; i += 2) {
    const a = tile(tiles[i], tw, p, now);
    const b = tiles[i + 1] ? tile(tiles[i + 1], tw, p, now) : [];
    const h = Math.max(a.length, b.length);
    const fill = (t, idx, wd) => {
      if (t[idx] !== undefined) return t[idx];
      // pad short tile with an empty bordered row before its bottom edge
      return ' '.repeat(wd);
    };
    // equalise heights by inserting blank rows before the bottom border
    const eq = (t) => {
      if (!t.length) return t;
      const bottom = t[t.length - 1];
      const row = `${p.fg(PALETTE.dim, '│')}${' '.repeat(tw - 2)}${p.fg(PALETTE.dim, '│')}`;
      const body = t.slice(0, -1);
      while (body.length < h - 1) body.push(row);
      return [...body, bottom];
    };
    const ea = eq(a), eb = eq(b);
    for (let k = 0; k < h; k++) out.push(`${fill(ea, k, tw)}${' '.repeat(gap)}${eb.length ? fill(eb, k, tw) : ''}`.trimEnd());
  }
  return out;
}

function section(title, width, p, extra = '') {
  const t = ` ${title}${extra ? ' ' + extra : ''} `;
  return p.boldFg(PALETTE.accent, title) + (extra ? ' ' + p.dim(extra) : '') + ' ' + p.fg(PALETTE.dim, '─'.repeat(Math.max(2, width - vlen(t))));
}

export function renderSitrep(data, opts = {}) {
  const width = Math.max(60, Math.min(opts.width || 100, 140));
  const now = opts.now ?? Date.now();
  const p = makePainter(opts.color !== false);
  const sit = (data && data.situation) || data || {};
  const cs = sit.cannot_see || {};
  const cov = cs.coverage || { live: 0, expected: 0 };
  const lines = [];

  const sep = p.dim('│');
  const left = `${p.boldFg(PALETTE.brand, '◉ LUCID')} ${sep} ${p.bold('sitrep')} ${sep} ${clockLondon(now)} ${p.dim('·')} `
    + `${p.fg(cov.live < cov.expected ? STATE_HEX.attention : STATE_HEX.ok, `${cov.live}/${cov.expected}`)} sources`;
  lines.push(left);
  lines.push(p.fg(PALETTE.dim, '━'.repeat(width)));

  lines.push('');
  for (const l of wrap(sit.L0 || 'No briefing available.', width)) lines.push(p.fg(PALETTE.text, l));
  lines.push('');

  const areas = sit.areas || [];
  if (areas.length) {
    lines.push(...grid(areas, width, p, now));
    lines.push('');
  }

  const needs = sit.needs_you || [];
  lines.push(section('NEEDS YOU', width, p, needs.length ? `${needs.length}` : ''));
  if (!needs.length) {
    lines.push(p.fg(STATE_HEX.ok, '  Nothing needs you right now.') + (cs.silent && cs.silent.length ? p.dim('  (but see what I can\'t see)') : ''));
  }
  const iw = width - 5;
  needs.forEach((it, i) => {
    const u = URGENCY[it.urgency] || URGENCY.whenever;
    const num = String(i + 1).padStart(2);
    lines.push('');
    lines.push(`${p.dim(num + '.')} ${p.pill(u.hex, u.label)} ${p.bold(clip(it.L0 || '', width - 8 - u.label.length))}`);
    const a = it.L1 || {};
    const field = (k, v) => {
      if (!v) return;
      const wl = wrap(v, iw - 6);
      wl.forEach((l, j) => lines.push(`     ${j === 0 ? p.dim(k.padEnd(5)) : '     '}${p.fg(PALETTE.muted, l)}`));
    };
    field('Who', a.who); field('What', a.what); field('Why', a.why); field('When', whenText(a.when, now));
    const m = firstMeasure(it);
    if (m) {
      const say = m.say || m.label;
      lines.push(`     ${p.boldFg(PALETTE.brand, '→ do:')} ${p.fg(PALETTE.text, clip(say, iw - 8))}`);
      const cmd = m.command || m.url;
      if (cmd) lines.push(`          ${p.fg(PALETTE.code, clip(cmd, iw - 5))}`);
    }
  });
  lines.push('');

  const changed = sit.changed || [];
  lines.push(section('SINCE YOU LOOKED', width, p, changed.length ? `${changed.length}` : ''));
  if (!changed.length) lines.push(p.dim('  Nothing has changed.'));
  for (const c of changed.slice(0, 8)) {
    const o = changedWords(c);
    const tail = `${o ? o + ' ' : ''}${ageOf(c.ts, now)} ago`;
    lines.push(`  ${p.dim('•')} ${clip(c.L0 || '', width - 6 - tail.length)} ${p.dim(tail)}`);
  }
  if (changed.length > 8) lines.push(p.dim(`  … and ${changed.length - 8} more`));
  lines.push('');

  const da = sit.doesnt_add_up || [];
  if (da.length) {
    lines.push(section("DOESN'T ADD UP", width, p, `${da.length}`));
    for (const x of da.slice(0, 5)) {
      lines.push(`  ${p.dim('•')} ${p.bold(clip(x.L0 || '', width - 6))}${x.urgent ? ' ' + p.pill(URGENCY.today.hex, 'TODAY') : ''}`);
      for (const [k, v] of [['Claimed', x.claimed], ['Observed', x.observed]]) {
        if (!v) continue;
        wrap(v, width - 16).forEach((l, j) => lines.push(`     ${j === 0 ? p.dim(k.padEnd(9)) : ' '.repeat(9)}${p.fg(PALETTE.muted, l)}`));
      }
    }
    if (da.length > 5) lines.push(p.dim(`  … and ${da.length - 5} more (quox lucid blind)`));
    lines.push('');
  }

  lines.push(section("WHAT I CAN'T SEE", width, p, `${meter(cov.live, cov.expected)} ${cov.live}/${cov.expected}`));
  const spots = blindSpots(cs);
  if (!spots.length && cov.live >= cov.expected) lines.push(p.dim('  Every expected source is speaking.'));
  else if (!spots.length) lines.push(p.fg(STATE_HEX.attention, `  ${cov.expected - cov.live} expected source(s) are not reporting.`));
  for (const s of spots) {
    for (const [j, l] of wrap(s.text, width - 4).entries()) {
      lines.push(`  ${p.fg(s.k === 'failing' ? STATE_HEX.blind : STATE_HEX.attention, l)}`);
    }
  }
  return lines.join('\n') + '\n';
}
