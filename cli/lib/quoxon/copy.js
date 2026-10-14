/** /copy helpers: pick the text and build the OSC 52 clipboard escape. */
import { stripMarks } from './palette.js';

export function osc52(text, env = process.env) {
  const seq = `\x1b]52;c;${Buffer.from(stripMarks(text), 'utf8').toString('base64')}\x07`;
  return env.TMUX ? `\x1bPtmux;${seq.replace(/\x1b/g, '\x1b\x1b')}\x1b\\` : seq;
}

/** Fenced code blocks (``` or ~~~) of a markdown string, in order, without the fence lines. */
export function codeBlocks(md) {
  const out = []; let cur = null; let fence = null;
  for (const line of String(md).split('\n')) {
    const m = line.match(/^\s*(```+|~~~+)/);
    if (cur === null) { if (m) { fence = m[1][0]; cur = []; } continue; }
    if (m && m[1][0] === fence && line.trim() === m[1] ) { out.push(cur.join('\n')); cur = null; continue; }
    cur.push(line);
  }
  if (cur && cur.length) out.push(cur.join('\n'));
  return out;
}

/** arg: '' | 'N' | 'code'. -> { text } or { error } */
export function pickCopy(answers, arg) {
  const list = (answers || []).filter(a => a.text && a.text.trim());
  if (!list.length) return { error: 'No answer to copy yet.' };
  if (arg === 'code') {
    for (let i = list.length - 1; i >= 0; i--) { const b = codeBlocks(list[i].text); if (b.length) return { text: stripMarks(b[b.length - 1]) }; }
    return { error: 'No code block in the answers so far.' };
  }
  const n = arg ? Number(arg) : 1;
  if (!Number.isInteger(n) || n < 1) return { error: 'Usage: /copy [N|code]' };
  if (n > list.length) return { error: `Only ${list.length} answer${list.length === 1 ? '' : 's'} so far.` };
  return { text: stripMarks(list[list.length - n].text) };
}
