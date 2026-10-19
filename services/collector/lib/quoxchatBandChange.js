'use strict';
/**
 * QC-BRUTALOOP-W15c: "your child moves to the next age band, and its price,
 * from the first day of the month after their birthday". A visitor who says
 * "my son turns 2 on 20 October" and asks for a price on a date got a funding
 * answer. The switch date is computed here and handed to the prompt as a
 * fact; the price lookup stays with the model.
 */
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RULE_RE = /\bfrom\s+the\s+first(?:\s+day)?\s+of\s+the\s+month\s+(?:after|following)\s+(?:their|the\s+child(?:'|’)?s|his|her|a\s+child(?:'|’)?s|your\s+child(?:'|’)?s)\s+birthday\b/i;
const DAY_FIRST = new RegExp(`\\bturn(?:s|ing)\\s+(\\d{1,2})\\s+(?:on|in)\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MON}(?:,?\\s+(\\d{4}))?\\b`, 'i');
const MON_FIRST = new RegExp(`\\bturn(?:s|ing)\\s+(\\d{1,2})\\s+(?:on|in)\\s+${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i');
const monIdx = (s) => NAMES.findIndex((n) => n.toLowerCase().startsWith(s.toLowerCase().slice(0, 3)));

function todayYmd(now, tz) {
  let p;
  try { p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); } catch (_) { p = now.toISOString().slice(0, 10); }
  const [y, m, d] = p.split('-').map(Number);
  return { y, m: m - 1, d };
}

function planBandChange(visitorTexts, knowledgeTexts, now = new Date(), tz = 'Europe/London') {
  if (!(Array.isArray(knowledgeTexts) ? knowledgeTexts : []).some((k) => RULE_RE.test(String(k || '')))) return null;
  for (const t of Array.isArray(visitorTexts) ? visitorTexts : []) {
    const txt = String(t || '');
    let age; let day; let mon; let year;
    let m = DAY_FIRST.exec(txt);
    if (m) { age = Number(m[1]); day = Number(m[2]); mon = monIdx(m[3]); year = m[4] ? Number(m[4]) : null; } else if ((m = MON_FIRST.exec(txt))) { age = Number(m[1]); mon = monIdx(m[2]); day = Number(m[3]); year = m[4] ? Number(m[4]) : null; } else continue;
    if (!(age >= 1 && age <= 18) || !(day >= 1 && day <= 31) || mon < 0) continue;
    const today = todayYmd(now, tz);
    if (!year) {
      year = today.y;
      if (Date.UTC(year, mon, day) < Date.UTC(today.y, today.m, today.d)) year += 1;
    }
    const sw = new Date(Date.UTC(year, mon + 1, 1));
    const switchLabel = `1 ${NAMES[sw.getUTCMonth()]} ${sw.getUTCFullYear()}`;
    const bday = `${day} ${NAMES[mon].slice(0, 3)} ${year}`;
    const before = age === 2 ? 'under 2' : `${age - 1} year olds`;
    return { age, birthday: bday, switchLabel, fact: `Band change: turns ${age} on ${bday}, so the ${age} year olds band and price apply from ${switchLabel}; before that the ${before} band applies.` };
  }
  return null;
}

module.exports = { planBandChange };
