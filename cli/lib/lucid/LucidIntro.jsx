/**
 * LucidIntro: the ~1.6s startup for `quox lucid deck`.
 *
 * Frames (50ms): the Quoxon particle collapse (particles swarm in and lock into the horned Q, tail last),
 * the ◉ LUCID mark fades in under it, then "tuning in…" resolves into
 * "◉ LUCID │ N sources live · M need you" once the first fetch has landed.
 * The fetch is owned by the deck and runs in parallel, never gated on this.
 * onDone fires once: at the natural end, on a hard 2.5s cap, or on a key
 * (the deck calls skip via the `skipSignal` prop).
 */
import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { c, gradient, mono } from '../quoxon/theme.js';
import { QGlyph } from '../quoxon/qmotion.js';
import { Clock } from '../quoxon/motion/clock.js';
import { particleCellsAt, qCells, cellsToAnsi, labSize } from '../quoxon/qart.js';

export const FRAME_MS = 50;
const PARTICLE_MS = 1100; // the collapse; the Q is fully settled ~470ms later
const MIN_FRAMES = 32;    // 1.6s: the Q settles, then the live line shows
const MAX_FRAMES = 50;    // 2.5s cap if the fetch never lands

/** Rows of the particle Q at frame `frame` (motion off: the settled Q). Under 12 rows the compact Q. */
export function introQ(cols, rows, frame, motion = true) {
  const size = labSize(cols, Math.max(0, rows - 8));
  const color = !mono();
  const t = frame * FRAME_MS;
  return cellsToAnsi(motion ? particleCellsAt(size, t, { dur: PARTICLE_MS, color }) : qCells(size, { color }));
}

export function LucidIntro({ data, err, onDone, rows = 24, cols = 100, motion = true }) {
  const [frame, setFrame] = useState(0);
  const doneRef = useRef(false);
  const readyAt = useRef(null);
  const sit = data && data.situation;

  if (sit && readyAt.current == null) readyAt.current = frame;

  // The deck's shared clock drives the intro too: one timer, armed only while the intro still has frames to play.
  const clockRef = useRef(null);
  if (!clockRef.current) clockRef.current = new Clock(() => setFrame((f) => f + 1));
  useEffect(() => { if (!doneRef.current) clockRef.current.schedule([{ every: FRAME_MS }]); });
  useEffect(() => () => clockRef.current.stop(), []);

  const finishAt = readyAt.current != null
    ? Math.max(MIN_FRAMES, readyAt.current + 6)
    : (err ? Math.max(MIN_FRAMES, 16) : MAX_FRAMES);

  useEffect(() => {
    if (frame >= finishAt && !doneRef.current) { doneRef.current = true; onDone(); }
  }, [frame, finishAt, onDone]);

  const qRows = introQ(cols, rows, frame, motion);
  const markOn = frame >= 14;
  const resolved = sit && frame >= 22 && frame >= (readyAt.current ?? 0) + 2;
  const cov = (sit && sit.cannot_see && sit.cannot_see.coverage) || { live: 0, expected: 0 };
  const dots = '.'.repeat((frame % 3) + 1).padEnd(3, ' ');

  const mark = (
    <Text>
      <QGlyph state="working" ms={Date.now()} quiet={!motion} />
      <Text> </Text>
      {gradient('LUCID').map((g, i) => <Text key={i} bold color={g.color}>{g.ch}</Text>)}
    </Text>
  );

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} paddingY={1}>
      <Box flexDirection="column" alignItems="center">
        {qRows.map((l, r) => <Text key={r} wrap="truncate">{l}</Text>)}
      </Box>
      <Box marginTop={1}>{markOn ? mark : <Text> </Text>}</Box>
      <Box marginTop={1}>
        {frame < 16 ? <Text> </Text> : resolved ? (
          <Text>
            <QGlyph state={(sit.needs_you || []).length ? 'waiting' : 'resting'} ms={Date.now()} quiet />
            <Text bold color={c('sky')}> LUCID</Text>
            <Text color={c('muted')}> │ </Text>
            <Text color={c('ok')}>{cov.live} sources live</Text>
            <Text color={c('muted')}> · </Text>
            <Text bold color={(sit.needs_you || []).length ? c('warn') : c('ok')}>{(sit.needs_you || []).length} need you</Text>
          </Text>
        ) : err && !sit ? (
          <Text color={c('error')}>LUCID unreachable, still trying</Text>
        ) : (
          <Text color={c('muted')}>tuning in{dots}</Text>
        )}
      </Box>
      <Box marginTop={1}><Text color={c('muted')}>any key to skip</Text></Box>
    </Box>
  );
}
