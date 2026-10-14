/**
 * Local intent matcher for Getting started. No model, no network: a keyword table, so the answer is instant
 * and predictable. Anything it does not recognise is "offscript" and gets an honest deferral.
 */

export const INTENTS = ['servers', 'automate', 'code', 'email', 'explore'];

// Order matters: the first rule whose pattern matches wins ("connect" first, so "I already have a server"
// is never read as "watch my servers").
const RULES = [
  ['connect', /\b(already (have|got|run)|have (a|my|an?) (own )?(server|quox|instance)|existing (server|quox|instance)|my (own )?quox(core)?|connect (to )?(a |my )?(server|quox))\b/i],
  ['servers', /\b(servers?|hosts?|fleet|monitor(ing)?|watch(ing)?|uptime|infra(structure)?|machines?|homelab|proxmox|vms?|nodes?|cluster|disk space|logs?)\b/i],
  ['email', /\b(e-?mails?|mail|inbox|gmail|outlook|newsletters?|replies)\b/i],
  ['code', /\b(code|coding|coder|repos?|repository|github|gitlab|pull requests?|prs?|bugs?|refactor|programm(ing|er)|develop(er|ment)?|tests?)\b/i],
  ['automate', /\b(automat(e|ion|ing)|workflows?|schedul(e|ed|ing)|cron|routines?|repetitive|every (day|morning|week|hour)|n8n|zapier|tasks?|jobs?)\b/i],
  ['explore', /\b(look(ing)? around|explore|just looking|curious|show me|demo|tour|not sure|no idea|anything|surprise me|what can (you|it|quox) do|browse)\b/i]
];

/** -> { intent: one of INTENTS | 'connect' | 'offscript' | 'empty', text } */
export function matchIntent(input) {
  const text = String(input ?? '').trim();
  if (!text) return { intent: 'empty', text };
  const n = /^[1-5]$/.exec(text);
  if (n) return { intent: INTENTS[Number(n[0]) - 1], text };
  for (const [intent, re] of RULES) if (re.test(text)) return { intent, text };
  return { intent: 'offscript', text };
}

/** Y/n answer: Enter alone means yes. -> true | false | null (not an answer) */
export function yesNo(input) {
  const t = String(input ?? '').trim().toLowerCase();
  if (t === '' || /^(y|yes|yeah|yep|sure|ok|okay|go|do it|set it up|please)\b/.test(t)) return true;
  if (/^(n|no|nope|not now|later|skip|cancel)\b/.test(t)) return false;
  return null;
}

/** `/connect server <url>` -> { ok, url } | { ok: false, reason: 'usage' | 'url', value } | null (not /connect) */
export function parseConnect(input) {
  const t = String(input ?? '').trim();
  if (!/^\/connect\b/i.test(t)) return null;
  const m = /^\/connect\s+server(?:\s+(\S+))?\s*$/i.exec(t);
  if (!m) return { ok: false, reason: 'usage' };
  if (!m[1]) return { ok: false, reason: 'usage' };
  let raw = m[1];
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname) return { ok: false, reason: 'url', value: m[1] };
    return { ok: true, url: u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')) };
  } catch {
    return { ok: false, reason: 'url', value: m[1] };
  }
}
