/**
 * /spawn: ask HYPERION (agent atlas) for a disposable VM. VMs are requested ONLY by posting to slot `provisioner`
 * ("VM please <c>c <r>G <d>G for <purpose>") and released with "done <vmid>"; nothing here talks to the pool tool.
 *
 * Lifespan is required (max 24h). At most 3 live VMs per session, counted from local state. Leases are stored
 * locally with their expiry. No server-side slot reminder exists, so expiry is client side: a timer while the TUI
 * runs, `sweep()` on the next start, and /spawn list shows overdue leases in red.
 */
import { askText } from '../ask.js';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PROVISIONER = 'provisioner';
export const MAX_LIVE = 3;
export const MAX_LIFESPAN_MS = 24 * 3600000;
const MAX_TIMER = 2147483647;
export const spawnStatePath = () => join(homedir(), '.config', 'quox', 'quoxon-spawns.json');

const UNIT = '(?:d|days?|h|hrs?|hours?|m|mins?|minutes?)';
const unitMs = (u) => (/^d/i.test(u) ? 86400000 : /^h/i.test(u) ? 3600000 : 60000);

/** Loose text -> { cores, ramG, diskG, lifespanMs, objective } plus `missing` (names) and `error` when it cannot proceed. */
export function parseSpawn(text) {
  let rest = String(text || '').trim();
  const out = { cores: null, ramG: null, diskG: null, lifespanMs: null, objective: null };
  const om = new RegExp(`\\b(?:for|to)\\s+(?!\\d+(?:\\.\\d+)?\\s*${UNIT}\\b)(.+)$`, 'i').exec(rest);
  if (om) { out.objective = om[1].trim(); rest = rest.slice(0, om.index); }
  const take = (re, fn) => { const m = re.exec(rest); if (m) { fn(m); rest = rest.replace(m[0], ' '); } };
  take(/(\d+)\s*(?:c|cores?|cpus?|vcpus?)\b/i, (m) => { out.cores = Number(m[1]); });
  take(/(\d+)\s*g(?:i?b)?\s*(?:of\s+)?(?:ram|mem(?:ory)?)\b/i, (m) => { out.ramG = Number(m[1]); });
  take(/(\d+)\s*g(?:i?b)?\s*(?:of\s+)?(?:disk|storage)\b/i, (m) => { out.diskG = Number(m[1]); });
  take(new RegExp(`(?:\\bfor\\s+)?\\b(\\d+(?:\\.\\d+)?)\\s*(${UNIT})\\b`, 'i'), (m) => { out.lifespanMs = Math.round(Number(m[1]) * unitMs(m[2])); });
  for (let m = /(\d+)\s*g(?:i?b)?\b/i.exec(rest); m && (out.ramG == null || out.diskG == null); m = /(\d+)\s*g(?:i?b)?\b/i.exec(rest)) {
    if (out.ramG == null) out.ramG = Number(m[1]); else out.diskG = Number(m[1]);
    rest = rest.replace(m[0], ' ');
  }
  if (out.diskG == null) out.diskG = 20;
  const missing = [];
  if (!out.cores) missing.push('cores');
  if (!out.ramG) missing.push('ram');
  if (!out.lifespanMs) missing.push('lifespan');
  if (!out.objective) missing.push('objective');
  if (missing.length) out.missing = missing;
  if (out.lifespanMs && out.lifespanMs > MAX_LIFESPAN_MS) out.error = 'Lifespan is capped at 24h.';
  if (out.lifespanMs != null && out.lifespanMs <= 0) out.error = 'Lifespan must be more than zero.';
  return out;
}

/** HYPERION's free-text reply -> { vmid, ip, user } | null (no vmid = not a lease). */
export function parseLease(text) {
  const t = String(text || '');
  const v = /vm\s*id\D{0,3}(\d{3,6})/i.exec(t) || /\b(9\d{3})\b/.exec(t);
  if (!v) return null;
  const ip = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(t);
  const u = /\buser\W{0,3}([a-z_][\w-]*)/i.exec(t);
  return { vmid: Number(v[1]), ip: ip ? ip[1] : null, user: u ? u[1] : 'hyp' };
}

export const fmtSpan = (ms) => { const m = Math.round(ms / 60000); return m >= 60 && m % 60 === 0 ? `${m / 60}h` : m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${Math.max(m, 0)}m`; };

const readAll = (p) => { try { const d = JSON.parse(readFileSync(p, 'utf8')); return Array.isArray(d?.leases) ? d : { leases: [] }; } catch { return { leases: [] }; } };
const writeAll = (d, p) => { try { mkdirSync(dirname(p), { recursive: true }); const tmp = `${p}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 }); renameSync(tmp, p); } catch { /* a read-only home never breaks the TUI */ } };

/**
 * deps: api (slotSay, slotStream), say, session() -> this window's session name, from() -> slot signature,
 * statePath, now, setTimer/clearTimer (tests), replyTimeoutMs.
 */
export function createSpawnCmd({ api, say, session, from, statePath = spawnStatePath(), now = Date.now, setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clearTimer = clearTimeout, replyTimeoutMs = 180000 }) {
  const st = { pending: null, waiting: null, timers: new Map() };

  const leases = ({ live = false } = {}) => readAll(statePath).leases.filter((l) => l.session === session() && (!live || l.state === 'live'));
  const save = (fn) => { const d = readAll(statePath); d.leases = fn(d.leases); writeAll(d, statePath); };

  function arm(l) {
    clearTimer(st.timers.get(l.vmid));
    const ms = Math.min(Math.max(l.expiresAt - now(), 0), MAX_TIMER);
    st.timers.set(l.vmid, setTimer(() => { st.timers.delete(l.vmid); return release(l.vmid, 'lifespan reached'); }, ms));
  }

  async function release(vmid, why) {
    const l = leases({ live: true }).find((x) => x.vmid === vmid);
    if (!l) return say(`No live VM ${vmid} in this session. /spawn list shows yours.`, 'warn');
    const r = await api.slotSay(PROVISIONER, `done ${vmid}`, { from: from() });
    if (!r?.ok) return say(`Could not post "done ${vmid}" to ${PROVISIONER}: ${r?.message || 'failed'}. It is still listed; retry /spawn done ${vmid}.`, 'error');
    clearTimer(st.timers.get(vmid)); st.timers.delete(vmid);
    save((all) => all.map((x) => (x.vmid === vmid && x.session === l.session ? { ...x, state: 'released', releasedAt: now() } : x)));
    return say(`VM ${vmid} released to HYPERION (${why}).`, 'ok');
  }

  function usage() {
    return say('Usage: /spawn <cores>c <ram>G <disk>G <lifespan> for <objective>   e.g. /spawn 4 cores 8G 20G for 2h to test the installer. Also: /spawn list, /spawn done <vmid>.', 'warn');
  }

  async function run(arg = '') {
    const t = String(arg || '').trim();
    if (!t) return usage();
    if (/^list$/i.test(t)) return list();
    const d = /^done\s+(\d+)$/i.exec(t);
    if (d) return release(Number(d[1]), 'released by you');
    st.pending = null;
    const p = parseSpawn(t);
    if (p.error) return say(p.error, 'warn');
    if (p.missing?.includes('lifespan')) return say('How long should it live? Lifespan is required (max 24h): add e.g. 2h or 90m, then run /spawn again.', 'warn');
    if (p.missing) return say(`Missing: ${p.missing.join(', ')}. ${p.missing.includes('objective') ? 'Say what it is for: "for <objective>". ' : ''}Example: /spawn 4c 8G 20G 2h for test the installer`, 'warn');
    const live = leases({ live: true });
    if (live.length >= MAX_LIVE) return say(`This session already has ${live.length} live VMs (cap ${MAX_LIVE}). /spawn done <vmid> frees one: ${live.map((l) => l.vmid).join(', ')}.`, 'warn');
    if (!api.slotSay || !api.slotStream) return say('/spawn needs slots, which this server or mode does not have.', 'warn');
    st.pending = { p, at: now() };
    say(`Request a VM from HYPERION: ${p.cores}c ${p.ramG}G ${p.diskG}G, lifespan ${fmtSpan(p.lifespanMs)}, for: ${p.objective}.`, 'accent');
    say(askText('Go?', { action: `post "VM please ${p.cores}c ${p.ramG}G ${p.diskG}G" to slot ${PROVISIONER}`, reason: `This posts to slot ${PROVISIONER} (HYPERION, agent atlas), signed ${from()}; it releases the VM at expiry.` }), 'ask');
    return undefined;
  }

  function answer(text) {
    const pe = st.pending;
    if (!pe) return false;
    const t = String(text || '').trim();
    if (t.startsWith('/')) { st.pending = null; return false; }
    st.pending = null;
    if (/^y(es)?$/i.test(t) && now() - pe.at < 600000) { st.waiting = request(pe.p); return true; }
    say('Cancelled; nothing posted.', 'dim');
    return /^no?$/i.test(t);
  }

  async function request(p) {
    const me = from();
    const since = new Date(now() - 1000).toISOString();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), replyTimeoutMs);
    try {
      const stream = api.slotStream(PROVISIONER, { since, excludeFrom: me }, ac.signal);
      const reader = (async () => {
        for await (const ev of stream) {
          if (ev?.type !== 'slot.message' || !ev.message || ev.message.from === me) continue;
          const lease = parseLease(ev.message.text);
          if (lease) return { lease, msg: ev.message };
          if (/refus|cannot|can't|no capacity|denied|unable|error|not allowed/i.test(ev.message.text || '')) return { refusal: ev.message.text };
        }
        return null;
      })();
      const purpose = `${p.objective} (lifespan ${fmtSpan(p.lifespanMs)}, released by the requester at expiry)`;
      const r = await api.slotSay(PROVISIONER, `VM please ${p.cores}c ${p.ramG}G ${p.diskG}G for ${purpose}`, { from: me });
      if (!r?.ok) { ac.abort(); await reader.catch(() => {}); return say(`Could not post to ${PROVISIONER}: ${r?.message || 'failed'}. Nothing was requested.`, 'error'); }
      say(`Posted to ${PROVISIONER}; waiting for HYPERION's lease reply.`, 'dim');
      const got = await reader.catch(() => null);
      if (got?.refusal) return say(`HYPERION: ${got.refusal}`, 'warn');
      if (!got?.lease) return say(`No lease reply from HYPERION within ${Math.round(replyTimeoutMs / 1000)}s. The request is posted; check slot ${PROVISIONER} (/slot log) and, if a VM arrives, /spawn done <vmid> when finished.`, 'warn');
      const { lease } = got;
      const rec = { vmid: lease.vmid, ip: lease.ip, user: lease.user, cores: p.cores, ramG: p.ramG, diskG: p.diskG, objective: p.objective, session: session(), leasedAt: now(), expiresAt: now() + p.lifespanMs, state: 'live' };
      save((all) => [...all, rec]);
      arm(rec);
      say(`VM ${lease.vmid} leased${lease.ip ? ` at ${lease.ip}` : ''}, user ${lease.user}, expires in ${fmtSpan(p.lifespanMs)}.`, 'ok');
      if (lease.ip) say(`Connect: ssh ${lease.user}@${lease.ip}  (use the key HYPERION's reply names)`, 'ok');
      say(`Release early with /spawn done ${lease.vmid}.`, 'dim');
      return undefined;
    } finally { clearTimeout(timer); }
  }

  function list() {
    const all = leases();
    if (!all.length) return say('No VMs spawned by this session.', 'dim');
    for (const l of all) {
      const overdue = l.state === 'live' && l.expiresAt < now();
      const when = l.state === 'released' ? 'released' : overdue ? `OVERDUE by ${fmtSpan(now() - l.expiresAt)}, releases on /spawn done ${l.vmid} or next start` : `expires in ${fmtSpan(l.expiresAt - now())}`;
      say(`${l.vmid}  ${l.ip || '?'}  ${l.user}@  ${l.cores}c ${l.ramG}G ${l.diskG}G  ${when}  ${l.objective}`, overdue ? 'error' : l.state === 'released' ? 'dim' : undefined);
    }
    return undefined;
  }

  /** On start: release this session's overdue leases, and re-arm timers for the rest. */
  async function sweep() {
    for (const l of leases({ live: true })) { if (l.expiresAt <= now()) await release(l.vmid, 'overdue at start'); else arm(l); }
  }

  return { run, answer, sweep, leases, get pending() { return st.pending; }, get waiting() { return st.waiting; } };
}
