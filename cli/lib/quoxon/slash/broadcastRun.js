/**
 * QUOXON-BROADCAST: the I/O half of /broadcast, /page and /ack. app.js adds only switch cases that call these.
 * One server call fans out (POST /api/v1/slots/broadcast); with --ack the sender then sees the delivery line
 * update as recipients acknowledge. The poll is display only: the broadcast and its acks live on the server.
 */
import { parseBroadcastArgs, parsePageArgs, parseAckArgs, parseStatusArgs, broadcastSummary, broadcastCard, BROADCAST_USAGE } from './broadcast.js';

const roomC = (r) => ({ sent: 0, sending: 0, failed: 0, ...(r?.counts?.room || {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runBroadcast({ api, kind, arg, from, say, card = null, isClosed = () => false, pollMs = 4000, maxPolls = 30 }) {
  if (!api.slotBroadcast) return say('Broadcast is not available in this mode.', 'warn');
  const show = (data) => {
    if (card) return card(broadcastCard(data, { kind }));
    for (const [line, tone] of broadcastSummary(data)) say(line, tone);
    return undefined;
  };
  const st0 = kind === 'page' ? null : parseStatusArgs(arg);
  if (st0) {
    const st = api.slotBroadcastStatus ? await api.slotBroadcastStatus(st0.id) : { ok: false, message: 'not available in this mode' };
    return st.ok ? show(st.data) : say(`Broadcast status failed: ${st.message}`, 'warn');
  }
  const parsed = kind === 'page' ? parsePageArgs(arg) : parseBroadcastArgs(arg);
  if (!parsed.ok) return say(parsed.message, parsed.message === BROADCAST_USAGE ? 'plain' : 'warn');
  const r = await api.slotBroadcast({ text: parsed.text, slots: parsed.slots, priority: parsed.priority, ack: parsed.ack, from });
  if (!r.ok) return say(`${kind === 'page' ? 'Page' : 'Broadcast'} failed: ${r.message}`, 'warn');
  show(r.data);
  // PRESENCE: it reached a human slot whose human is away; approvals to them will queue.
  if (r.data?.human_presence?.away && r.data.human_presence.notice) say(`⏸ ${r.data.human_presence.notice}`, 'warn');
  // POKE-WAKE: a page also asks each delivered slot's keeper to wake its idle session, so the page is read now,
  // not at the session's next prompt. Runs beside the ack display; the page stands whatever the wake says.
  const wakes = kind === 'page' && api.slotControl
    ? Promise.all((r.data.deliveries || []).filter((d) => d.status === 'delivered').map((d) => runWake({ api, slot: d.slot, say, isClosed, pollMs: Math.max(pollMs, 1), maxPolls: 15 }).catch(() => {})))
    : null;
  const done = async (v) => { if (wakes) await wakes; return v; };
  if (!api.slotBroadcastStatus || !r.data.counts?.delivered) return done(undefined);
  // The card is history (printed once), so what changes afterwards arrives as short lines: acks as they come in,
  // and one line when the chat-room copies settle. Display only: the broadcast and its acks live on the server.
  let lastAck = r.data.counts.acknowledged ?? null;
  let roomsDone = !roomC(r.data).sending;
  const ackWanted = parsed.ack && r.data.counts.awaiting > 0;
  if (roomsDone && !ackWanted) return done(undefined);
  for (let i = 0; i < maxPolls && !isClosed(); i += 1) {
    await sleep(pollMs);
    let st = null;
    try { st = await api.slotBroadcastStatus(r.data.id); } catch { st = null; }
    if (!st?.ok) continue;
    const c = st.data.counts || {};
    const rc = roomC(st.data);
    if (!roomsDone && !rc.sending) {
      roomsDone = true;
      say(rc.failed ? `chat rooms: ${rc.sent} sent, ${rc.failed} failed` : `chat rooms: all ${rc.sent} sent`, rc.failed ? 'warn' : 'ok');
    }
    if (parsed.ack && c.acknowledged !== undefined && c.acknowledged !== lastAck) {
      lastAck = c.acknowledged;
      say(`acknowledged ${c.acknowledged} / ${c.delivered}`, c.awaiting ? 'plain' : 'ok');
    }
    if (roomsDone && !(parsed.ack && c.awaiting)) return done(undefined);
  }
  return done(undefined);
}

/**
 * FORCE-WAKE: `/poke|/wake|/slap|/nudge <slot> [text]`. `--force` is accepted anywhere as a no-op (every human
 * wake already sets an unsent draft aside and puts it back) and is never page text. null = no slot given.
 */
export function parsePokeArgs(restArg) {
  const s = String(restArg || '').replace(/(^|\s)--force(?=\s|$)/g, '$1').trim();
  const m = /^(\S+)(?:\s+([\s\S]+))?$/.exec(s);
  return m ? { slot: m[1], text: m[2] ? m[2].trim() : null } : null;
}

/**
 * POKE-WAKE: ask the slot's keeper to wake its session (slot control `wake`, human admin only, server-side).
 * The keeper types one fixed "read your slot" line at an empty prompt; never the page text. Display only.
 */
export async function runWake({ api, slot, say, isClosed = () => false, pollMs = 4000, maxPolls = 15 }) {
  const r = await api.slotControl(slot, 'wake');
  if (!r?.ok) {
    if (r?.status === 403) return say(`${slot}: waking a session needs an org owner or admin; the page waits for its next check`, 'warn');
    if (r?.status === 400) return say(`${slot}: this server does not support wake yet; the page waits for its next check`, 'warn');
    if (r?.status === 409) return say(`${slot}: nobody holds this slot, so there is no session to wake`, 'warn');
    return say(`${slot}: wake request failed (${r?.message || 'failed'}); the page waits for its next check`, 'warn');
  }
  const id = r.data?.control_id;
  if (!id || !api.slotControlGet) return say(`${slot}: wake requested`, 'plain');
  for (let i = 0; i < maxPolls && !isClosed(); i += 1) {
    await sleep(pollMs);
    let g = null;
    try { g = await api.slotControlGet(slot, id); } catch { g = null; }
    const st = g?.ok ? g.data?.status : null;
    // WAKE-REAL: the waker is told which happened: a turn started, or Claude Code queued it mid-turn.
    if (st === 'done' && /^queued\b/.test(String(g.data.result || ''))) return say(`${slot} ${g.data.result}`, 'ok');
    if (st === 'done') return say(`${slot} woken: ${g.data.result || 'done'}`, 'ok');
    if (st === 'failed') return say(`${slot} not woken: ${String(g.data.result || 'failed').replace(/^not woken:\s*/, '')}`, 'warn');
  }
  return say(`${slot} not woken yet: it is mid-turn, so its keeper wakes it as soon as the turn ends (retrying up to 10m), or its keeper is not running (/slot status ${slot})`, 'warn');
}

export async function runAck({ api, arg, slot, say }) {
  const a = parseAckArgs(arg);
  if (!a.ok) return say(a.message, 'warn');
  if (!slot) return say('/ack answers as the slot this window holds; hold one with /slot <name>.', 'warn');
  if (!api.slotAck) return say('Broadcast is not available in this mode.', 'warn');
  const r = await api.slotAck(a.id, slot);
  if (!r.ok) return say(`ack failed: ${r.message}`, 'warn');
  return say(`Acknowledged ${a.id} as ${slot}.`, 'plain');
}
