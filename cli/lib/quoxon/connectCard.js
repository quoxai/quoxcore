/**
 * The secure /connect card. Shown in place of the composer while it is open. It renders only the
 * mask from the secret box, never the value.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { c, clip } from './theme.js';
import { Rule, AskCard } from './render.js';

const h = React.createElement;

/** card: { provider: PROVIDERS entry, phase: 'input'|'saving'|'consent', error?: string, question?: string }, mask: string */
export function ConnectCard({ card, mask, cols }) {
  const p = card.provider;
  const w = Math.max(10, cols - 4);
  // QUOXON-Z2H lane R: the one consent question after a cloud connect (y records the user's own OK).
  if (card.phase === 'consent') return h(AskCard, { text: card.question, cols }); // QUOXON-ASK: the same card as an approval
  // #1288: an org admin's own Ollama on a private address: y/N, then the save with a confirm for that origin.
  if (card.phase === 'private') return h(AskCard, { text: card.question, cols });
  if (card.phase === 'saving' && card.privateOffer) {
    return h(Box, { flexDirection: 'column', width: cols, marginTop: 1 },
      h(Text, { color: c('dim') }, clip(`  ◐ checking ${card.privateOffer.host} answers as Ollama, then saving…`, cols)));
  }
  if (card.phase === 'saving' && card.consentType) {
    return h(Box, { flexDirection: 'column', width: cols, marginTop: 1 },
      h(Rule, { cols, color: 'sky' }),
      h(Text, { color: c('sky'), bold: true }, clip(`Ⓠ ${p.name} is connected · one question`, cols)),
      h(Text, { color: c('text'), wrap: 'wrap' }, `  Your messages and any tool results go to ${p.name}, a third party, when it answers. Nothing is sent until you say yes. You can withdraw this any time (Settings > Privacy).`),
      h(Text, { color: c('warn'), bold: true }, clip(`  ${card.question}`, cols)),
      h(Text, { color: c('text') }, card.phase === 'saving' ? clip('  ◐ recording your OK…', cols) : clip('  y yes · n or Enter no · Esc no', cols)),
      h(Rule, { cols, color: 'sky' }));
  }
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
