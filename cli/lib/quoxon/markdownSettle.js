/**
 * The streaming split, without the renderer. events.js (and so `quox --print`) needs only
 * splitSettled; importing it from markdown.js loaded React + Ink (~2 s cold) on every
 * headless turn before the request was even sent (QUOXON-LATENCY). markdown.js re-exports
 * both names, so the interactive client is unchanged.
 */
import { Lexer } from 'marked';

export const lex = (src) => new Lexer({ gfm: true, breaks: false }).lex(src);

export function splitSettled(text) {
  const tokens = lex(text);
  let last = -1;
  for (let i = tokens.length - 1; i >= 0; i--) if (tokens[i].type !== 'space') { last = i; break; }
  if (last <= 0) return { settled: '', rest: text };
  let off = 0;
  for (let i = 0; i < last; i++) off += tokens[i].raw.length;
  return { settled: text.slice(0, off), rest: text.slice(off) };
}
