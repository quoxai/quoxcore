/**
 * Perpetual status indicator model (CLI-QUOX): a one-cell Q whose COLOUR carries state.
 *   resting  dim sky, slow breathing        working  sky <-> violet shimmer (katakana rain beside it)
 *   waiting  amber pulse (needs approval)   failing  red, static
 * The glyph is Ⓠ (U+24C0, the documented Quox stand-in): compared in xterm.js against `◖Q`, `Q` and `◖Q◗`
 * it was the only one that reads as a Q at a glance in every colour; the bare Q is lost beside text and
 * the half-circle forms look like a bullet. Pure functions, tick t advances every 120 ms.
 */
export const Q_GLYPH = 'Ⓠ';
export const STATES = ['resting', 'working', 'waiting', 'failing'];
const SKY = [56, 189, 248], VIOLET = [168, 85, 247], AMBER = [245, 158, 11], RED = [239, 68, 68];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const tri = (t, period) => { const k = (t % period) / period; return k < 0.5 ? k * 2 : 2 - k * 2; };

/** working / waiting / failing from what the app knows; Working is only mounted while a turn runs. */
export function indicatorState(activity, failing = false) {
  if (failing) return 'failing';
  if (/^waiting for approval/i.test(String(activity || ''))) return 'waiting';
  return 'working';
}

/** rgb for the Q at tick t. quiet (reduced motion) freezes the animation at a representative colour. */
export function qColor(state, t = 0, quiet = false) {
  switch (state) {
    case 'resting': return mix([40, 70, 90], SKY, quiet ? 0.5 : 0.25 + 0.5 * tri(t, 20));
    case 'waiting': return mix([120, 76, 6], AMBER, quiet ? 1 : 0.3 + 0.7 * tri(t, 10));
    case 'failing': return RED;
    default: return mix(SKY, VIOLET, quiet ? 0.5 : tri(t, 16));
  }
}

/** The word shown for a state when the activity text is not the whole story. */
export function stateWord(state, activity) {
  if (state === 'failing') return 'Failed';
  if (state === 'resting') return 'Ready';
  const a = String(activity || '').replace(/[.…\s]+$/u, '');
  return !a || a === 'Working' ? 'Thinking' : a;
}

/** 842 -> "842", 1234 -> "1.2k", 12400 -> "12k". */
export function fmtTokens(n) {
  n = Math.max(0, Math.round(Number(n) || 0));
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k < 10 ? `${k.toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(k)}k`;
}

/** USD for the closing line: undefined (omit) when absent, zero or not a number; never invented. */
export function fmtCost(usd) {
  const v = Number(usd);
  if (!Number.isFinite(v) || v <= 0) return null;
  return `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
}

/**
 * Normalise a server usage object. Real numbers only: { tokens, cost } with null for anything missing.
 * tokens = output tokens (what streamed back); falls back to input+output only when no split is given.
 */
export function normUsage(u, doneCost) {
  const o = (u && typeof u === 'object') ? u : {};
  const out = o.output_tokens ?? o.completion_tokens;
  const inp = o.input_tokens ?? o.prompt_tokens;
  const total = o.total_tokens;
  const tokens = Number.isFinite(Number(out)) && out != null ? Number(out)
    : Number.isFinite(Number(total)) && total != null ? Number(total)
    : Number.isFinite(Number(inp)) && inp != null ? Number(inp) : null;
  // cost_source 'claude-cli': the claude CLI's own API-equivalent estimate on the subscription path, not a price.
  const costSource = typeof o.cost_source === 'string' ? o.cost_source : null;
  const cost = Number(o.cost_usd ?? doneCost);
  return { tokens, cost: !costSource && Number.isFinite(cost) && cost > 0 ? cost : null, real: tokens != null, costSource };
}

/** Live token figure: the real number once the server reported it, else an estimate from received text (~chars/4). */
export function turnTokens(turn) {
  if (!turn) return 0;
  if (turn.usage?.real) return turn.usage.tokens;
  return Math.ceil((turn.chars || 0) / 4);
}

/**
 * Glyphs that stand in for letters while the word "decrypts" (owner 2026-10-12: far more variety). Half-width
 * katakana only: one cell each, the width of a Latin letter, so the word never jitters. 42 of them: the whole
 * U+FF66..U+FF9D block minus forms that read as a Latin letter, digit, bracket or bare box/stroke in DejaVu
 * Sans Mono fallback (ｪｴ like I/E, ｭｮﾕﾖ boxes, ﾆ "=", ﾉ "/", ﾌ "7", ﾍ "^", ﾘ "U", ﾚ "L", ﾛ a box, ｰ a dash)
 * and the voiced marks ﾞ ﾟ.
 */
/** Decode glyphs: every half-width katakana (U+FF66-FF9D, one cell each, minus the long-vowel bar ｰ) plus the
 * code-rain digits. Owner 2026-10-15: the reveal felt like "just a few characters" with 44 look-alike kana. */
export const SCRAMBLE_GLYPHS = 'ｦｧｨｩｪｫｬｭｮｯｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789';

/** Deterministic hash in [0,1). */
const hsh = (a, b, c = 0) => { let x = (a * 374761393 + b * 668265263 + c * 2147483647) | 0; x = Math.imul(x ^ (x >>> 13), 1274126177); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };

/** Per-cell flicker period (ms), 60..180, so cells never pulse in lockstep. */
export const cellPeriod = (i, seed = 0) => 60 + Math.floor(hsh(i, 911, seed) * 121);
export const SCRAMBLE_CHANCE = 0.5; // x mean cascade 3/5 of an episode -> ~30% of letters scrambled at any time
const EPISODE = 5;                  // an episode is 5 flicker periods: a cascade of 2..4 glyphs, then the letter
const FLASH_MS = 90;                 // one frame of bright flash when a cell resolves

/**
 * Glyph for cell i in flicker bucket k. Even and odd buckets draw from disjoint halves of the set, so a cell
 * never shows the same glyph twice in a row.
 */
export function cellGlyph(i, k, seed = 0) {
  const half = Math.floor(SCRAMBLE_GLYPHS.length / 2);
  const odd = ((k % 2) + 2) % 2;
  return SCRAMBLE_GLYPHS[odd * half + Math.floor(hsh(i, k, seed) * half)];
}

/**
 * The activity word at time `now` (ms): "Matrix rain through the word". Pure. Returns [{ ch, glyph, flash }].
 *   decode-in: a word that just changed (at `since`) resolves left to right over DECODE_MS (unresolved = glyph)
 *   steady:    each letter runs its own clock (cellPeriod); per episode of 4 periods it is either plain or
 *              cascades through 2..4 different glyphs and resolves with one bright flash frame
 * Spaces are never scrambled; every cell is one column, so the width never changes.
 */
export function wordFrame(word, now, { since = -Infinity, seed = 0 } = {}) {
  const chars = [...String(word)];
  const letters = chars.filter(ch => ch.trim()).length;
  let li = -1;
  return chars.map((ch, i) => {
    if (!ch.trim()) return { ch, glyph: false, flash: false };
    li++;
    const P = cellPeriod(i, seed), phase = Math.floor(hsh(i, 313, seed) * P * EPISODE);
    const tt = now + phase, k = Math.floor(tt / P);
    const decodeAt = since + ((li + 1) / letters) * DECODE_MS;
    if (now < decodeAt) return { ch: cellGlyph(i, k, seed), glyph: true, flash: false };
    if (now - decodeAt < FLASH_MS) return { ch, glyph: false, flash: true }; // resolve flash on decode-in too
    if (now < since + DECODE_MS + 200) return { ch, glyph: false, flash: false }; // a fresh word reads cleanly first
    const E = Math.floor(k / EPISODE), pos = k - E * EPISODE;
    const cascade = (e) => (hsh(i, e, seed + 17) < SCRAMBLE_CHANCE ? 2 + Math.floor(hsh(i, e, seed + 29) * 3) : 0);
    const m = cascade(E);
    if (pos < m) return { ch: cellGlyph(i, k, seed), glyph: true, flash: false };
    const resolvedAt = (E * EPISODE + m) * P;
    if (m > 0 && pos === m && tt - resolvedAt < Math.min(P, FLASH_MS)) return { ch, glyph: false, flash: true };
    return { ch, glyph: false, flash: false };
  });
}

/** Gradient stops per state for the coloured word (same families as the composer ring). */
export const WORD_PALETTES = {
  working: [SKY, VIOLET, [6, 182, 212]],
  writing: [[34, 197, 94], [74, 222, 128], [20, 184, 166]],
  waiting: [AMBER, [234, 88, 12], [251, 191, 36]],
  failing: [RED, RED, RED],
};
/**
 * Colour of a word cell: one gradient sweeping across the word over time (~1.6 s per pass). Resolved letters
 * are slightly brighter than glyphs; a flash is near white. quiet (reduced motion) freezes the sweep.
 */
export function wordColor(state, i, n, now, kind = 'letter', quiet = false) {
  const pal = WORD_PALETTES[state] || WORD_PALETTES.working;
  const u = ((((n > 1 ? i / (n - 1) : 0) * 0.65 - (quiet ? 0 : now / 1600)) % 1) + 1) % 1;
  const x = u * pal.length, a = Math.floor(x) % pal.length, b = (a + 1) % pal.length;
  const base = mix(pal[a], pal[b], x - Math.floor(x));
  if (kind === 'flash') return mix(base, [255, 255, 255], 0.7);
  if (kind === 'glyph') return mix(base, [30, 36, 48], 0.28);
  return mix(base, [255, 255, 255], 0.12);
}

/**
 * Previous model (kept for the drop-in reveal and existing callers): one frame with a random 30-45% of the
 * letter positions scrambled. Returns [{ ch, glyph }]. rand is injectable for tests.
 */
export function scrambleFrame(word, rand = Math.random) {
  const chars = [...String(word)];
  const idx = chars.map((c, i) => (c.trim() ? i : -1)).filter((i) => i >= 0);
  const chosen = new Set();
  if (idx.length > 1) {
    const k = Math.min(idx.length - 1, Math.max(1, Math.round(idx.length * (0.3 + 0.15 * rand()))));
    const pool = [...idx];
    while (chosen.size < k) chosen.add(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  return chars.map((ch, i) => (chosen.has(i) ? { ch: SCRAMBLE_GLYPHS[Math.floor(rand() * SCRAMBLE_GLYPHS.length)], glyph: true } : { ch, glyph: false }));
}
/** Shimmer colour for the glyph at position i, tick t (sky to violet). */
export const glyphColor = (i, t) => mix(SKY, VIOLET, tri(t + i * 2, 16));

export const DECODE_MS = 300;
/**
 * A word that just changed decodes in: letters resolve left to right over DECODE_MS. Unresolved positions
 * are always glyphs; resolved ones follow the normal 30-45% scramble. progress 0..1 (>=1 = steady state).
 */
export function decodeFrame(word, progress, rand = Math.random) {
  const base = scrambleFrame(word, rand);
  if (progress >= 1) return base;
  const n = base.filter((g) => g.ch.trim()).length;
  let seen = 0;
  const revealed = Math.floor(clamp01(progress) * n);
  return base.map((g) => {
    if (!g.ch.trim()) return g;
    const i = seen++;
    if (i < revealed) return g;
    return g.glyph ? g : { ch: SCRAMBLE_GLYPHS[Math.floor(rand() * SCRAMBLE_GLYPHS.length)], glyph: true };
  });
}
const clamp01 = (x) => Math.max(0, Math.min(1, x));
