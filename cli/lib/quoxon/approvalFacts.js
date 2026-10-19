// APPROVAL-WWWH (owner 2026-10-16 "why? what command for 17 hosts! insufficient info to authorise. who?? what? why???"):
// the four facts an approver needs, read from the item and nothing else: WHAT (the exact command or tool input), WHERE
// (host count and names), WHO (the delegation chain and the human it acts for) and WHY (reason, the user's own words,
// when). Pure, so the card, the /approvals row and /approvals N detail cannot drift apart.

export const CMD_CARD_MAX = 400;
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : (() => { try { return JSON.stringify(v); } catch { return String(v); } })());

/** Text cut at `max` with a visible, honest tail. `n` is the /approvals number when known. */
export function clipVisible(text, max, n = null) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)} (+${s.length - max} chars, /approvals ${n ?? 'N'} detail for full)`;
}

/** The exact command or tool input, verbatim: method.command, else the reach request, else args. */
export function commandOf(it) {
  const p = it?.payload || {}; const c = p.approval_context || {}; const m = c.method || {};
  if (typeof m.command === 'string' && m.command) return { text: m.command, kind: 'command' };
  const rq = (p.reach?.requests || []).find(r => r && r.kind === 'command' && typeof r.id === 'string' && r.id);
  if (rq) return { text: rq.id, kind: 'command' };
  const a = m.args ?? c.args ?? p.args ?? null;
  if (a != null && a !== '') return { text: str(a), kind: 'input' };
  return null;
}

/** Hosts (or other comma-separated targets) with the count. The full target string wins over the clipped what.target. */
export function hostsOf(it) {
  const p = it?.payload || {}; const c = p.approval_context || {};
  const raw = [c.method?.target, c.target, p.targetId, p.what?.target].find(v => typeof v === 'string' && v.trim() && !v.trim().endsWith('…')) || p.what?.target || '';
  const list = String(raw).split(',').map(x => x.trim()).filter(Boolean);
  return { list, count: list.length };
}

/** "17 hosts: a, b, c (+14 more, /approvals N detail for all)". `all` lists every name. */
export function whereText(it, { all = false, first = 3, n = null } = {}) {
  const { list, count } = hostsOf(it);
  if (!count) return null;
  if (count === 1) return list[0];
  const tool = String(it?.payload?.toolName || it?.payload?.approval_context?.method?.tool || '');
  const w = /ssh|exec|host|shell/i.test(tool) ? 'hosts' : 'targets';
  if (all) return `${count} ${w}: ${list.join(', ')}`;
  const shown = list.slice(0, first).join(', ');
  return count > first ? `${count} ${w}: ${shown} (+${count - first} more, /approvals ${n ?? 'N'} detail for all)` : `${count} ${w}: ${shown}`;
}

/** Read-only or write, only as the server classified it. Null when it did not say. */
export function accessOf(it) {
  const c = it?.payload?.approval_context || {};
  const k = c.method?.access || c.access;
  if (k === 'read_only' || k === 'read') return 'read-only';
  if (k === 'write') return 'write';
  const lab = String(c.why_approval?.label || '');
  if (/not on the read-only allowlist/i.test(lab)) return 'NOT read-only: not on the read-only allowlist, so it may change things';
  return null;
}

/** WHO: "QUOX → SENTINEL (session claude in app) for Adam DEV SERVER". */
export function whoText(it) {
  const c = it?.payload?.approval_context || {}; const rb = c.requested_by || {}; const ob = c.on_behalf_of || {};
  const chain = Array.isArray(rb.delegation_chain) && rb.delegation_chain.length ? rb.delegation_chain.join(' → ') : (rb.agent_label || c.source_label || null);
  const caller = rb.caller?.name || rb.session_label || null;
  const via = [caller && `via ${rb.caller?.kind === 'session' || rb.session_label ? 'session ' : ''}${caller}`, rb.surface_label && `${rb.surface_label}`, rb.profile && `profile ${rb.profile}`].filter(Boolean).join(', ');
  const forWhom = ob.user_name || ob.user_id || null;
  const head = [chain, via && `(${via})`].filter(Boolean).join(' ');
  if (!head && !forWhom) return null;
  return `${head || 'unknown requester'}${forWhom ? ` acting for ${forWhom}` : ''}`;
}

/** WHY: the reason text (marked inferred when the caller did not state it). */
export function whyText(it) {
  const c = it?.payload?.approval_context || {}; const r = c.reason;
  if (r && typeof r === 'object') return r.text ? `${r.text}${r.source === 'inferred' ? ' (inferred, not stated by the caller)' : ''}` : null;
  return r || it?.payload?.reason || null;
}

/** The user's own words that started this, when the server kept them. */
export const excerptOf = (it) => it?.payload?.approval_context?.on_behalf_of?.request_excerpt || null;

/** One bag of the facts, for the card. */
export function approvalFacts(it, { n = null } = {}) {
  const cmd = commandOf(it);
  const when = it?.payload?.approval_context?.created_at || it?.created_at || it?.createdAt || null;
  return {
    command: cmd ? { ...cmd, shown: clipVisible(cmd.text, CMD_CARD_MAX, n) } : null,
    where: whereText(it, { n }),
    hostList: hostsOf(it).list,
    who: whoText(it),
    why: whyText(it),
    asked: excerptOf(it),
    when: when ? String(when).replace('T', ' ').slice(0, 16) + ' UTC' : null,
    access: accessOf(it)
  };
}
