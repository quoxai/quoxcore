/**
 * Sparkline — pure presentational block-ramp trend renderer
 *
 * Maps a numeric series onto the unicode block ramp (▁▂▃▄▅▆▇█), scaled
 * between the min/max of the (optionally windowed) series, and renders it
 * as a single <Text> line. Used for btop-style "line went up/down" trends
 * inside dense TUI views (e.g. HealthView).
 *
 * Props:
 *   data  {number[]} - the series to render (oldest -> newest)
 *   width {number}   - optional max number of points to show; when the
 *                       series is longer than width, only the most recent
 *                       `width` points are rendered (and the ramp is
 *                       scaled to that visible window)
 *   color {string}   - optional hex color (defaults to theme cyberBlue)
 */

import React from 'react';
import { Text } from 'ink';
import { colors } from '../theme.js';

// ── Block ramp (low -> high) ────────────────────────────────────────────
const RAMP = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const MID_CHAR = RAMP[Math.floor(RAMP.length / 2)];

/**
 * Convert a numeric series into a string of ramp characters.
 * Exported for direct unit testing without rendering ink output.
 */
export function sparklineChars(data, width) {
  if (!Array.isArray(data) || data.length === 0) return '';

  const series = width && data.length > width ? data.slice(-width) : data;

  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min;

  if (range === 0) {
    return MID_CHAR.repeat(series.length);
  }

  return series
    .map((v) => {
      const ratio = (v - min) / range;
      const idx = Math.min(RAMP.length - 1, Math.floor(ratio * RAMP.length));
      return RAMP[idx];
    })
    .join('');
}

export function Sparkline({ data, width, color }) {
  const chars = sparklineChars(data, width);
  return <Text color={color || colors.cyberBlue}>{chars}</Text>;
}
