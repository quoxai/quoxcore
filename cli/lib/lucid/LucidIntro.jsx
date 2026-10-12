/**
 * LucidIntro: the ~1.2s startup for `quox lucid deck`.
 *
 * Frames (50ms): the QUOX block wordmark is revealed by a gradient sweep, the
 * ◉ LUCID mark fades in under it, then "tuning in…" resolves into
 * "◉ LUCID │ N sources live · M need you" once the first fetch has landed.
 * The fetch is owned by the deck and runs in parallel, never gated on this.
 * onDone fires once: at the natural end, on a hard 2.5s cap, or on a key
 * (the deck calls skip via the `skipSignal` prop).
 */
import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import { BLOCK_FONT, gradientColor } from '../tui/intro/Intro.jsx';
import { PALETTE, STATE_HEX } from './fmt.js';

export const FRAME_MS = 50;
const SWEEP_FRAMES = 12;
const MIN_FRAMES = 24;   // 1.2s
const MAX_FRAMES = 50;   // 2.5s cap if the fetch never lands

const LETTERS = ['Q', 'U', 'O', 'X'];
const rgb = (c, s) => chalk.rgb(c[0], c[1], c[2])(s);

function titleRow(row, frame, colsRevealed) {
  let out = ''; let col = 0;
  const total = LETTERS.reduce((n, ch) => n + BLOCK_FONT[ch][0].length + 1, 0);
  for (const ch of LETTERS) {
    const g = BLOCK_FONT[ch][row];
    for (let i = 0; i < g.length; i++) {
      const x = col + i;
      const lit = g[i] !== ' ';
      if (x > colsRevealed) { out += '  '; continue; }
      if (!lit) { out += '  '; continue; }
      const edge = colsRevealed - x < 2 && colsRevealed < total;
      out += edge ? chalk.white('██') : rgb(gradientColor(x / total + frame * 0.02), '██');
    }
    out += '  ';
    col += g.length + 1;
  }
  return out;
}

export function LucidIntro({ data, err, onDone, rows = 24 }) {
  const [frame, setFrame] = useState(0);
  const doneRef = useRef(false);
  const readyAt = useRef(null);
  const sit = data && data.situation;

  if (sit && readyAt.current == null) readyAt.current = frame;

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), FRAME_MS);
    return () => clearInterval(id);
  }, []);

  const finishAt = readyAt.current != null
    ? Math.max(MIN_FRAMES, readyAt.current + 6)
    : (err ? Math.max(MIN_FRAMES, 16) : MAX_FRAMES);

  useEffect(() => {
    if (frame >= finishAt && !doneRef.current) { doneRef.current = true; onDone(); }
  }, [frame, finishAt, onDone]);

  const tall = rows >= 16;
  const total = LETTERS.reduce((n, ch) => n + BLOCK_FONT[ch][0].length + 1, 0);
  const revealed = Math.round((Math.min(frame, SWEEP_FRAMES) / SWEEP_FRAMES) * (total + 2)) - 1;
  const markOn = frame >= 6;
  const resolved = sit && frame >= 14 && frame >= (readyAt.current ?? 0) + 2;
  const cov = (sit && sit.cannot_see && sit.cannot_see.coverage) || { live: 0, expected: 0 };
  const dots = '.'.repeat((frame % 3) + 1).padEnd(3, ' ');

  const mark = [...'◉ LUCID'].map((ch, i) => (
    <Text key={i} bold color={'#' + gradientColor((i / 7) + frame * 0.03).map((v) => v.toString(16).padStart(2, '0')).join('')}>{ch}</Text>
  ));

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} paddingY={1}>
      {tall ? (
        <Box flexDirection="column" alignItems="center">
          {Array.from({ length: 5 }, (_, r) => <Text key={r}>{titleRow(r, frame, revealed)}</Text>)}
        </Box>
      ) : (
        <Text bold color={PALETTE.brand}>Q U O X</Text>
      )}
      <Box marginTop={1}>{markOn ? mark : <Text> </Text>}</Box>
      <Box marginTop={1}>
        {frame < 10 ? <Text> </Text> : resolved ? (
          <Text>
            <Text bold color={PALETTE.brand}>◉ LUCID</Text>
            <Text color={PALETTE.dim}> │ </Text>
            <Text color={STATE_HEX.ok}>{cov.live} sources live</Text>
            <Text color={PALETTE.dim}> · </Text>
            <Text bold color={(sit.needs_you || []).length ? STATE_HEX.attention : STATE_HEX.ok}>{(sit.needs_you || []).length} need you</Text>
          </Text>
        ) : err && !sit ? (
          <Text color={STATE_HEX.blind}>LUCID unreachable, still trying</Text>
        ) : (
          <Text color={PALETTE.muted}>tuning in{dots}</Text>
        )}
      </Box>
      <Box marginTop={1}><Text color={PALETTE.dim}>any key to skip</Text></Box>
    </Box>
  );
}
