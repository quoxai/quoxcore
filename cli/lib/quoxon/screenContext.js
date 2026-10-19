/**
 * SCREEN-CONTEXT: "the conversation can see the terminal it runs in".
 *
 * Every turn carries a compact `terminal` block: who/where, the roster rows on screen WITH their ids, custom
 * row text, pending approval cards, the last events (commands run and their one-line outcome, notices, errors,
 * failed turns) and the slash command names. Hard cap 2 KB. After the first turn only the parts that changed
 * are sent. Built from an allowlist of fields; anything credential-shaped is masked; nobody else's message
 * bodies are ever included (slot chat never enters the event ring).
 *
 * Pure except for the ring buffer held by createScreenContext(); the app feeds it and calls build() per turn.
 */
export const SCREEN_CAP = 2048;
export const RING_MAX = 10;
const ALWAYS = new Set(['roster', 'approvals']);

const PATTERNS = [
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}/g,
  /\b(?:sk|pk|rk|xox[bpas]|ghp|gho|ghs|github_pat|glpat|AKIA|AIza)[-_A-Za-z0-9]{12,}/g,
  /\bBearer\s+[\w.~+/=-]{8,}/gi,
  /\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|pin|authorization)\b\s*[:=]\s*\S+/gi,
  /([?&](?:token|key|secret|sig|signature|access_token)=)[^&\s]+/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/g
];

const CONTROL = new RegExp('[\\u0000-\\u001F\\u007F\\u200B-\\u200F\\u2028-\\u202F\\uFEFF]+', 'g');

/** Mask credential-shaped text and flatten to one clipped line. */
export function safe(v, n = 80) {
  let s = String(v == null ? '' : v).replace(CONTROL, ' ');
  for (const re of PATTERNS) s = s.replace(re, (m, g1) => (typeof g1 === 'string' && /^[?&]/.test(g1) ? `${g1}[masked]` : '[masked]'));
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const bytes = (s) => Buffer.byteLength(s);
export function clipBytes(s, max) {
  if (bytes(s) <= max) return s;
  let out = s.slice(0, max - 1);
  while (bytes(out + '…') > max) out = out.slice(0, -1);
  return out + '…';
}

const age = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return null;
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

/** A line the user cannot have meant as a command they want repeated (PIN-bearing verbs): name only. */
const PIN_VERBS = /^\/(authenticate|authorise|authorize|pin|login|connect|key)\b/i;

function whoSection(w) {
  const bits = [];
  if (w.profile) bits.push(`profile ${safe(w.profile, 32)}`);
  if (w.org) bits.push(`org ${safe(w.org, 40)}`);
  if (w.agent) bits.push(`agent ${safe(w.agent, 32)}`);
  if (w.model) bits.push(`model ${safe(String(w.model || '').replace(/\s*\(as the server last reported\)/, ''), 48)}`);
  if (w.slot) bits.push(`you are in slot ${safe(w.slot, 32)}`);
  if (w.rooms?.length) bits.push(`rooms ${w.rooms.slice(0, 6).map(r => '#' + safe(r, 24)).join(' ')}`);
  return bits.length ? `you: ${bits.join(' · ')}` : '';
}

function rosterSection(rows) {
  if (!rows?.length) return '';
  const lines = rows.slice(0, 8).map((r) => {
    const parts = [safe(r.kind || 'row', 12), safe(r.id || r.key, 40), safe(r.name, 50), safe(r.state, 12)];
    if (r.activity) parts.push(safe(r.activity, 40));
    const a = age(r.ageMs); if (a) parts.push(a);
    return '  ' + parts.filter(Boolean).join(' · ');
  });
  return `roster:\n${lines.join('\n')}`;
}

function rowsSection(rows) {
  if (!rows?.length) return '';
  return `custom rows:\n${rows.slice(0, 3).map(r => `  ${safe(r.label || r.id, 16)}: ${safe(r.text || r.error || '', 100)}`).join('\n')}`;
}

function approvalsSection(cards) {
  if (!cards?.length) return '';
  const lines = cards.slice(0, 5).map((c, i) => `  [${i + 1}] ${safe(c.id, 36)} · ${safe(c.summary, 60)}${c.requester ? ` · by ${safe(c.requester, 24)}` : ''}${c.privileged ? ' · privileged' : ''}`);
  return `approvals waiting:\n${lines.join('\n')}`;
}

function commandsSection(names) {
  if (!names?.length) return '';
  return `slash commands: ${names.map(n => String(n).replace(/^\//, '')).join(' ')}`;
}

/** The event ring: commands (with the first notice after them as outcome), notices, errors, failed turns. */
export function createScreenContext() {
  const ring = []; // { seq, k, text, out? }
  let seq = 0;
  const st = { on: true, sent: null, last: null, turn: 0, hashes: {} };
  const push = (k, text, extra = {}) => { ring.push({ seq: ++seq, k, text: safe(text, 140), ...extra }); while (ring.length > 40) ring.shift(); };
  return {
    get on() { return st.on; },
    set on(v) { st.on = Boolean(v); if (v) { st.hashes = {}; st.sent = null; } },
    /** A slash command the user ran. PIN-bearing verbs keep the verb only. */
    command(line) { const t = String(line || '').trim(); push('cmd', PIN_VERBS.test(t) ? t.split(/\s+/)[0] : t); },
    /** A notice shown on screen; the first one after a command is that command's outcome. */
    notice(text, tone) {
      const prev = ring[ring.length - 1];
      if (prev && prev.k === 'cmd' && prev.out == null) prev.out = safe(text, 100);
      else if (tone === 'warn' || tone === 'error') push('notice', text);
    },
    error(text) { push('error', text); },
    failedTurn(reason) { push('failed turn', reason || 'failed'); },
    /** Build this turn's block. snap = { who, rows, customRows, cards, commands }. -> { text, sections, bytes, first, unchanged } | null (off). */
    build(snap) {
      if (!st.on) { st.last = null; return null; }
      const first = st.sent == null;
      const evs = ring.filter(e => e.seq > (st.sent ?? 0)).slice(-RING_MAX);
      const eventLines = evs.map(e => e.k === 'cmd' ? `  ${e.text}${e.out ? ` -> ${e.out}` : ''}` : `  ${e.k}: ${e.text}`);
      const state = [
        ['you', whoSection(snap.who || {})],
        ['approvals', approvalsSection(snap.cards)],
        ['roster', rosterSection(snap.rows)],
        ['rows', rowsSection(snap.customRows)]
      ];
      const kept = []; const same = []; const hashes = {};
      for (const [name, body] of state) {
        hashes[name] = body;
        const prev = st.hashes[name] ?? '';
        if (first || ALWAYS.has(name)) { if (body) kept.push([name, body]); continue; } // roster rows and approvals go in full every turn: a pasted row must always resolve
        if (prev === body) { if (body) same.push(name); continue; }
        kept.push([name, body || `${name}: now empty`]);
      }
      if (eventLines.length) kept.push(['events', `since your last message:\n${eventLines.join('\n')}`]);
      if (first) { const c = commandsSection(snap.commands); if (c) kept.push(['commands', c]); }
      const tail = same.length ? `\n(unchanged since the last message: ${same.join(', ')})` : '';
      const room = SCREEN_CAP - bytes(tail);
      let text = ''; const names = [];
      for (const [name, body] of kept) {
        const next = text ? `${text}\n${body}` : body;
        names.push(name);
        if (bytes(next) > room) { text = clipBytes(next, room); break; }
        text = next;
      }
      text = clipBytes(text + tail, SCREEN_CAP);
      st.hashes = hashes; st.sent = seq; st.turn += 1;
      st.last = { text, sections: names, bytes: bytes(text), first, unchanged: same };
      return st.last;
    },
    /** What was sent on the last turn (for /context). */
    last() { return st.last; },
    summary() { const l = st.last; return l ? `${l.bytes} bytes: ${l.sections.join(', ') || 'nothing new'}${l.unchanged?.length ? ` (unchanged: ${l.unchanged.join(', ')})` : ''}` : null; }
  };
}
