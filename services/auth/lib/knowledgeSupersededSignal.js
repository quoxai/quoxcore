/**
 * Wave 7 #4: cheap upload-time signal that a document is probably old, replaced
 * or archived, so the admin gets a one-click "Treat as reference only" prompt
 * (PATCH superseded). Pure; no I/O.
 */

const NAME_RE = /(?:^|[^a-z0-9])(old|archive|archived|superseded|replaced|obsolete|outdated|deprecated|legacy|previous)(?:[^a-z0-9]|$)/i;
const LINE_RE = /\b(superseded|replaced by|no longer (?:valid|current|in use|applies)|out of date|outdated|obsolete|archived?|deprecated|for reference only|ended|expired|finished|discontinued|no longer (?:available|offered|running|on offer)|ran (?:from )?[^.]{0,40}?\bto\b|ran (?:until|through))\b/i;
const PAST_END_RE = /\b(?:valid (?:until|through|to)|ends?|ended|expires?|until|through)\b[^0-9]{0,20}(20\d{2})/i;
const FROM_RE = /\b(?:valid from|effective(?: from)?|in force from|from)\s+(?:the\s+)?(?:\d{1,2}(?:st|nd|rd|th)?\s+)?(?:of\s+)?(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?,?\s+(?:\d{1,2}(?:st|nd|rd|th)?,?\s+)?(20\d{2})\b/i;
// W16: "(updated April 2026)", "Last updated March 2025", "revised 3 May 2026".
const UPD_RE = /\b(?:last\s+)?(?:updated|revised|valid from|effective(?: from)?)[:\s]+(?:on\s+)?(?:the\s+)?(?:\d{1,2}(?:st|nd|rd|th)?\s+)?(?:of\s+)?(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?,?\s+(?:\d{1,2}(?:st|nd|rd|th)?,?\s+)?(20\d{2})\b|\b(?:last\s+)?(?:updated|revised)[:\s]+(?:in\s+)?(20\d{2})\b/i;
function datedYear(line) {
  const l = String(line || '').slice(0, 300);
  const m = UPD_RE.exec(l) || FROM_RE.exec(l);
  return m ? Number(m[1] || m[2]) : null;
}
const YEAR_RE = /(?:^|[^0-9])(20\d{2})(?:[^0-9]|$)/g;

function years(name) {
  const out = [];
  const s = String(name || '');
  let m;
  YEAR_RE.lastIndex = 0;
  while ((m = YEAR_RE.exec(s)) !== null) { out.push(Number(m[1])); YEAR_RE.lastIndex = m.index + m[0].length - 1; }
  return out;
}

// W17: version tokens (v2, version 2, rev 2, r2, edition 2) ordered against a
// sibling with the same name/title once the token is stripped.
const VER_RE = /(?:^|[^a-z0-9])(?:v|ver|version|rev|revision|r|edition|ed)[.\s_-]*(\d{1,3})(?:\.\d+)*(?![0-9a-z])/i;
export function versionKey(text) {
  const t = String(text || '').split('\n')[0].slice(0, 200);
  const m = VER_RE.exec(t);
  if (!m) return null;
  const rest = (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!rest) return null;
  return { n: Number(m[1]), key: rest };
}
function olderVersion(mine, others) {
  if (!mine) return false;
  return others.some(o => { const v = versionKey(o); return v && v.key === mine.key && v.n > mine.n; });
}

export function detectSupersededSignal({ filename, firstLine = '', existingNames = [], existingFirstLines = [], lastLines = [] } = {}) {
  const reasons = [];
  const base = String(filename || '').replace(/\.[a-z0-9]{1,5}$/i, '');
  if (NAME_RE.test(base)) reasons.push('filename');
  if (firstLine && LINE_RE.test(String(firstLine).slice(0, 300))) reasons.push('first_line');
  if (firstLine) {
    const pe = PAST_END_RE.exec(String(firstLine).slice(0, 300));
    if (pe && Number(pe[1]) < new Date().getFullYear() && !reasons.includes('first_line')) reasons.push('first_line');
  }
  // W15: "<thing> from 1 September 2025" older than a sibling's "from ... 2026" (or than this year).
    if (firstLine) {
    const fm = FROM_RE.exec(String(firstLine).slice(0, 300));
    if (fm) {
      const fy = Number(fm[1]);
      const sib = (existingFirstLines || []).map(l => FROM_RE.exec(String(l || '').slice(0, 300))).filter(Boolean).map(x => Number(x[1]));
      if (sib.length > 0 && fy < Math.max(...sib)) { reasons.push('older_year'); }
      else if (fy < new Date().getFullYear() && !reasons.includes('first_line')) reasons.push('first_line');
    }
  }
  // W16: footer-dated archive ("Last updated March 2025" in the last 3 non-empty lines).
  const footerYears = (Array.isArray(lastLines) ? lastLines : []).filter(l => String(l || '').trim()).slice(-3).map(datedYear).filter(y => y !== null);
  if (footerYears.length > 0) {
    const fy = Math.max(...footerYears);
    const sib = (existingFirstLines || []).map(datedYear).filter(y => y !== null);
    if (sib.length > 0 && fy < Math.max(...sib)) { if (!reasons.includes('older_year')) reasons.push('older_year'); }
    else if (fy < new Date().getFullYear() && !reasons.includes('first_line')) reasons.push('first_line');
  }
  const mine = years(base);
  if (mine.length > 0) {
    const others = (existingNames || []).flatMap(n => years(String(n).replace(/\.[a-z0-9]{1,5}$/i, '')));
    if (others.length > 0 && Math.max(...mine) < Math.max(...others) && !reasons.includes('older_year')) reasons.push('older_year');
  }
  // W17: a version token lower than a sibling's for the same name / title.
  const nameOld = olderVersion(versionKey(base), (existingNames || []).map(n => String(n).replace(/\.[a-z0-9]{1,5}$/i, '')));
  const lineOld = olderVersion(versionKey(String(firstLine || '').replace(/^[#\s>*]+/, '')), (existingFirstLines || []).map(l => String(l || '').replace(/^[#\s>*]+/, '')));
  if (nameOld || lineOld) {
    reasons.push('version');
    if (nameOld && lineOld) reasons.push('version_confirmed');
  }
  return { suggest_superseded: reasons.length > 0, reasons };
}

/** Strong: filename + first-line + older-year all fired, or a version-token supersession confirmed by name AND title (or another signal). */
export function isStrongSupersededSignal(sig) {
  const r = sig && Array.isArray(sig.reasons) ? sig.reasons : [];
  if (r.includes('version') && (r.includes('version_confirmed') || r.includes('filename') || r.includes('first_line'))) return true;
  return r.includes('filename') && r.includes('first_line') && r.includes('older_year');
}
