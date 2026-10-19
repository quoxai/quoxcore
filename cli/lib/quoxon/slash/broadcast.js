/**
 * QUOXON-BROADCAST: pure helpers for /broadcast, /page and /ack (and `quox slot broadcast`).
 * No I/O. v1 scope: all held slots or --slots, --priority urgent, --ack, /page. Scheduling, voice,
 * fleet and org reach, bulletins and drafting are not built.
 */
export const BROADCAST_USAGE = 'Usage: /broadcast [--slots a,b] [--priority urgent] [--ack] <text>';
export const PAGE_USAGE = 'Usage: /page <slot> <text>';
const NOT_YET = new Set(['--fleet', '--org', '--voice', '--at']);

/**
 * -> { ok:true, text, slots|null, priority, ack } | { ok:false, message }.
 * Flags may come before the text; `--all` is accepted (the default). `--priority=urgent` also works.
 */
export function parseBroadcastArgs(arg) {
  const toks = String(arg || '').trim().split(/\s+/).filter(Boolean);
  let slots = null; let priority = 'normal'; let ack = false;
  let i = 0;
  for (; i < toks.length && toks[i].startsWith('--'); i += 1) {
    const [flag, inline] = toks[i].split(/=(.*)/s);
    if (NOT_YET.has(flag)) return { ok: false, message: `${flag} is not available yet (v1 sends to held slots in this org: --slots, --priority, --ack).` };
    if (flag === '--all') { slots = null; continue; }
    if (flag === '--ack') { ack = true; continue; }
    const val = inline !== undefined ? inline : toks[++i];
    if (flag === '--slots') {
      const list = String(val || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (!list.length) return { ok: false, message: '--slots needs a comma-separated list, e.g. --slots provisioner,quox2' };
      slots = list; continue;
    }
    if (flag === '--priority') {
      if (val !== 'urgent' && val !== 'normal') return { ok: false, message: '--priority is urgent or normal' };
      priority = val; continue;
    }
    return { ok: false, message: `unknown flag ${flag}. ${BROADCAST_USAGE}` };
  }
  const text = toks.slice(i).join(' ');
  if (!text) return { ok: false, message: BROADCAST_USAGE };
  return { ok: true, text, slots, priority, ack };
}

/** `/page <slot> <text>` -> urgent, ack-required, one recipient. */
export function parsePageArgs(arg) {
  const m = /^(\S+)\s+([\s\S]*\S[\s\S]*)$/.exec(String(arg || '').trim());
  if (!m || m[1].startsWith('--')) return { ok: false, message: PAGE_USAGE };
  return { ok: true, text: m[2].trim(), slots: [m[1].toLowerCase()], priority: 'urgent', ack: true };
}

const plural = (n) => (n === 1 ? 'session' : 'sessions');
const NAMES_SHOWN = 5;
const okSlots = (r) => (r.deliveries || []).filter((d) => d.status === 'delivered' || d.status === 'queued'); // RESTORE-TUI: queued has it (older servers)
const badSlots = (r) => (r.deliveries || []).filter((d) => d.status === 'failed' || d.status === 'unknown');
const roomC = (r) => ({ sent: 0, sending: 0, failed: 0, ...(r?.counts?.room || {}) });
const isAck = (r) => !!(r?.ack ?? r?.ack_required);
const namesRow = (r) => {
  const n = okSlots(r).map((d) => d.slot);
  return n.length > NAMES_SHOWN ? `${n.slice(0, NAMES_SHOWN).join(' ')} +${n.length - NAMES_SHOWN}` : n.join(' ');
};
const roomText = (rc, sep) => [rc.sent && `${rc.sent} sent`, rc.sending && `${rc.sending} sending`, rc.failed && `${rc.failed} failed`].filter(Boolean).join(sep);
const failText = (d) => `${d.slot}: ${d.status}${d.detail ? ` (${d.detail})` : ''}`;
const titleWord = (r) => {
  const c = r?.counts || {};
  if (!c.total) return 'not sent';
  if (!c.delivered) return 'not sent';
  return c.failed ? 'partly sent' : 'sent';
};

/**
 * The sender's delivery card as data: { title, tone, rows: [[[text, role], ...], ...], foot }.
 * Roles are theme roles: ok (green), warn (gold), error (red), prose. Rendered by render.js (framed) or
 * flattened to text. "delivered" means the line is in the slot; the chat-room copy is its own row.
 */
export function broadcastCard(r, { kind = 'broadcast' } = {}) {
  const c = r?.counts || {};
  const rc = roomC(r);
  const rows = [];
  if (!c.total) rows.push([['\u26A0 no held slots in this org to hear it', 'warn']]);
  else if (c.delivered) {
    rows.push([[`\u2714 ${c.delivered} ${c.delivered === 1 ? 'session has' : 'sessions have'} it`, 'ok']]);
    if (namesRow(r)) rows.push([[namesRow(r), 'prose']]); // an older server sends no per-slot list: no empty row
  }
  for (const d of badSlots(r).slice(0, 3)) rows.push([[`\u2716 ${failText(d)}`, 'error']]);
  if (badSlots(r).length > 3) rows.push([[`\u2716 +${badSlots(r).length - 3} more failed`, 'error']]);
  if (c.delivered && roomText(rc, ' ')) rows.push([[`chat rooms: ${roomText(rc, ' \u00B7 ')}`, rc.failed ? 'error' : rc.sending ? 'warn' : 'ok']]);
  if (isAck(r) && c.delivered) rows.push([[`acknowledged ${c.acknowledged || 0} / ${c.delivered}`, c.awaiting ? 'warn' : 'ok']]);
  const tone = !c.total || (!c.delivered && !c.failed) ? 'warn' : c.failed || !c.delivered ? 'error' : 'ok';
  return {
    title: `\u{1F4E3} ${kind === 'page' ? 'PAGE' : 'BROADCAST'} ${titleWord(r)}`,
    tone, rows, foot: `${r.id} \u00B7 /broadcast status <id>`,
    narrow: broadcastNarrow(r),
  };
}

/** One line for narrow terminals. */
export function broadcastNarrow(r) {
  const c = r?.counts || {};
  const rc = roomC(r);
  if (!c.total) return '\u{1F4E3} no held slots to hear it \u26A0';
  const rooms = `(rooms ${rc.sent}/${c.delivered})`;
  if (c.failed) return `\u{1F4E3} sent to ${c.delivered} of ${c.total} ${plural(c.total)} \u2716 ${c.failed} failed ${rooms}`;
  const ack = isAck(r) ? ` \u00B7 acked ${c.acknowledged || 0}/${c.delivered}` : '';
  return `\u{1F4E3} sent to ${c.delivered} ${plural(c.delivered)} \u2714 ${rooms}${ack}`;
}

/** The same facts as plain text lines [[text, tone]] (CLI output, and the TUI when no card surface is wired). */
export function broadcastSummary(r) {
  const c = r?.counts || {};
  const rc = roomC(r);
  const lines = [];
  if (!c.total) return [[`Broadcast ${r.id}: no held slots in this org to hear it.`, 'warn']];
  lines.push([`Broadcast ${r.id} ${titleWord(r)}: ${(c.delivered || 0) + (c.queued || 0)} of ${c.total} ${plural(c.total)} have it${okSlots(r).length ? ` (${okSlots(r).map((d) => d.slot).join(', ')})` : ''}`, c.failed ? 'warn' : 'plain']);
  if (c.delivered && roomText(rc, ', ')) lines.push([`  chat rooms: ${roomText(rc, ', ')}`, rc.failed ? 'warn' : 'plain']);
  for (const d of badSlots(r)) lines.push([`  ${failText(d)}`, 'warn']);
  if (isAck(r) && c.delivered) lines.push([`  acknowledged ${c.acknowledged || 0} / ${c.delivered}. Check: quox slot broadcast-status ${r.id}`, 'plain']);
  return lines;
}

/** The sender's live line: "Broadcast delivery: delivered N / acknowledged M / awaiting K". */
export function deliveryLine(st) {
  const c = st?.counts || {};
  const base = `Broadcast delivery: delivered ${(c.delivered || 0) + (c.queued || 0)}`; // RESTORE-TUI: an older server still counts queued separately; queued has it too
  return st?.ack_required ? `${base} / acknowledged ${c.acknowledged || 0} / awaiting ${c.awaiting || 0}` : base;
}

/** `/broadcast status <id>` -> { id } | null (anything else after "status" is just message text). */
export function parseStatusArgs(arg) {
  const m = /^status\s+(bc_[0-9a-f]+)\s*$/.exec(String(arg || '').trim());
  return m ? { id: m[1] } : null;
}

const BC_RE = /^(\u{1F6A8} URGENT|\u{1F4E3}) BROADCAST from ([^\n]*?): ([\s\S]*?)(?:\n\(ack with \/ack (bc_[0-9a-f]+)\))?$/u;
/** Recognise a broadcast line in the slot stream -> { urgent, sender, text, ackId } | null. */
export function parseBroadcastText(text) {
  const m = BC_RE.exec(String(text || ''));
  return m ? { urgent: m[1] !== '\u{1F4E3}', sender: m[2], text: m[3], ackId: m[4] || null } : null;
}

export const ACK_USAGE = 'Usage: /ack <broadcast id>';
export function parseAckArgs(arg) {
  const id = String(arg || '').trim();
  return /^bc_[0-9a-f]+$/.test(id) ? { ok: true, id } : { ok: false, message: ACK_USAGE };
}
