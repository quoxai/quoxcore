/**
 * QUOXON-FW: a slash line whose words name a real `quox` CLI leaf (`/plans list`, `/notes new "x"`) is that command.
 * Pure resolution only; app.js runs it (read: in-window like a ! command; write: asks "Run it? y/N"; never: refuses).
 * LEAVES is cliLeaves.json: path -> read|write|never, vendored from docs/matrix/sources/cli-leaf-policy.json
 * (a test fails if they drift; regenerate with the one-liner in that test's failure message).
 */
import { createRequire } from 'node:module';
import { tokenize } from '../bang.js';

export const LEAVES = createRequire(import.meta.url)('./cliLeaves.json');

// verbs people type that the CLI spells differently (only used when the result is a real leaf)
const ALIASES = { ls: 'list', lists: 'list', rm: 'remove', del: 'delete', new: 'add', create: 'add', info: 'show', get: 'show', aware: 'lucid', neighbors: 'neighbours' };

function variants(w) {
  const lw = w.toLowerCase();
  const out = new Set([lw]);
  if (lw.endsWith('ies')) out.add(`${lw.slice(0, -3)}y`);
  if (lw.endsWith('es')) out.add(lw.slice(0, -2));
  if (lw.endsWith('s')) out.add(lw.slice(0, -1)); else out.add(`${lw}s`);
  if (ALIASES[lw]) out.add(ALIASES[lw]);
  for (const v of [...out]) if (ALIASES[v]) out.add(ALIASES[v]);
  return [...out];
}

const MAX_DEPTH = 4;

/** -> { path, cls, args, display } | null. args is the full argv after `quox` (quoted args preserved). */
export function resolveCliSlash(cmd, restArg, leaves = LEAVES) {
  const first = String(cmd || '').replace(/^\//, '');
  if (!first || first.startsWith('-')) return null;
  const rest = tokenize(String(restArg || ''));
  const words = [first, ...rest];
  const walk = (n) => { // all path spellings for the first n words
    let acc = [[]];
    for (let i = 0; i < n; i++) {
      if (words[i].startsWith('-')) return [];
      const vs = variants(words[i]);
      acc = acc.flatMap(p => vs.map(v => [...p, v]));
    }
    return acc;
  };
  for (let n = Math.min(MAX_DEPTH, words.length); n >= 1; n--) {
    for (const p of walk(n)) {
      const path = p.join(' ');
      if (Object.prototype.hasOwnProperty.call(leaves, path)) {
        const args = [...p, ...words.slice(n)];
        return { path, cls: leaves[path], args, display: `quox ${args.map(a => (/[\s"']/.test(a) || a === '' ? JSON.stringify(a) : a)).join(' ')}` };
      }
    }
  }
  return null;
}
