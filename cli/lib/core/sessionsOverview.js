/**
 * QUOXON J2: `quox sessions` overview of GET /api/v1/sessions, grouped by
 * agent, newest activity first. overviewLines() is plain text + a tone per
 * line, shared by the CLI renderer (ANSI colour) and the quox conversation
 * client's `/sessions all` (which colours by tone itself).
 */
import { hostname as osHostname } from 'node:os';
import { line } from './quoxglyph.js';
import { formatAge } from './claudeLs.js';
import { loadNames } from '../quoxon/session.js';

export const GLYPH = { working: '◐', waiting: '⏸', resting: '○', failing: '✖' };
const TONE = { working: 'ok', waiting: 'warn', failing: 'warn', resting: 'dim' };
const ANSI = { ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', dim: '\x1b[2m', accent: '\x1b[36m', reset: '\x1b[0m' };
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

const clip = (v, n) => {
  const a = [...String(v ?? '')];
  return a.length > n ? a.slice(0, n - 1).join('') + '…' : String(v ?? '');
};
const pad = (v, n) => clip(v, n).padEnd(n);

function kindLabel(r) {
  if (r.kind === 'tmux') return r.backend ? `tmux·${r.backend}` : 'tmux';
  return r.kind;
}

function hostLabel(r, localHost) {
  if (!r.host) return r.kind === 'tmux' ? '?' : 'server';
  return localHost && r.host === localHost ? 'this host' : r.host;
}

export const RECENT_CONVERSATIONS = 5;
const KEEP_KINDS = new Set(['tmux', 'slot', 'resident', 'objective', 'loop', 'workflow']);

/** One-line title, clipped on a word boundary when one is near the end, never mid-surrogate. */
export function clipTitle(raw, max = 34) {
  const s = String(raw ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  const a = [...s];
  if (a.length <= max) return s;
  const cut = a.slice(0, max - 1).join('');
  const sp = cut.lastIndexOf(' ');
  return (sp >= Math.floor(max / 2) ? cut.slice(0, sp) : cut).replace(/[\s,.;:-]+$/, '') + '…';
}

const timeOf = (r) => { const t = Date.parse(r.last_active); return Number.isFinite(t) ? t : -Infinity; };

/**
 * The default view shows what is useful or eventful: every tmux session, slot,
 * resident and running piece of work, every working/waiting conversation, and
 * only the RECENT_CONVERSATIONS most recent other conversations. `all` keeps
 * everything. Conversation names use the local /rename name when known, else
 * the server title. Regrouped by each row's own agent; "no agent" goes last.
 * -> { groups, hiddenConversations, shown }
 */
export function prepareIndex(index, { all = false, names = {}, keep = RECENT_CONVERSATIONS } = {}) {
  const rows = (index.groups || []).flatMap((g) => g.rows).map((r) => (r.kind === 'conversation'
    // The hint is this client's own command, so set it here too (correct against an older server's --print hint).
    ? { ...r, name: clipTitle((names && names[r.id] && names[r.id].name) || r.name || '(untitled)'), attach_hint: `quox --conversation ${r.id}` }
    : r));
  let hidden = 0;
  let kept = rows;
  if (!all) {
    const quiet = rows.filter((r) => r.kind === 'conversation' && r.state !== 'working' && r.state !== 'waiting').sort((a, b) => timeOf(b) - timeOf(a));
    const keepIds = new Set(quiet.slice(0, keep));
    hidden = quiet.length - keepIds.size;
    kept = rows.filter((r) => KEEP_KINDS.has(r.kind) || r.kind !== 'conversation' || r.state === 'working' || r.state === 'waiting' || keepIds.has(r));
  }
  const by = new Map();
  for (const r of [...kept].sort((a, b) => timeOf(b) - timeOf(a))) {
    const k = r.agent || null;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const groups = [...by.entries()].map(([agent, rs]) => ({ agent, rows: rs }))
    .sort((a, b) => (a.agent === null) - (b.agent === null) || timeOf(b.rows[0]) - timeOf(a.rows[0]));
  return { groups, hiddenConversations: hidden, shown: kept.length };
}

/** -> [{ text, tone, state? }] */
export function overviewLines(index, { now = Date.now(), localHost = null, all = false, names = {} } = {}) {
  const prepared = prepareIndex(index, { all, names });
  const counts = index.counts || {};
  const total = counts.total || 0;
  const out = [
    { text: stripAnsi(line('quox', 'sessions', { result: `${total} live` })), tone: 'accent' },
    { text: `${total} live · ${counts.working || 0} working · ${counts.waiting || 0} waiting · ${counts.resting || 0} resting · ${counts.failing || 0} failing`, tone: 'dim' },
  ];
  if (!total) out.push({ text: 'No live sessions in this org.', tone: 'dim' });
  for (const g of prepared.groups) {
    out.push({ text: `${g.agent || 'no agent'} (${g.rows.length})`, tone: 'accent' });
    for (const r of g.rows) {
      const t = Date.parse(r.last_active);
      const age = Number.isFinite(t) ? formatAge((now - t) / 1000) : '-';
      const extra = [r.slot ? `slot ${r.slot}` : null, r.state_reason || null].filter(Boolean).join(', ');
      const text = `  ${GLYPH[r.state] || '?'} ${pad(r.state, 8)} ${pad(r.name, 34)} ${pad(kindLabel(r), 13)} ${pad(hostLabel(r, localHost), 12)} ${pad(age, 5)} ${r.attach_hint || ''}${extra ? `  (${extra})` : ''}`;
      out.push({ text, tone: TONE[r.state] || 'dim', state: r.state });
    }
  }
  if (prepared.hiddenConversations > 0) {
    out.push({ text: `  +${prepared.hiddenConversations} more conversations (last 24 h) · quox sessions --all`, tone: 'dim' });
  }
  const bad = (index.sources || []).filter((s) => s.state !== 'connected');
  if (bad.length) {
    out.push({ text: `sources: ${bad.map((s) => `${s.id}: ${s.state}${s.note ? ` (${s.note})` : ''}`).join(' · ')}`, tone: 'dim' });
  }
  return out;
}

export function renderOverview(index, { now = Date.now(), localHost = osHostname(), color = false, all = false, names = {} } = {}) {
  return overviewLines(index, { now, localHost, all, names }).map((l) => {
    if (!color) return l.text;
    const c = l.state === 'failing' ? ANSI.fail : ANSI[l.tone] || '';
    return `${c}${l.text}${ANSI.reset}`;
  }).join('\n');
}

const errText = (e) => `${e && e.status ? `HTTP ${e.status}: ` : ''}${(e && e.message) || 'request failed'}`;

/**
 * Bare `quox sessions`. --json prints the raw index; --watch redraws every 2 s
 * until interrupted. An error is printed with its status (never shown as an
 * empty list) and exits 1; in --watch it is shown and the next refresh retries.
 */
export async function runSessionsOverview({ json = false, watch = false, all = false } = {}, over = {}) {
  const d = {
    write: (s) => process.stdout.write(s),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    localHost: osHostname(),
    color: !!process.stdout.isTTY && !process.env.NO_COLOR,
    iterations: Infinity,
    names: undefined,
    ...over,
  };
  const names = () => d.names ?? loadNames();
  if (!d.fetchIndex) throw new Error('fetchIndex required');
  if (!watch) {
    try {
      const idx = await d.fetchIndex();
      d.write(json ? JSON.stringify(idx, null, 2) + '\n' : renderOverview(idx, { now: d.now(), localHost: d.localHost, color: d.color, all, names: names() }) + '\n');
      return 0;
    } catch (e) {
      d.write(`quox sessions: ${errText(e)}\n`);
      return 1;
    }
  }
  for (let i = 0; i < d.iterations; i++) {
    let body;
    try {
      const idx = await d.fetchIndex();
      body = json ? JSON.stringify(idx) : renderOverview(idx, { now: d.now(), localHost: d.localHost, color: d.color, all, names: names() });
    } catch (e) {
      body = `quox sessions: ${errText(e)} (retrying)`;
    }
    d.write(`\x1b[2J\x1b[H${body}\n\n(refreshing every 2 s, Ctrl-C to stop)\n`);
    await d.sleep(2000);
  }
  return 0;
}
