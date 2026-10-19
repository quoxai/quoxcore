/**
 * `quox active` / TUI `/active` (QUOXON-1208, owner: "summary of who is doing what"). ONE simplified list over the
 * org session index (GET /api/v1/sessions: tmux sessions, held slots, residents, work, working chats), one line per
 * active worker, newest activity first, grouped Working / Waiting on you / Idle (+ Failing when there is any).
 * Real data only: a worker's "doing" text is what the index carries (its state reason, slot, agent), never invented;
 * a source the index could not read is named in one line. Pure: activeLines(index, opts) -> [{ text, tone }].
 */
import { formatAge } from './claudeLs.js';

export const ACTIVE_KINDS = ['sessions', 'slots', 'agents'];
export const PER_GROUP = 10;
export const ASLEEP_AFTER_S = 6 * 3600; // a resting worker with no activity for this long reads as asleep

const clip = (v, n) => { const a = [...String(v ?? '')]; return a.length > n ? a.slice(0, n - 1).join('') + '…' : String(v ?? ''); };
const t = (r) => { const x = Date.parse(r.last_active); return Number.isFinite(x) ? x : -Infinity; };

/** Which filter(s) a row belongs to. sessions = terminal sessions, slots = held slots, agents = residents or agent-attached rows. */
export function rowKinds(r) {
  const k = new Set();
  if (r.kind === 'tmux') k.add('sessions');
  if (r.kind === 'slot') k.add('slots');
  if (r.kind === 'resident' || r.agent) k.add('agents');
  return k;
}

function doing(r) {
  const bits = [];
  if (r.state_reason) bits.push(String(r.state_reason).replace(/\s+/g, ' ').trim());
  if (r.kind === 'tmux' && r.backend) bits.push(`${r.backend} session`);
  else if (r.kind === 'slot') bits.push('holding a slot');
  else if (r.kind === 'conversation') bits.push('chat');
  else if (r.kind) bits.push(r.kind);
  if (r.slot && r.kind !== 'slot') bits.push(`slot ${r.slot}`);
  if (r.agent) bits.push(`agent ${r.agent}`);
  return bits.length ? bits.join(', ') : 'no activity detail recorded';
}

function stateWord(r, ageS) {
  if (r.state === 'working') return 'working';
  if (r.state === 'waiting') return 'waiting on you';
  if (r.state === 'failing') return 'failing';
  if (ageS != null && ageS >= ASLEEP_AFTER_S) return 'asleep';
  return ageS != null ? `idle ${formatAge(ageS)}` : 'idle';
}

/** -> { rows: [{ name, doing, state, group, since, ts, kinds }], groups: {working, waiting, failing, idle}, down: [..] } */
export function prepareActive(index, { filter = null, now = Date.now() } = {}) {
  const rows = (index?.rows || (index?.groups || []).flatMap((g) => g.rows) || [])
    .filter((r) => r.kind !== 'conversation' || r.state === 'working' || r.state === 'waiting')
    .filter((r) => !filter || rowKinds(r).has(filter))
    .sort((a, b) => t(b) - t(a))
    .map((r) => {
      const ts = t(r);
      const ageS = Number.isFinite(ts) ? Math.max(0, (now - ts) / 1000) : null;
      const group = r.state === 'working' ? 'working' : r.state === 'waiting' ? 'waiting' : r.state === 'failing' ? 'failing' : 'idle';
      const name = r.kind === 'slot' ? (r.holder_session || r.name || '(unnamed slot)') : (r.name || '(unnamed)');
      return { name, doing: doing(r), state: stateWord(r, ageS), group, since: ageS == null ? 'no activity recorded' : `${formatAge(ageS)} ago`, ts };
    });
  const groups = { working: [], waiting: [], failing: [], idle: [] };
  for (const r of rows) groups[r.group].push(r);
  const down = (index?.sources || []).filter((s) => s.state !== 'connected');
  return { rows, groups, down };
}

const TITLES = { working: 'Working', waiting: 'Waiting on you', failing: 'Failing', idle: 'Idle' };
const TONES = { working: 'ok', waiting: 'warn', failing: 'warn', idle: 'dim' };

export function activeLines(index, { filter = null, now = Date.now(), all = false } = {}) {
  const p = prepareActive(index, { filter, now });
  const out = [{ text: `Active${filter ? ` ${filter}` : ''}: ${p.rows.length} · ${p.groups.working.length} working · ${p.groups.waiting.length} waiting on you · ${p.groups.idle.length} idle${p.groups.failing.length ? ` · ${p.groups.failing.length} failing` : ''}`, tone: 'accent' }];
  if (!p.rows.length) out.push({ text: p.down.some((s) => s.state !== 'unavailable') ? 'Nothing to show (see the sources below).' : `No active ${filter || 'workers'} in this org.`, tone: 'dim' });
  for (const g of ['working', 'waiting', 'failing', 'idle']) {
    const rs = p.groups[g];
    if (!rs.length) continue;
    out.push({ text: `${TITLES[g]} (${rs.length})`, tone: 'accent' });
    for (const r of all ? rs : rs.slice(0, PER_GROUP)) out.push({ text: `  ${clip(r.name, 28).padEnd(28)} ${clip(r.doing, 44).padEnd(44)} ${r.state}, ${r.since}`, tone: TONES[g] });
    if (!all && rs.length > PER_GROUP) out.push({ text: `  +${rs.length - PER_GROUP} more`, tone: 'dim' });
  }
  // 'unavailable' is a source the server declares it does not list yet (residents): an expected absence, not a failed read.
  // Only a real fault (error, timeout) is "could not read". Residents that hold a slot already show up as rows above.
  const failed = p.down.filter((s) => s.state !== 'unavailable');
  const absent = p.down.filter((s) => s.state === 'unavailable');
  if (failed.length) out.push({ text: `could not read: ${failed.map((s) => `${s.id} (${s.state}${s.note ? `: ${s.note}` : ''})`).join(' · ')}`, tone: 'warn' });
  if (absent.length) out.push({ text: `not listed separately yet: ${absent.map((s) => s.id).join(' · ')} (shown above when they hold a slot)`, tone: 'dim' });
  return out;
}

// ---- TUI /active: one clean row per session -------------------------------------------------------------
const GLYPH = { working: '◐', waiting: '⚠', failing: '✖', idle: '·' };
const RANK = { waiting: 0, failing: 1, working: 2, idle: 3 };
const TUI_TONES = { working: undefined, waiting: undefined, failing: undefined, idle: undefined }; // the row's own glyph carries status; a tone would prefix a second glyph on every wrapped line
const GROUP_TITLES = { waiting: 'Waiting on you', failing: 'Failing', working: 'Working', idle: 'Idle' };

/** "resident:dev-host-01" -> { name: 'dev-host-01', tag: 'resident' }: the machine prefix becomes a readable tag. */
function readableName(raw) {
  const m = String(raw).match(/^(resident|agent|slot|tmux):(.+)$/i);
  return m ? { name: m[2], tag: m[1].toLowerCase() } : { name: String(raw), tag: null };
}
const humanReason = (reason) => String(reason || '').replace(/\s+/g, ' ').trim().replace(/^unread slot messages?$/i, 'unread messages');

/** Word-wrap `rest` after `first`; continuation lines get a 4-space hanging indent. Never clips, never exceeds `width`. */
function wrapHanging(first, rest, width, sep = '  ') {
  const out = [];
  let cur = first, fresh = true; // fresh: only the label is on this line so far
  for (const w of String(rest).split(/\s+/).filter(Boolean)) {
    const joined = fresh ? `${cur}${sep}${w}` : `${cur} ${w}`;
    if ([...joined].length <= width) { cur = joined; fresh = false; continue; }
    out.push(cur); cur = `    ${w}`; fresh = false;
  }
  out.push(cur);
  return out;
}

/**
 * The window's /active: one row per session (deduped by readable name; the row that needs you wins), shaped
 * `  <glyph> <name>  <what it needs> · <age>`, word-wrapped under a hanging indent at `cols`, never clipped, grouped
 * Waiting on you / Failing / Working / Idle. The `quox active` CLI keeps activeLines(); this is the TUI-only view.
 */
export function activeRows(index, { now = Date.now(), cols = 80, filter = null, unread = null } = {}) {
  const raw = (index?.rows || (index?.groups || []).flatMap((g) => g.rows) || [])
    .filter((r) => r.kind !== 'conversation' || r.state === 'working' || r.state === 'waiting')
    .filter((r) => !filter || rowKinds(r).has(filter));
  const byName = new Map();
  for (const r of raw) {
    const base = r.kind === 'slot' ? (r.holder_session || r.name || '(unnamed slot)') : (r.name || '(unnamed)');
    const { name, tag } = readableName(base);
    const ts = t(r), ageS = Number.isFinite(ts) ? Math.max(0, (now - ts) / 1000) : null;
    const group = r.state === 'working' ? 'working' : r.state === 'waiting' ? 'waiting' : r.state === 'failing' ? 'failing' : 'idle';
    const needs = [];
    let why = humanReason(r.state_reason);
    const nUnread = unread && (unread.get?.(r.kind === 'slot' ? (r.name || '') : (r.slot || '')) ?? null); // optional per-slot count from the slots list
    if (why === 'unread messages' && nUnread > 0) why = `${nUnread} unread message${nUnread === 1 ? '' : 's'}`;
    if (why) needs.push(why);
    else needs.push(group === 'idle' ? (ageS != null && ageS >= ASLEEP_AFTER_S ? 'asleep' : 'idle') : group);
    if (r.kind === 'slot') needs.push('holding a slot'); else if (r.slot) needs.push(`holding slot ${r.slot}`);
    if (r.agent) needs.push(`agent ${r.agent}`);
    const cand = { name, tag: tag || (r.kind === 'resident' ? 'resident' : null), group, needs, ageS, ts };
    const key = name.toLowerCase(), old = byName.get(key);
    if (!old) { byName.set(key, cand); continue; }
    const better = RANK[cand.group] < RANK[old.group] || (RANK[cand.group] === RANK[old.group] && cand.ts > old.ts);
    const win = better ? cand : old, lose = better ? old : cand;
    const hasUnread = win.needs.some((n) => /unread/.test(n));
    win.needs = [...new Set([...win.needs, ...lose.needs.filter((n) => !/^(working|idle|asleep|failing)$/.test(n) && !(hasUnread && /unread/.test(n)) && !(/^holding a slot$/.test(n) && win.needs.some((x) => /^holding/.test(x))))])];
    win.tag = win.tag || lose.tag;
    byName.set(key, win);
  }
  const rows = [...byName.values()].sort((a, b) => RANK[a.group] - RANK[b.group] || b.ts - a.ts);
  const n = (g) => rows.filter((r) => r.group === g).length;
  const width = Math.max(30, cols - 4);
  const hdr = `${rows.length} · ${n('waiting')} need you · ${n('working')} working · ${n('idle')} idle${n('failing') ? ` · ${n('failing')} failing` : ''}`;
  const out = wrapHanging(`Active${filter ? ` ${filter}` : ''}:`, hdr, width, ' ').map((text) => ({ text, tone: 'accent' }));
  if (!rows.length) out.push({ text: `No active ${filter || 'workers'} in this org.`, tone: undefined });
  let last = null;
  for (const r of rows) {
    if (r.group !== last) { last = r.group; out.push({ text: `${GROUP_TITLES[r.group]} (${n(r.group)})`, tone: 'accent' }); }
    const label = `${r.name}${r.tag ? ` (${r.tag})` : ''}`;
    const what = `${r.needs.join(' · ')}${r.ageS == null ? '' : ` · ${formatAge(r.ageS)} ago`}`;
    for (const text of wrapHanging(`  ${GLYPH[r.group]} ${label}`, what, width)) out.push({ text, tone: TUI_TONES[r.group] });
  }
  // a source that could not be read is never an empty org: name it ('unavailable' is an expected absence, not a fault)
  const failed = (index?.sources || []).filter((x) => x.state !== 'connected' && x.state !== 'unavailable');
  if (failed.length) for (const text of wrapHanging('could not read:', failed.map((x) => `${x.id} (${x.state}${x.note ? `: ${x.note}` : ''})`).join(' · '), width, ' ')) out.push({ text, tone: 'warn' });
  return out;
}

/** Bare `quox active [sessions|slots|agents] [--json] [--all]`. A failed fetch prints its status and exits 1 (never an empty list). */
export async function runActive({ filter = null, json = false, all = false, lines = false, cols = null } = {}, over = {}) {
  const d = { write: (s) => process.stdout.write(s), now: () => Date.now(), ...over };
  if (filter && !ACTIVE_KINDS.includes(filter)) { d.write(`quox active: unknown filter "${filter}" (sessions, slots or agents)\n`); return 1; }
  try {
    const idx = await d.fetchIndex();
    if (json) {
      const p = prepareActive(idx, { filter, now: d.now() });
      d.write(JSON.stringify({ filter, counts: Object.fromEntries(Object.entries(p.groups).map(([k, v]) => [k, v.length])), workers: p.rows.map(({ ts, ...r }) => r), sources_down: p.down }, null, 2) + '\n');
    } else if (lines) d.write(activeLines(idx, { filter, now: d.now(), all }).map((l) => l.text).join('\n') + '\n');
    else {
      let unread = null;
      if (d.fetchSlots) { try { unread = new Map((await d.fetchSlots() || []).map((x) => [x.name, x.unread_count || 0])); } catch { unread = null; } } // the count is a nicety: a failed slots read never hides the list
      d.write(activeRows(idx, { filter, now: d.now(), cols: cols || process.stdout.columns || 100, unread }).map((l) => l.text).join('\n') + '\n');
    }
    return 0;
  } catch (e) {
    d.write(`quox active: ${e && e.status ? `HTTP ${e.status}: ` : ''}${(e && e.message) || 'request failed'}\n`);
    return 1;
  }
}
