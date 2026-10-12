/**
 * Wave 7 #4: cheap upload-time signal that a document is probably old, replaced
 * or archived, so the admin gets a one-click "Treat as reference only" prompt
 * (PATCH superseded). Pure; no I/O.
 */

const NAME_RE = /(?:^|[^a-z0-9])(old|archive|archived|superseded|replaced|obsolete|outdated|deprecated|legacy|previous)(?:[^a-z0-9]|$)/i;
const LINE_RE = /\b(superseded|replaced by|no longer (?:valid|current|in use|applies)|out of date|outdated|obsolete|archived?|deprecated|for reference only)\b/i;
const YEAR_RE = /(?:^|[^0-9])(20\d{2})(?:[^0-9]|$)/g;

function years(name) {
  const out = [];
  const s = String(name || '');
  let m;
  YEAR_RE.lastIndex = 0;
  while ((m = YEAR_RE.exec(s)) !== null) { out.push(Number(m[1])); YEAR_RE.lastIndex = m.index + m[0].length - 1; }
  return out;
}

export function detectSupersededSignal({ filename, firstLine = '', existingNames = [] } = {}) {
  const reasons = [];
  const base = String(filename || '').replace(/\.[a-z0-9]{1,5}$/i, '');
  if (NAME_RE.test(base)) reasons.push('filename');
  if (firstLine && LINE_RE.test(String(firstLine).slice(0, 300))) reasons.push('first_line');
  const mine = years(base);
  if (mine.length > 0) {
    const others = (existingNames || []).flatMap(n => years(String(n).replace(/\.[a-z0-9]{1,5}$/i, '')));
    if (others.length > 0 && Math.max(...mine) < Math.max(...others)) reasons.push('older_year');
  }
  return { suggest_superseded: reasons.length > 0, reasons };
}
