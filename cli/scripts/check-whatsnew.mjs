#!/usr/bin/env node
// QUOXON-WHATSNEW3 land check: a change to the Quox TUI's user-facing code (cli/lib/quoxon) should add a line to
// cli/lib/quoxon/whatsnew.jsonl, or carry a `Whatsnew: <title> | <command>` trailer, so What's new cannot go stale.
// A warning, never a block. Opt out for a change users cannot see with `[no-whatsnew]` or `Whatsnew: none`.
//   node cli/scripts/check-whatsnew.mjs <base> <head>     (prints the warning, always exits 0)
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const USER_FACING = /^cli\/lib\/quoxon\/(?!.*\.test\.jsx?$)(?!whatsnew\.)[^]*\.(js|jsx|mjs)$/;
const JSONL = 'cli/lib/quoxon/whatsnew.jsonl';

/** { files, messages } -> a warning string, or null when nothing is owed. */
export function whatsnewWarning({ files = [], messages = [] }) {
  const touched = files.filter(f => USER_FACING.test(f));
  if (!touched.length || files.includes(JSONL)) return null;
  const text = messages.join('\n');
  if (/\[no-whatsnew\]/i.test(text) || /^Whatsnew:\s*\S/mi.test(text)) return null;
  return `whatsnew: ${touched.length} user-facing TUI file(s) changed (${touched.slice(0, 3).join(', ')}${touched.length > 3 ? ', ...' : ''}) `
    + `but ${JSONL} has no new line. Append one (id, date, title, text, try or shell, since, sha), add a `
    + `"Whatsnew: <title> | <command>" trailer, or mark the commit [no-whatsnew] if users cannot see it.`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [base = 'origin/main', head = 'HEAD'] = process.argv.slice(2);
  try {
    const git = (a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const files = git(['diff', '--name-only', `${base}...${head}`]).split('\n').filter(Boolean);
    const messages = git(['log', '--format=%B%x00', `${base}..${head}`]).split('\0');
    const w = whatsnewWarning({ files, messages });
    if (w) console.log(`⚠ ${w}`);
  } catch (e) { console.log(`whatsnew check skipped: ${e.message}`); }
}
