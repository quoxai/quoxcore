/**
 * One small list component for everything slash commands pop up under the composer: the command
 * palette, the /resume picker and the /config card. Rows: { key, text, note?, dim? }. The selected
 * row carries a marker; dim rows show their note (the reason) in muted text.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { c, clip } from '../theme.js';

const h = React.createElement;

export function ListView({ title = null, rows = [], sel = 0, cols = 80, hint = null, empty = null, more = 0 }) {
  // The key column grows with the window (22 cells minimum, 32 at most) and always leaves a one-cell gap, so a name that fits is shown whole;
  // one that does not gets the ellipsis from truncate-end, never a silent cut.
  const keyW = Math.min(Math.max(22, Math.min(32, Math.floor(cols / 3))), Math.max(8, ...rows.map(r => [...String(r.key || '')].length)) + 1);
  const textW = Math.max(10, cols - keyW - 6);
  return h(Box, { flexDirection: 'column', paddingLeft: 1 },
    title ? h(Text, { color: c('muted'), bold: true }, clip(title, cols - 2)) : null,
    !rows.length && empty ? h(Text, { color: c('muted') }, `  ${clip(empty, cols - 4)}`) : null,
    ...rows.map((r, i) => {
      const on = i === sel;
      const body = r.dim && r.note ? `${r.note} · ${r.text}` : r.note ? `${r.text}  ${r.note}` : r.text;
      return h(Box, { key: `${i}:${r.key}` },
        h(Text, { color: on ? c('key') : c('muted') }, on ? '▸ ' : '  '),
        h(Box, { width: keyW, flexShrink: 0 }, h(Text, { color: r.dim ? c('muted') : on ? c('key') : c('label'), bold: on && !r.dim, wrap: 'truncate-end' }, String(r.key || ''))),
        h(Text, { color: c(r.dim ? 'muted' : 'text'), wrap: 'truncate-end' }, clip(String(body || ''), textW)));
    }),
    more > 0 ? h(Text, { color: c('muted') }, `  … ${more} more, keep typing to narrow`) : null,
    hint ? h(Text, { color: c('dim') }, `  ${clip(hint, cols - 4)}`) : null);
}
