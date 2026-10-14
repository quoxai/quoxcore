/**
 * The secure /connect card. Shown in place of the composer while it is open. It renders only the
 * mask from the secret box, never the value.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { c, clip } from './theme.js';
import { Rule } from './render.js';

const h = React.createElement;

/** card: { provider: PROVIDERS entry, phase: 'input'|'saving', error?: string }, mask: string */
export function ConnectCard({ card, mask, cols }) {
  const p = card.provider;
  const w = Math.max(10, cols - 4);
  return h(Box, { flexDirection: 'column', width: cols, marginTop: 1 },
    h(Rule, { cols, color: 'sky' }),
    h(Text, { color: c('sky'), bold: true }, clip(`Ⓠ Connect ${p.name}${card.subtitle ? ` · ${card.subtitle}` : ''} · goes straight to your org vault, never into chat`, cols)),
    h(Text, { color: c('text') }, clip(`  ${p.why}`, cols)),
    p.disclosure ? h(Text, { color: c('warn'), wrap: 'wrap' }, `  ${p.disclosure}`) : null,
    h(Text, { color: c('text') }, clip(`  Get a key: ${p.keyUrl}`, cols)),
    h(Text, { color: c('text') }, clip(`  key    ${mask || ''}${card.phase === 'input' ? '▏' : ''}`, cols)),
    card.error ? h(Text, { color: c('warn') }, clip(`  ${card.error}`, w + 2)) : null,
    h(Text, { color: c('dim') }, card.phase === 'saving'
      ? clip(`  ◐ testing with ${p.name}, then saving…`, cols)
      : clip('  paste your key · Enter test and save · Esc cancel · keys typed here stay in this card', cols)),
    h(Rule, { cols, color: 'sky' }));
}
