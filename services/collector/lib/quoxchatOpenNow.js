'use strict';
/**
 * QC-BRUTALOOP-W15c: "is the <office/reception/shop/...> open right now?" for a
 * NAMED facility whose hours sit in KNOWLEDGE as their own sentence. The whole-
 * business guard merges every hours sentence; this picks the sentence whose
 * subject matches the noun in the question, computes open/closed against the
 * local clock, and hands it to the prompt as a computed fact.
 */
const { localClock } = require('./quoxchatSafety');

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const NOW_RE = /\b(?:right\s+now|at\s+the\s+moment|currently|open\s+now|now\s+open|open\s+today\s+and\s+now)\b/i;
const SUBJ_RE = /\b(?:is|are|was)\s+(?:the|your|our|a)?\s*([a-z][a-z\- ]{1,30}?)\s+(?:currently\s+|now\s+)?open\b|\b(?:the|your|our)\s+([a-z][a-z\-]{1,24})\s+(?:open|opening)\s+(?:right\s+)?now\b/i;
const NOT_SUBJECT = new Set(['you', 'it', 'there', 'that', 'this', 'we', 'they', 'anyone', 'anybody', 'someone', 'place']);
const RANGE = /(\d{1,2}):(\d{2})\s*(?:to|-|–|until|till)\s*(\d{1,2}):(\d{2})/g;

function daysOf(label) {
  const l = String(label || '').toLowerCase();
  if (/weekdays?|monday to friday|mon(?:day)?\s*-\s*fri(?:day)?/.test(l)) return [1, 2, 3, 4, 5];
  if (/weekends?/.test(l)) return [0, 6];
  const r = l.match(/(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+to\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
  if (r) { const a = DAYS.indexOf(r[1]); const b = DAYS.indexOf(r[2]); const d = []; for (let i = a; ; i = (i + 1) % 7) { d.push(i); if (i === b) break; } return d; }
  const one = DAYS.filter((d) => l.includes(d)).map((d) => DAYS.indexOf(d));
  return one.length ? one : null;
}
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function subjectOf(message) {
  const msg = String(message || '');
  if (!NOW_RE.test(msg) || !/\bopen/i.test(msg)) return null;
  const m = SUBJ_RE.exec(msg);
  if (!m) return null;
  const words = (m[1] || m[2]).toLowerCase().split(/\s+/).filter((w) => w && !['the', 'your', 'our', 'a'].includes(w));
  const w = words[words.length - 1];
  return w && !NOT_SUBJECT.has(w) ? w : null;
}

function rangesFor(knowledgeTexts, subject, dow) {
  const re = new RegExp(`\\b${subject}s?\\b`, 'i');
  const out = [];
  for (const k of Array.isArray(knowledgeTexts) ? knowledgeTexts : []) {
    for (const part of String(k || '').split(/\n|(?<=[.;])\s+/)) {
      const first = part.search(/\d{1,2}:\d{2}\s*(?:to|-|–|until|till)\s*\d{1,2}:\d{2}/);
      if (first < 0) continue;
      const label = part.slice(0, first);
      if (!re.test(label)) continue;
      const days = daysOf(label);
      if (days && !days.includes(dow)) continue;
      for (const m of part.matchAll(RANGE)) out.push([Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

function planOpenNow(message, knowledgeTexts, now = new Date(), tz = 'Europe/London') {
  const subject = subjectOf(message);
  if (!subject) return null;
  const clock = localClock(now, tz);
  if (!rangesFor(knowledgeTexts, subject, 0).length && ![0, 1, 2, 3, 4, 5, 6].some((d) => rangesFor(knowledgeTexts, subject, d).length)) return null;
  const today = rangesFor(knowledgeTexts, subject, clock.dow);
  const cur = today.find(([a, b]) => clock.minutes >= a && clock.minutes < b);
  const name = `the ${subject}`;
  if (cur) {
    const fact = `Open-now (computed from the local clock, ${clock.weekday} ${hm(clock.minutes)}): ${name} is open right now, until ${hm(cur[1])} today. Answer the now-question first.`;
    return { subject, open: true, fact, sentence: `${name.charAt(0).toUpperCase() + name.slice(1)} is open right now, until ${hm(cur[1])} today.` };
  }
  let when;
  const later = today.find(([a]) => a > clock.minutes);
  if (later) when = `opens at ${hm(later[0])}`;
  else {
    for (let i = 1; i <= 7 && !when; i++) {
      const d = (clock.dow + i) % 7;
      const r = rangesFor(knowledgeTexts, subject, d);
      if (r.length) when = i === 1 ? `opens tomorrow at ${hm(r[0][0])}` : `opens ${DAYS[d].charAt(0).toUpperCase()}${DAYS[d].slice(1)} at ${hm(r[0][0])}`;
    }
  }
  const tail = when ? ` and ${when}` : '';
  const fact = `Open-now (computed from the local clock, ${clock.weekday} ${hm(clock.minutes)}): ${name} is closed right now${tail}. Answer the now-question first.`;
  return { subject, open: false, fact, sentence: `${name.charAt(0).toUpperCase() + name.slice(1)} is closed right now${tail}.` };
}

function enforceOpenNow(text, plan) {
  const src = String(text || '');
  if (!plan) return { text: src, changed: false };
  const closedSaid = /\b(?:closed|shut)\b|\bnot\s+(?:currently\s+)?open\b|\bopens\s+(?:at|tomorrow|on|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(src);
  const openSaid = /\b(?:is|are|we(?:'|’)re)\s+(?:currently\s+)?open\b|\bopen\s+(?:right\s+)?now\b/i.test(src);
  const ok = plan.open ? (openSaid && !closedSaid) : (closedSaid && !openSaid);
  if (ok) return { text: src, changed: false };
  return { text: `${plan.sentence} ${src}`.trim(), changed: true };
}

module.exports = { planOpenNow, enforceOpenNow, subjectOf };
