/** Ink views for /dragon explain|ask (the talking dragon) and /dragon sleep (the screensaver). Frames come from dragonModes.js. */
import React from 'react';
import { Box, Text } from 'ink';
import { cellNodes } from './qmotion.js';
import { composeSleep } from './dragonModes.js';
import { pickCells } from './qdragonScenes.js';
import { flyFrame, flyCols } from './qdragonFly.js';
import { mono, isLight, clip } from './theme.js';
import { useFrame } from './motion/frame.js';

const h = React.createElement;

/** The sleep screen: the whole live region while asleep (and for the decode on wake). Reads the clock itself. */
export function SleepScreen({ lines, cols, rows, startedAt, wakeAt = null, still = false }) {
  useFrame();
  const now = Date.now();
  const wake = wakeAt != null;
  const ms = wake ? now - wakeAt : now - startedAt;
  const grid = composeSleep({ lines, cols, rows, ms, wake, still, mono: mono(), theme: isLight() ? 'light' : 'dark' });
  return h(Box, { flexDirection: 'column' }, ...grid.map((r, k) => h(Text, { key: k, wrap: 'truncate' }, ...cellNodes(r, `s${k}-`))));
}

/** The compact dragon beside an explain/ask answer: the mouth works while text streams, then it rests with idle eyes. */
export function DragonTalk({ cols, label, talking, since, still = false }) {
  useFrame();
  const dcols = Math.min(cols, 44);
  const t = Date.now() - since;
  const cells = pickCells(t, dcols, undefined, { theme: isLight() ? 'light' : 'dark', mono: mono(), still: still || !talking, talk: talking && !still, size: 'mid', mouthSide: 'right' });
  return h(Box, { flexDirection: 'column', marginTop: 1 },
    ...cells.map((row, k) => h(Text, { key: k, wrap: 'truncate' }, ...cellNodes(row, `t${k}-`))),
    h(Text, null, clip(label, Math.max(10, cols - 2))));
}

/** /dragon-fly: one pass of the dragon in flight across the live region (qdragonFly.js). `still`: a single frame, no motion. */
export function FlyLive({ cols, rows, startedAt, still = false }) {
  useFrame();
  const c = flyCols(cols);
  const cells = flyFrame(Date.now() - startedAt, c, { still, mono: mono(), theme: isLight() ? 'light' : 'dark', termRows: rows });
  return h(Box, { flexDirection: 'column', marginTop: 1 },
    ...cells.map((row, k) => h(Text, { key: k, wrap: 'truncate' }, ...cellNodes(row, `f${k}-`))));
}
