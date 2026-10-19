// QUOXON-APPROVALS: pure helpers for /approvals rows, filters, detail and /approve|/deny argument parsing.
import { describeInboxItem, approvalSourceLabel, isPrivileged } from './events.js';
import { commandOf, hostsOf, whereText, whoText, whyText, excerptOf, accessOf, clipVisible } from './approvalFacts.js';

// quox ask: a decision request is an inbox item of kind question with payload.type 'decision'.
export const isDecision = (it) => it?.payload?.type === 'decision' && Array.isArray(it.payload.options);
/** Who stands behind a recommendation: an explicit recommended_by, else the asking session or agent, else Quox. Never invented when there is no recommendation. */
export const recommenderOf = (p) => String(p.recommended_by || p.session || p.agent || 'Quox');
/** Display order only: the recommended option first, the rest in their original order. Keys never move with it. No recommendation = original order. */
export const displayOptions = (p) => { const rec = p.options.find(o => o.key === p.recommend); return rec ? [rec, ...p.options.filter(o => o !== rec)] : p.options.slice(); };
const left = (it, now) => { const t = Date.parse(it?.due_at ?? it?.payload?.expires_at); if (!Number.isFinite(t)) return null; const ms = t - now; if (ms <= 0) return { text: 'expired', soon: true }; const m = Math.round(ms / 60000); return { text: m >= 120 ? `${Math.round(m / 60)}h left` : m >= 1 ? `${m}m left` : '<1m left', soon: ms <= 15 * 60000 }; };

/** One line for a decision: [3] SEER asks: Publish the guide now? (a) Ship now (b) Wait (c) Drop · recommends a · 2h left. The tail never gets clipped away; the middle gives way. */
export function decisionRow(it, n, { cols = 100, now = Date.now() } = {}) {
  const p = it.payload;
  const head = `  [${n}] ${p.session || approvalSourceLabel(it)} asks: ${cleanTitle(it)}`;
  const opts = p.options.map((o) => `(${o.key}) ${o.label}`).join(' ');
  const l = left(it, now);
  const tail = [p.recommend ? `recommends ${p.recommend}` : null, l ? `${l.soon ? '⚠ ' : ''}${l.text}` : null, p.high_risk ? 'high risk' : null].filter(Boolean).join(' · ');
  const body = `${head} ${opts}`;
  const room = cols - (tail ? tail.length + 3 : 0);
  const mid = body.length > room ? body.slice(0, Math.max(10, room - 1)) + '…' : body;
  return tail ? `${mid} · ${tail}` : mid;
}

/** Full detail for a decision: who, what, why, every option. */
export function decisionDetail(it, n, { now = Date.now() } = {}) {
  const p = it.payload; const l = left(it, now);
  const rows = [
    ['item', `[${n}] ${it.title || it.id}`],
    ['id', it.id],
    ['from', [p.session, p.profile && `profile ${p.profile}`, p.agent && `agent ${p.agent}`].filter(Boolean).join(', ')],
    ['why', p.why],
    ...displayOptions(p).map((o, i) => [i === 0 ? 'options' : '', `${o.key === p.recommend ? '★ ' : ''}(${o.key}) ${o.label}${o.key === p.recommend ? `   ★ recommended by ${recommenderOf(p)}` : ''}${o.key === p.default ? '   default' : ''}`]),
    ['expires', l ? `${l.soon ? '⚠ ' : ''}${l.text} (${it.due_at || p.expires_at})` : null],
    ['risk', p.high_risk ? 'high risk: answering needs your step-up PIN' : null],
  ].filter((r) => r[1]);
  return rows.map(([k, v]) => `  ${String(k).padEnd(8)}${v}`);
}

/**
 * /answer arguments after the command word: "3 b after Friday", or "b after Friday" when an item is focused.
 * Returns { n (null = the only open decision), key, note, bad }. A quoted note loses its quotes.
 */
/**
 * QUOXON-1191b: pair syntax "1 y 2 n", "1 y, 2 n", "1y 2n". Returns [{ k, key }] (key lowercase y|n), null when the
 * words are not entirely pairs, or { bad: true } for a 0 or a repeated number.
 */
export function parsePairs(words) {
  const text = words.join(' ').trim();
  if (!/^(\d+\s*[yn](\s*,\s*|\s+|$))+$/i.test(text)) return null;
  const pairs = [...text.matchAll(/(\d+)\s*([yn])/gi)].map(m => ({ k: Number(m[1]), key: m[2].toLowerCase() }));
  if (!pairs.length) return null;
  if (pairs.some(x => x.k < 1) || new Set(pairs.map(x => x.k)).size !== pairs.length) return { bad: true };
  return pairs;
}

export function parseAnswer(words, { focusN = null, raw = null } = {}) {
  const out = { n: null, key: null, note: '', bad: false };
  let w = words.slice();
  const pr = parsePairs(w);
  if (pr && (pr.bad || pr.length >= 2 || (w.length === 1 && /^\d+[yn]$/i.test(w[0])))) {
    if (pr.bad) { out.bad = true; return out; }
    out.ns = pr.map(x => x.k); out.n = out.ns[0]; out.keys = Object.fromEntries(pr.map(x => [x.k, x.key])); out.key = pr[0].key;
    return out;
  }
  if (w[0] && /^\d+$/.test(w[0])) { out.n = Number(w[0]); w = w.slice(1); }
  else if (w[0] && /^\d+(-\d+)?(,\d+(-\d+)?)+$|^\d+-\d+$/.test(w[0])) { // QUOXON-1191: /answer 1-5 y, /answer 1,3,4 y
    const ns = [];
    for (const part of w[0].split(',')) { const m = /^(\d+)(?:-(\d+))?$/.exec(part); const a = Number(m[1]); const b = Number(m[2] ?? m[1]); if (a < 1 || b < a || b - a > 199) { out.bad = true; return out; } for (let k = a; k <= b; k++) if (!ns.includes(k)) ns.push(k); }
    out.ns = ns; out.n = ns[0]; w = w.slice(1);
  }
  else if (w.length >= 2 && /^n$/i.test(w[0])) w = w.slice(1); // the hint's literal "N" is the same as no number
  else out.n = focusN;
  if (!w[0]) { out.bad = true; return out; }
  out.key = w[0].toLowerCase();
  const noteWords = w.slice(1);
  out.note = raw != null && noteWords.length
    ? cleanNote(rawTail(raw, words.length - noteWords.length))
    : cleanNote(noteWords.join(' '));
  return out;
}

const ctxOf = (it) => it?.payload?.approval_context || {};
const obOf = (it) => ctxOf(it).on_behalf_of || {};

/** Every name an item answers to as its requester (agent, session, source label). */
export function requesterNames(it) {
  const ob = obOf(it); const c = ctxOf(it);
  return [ob.agent, ob.agent_id, ob.session_name, ob.session, c.requested_by?.agent_label, c.source_label, it?.payload?.source, it?.source]
    .filter(Boolean).map(String);
}
export const isAgentItem = (it) => { const ob = obOf(it); return Boolean(ob.agent || ob.agent_id || ob.session_name || ob.session || ctxOf(it).requested_by?.agent_label); };
export const matchesAgent = (it, name) => { const n = String(name || '').toLowerCase(); return Boolean(n) && requesterNames(it).some(x => x.toLowerCase() === n || x.toLowerCase().includes(n)); };

export function ageText(iso, now = Date.now()) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return '?';
  const m = Math.max(0, Math.round((now - t) / 60000));
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

/** 'mine' | 'agents' | 'old' | <agent name> | null -> predicate. */
export function filterPredicate(f, { userId = null, conversationId = null, now = Date.now(), oldMs = 24 * 3600 * 1000 } = {}) {
  if (!f) return () => true;
  const k = String(f).toLowerCase();
  if (k === 'mine') return (it) => { const ob = obOf(it); return Boolean((userId && ob.user_id && String(ob.user_id) === String(userId)) || (conversationId && ob.conversation_id === conversationId)); };
  if (k === 'agents') return isAgentItem;
  if (k === 'old') return (it) => { const t = Date.parse(it?.created_at ?? it?.createdAt); return Number.isFinite(t) && now - t > oldMs; };
  return (it) => matchesAgent(it, f);
}

/** One line: [N] age  who  what  (risk). Clipped to `cols`. */
export function approvalRow(it, n, { cols = 100, now = Date.now() } = {}) {
  if (isDecision(it)) return decisionRow(it, n, { cols, now });
  const d = describeInboxItem(it);
  const who = requesterNames(it)[0] || approvalSourceLabel(it);
  let what = [d.tool, d.target && d.target !== d.tool ? d.target : null].filter(Boolean).join(' ') || d.title || it.id;
  const risk = ctxOf(it).risk ? ` (${ctxOf(it).risk})` : '';
  const priv = isPrivileged({ tool: d.tool, risk: ctxOf(it).risk, flag: it?.payload?.privileged === true || ctxOf(it).privileged === true, title: it.title }) ? ' [privileged]' : '';
  const cmd = commandOf(it);
  if (cmd && cmd.kind === 'command') { // APPROVAL-WWWH: the exact command and the host count, never just the tool name; the command gives way last, with a visible tail
    const { count, list } = hostsOf(it);
    const on = count > 1 ? ` on ${count} ${/ssh|exec|host|shell/i.test(String(d.tool || it?.payload?.toolName || '')) ? 'hosts' : 'targets'} (${list.slice(0, 2).join(', ')}, +${count - 2} more)` : (count === 1 ? ` on ${list[0]}` : '');
    const one = cmd.text.replace(/\s*\n\s*/g, ' ; ');
    const head = `  [${n}] ${ageText(d.at, now).padStart(3)}  ${String(who).slice(0, 18).padEnd(18)}  ${d.tool || 'run'} `;
    const room = Math.max(24, cols - head.length - on.length - risk.length - priv.length - 2);
    return `${head}\`${clipVisible(one, room, n)}\`${on}${risk}${priv}`;
  }
  const line = `  [${n}] ${ageText(d.at, now).padStart(3)}  ${String(who).slice(0, 18).padEnd(18)}  ${what}${risk}${priv}`;
  return line.length > cols ? line.slice(0, Math.max(10, cols - 1)) + '…' : line;
}

/** Full detail for /approvals N: one line per fact. */
export function approvalDetail(it, n, { now = Date.now() } = {}) {
  if (isDecision(it)) return decisionDetail(it, n, { now });
  const d = describeInboxItem(it); const c = ctxOf(it); const m = c.method || {}; const p = it?.payload || {};
  const args = m.argv ?? m.args ?? c.argv ?? c.args ?? p.args ?? null;
  const cmdFull = commandOf(it);
  const why = whyText(it) || c.why || p.reason || it?.summary || it?.description || null;
  const rc = it?.receipt || p.receipt || c.receipt || null;
  const receipt = rc ? (typeof rc === 'string' ? rc : (rc.ward_seq != null ? `ward seq ${rc.ward_seq}${rc.verified ? ' verified' : ''}` : JSON.stringify(rc).slice(0, 100))) : (it?.aee_correlation_id || p.approval_id || null);
  const rows = [
    ['item', `[${n}] ${it.title || it.id}`],
    ['id', it.id],
    ['tool', d.tool], ['target', hostsOf(it).count > 1 ? null : d.target],
    ['command', cmdFull && cmdFull.kind === 'command' ? cmdFull.text : null],
    ['args', cmdFull && cmdFull.kind === 'command' ? null : (args == null ? null : (typeof args === 'string' ? args : JSON.stringify(args)).slice(0, 300))],
    ['where', hostsOf(it).count ? whereText(it, { all: true }) : null],
    ['who', whoText(it)],
    ['why', why ? String(why) : null],
    ['request', excerptOf(it) ? `"${excerptOf(it)}"` : null],
    ['class', accessOf(it)],
    ['from', requesterNames(it).join(', ') || approvalSourceLabel(it)],
    ['asked', d.at ? `${ageText(d.at, now)} ago (${String(d.at)})` : null],
    ['risk', c.risk || null],
    ['receipt', receipt],
    ['url', it.dashboard_url || null]
  ].filter(r => r[1]);
  return rows.flatMap(([k, v]) => String(v).split('\n').map((line, i) => `  ${(i ? '' : k).padEnd(8)}${line}`));
}

/**
 * /approve|/deny arguments after the command word. Forms: N, 1,2, 1-3, all, agent <name>; deny may end with a free-text
 * reason. 'confirm' (approve only) is stripped. Returns { nums, all, agent, reason, confirm, bad }.
 */
export const NOTE_MAX = 4000;
/** The raw text after the first `skip` whitespace-separated tokens, whitespace and line breaks kept. */
export function rawTail(raw, skip) {
  const m = new RegExp(`^\\s*(?:\\S+\\s+){${Math.max(0, skip - 1)}}\\S+\\s*`).exec(String(raw ?? ''));
  return skip > 0 ? (m ? String(raw).slice(m[0].length) : '') : String(raw ?? '');
}
/** A typed note: a balanced pair of quotes is removed; an opening quote with no close just goes, and the rest stays. Nothing else is dropped. */
export function cleanNote(t) {
  let s = String(t ?? '').trim();
  const q = s[0];
  if (q === '"' || q === "'" || q === '\u201c') {
    const close = q === '\u201c' ? '\u201d' : q;
    s = s.slice(1);
    if (s.endsWith(close)) s = s.slice(0, -1);
  }
  return s.trim().slice(0, NOTE_MAX);
}

export function parseDecision(words, verb, { raw = null } = {}) {
  const out = { nums: [], all: false, agent: null, reason: '', confirm: false, bad: false };
  let w = words.slice();
  if (verb === 'approve') { out.confirm = w.includes('confirm'); w = w.filter(x => x !== 'confirm'); }
  let i = 0;
  if (w[0] && w[0].toLowerCase() === 'agent') {
    if (!w[1]) { out.bad = true; return out; }
    out.agent = w[1]; i = 2;
  } else {
    for (; i < w.length; i++) {
      const tok = w[i];
      if (tok.toLowerCase() === 'all') { out.all = true; continue; }
      if (!/^[\d,\-]+$/.test(tok)) break;
      let ok = false;
      for (const part of tok.split(',').filter(Boolean)) {
        const m = /^(\d+)(?:-(\d+))?$/.exec(part);
        if (m && Number(m[1]) >= 1 && Number(m[2] ?? m[1]) >= Number(m[1]) && Number(m[2] ?? m[1]) - Number(m[1]) < 200) { ok = true; for (let k = Number(m[1]); k <= Number(m[2] ?? m[1]); k++) out.nums.push(k); }
        else { out.bad = true; return out; }
      }
      if (!ok) { out.bad = true; return out; }
      if (out.all) break;
    }
  }
  const restWords = w.slice(i);
  const rest = restWords.join(' ').trim();
  if (rest) {
    if (verb === 'reject') out.reason = raw != null ? cleanNote(rawTail(raw, words.length - restWords.length)) : rest.slice(0, NOTE_MAX);
    else out.bad = true;
  }
  if (!out.all && !out.agent && !out.nums.length) out.bad = true;
  return out;
}

/**
 * WALKTHROUGH (owner 2026-10-17: "guide me simply one at a time, explain, advise"). One decision as one plain card.
 * Identity is the decision id, never a position. -> { lines, choices:[{key,label,word}], recommendKey, source }.
 */
const isLabelled = (o) => o.label && String(o.label).toLowerCase() !== String(o.key).toLowerCase();
const optWord = (o) => (isLabelled(o) ? o.label : `option ${o.key} (no label given)`);
/** "Type 1: <label> · Type 2: <label>" plus s to skip, for a non-yes/no decision. */
export function walkChoicesLine(it) {
  return it.payload.options.map(o => `Type ${o.key}: ${optWord(o)}`).join(' · ') + ' · Type s to skip';
}
export function walkNotYesNo(it) {
  return `This one isn't yes/no. ${walkChoicesLine(it).replace(/ · Type s to skip$/, '')}, or s to skip.`;
}
export function walkNoCatch(it) {
  const ks = it.payload.options.map(o => o.key);
  const keys = ks.length > 1 ? `${ks.slice(0, -1).join(', ')} or ${ks[ks.length - 1]}` : ks.join('');
  return `I did not catch a choice. Type ${keys}. ${walkChoicesLine(it)} (? asks about it, Esc stops).`;
}
/** A title without the asker's own name in front of it ("SEER: Publish?" asked by SEER -> "Publish?"), whitespace and line breaks folded. */
export function cleanTitle(it) {
  const p = it.payload || {}; const t = String(it.title || it.id || '').replace(/\s+/g, ' ').trim();
  for (const name of [p.session, p.agent].filter(Boolean).map(String)) {
    if (t.toLowerCase().startsWith(name.toLowerCase() + ':')) { const rest = t.slice(name.length + 1).trim(); if (rest) return rest; }
  }
  return t;
}
/** Word-wrap `text` into lines no wider than `cols`, the label on the first line and a hanging indent of the same width under it. */
export function hang(label, text, cols) {
  const lead = '  ' + label.padEnd(8); const pad = ' '.repeat(lead.length);
  if (!cols) return [lead + text];
  const room = Math.max(20, cols - lead.length - 1); const out = []; let cur = '';
  for (const w of String(text).split(' ')) {
    if (cur && cur.length + 1 + w.length > room) { out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur || !out.length) out.push(cur);
  return out.map((l, k) => (k ? pad : lead) + l);
}
/** Owner 2026-10-17: a test or guard loosening needs a plain justification. True when the title, kind or tags say the ask would make a check easier to pass. */
export const LOOSEN_RE = /loosen|weaken|relax|widen|(?:delete|remove|skip|disable|replace|rewrite|change|edit|update)\w*\s+(?:\w+\s+){0,3}?(?:tests?|guards?|checks?|assertions?|proof cases?)\b|test.?pin|goal ?post/i;
export const isLoosening = (it) => { const p = it?.payload || {}; return p.loosening === true || LOOSEN_RE.test([it?.title, p.kind, p.category, ...(Array.isArray(p.tags) ? p.tags : [])].filter(Boolean).join(' ')); };
export const NO_REASON = 'No reason given: ask the session, or say no.';
export const NO_JUSTIFICATION = 'No plain justification given: ask the session, or say no.';
const justificationOf = (p) => String(p.justification || p.plain_justification || '').replace(/\s+/g, ' ').trim();
export function walkCard(it, i, total, { cols = 0 } = {}) {
  const p = it.payload; const who = p.session || p.agent || 'A session';
  const loose = isLoosening(it); const just = justificationOf(p); // JUSTIFY shows whenever the asker gave one, loosening title or not
  const bareLoose = loose && !just; // no clear justification: "no" is the safe default and nothing is starred
  const yn = p.options.some(o => o.key === 'y') && p.options.some(o => o.key === 'n');
  const rec = bareLoose ? null : (p.options.find(o => o.key === p.recommend) || null);
  const dflt = bareLoose ? (p.options.find(o => o.key === 'n') || null) : (p.options.find(o => o.key === p.default) || null);
  const why = String(p.why || '').replace(/\s+/g, ' ').trim();
  const what = yn
    ? `Yes lets ${who} go ahead with this; no stops it.${p.high_risk ? ' High risk: a yes needs your PIN.' : ''}`
    : `${who} needs you to choose how to settle this.${p.high_risk ? ' High risk: a yes needs your PIN.' : ''}`;
  const advice = bareLoose
    ? `${yn ? 'I would say no' : 'Do not approve this yet'}: this makes a check easier to pass and nothing explains why that is safe.${dflt ? ` Safe default: ${optWord(dflt)} (${dflt.key}).` : ''}`
    : rec
    ? `I would ${yn ? (rec.key === 'y' ? 'say yes' : 'say no') : `go with ${optWord(rec)} (${rec.key})`}. The asker recommended it.`
    : `${who} gave no recommendation, and I will not guess one.${dflt ? ` If nobody answers it would take ${optWord(dflt)} (${dflt.key}).` : ''}`;
  const keyClash = (k) => p.options.some(o => o.key === k);
  const choices = [
    ...p.options.map(o => ({ key: o.key, label: optWord(o), word: yn ? (o.key === 'y' ? 'Yes' : o.key === 'n' ? 'No' : optWord(o)) : optWord(o) })),
    { key: keyClash('s') ? 'skip' : 's', label: 'Skip for now', defer: true },
    { key: keyClash('?') ? 'ask' : '?', label: 'Ask about it', ask: true },
  ];
  const lines = [
    `Decision ${i} of ${total} · ${who} asks`,
    ...hang('', cleanTitle(it), cols).map(l => l.slice(8)),
    ...hang('WHAT', what, cols),
    ...(why ? hang('WHY', why, cols) : []),
    ...(loose || just ? hang('JUSTIFY', just || NO_JUSTIFICATION, cols) : []),
    ...(!why && !just && !loose ? hang('WHY', NO_REASON, cols) : []),
    ...hang('ADVICE', advice, cols),
  ];
  // RECO-HIGHLIGHT: a real recommendation is its own first line (the TUI paints it bold in the accent colour), marked in text so a no-colour terminal still sees it.
  let recoLine = null;
  if (rec) { recoLine = lines.length; lines.push(`  ★ [${rec.key}] ${optWord(rec)}  ★ recommended by ${recommenderOf(p)}`); }
  lines.push('  ' + choices.filter(c => !(rec && c.key === rec.key)).map(c => `[${c.key}] ${c.label}`).join('  ')); // the recommended key is on the star line above: each key is offered once
  return { lines, choices, recommendKey: rec ? rec.key : null, recoLine, displayKeys: displayOptions(p).map(o => o.key), source: rec ? 'asker' : null };
}

/** The reply to a walkthrough card -> { key, note } | { defer:true } | { ask:true } | null. "y because X": text after the choice is the note, kept in full. */
export function walkReply(it, text) {
  const p = it.payload; const raw = String(text ?? '').trim();
  if (!raw) return null;
  const yn = p.options.some(o => o.key === 'y') && p.options.some(o => o.key === 'n');
  const notYesNo = !yn;
  const first = raw.split(/\s+/)[0]; const f = first.toLowerCase().replace(/[.!,]+$/, '');
  const note = () => cleanNote(rawTail(raw, 1));
  const hasKey = (k) => p.options.some(o => o.key.toLowerCase() === k);
  if (hasKey(f)) return { key: p.options.find(o => o.key.toLowerCase() === f).key, note: note() };
  if (/^(skip|s|later|next)$/.test(f)) return { defer: true };
  if (f === '?' || /^(ask|why|explain|help)$/.test(f)) return { ask: true };
  if (/^(yes|yep|yeah|ok|okay)$/.test(f)) return yn ? { key: 'y', note: note() } : (notYesNo ? { notYesNo: true } : null);
  if (/^(no|nope)$/.test(f)) return yn ? { key: 'n', note: note() } : { notYesNo: true };
  const t = raw.toLowerCase().replace(/[.!]+$/, '');
  const hit = p.options.find(o => isLabelled(o) && t.startsWith(String(o.label).toLowerCase()));
  return hit ? { key: hit.key, note: cleanNote(raw.slice(String(hit.label).length)) } : null;
}

/** The end summary of a walkthrough. state = { answered:[{title,word}], skipped:[title], left:[title] } */
export function walkSummary(st) {
  const out = [`Walkthrough done: ${st.answered.length} answered, ${st.skipped.length} skipped, ${st.left.length} left.`];
  for (const a of st.answered) out.push(`  ✔ ${a.title}: ${a.word}`);
  for (const t of st.skipped) out.push(`  ↷ skipped: ${t}`);
  for (const t of st.left) out.push(`  · still waiting: ${t}`);
  return out;
}
