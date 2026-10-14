/**
 * `quox claude ls`: one row per quox-* tmux session. Pure parse/build/render
 * functions take injected tmux output, held-slots JSON and a clock so they
 * unit-test without tmux. SLOT comes from ~/.quox/held-slots.json (holder
 * session name), AGENT from the attach kit of the claude pid that slot entry
 * records (~/.quox/attach/sessions/claude-<pid>/<agent>/). Both are '-' when
 * not derivable (a session that holds no slot has no recorded pid).
 */
import { spawnSync as realSpawnSync } from 'node:child_process';
import { PREFIX, programOf } from './governedSession.js';
import { slotsBySession, readAttachSafe, readHeldSlotsSafe } from './liveSessionsReport.js';
import { line } from './quoxglyph.js';

export const LS_FORMAT = '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_activity}\t#{session_windows}';

export function formatAge(sec) {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const toDate = (v) => new Date(Number(v) * 1000);

export function parseQuoxSessions(out) {
  return String(out || '').split('\n').map((l) => l.split('\t'))
    .filter((c) => c.length >= 5 && c[0].startsWith(PREFIX) && c[0].length > PREFIX.length)
    .map((c) => ({
      name: c[0].slice(PREFIX.length),
      created: toDate(c[1]),
      clients: Number(c[2]) || 0,
      activity: toDate(c[3]),
      windows: Number(c[4]) || 0,
    }));
}

export function buildRows({ tmuxOut, held, now = new Date(), attachLookup = readAttachSafe }) {
  const bySession = slotsBySession(held);
  return parseQuoxSessions(tmuxOut)
    .sort((a, b) => b.activity - a.activity)
    .map((s) => {
      // The slot ledger records the bare session name (what --resume NAME used).
      const hit = bySession[s.name] || bySession[s.name.replace(/^(codex-|gemini-|tui-)/, '')] || null;
      const att = hit ? attachLookup(hit.pid) : null;
      const age = (d) => formatAge((now - d) / 1000);
      return {
        name: s.name,
        state: s.clients > 0 ? 'attached' : 'detached',
        clients: s.clients,
        created: s.created.toISOString(),
        created_age: age(s.created),
        last_active: s.activity.toISOString(),
        active_age: age(s.activity),
        slot: hit ? hit.slot : null,
        agent: att ? att.agent : null,
        backend: programOf(s.name),
      };
    });
}

const clip = (v, n) => {
  const a = [...String(v)];
  return a.length > n ? a.slice(0, n - 1).join('') + '…' : String(v);
};

export function renderTable(rows, { color = false } = {}) {
  const W = { NAME: 20, STATE: 9, CLIENTS: 8, CREATED: 8, 'LAST ACTIVE': 12, SLOT: 8, AGENT: 8, BACKEND: 7 };
  const cols = Object.keys(W);
  const cell = (v, k, last) => (last ? clip(v, W[k]) : clip(v, W[k] - 1).padEnd(W[k]));
  const fmt = (vals) => cols.map((k, i) => cell(vals[i], k, i === cols.length - 1)).join('');
  const head = line('quox', 'sessions', { result: `${rows.length} running` });
  const body = rows.map((r) => fmt([r.name, r.state, r.clients, r.created_age, r.active_age, r.slot || '-', r.agent || '-', r.backend]));
  return [head, fmt(cols), ...body].join('\n');
}

export function runClaudeLs({ json = false } = {}, over = {}) {
  const d = {
    spawnSync: realSpawnSync, now: () => new Date(), write: (s) => process.stdout.write(s),
    held: undefined, attachLookup: readAttachSafe, ...over,
  };
  const r = d.spawnSync('tmux', ['list-sessions', '-F', LS_FORMAT], { encoding: 'utf8' });
  if (r && r.error && r.error.code === 'ENOENT') {
    d.write('tmux is not installed (apt install tmux / brew install tmux).\n');
    return 1;
  }
  // A non-zero exit means no server is running (nothing to list), not an error.
  const out = r && r.status === 0 ? r.stdout : '';
  const rows = buildRows({ tmuxOut: out, held: d.held ?? readHeldSlotsSafe(), now: d.now(), attachLookup: d.attachLookup });
  if (json) { d.write(JSON.stringify(rows, null, 2) + '\n'); return 0; }
  if (!rows.length) { d.write('No quox sessions running.\n'); return 0; }
  d.write(renderTable(rows) + '\n');
  return 0;
}
