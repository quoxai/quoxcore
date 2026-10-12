/**
 * Animated intro header for QuoxCLI TUI
 *
 * Renders a swirling animated orb with dot-density characters, "QUOX" in
 * large block font with flowing gradient, and a shimmering subtitle.
 * All on one screen with the main menu below — no "press any key" gate.
 *
 * Inspired by QuoxBastion's Go TUI intro (intro.go) and
 * terminal-text-effects (TTX) orb_dots effect.
 *
 * Animation sequence (~2s):
 *   0.0s  Orb fades in with expanding energy ring
 *   0.4s  Block title appears with flowing gradient
 *   0.7s  Subtitle shimmers in
 *   2.0s  Animation completes and FREEZES on the final frame — no
 *         perpetual "breathing" interval runs after the burst, so the
 *         intro costs zero background CPU once it's settled.
 *
 * Lite mode (QUOX_TUI_LITE env var, or non-TTY stdout): skips the
 * animated burst entirely and renders a single static brand-coherent
 * banner with no setInterval at all — for constrained VMs / piped output.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import chalk from 'chalk';
import { colors } from '../theme.js';

// ── Brand palette (Quox blue → indigo → violet → lilac) ──────────────
const PALETTE = [
  [30, 58, 138],    // #1E3A8A deep blue
  [59, 130, 246],   // #3B82F6 electric blue
  [99, 102, 241],   // #6366F1 indigo
  [139, 92, 246],   // #8B5CF6 violet
  [168, 85, 247],   // #A855F7 purple
  [192, 132, 252],  // #C084FC lilac
  [196, 181, 253],  // #C4B5FD soft lavender
  [139, 92, 246],   // #8B5CF6 violet (loop)
];

// Dot density characters — refined look vs Bastion's block chars (░▒▓█)
const DOT_CHARS = ' \u00b7\u2219\u2022\u25cf\u25c9\u2b24';

// Block font glyphs for "QUOX" — 5 rows each, rendered double-width (██)
export const BLOCK_FONT = {
  'Q': ['\u2588\u2588\u2588\u2588\u2588', '\u2588   \u2588', '\u2588   \u2588', '\u2588  \u2588\u2588', ' \u2588\u2588\u2588\u2588'],
  'U': ['\u2588   \u2588', '\u2588   \u2588', '\u2588   \u2588', '\u2588   \u2588', '\u2588\u2588\u2588\u2588\u2588'],
  'O': ['\u2588\u2588\u2588\u2588\u2588', '\u2588   \u2588', '\u2588   \u2588', '\u2588   \u2588', '\u2588\u2588\u2588\u2588\u2588'],
  'X': ['\u2588   \u2588', ' \u2588 \u2588 ', '  \u2588  ', ' \u2588 \u2588 ', '\u2588   \u2588'],
};

// ── Animation timing ──────────────────────────────────────────────────
const ORB_W = 26;
const ORB_H = 8;
const FAST_FRAMES = 60;     // ~2s at ~20fps
const FAST_MS = 50;         // 20fps during intro burst
const SLOW_MS = 250;        // 4fps gentle breathing after

// ── Math helpers ──────────────────────────────────────────────────────

function noise(x, y, t) {
  const n1 = Math.sin(x * 2.1 + t * 0.7) * Math.cos(y * 1.9 - t * 0.5);
  const n2 = Math.sin(x * 0.9 - y * 1.3 + t * 0.8) * 0.5;
  const n3 = Math.cos(x * 1.5 + y * 2.1 + t * 0.3) * 0.3;
  return (n1 + n2 + n3) / 1.8;
}

function lerpColor(c1, c2, frac) {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * frac),
    Math.round(c1[1] + (c2[1] - c1[1]) * frac),
    Math.round(c1[2] + (c2[2] - c1[2]) * frac),
  ];
}

export function gradientColor(t) {
  t = t - Math.floor(t); // wrap to [0, 1)
  const pos = t * (PALETTE.length - 1);
  const i = Math.floor(pos);
  const j = Math.min(i + 1, PALETTE.length - 1);
  return lerpColor(PALETTE[i], PALETTE[j], pos - i);
}

// ── Render functions ──────────────────────────────────────────────────

/**
 * Render one row of the animated orb.
 *
 * Uses Gaussian glow, swirling motion, organic noise, pulsing breath,
 * and an optional expanding energy ring for the intro burst.
 */
function renderOrbLine(w, h, y, t, ringR) {
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const R = Math.min(cx, cy) * 0.9;

  // Global fade-in: 0→1 over first ~0.5s
  const fadeIn = Math.min(1.0, t / 0.6);

  let line = '';
  for (let x = 0; x < w; x++) {
    const dx = (x - cx) / R;
    const dy = (y - cy) / R * 1.8; // terminal aspect ratio correction
    const r = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);

    // Gaussian glow — soft falloff from center
    const glow = Math.exp(-Math.pow(r * 1.5, 2));

    // Swirling motion — rotates based on distance and time
    const swirl = Math.sin(r * 4 - t * 2 + angle * 2) * 0.3;

    // Gentle pulse (breathing)
    const pulse = Math.sin(t * 3) * 0.15 + 1.0;

    // Organic noise for natural feel
    const n = noise(dx * 3, dy * 3, t) * 0.2;

    let intensity = glow * (1.0 + swirl + n) * pulse * fadeIn;

    // Expanding energy ring (sweeps outward during intro burst)
    if (ringR > 0) {
      const distToRing = Math.abs(r - ringR);
      const ringWidth = 0.3;
      if (distToRing < ringWidth) {
        const ringIntensity = (1.0 - distToRing / ringWidth) * 0.8 * fadeIn;
        intensity = Math.max(intensity, ringIntensity);
      }
    }

    intensity = Math.max(0, Math.min(1, intensity));

    const charIdx = Math.floor(intensity * (DOT_CHARS.length - 1));
    const ch = DOT_CHARS[charIdx];

    if (ch === ' ' || intensity < 0.02) {
      line += ' ';
    } else {
      // Color from brand gradient, position shifts with radius + time
      const colorT = (r * 0.5 + t * 0.1) % 1.0;
      const c = gradientColor(colorT);
      // Fade RGB channels by intensity for natural glow falloff
      line += chalk.rgb(
        Math.max(0, Math.floor(c[0] * intensity)),
        Math.max(0, Math.floor(c[1] * intensity)),
        Math.max(0, Math.floor(c[2] * intensity)),
      )(ch);
    }
  }
  return line;
}

/**
 * Render one row of the "QUOX" block font title.
 *
 * Each filled glyph pixel becomes a double-width block (██) with
 * a flowing gradient that sweeps left-to-right over time.
 */
function renderTitleRow(row, t) {
  const text = 'QUOX';
  let result = '';
  let col = 0;
  let totalWidth = 0;

  // Calculate total glyph width for gradient positioning
  for (const ch of text) {
    const glyph = BLOCK_FONT[ch];
    if (glyph) totalWidth += glyph[0].length + 1;
  }

  for (const ch of text) {
    const glyph = BLOCK_FONT[ch];
    if (!glyph) continue;
    const glyphRow = glyph[row];
    for (let i = 0; i < glyphRow.length; i++) {
      const pos = (col + i) / totalWidth;
      const colorT = (pos + t * 0.3) % 1.0;
      const c = gradientColor(colorT);
      if (glyphRow[i] === ' ') {
        result += '  '; // double-width space
      } else {
        result += chalk.rgb(c[0], c[1], c[2])('\u2588\u2588'); // double-width block
      }
    }
    result += '  '; // gap between letters
    col += glyphRow.length + 1;
  }
  return result;
}

/**
 * Render subtitle with per-character shimmer gradient.
 */
function renderSubtitle(t) {
  const text = 'C O M M A N D   L I N E   I N T E R F A C E';
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const pos = i / text.length + t * 0.2;
    const c = gradientColor(pos);
    result += chalk.rgb(c[0], c[1], c[2])(text[i]);
  }
  return result;
}

// ── Module-level replay prevention ────────────────────────────────────
let _hasPlayed = false;

/** Reset intro animation state (for tests). */
export function _resetIntroState() {
  _hasPlayed = false;
}

// ── Component ─────────────────────────────────────────────────────────

/**
 * IntroHeader — animated header with orb, block title, and subtitle.
 *
 * On first mount, plays a 2-second animation burst (20fps), then FREEZES
 * on the final frame — the interval is cleared entirely, so there is no
 * perpetual "breathing" re-render eating CPU in the background. Return
 * visits (e.g. navigating back to the menu) render that same frozen
 * frame statically, with no timer scheduled at all.
 *
 * Lite mode (QUOX_TUI_LITE env var truthy, or non-TTY stdout) skips the
 * animated burst entirely and renders a static single-frame banner with
 * no setInterval whatsoever — for constrained VMs / piped output.
 *
 * Responsive:
 *   - Terminal >= 30 rows: full orb + block title
 *   - Terminal >= 22 rows: block title only (no orb)
 *   - Terminal < 22 rows:  simple text title
 */
export function IntroHeader() {
  const { stdout } = useStdout();
  const termRows = stdout?.rows || 24;

  // Lite mode: no animation, no timers — a single static render.
  const liteMode = Boolean(process.env.QUOX_TUI_LITE) || stdout?.isTTY === false;

  const skip = _hasPlayed;
  const [frame, setFrame] = useState((skip || liteMode) ? FAST_FRAMES + 10 : 0);

  useEffect(() => {
    if (liteMode) {
      // Static banner — never schedules a timer.
      _hasPlayed = true;
      return undefined;
    }

    if (skip) {
      // Already played this process — render the frozen final frame
      // statically, no timer scheduled (no perpetual breathing).
      return undefined;
    }

    // First visit: play the burst once, then freeze permanently.
    _hasPlayed = true;
    let f = 0;
    const id = setInterval(() => {
      f++;
      setFrame(f);
      if (f >= FAST_FRAMES) {
        // Burst complete — clear the interval entirely. No slow-breathing
        // phase follows; the final frame simply stays on screen.
        clearInterval(id);
      }
    }, FAST_MS);

    return () => clearInterval(id);
  }, [liteMode]);

  const t = frame * 0.08;

  // Responsive thresholds
  const showOrb = termRows >= 30;
  const showBlockTitle = termRows >= 22;

  // Stagger timing (instant on replay / lite mode)
  const titleReady = frame >= 8 || skip || liteMode;
  const subtitleReady = frame >= 14 || skip || liteMode;

  // Expanding energy ring (first 1.5s of the intro burst only)
  const ringR = (!skip && !liteMode && frame < 30) ? (frame / 30) * 2.0 : -1;

  // ── Build the divider ───────────────────────────────────────────────────────
  const divider = chalk.hex('#334155')('\u2500'.repeat(46));

  // ── Lite mode: static, brand-coherent, single-frame banner ─────
  if (liteMode) {
    return (
      <Box flexDirection="column" alignItems="center">
        <Text color={colors.primary} bold>QUOX</Text>
        <Text color={colors.dim}>COMMAND LINE INTERFACE</Text>
        <Text>{divider}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" alignItems="center">
      {/* ── Animated orb ───────────────────────────────────────── */}
      {showOrb && Array.from({ length: ORB_H }, (_, y) => (
        <Text key={`o${y}`}>{renderOrbLine(ORB_W, ORB_H, y, t, ringR)}</Text>
      ))}

      {/* ── Block title "QUOX" ─────────────────────────────────── */}
      {titleReady && showBlockTitle && (
        <Box flexDirection="column" alignItems="center">
          {Array.from({ length: 5 }, (_, row) => (
            <Text key={`t${row}`}>{renderTitleRow(row, t)}</Text>
          ))}
        </Box>
      )}

      {/* ── Simple title fallback (small terminals) ────────────── */}
      {titleReady && !showBlockTitle && (
        <Box>
          <Text color="#3B82F6" bold>QUOX</Text>
          <Text color="#71717A"> Command Line Interface</Text>
        </Box>
      )}

      {/* ── Subtitle + divider ─────────────────────────────────── */}
      {subtitleReady && (
        <Box flexDirection="column" alignItems="center">
          <Text>{renderSubtitle(t)}</Text>
          <Text>{divider}</Text>
        </Box>
      )}
    </Box>
  );
}
