/**
 * DEVSUITE phase 19: gather this host's tmux sessions into the payload for
 * POST /api/v1/live-sessions/report. Pure parse/map functions take injected
 * tmux output and held-slots JSON so they unit-test without tmux.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const TMUX_FORMAT = '#{session_name}\t#{session_created}\t#{session_attached}\t#{pane_current_command}\t#{pane_pid}\t#{session_activity}';

const AGENT_PROGRAMS = new Set(['claude', 'codex', 'gemini']);

/** Parse `tmux list-panes -a -F TMUX_FORMAT` output; one entry per session (first pane wins). */
export function parseTmuxPanes(out) {
  const seen = new Map();
  for (const line of String(out || '').split('\n')) {
    const c = line.split('\t');
    if (c.length < 5 || !c[0]) continue;
    if (seen.has(c[0])) continue;
    const created = Number(c[1]);
    const pid = Number.parseInt(c[4], 10);
    const activity = Number(c[5]);
    seen.set(c[0], {
      name: c[0],
      tmux: true,
      attached: Number(c[2]) > 0,
      program: c[3] || null,
      pid: Number.isInteger(pid) ? pid : null,
      started_at: Number.isFinite(created) && created > 0 ? new Date(created * 1000).toISOString() : null,
      last_active: Number.isFinite(activity) && activity > 0 ? new Date(activity * 1000).toISOString() : null,
    });
  }
  return [...seen.values()];
}

/** held-slots.json is { slotName: { session, pid, ... } }; return { holderSession: { slot, pid } }. */
export function slotsBySession(held) {
  const map = {};
  if (!held || typeof held !== 'object') return map;
  for (const [slot, e] of Object.entries(held)) {
    if (e && typeof e.session === 'string' && e.session && !(e.session in map)) {
      map[e.session] = { slot, pid: Number.isInteger(e.pid) ? e.pid : null };
    }
  }
  return map;
}

/**
 * Attach kits live at ~/.quox/attach/sessions/claude-<pid>/<agentId>/, where
 * <pid> is the claude process the slot entry records. Read ONLY the agent dir
 * name and the plain `splinter` label file (e.g. "S2 1"); never the token.
 */
export function readAttachSafe(pid, base = join(homedir(), '.quox', 'attach', 'sessions')) {
  if (!Number.isInteger(pid)) return null;
  try {
    const dir = join(base, `claude-${pid}`);
    if (!existsSync(dir)) return null;
    const agent = readdirSync(dir).find((d) => /^[a-z0-9_-]{1,40}$/.test(d));
    if (!agent) return null;
    let splinter = null;
    const sp = join(dir, agent, 'splinter');
    if (existsSync(sp)) {
      const m = /^(S\d{1,3})\b/.exec(readFileSync(sp, 'utf-8').trim());
      if (m) splinter = m[1];
    }
    return { agent, splinter };
  } catch {
    return null;
  }
}

export function buildReport({ tmuxOut, held, env = {}, host, attachLookup = readAttachSafe }) {
  const bySession = slotsBySession(held);
  const sessions = parseTmuxPanes(tmuxOut).slice(0, 50).map((s) => {
    // `quox claude --resume NAME` runs NAME in tmux session quox-NAME, while
    // the slot entry records the bare NAME.
    const bare = s.name.replace(/^quox-/, '');
    const hit = bySession[s.name] || bySession[bare] || null;
    const { last_active: lastActive, ...rest } = s;
    const out = { ...rest, slot: hit ? hit.slot : null };
    const att = hit ? attachLookup(hit.pid) : null;
    if (att) {
      out.agent = att.agent;
      if (att.splinter) out.splinter = att.splinter;
    }
    // No stream from env: QUOX_STREAM goes stale in inherited shells (house
    // rule, and it mislabelled VULCAN as QUOX-SECURITY on the first live run).
    // The column stays for a reliable source later (slot or attach metadata).
    // last_active (tmux session_activity) feeds the J1 index's working/resting state.
    out.meta = { agent_program: AGENT_PROGRAMS.has(s.program), ...(lastActive ? { last_active: lastActive } : {}) };
    return out;
  });
  return { host: host || hostname(), sessions };
}

export function readHeldSlotsSafe(path = join(homedir(), '.quox', 'held-slots.json')) {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

/** Live gather. Returns null when tmux is missing; an empty server yields an empty list. */
export function gatherReport({ spawn = spawnSync, env = process.env, held = readHeldSlotsSafe() } = {}) {
  const r = spawn('tmux', ['list-panes', '-a', '-F', TMUX_FORMAT], { encoding: 'utf8' });
  if (r.error) return null;
  return buildReport({ tmuxOut: r.status === 0 ? r.stdout : '', held, env });
}
