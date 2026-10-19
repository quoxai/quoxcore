/**
 * /mind: QuoxMind cognitive implants, read from the collector (same data as `quox mind`).
 * Pure: takes api.mind() output, returns [[text, tone]]. Implants with nothing recorded
 * say "no activity recorded"; nothing is invented. Lines are not clipped: notes wrap to the
 * terminal width, so a long description reads in full (owner drive 2026-10-15).
 */

const MARK = { healthy: '✔', degraded: '⚠', weak: '⚠', collecting: '◐', 'not-reported': '·', unreachable: '✖', 'license-required': '⛔' };

/** The 14 implant short ids (the collector's registry, in order). Used for help and for "did you mean". */
export const MIND_IMPLANTS = ['sense', 'repobrain', 'memory', 'temporal', 'focus', 'value', 'guard', 'qortex', 'insight', 'executive', 'predict', 'reflect', 'dream', 'learn'];
const SHORT_OF = { 'quox-nucleus': 'repobrain', 'quox-brain2': 'qortex' };
const shortOf = (id) => SHORT_OF[id] || String(id).replace(/^quox-/, '');

export const MIND_HELP_ARGS = new Set(['help', '-h', '--help', '?']);

/** /mind help: the forms and the implant ids. No server call. */
export function mindHelpLines() {
  return [
    ['/mind lists every QuoxMind implant with its status and last activity. Read-only, no model call.'],
    ['/mind <implant> shows one implant in full: what it does, how it grows, its metrics.'],
    [`Implants: ${MIND_IMPLANTS.join(', ')}.`],
  ];
}

/**
 * A failed /mind call as plain lines. A 404 "unknown implant" names the implant that does not exist,
 * lists the real ones, and points at a TUI command of the same name when there is one (/mind doctor -> /doctor).
 * Any other failure reports the server's own reason, not just "Request failed with status N".
 */
export function mindErrorLines(e, arg, { isCommand = () => false } = {}) {
  const body = e?.body && typeof e.body === 'object' ? e.body : {};
  const reason = body.error || body.message || (typeof e?.code === 'string' && !/^E[A-Z]/.test(e.code) ? e.code : '') || e?.message || 'failed';
  if (arg && (e?.status === 404 || /unknown implant/i.test(reason))) {
    const ids = Array.isArray(body.valid) && body.valid.length ? body.valid.map(shortOf) : MIND_IMPLANTS;
    const out = [[`No implant called "${arg}". /mind <implant> shows one implant's status (read-only).`, 'warn'],
      [`Implants: ${ids.join(', ')}.`]];
    const cmd = String(arg).split(/\s+/)[0].toLowerCase();
    if (isCommand(cmd)) out.push([`For the ${cmd} command, use /${cmd}.`]);
    else out.push(['/mind on its own lists them all.']);
    return out;
  }
  return [[`mind: ${e?.status ? `HTTP ${e.status}: ` : ''}${reason}`, 'error']];
}

/** Relative "fired" time for an ISO timestamp; 'never' when null. `now` is injectable for tests. */
export function fmtFired(iso, now = Date.now()) {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * The firing evidence for one implant (QUOXMIND-PROOF): last fired + 7-day count from the server.
 * Returns null when the server predates the evidence fields, so the old line is kept.
 */
function firingText(i, now) {
  if (!('fired_7d' in i)) return null;
  if (i.activity_error) return `firing unknown: ${i.activity_error}`;
  if (typeof i.fired_7d !== 'number') return 'firing not tracked';
  const idle = typeof i.idle_runs_7d === 'number' && i.idle_runs_7d > 0 ? ` (${i.idle_runs_7d} idle runs)` : '';
  return `${i.last_fired ? `fired ${fmtFired(i.last_fired, now)}` : 'never fired'} · 7d ${i.fired_7d}${idle}`;
}

export function mindLines(d, { now = Date.now() } = {}) {
  const out = [];
  const add = (t, tone) => out.push([t, tone]);
  if (d.implant) {
    const i = d.implant;
    add(`${MARK[i.status] || '·'} ${i.name} (${i.short}) · ${i.status}${i.tier ? ` · ${i.tier}` : ''}`);
    add(`  ${i.description || i.purpose}`);
    if (i.inspired_by) add(`  inspired by: ${i.inspired_by}`);
    if (i.summary) add(`  now: ${i.summary}`);
    add(`  ${i.activity}`);
    const fired = firingText(i, now);
    if (fired && typeof i.fired_7d === 'number') add(`  fired: ${fmtFired(i.last_fired, now)}${i.last_fired ? ` (${i.last_fired})` : ''} · 7d ${i.fired_7d}${i.activity_source ? ` · from ${i.activity_source}` : ''}`);
    else if (fired) add(`  ${fired}`);
    if (i.how_to_grow) add(`  how it grows: ${i.how_to_grow}`);
    if (Array.isArray(i.connected_to) && i.connected_to.length) add(`  connected to: ${i.connected_to.map(shortOf).join(', ')}`);
    for (const [k, v] of Object.entries(i.metrics || {})) if (v !== null && typeof v !== 'object') add(`  ${k}: ${typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v}`);
    const others = MIND_IMPLANTS.filter(s => s !== i.short);
    add(`This is ${i.name}'s status, read-only: nothing runs. /mind for all; others: ${others.map(s => `/mind ${s}`).join(', ')}.`, 'dim');
    return out;
  }
  const list = d.implants || [];
  add(`QuoxMind: ${list.length} cognitive implants`);
  for (const i of list) {
    const fired = firingText(i, now);
    const tail = fired !== null
      ? `${fired}${typeof i.fired_7d === 'number' && !i.activity_error && i.summary && i.activity !== 'no activity recorded' ? ` · ${i.summary}` : ''}`
      : (i.activity === 'no activity recorded' ? 'no activity recorded' : i.summary || i.activity);
    add(`${MARK[i.status] || '·'} ${i.short.padEnd(10)} ${i.status.padEnd(13)} ${tail}`, i.status === 'unreachable' ? 'warn' : undefined);
  }
  const h = d.health;
  if (h && typeof h.fired_7d_total === 'number') add(`${h.fired_7d_implants} of ${list.length} fired in the last 7 days (${h.fired_7d_total} firings), ${h.silent_7d} silent, ${h.activity_unknown} not tracked. /mind <id> for one.`);
  else if (h) add(`${h.with_activity} with activity, ${h.no_activity} with none recorded${h.average_health !== null ? `, average health ${h.average_health}` : ''}. /mind <id> for one.`);
  return out;
}
