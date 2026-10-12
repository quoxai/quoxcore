/**
 * Line diff for the revision viewer. A straight port of
 * services/collector/lib/notesq/diff.js lineDiff (a parity test keeps the two
 * identical), plus parseDiff to turn its text form into rows for rendering.
 */

const MAX_INPUT_LINES = 1500;

export function lineDiff(before, after, { context = 3, maxLines = 200 } = {}) {
  const a = String(before || '').replace(/\n$/, '').split('\n').slice(0, MAX_INPUT_LINES);
  const b = String(after || '').replace(/\n$/, '').split('\n').slice(0, MAX_INPUT_LINES);
  if (before === after) return { text: '', added: 0, removed: 0, changed: false, truncated: false };
  const n = a.length; const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a[i]]); i++; } else { ops.push(['+', b[j]]); j++; }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  if (a.length === 1 && a[0] === '') ops.splice(ops.findIndex((o) => o[0] === '-' && o[1] === ''), 1);
  const keep = ops.map(() => false);
  ops.forEach((o, k) => { if (o[0] !== ' ') for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = true; });
  const out = [];
  let skipped = false;
  ops.forEach((o, k) => {
    if (keep[k]) { if (skipped) out.push('@@'); skipped = false; out.push(`${o[0]}${o[1]}`); } else skipped = true;
  });
  const truncated = out.length > maxLines;
  const lines = truncated ? [...out.slice(0, maxLines), `@@ ${out.length - maxLines} more line(s) not shown`] : out;
  return {
    text: lines.join('\n'),
    added: ops.filter((o) => o[0] === '+').length,
    removed: ops.filter((o) => o[0] === '-').length,
    changed: true,
    truncated,
  };
}

/** lineDiff text -> [{ kind: 'add' | 'del' | 'ctx' | 'gap', text }]. '@@' lines are collapsed unchanged runs. */
export function parseDiff(text) {
  if (!text) return [];
  return text.split('\n').map((l) => {
    if (l.startsWith('@@')) return { kind: 'gap', text: l.slice(2).trim() };
    const t = l.slice(1);
    if (l[0] === '+') return { kind: 'add', text: t };
    if (l[0] === '-') return { kind: 'del', text: t };
    return { kind: 'ctx', text: t };
  });
}
