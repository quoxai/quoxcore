/**
 * HITL-CONTEXT (AQ-9A phase 6): work out WHICH session is calling when
 * $QUOX_SESSION is unset, so an approval card says "BRAIN2-AUDIT (CLI)"
 * instead of a bare user id. Display-only: the server never authorizes on it.
 *
 * Precedence:
 *   1. QUOX_SESSION
 *   2. QUOX_STREAM (advisory)
 *   3. the agent attached by this Claude process tree
 *      (~/.quox/attach/sessions/claude-<pid>/<agent>/)
 *   4. the slot held by this process tree (held-slots.json sessionKey claude-<pid>)
 *   5. last resort: "<parent process> in ~/<cwd>"
 *
 * Never reads token contents and never emits secrets: only directory names,
 * the kit's display_name, the slot's session label and the cwd.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

/** Tools the collector always holds for a human when an agent proposes them. */
export const APPROVAL_GATED_TOOLS = new Set([
  'loop_halt', 'slot_assign', 'bob_dispatch_build', 'email_send', 'send_notification',
  'remote_ssh', 'ssh_exec', 'db_query', 'alerts_manage', 'backup_run',
  'keeper_backup_create', 'deploy_template', 'gemini_generate', 'perplexity_research',
  'system_admin', 'proxmox_vm_action', 'calendar_event_create',
]);

export const MISSING_REASON_WARNING =
  'approval requests without --reason show \'none given\' to the human; pass --reason "why"';

/** One-line stderr warning when a gated tool is run without --reason, else null. */
export function missingReasonWarning(toolName, reason) {
  if (!APPROVAL_GATED_TOOLS.has(String(toolName || ''))) return null;
  if (typeof reason === 'string' && reason.trim()) return null;
  return `warning: ${MISSING_REASON_WARNING}`;
}

function cleanLabel(v, n = 48) {
  const s = String(v == null ? '' : v).replace(/[^\w .:@+\-/~]/g, '').trim().slice(0, n);
  return s || null;
}

const defaultDeps = {
  readName: (pid) => { try { return readFileSync(`/proc/${pid}/comm`, 'utf-8').trim(); } catch { return null; } },
  readPpid: (pid) => {
    try {
      const s = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const rest = s.slice(s.lastIndexOf(')') + 2).trim().split(/\s+/);
      const p = parseInt(rest[1], 10);
      return Number.isFinite(p) ? p : null;
    } catch { return null; }
  },
  attachSessionsRoot: () => join(homedir(), '.quox', 'attach', 'sessions'),
  heldSlotsPath: () => join(homedir(), '.quox', 'held-slots.json'),
  readdir: (d) => { try { return readdirSync(d, { withFileTypes: true }); } catch { return []; } },
  readJson: (p) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null; } catch { return null; } },
  exists: existsSync,
  cwd: () => { try { return process.cwd(); } catch { return ''; } },
  home: () => homedir(),
  pid: () => process.pid,
};

function findClaudeAncestor(deps, startPid) {
  let pid = startPid;
  for (let hop = 0; hop < 24; hop += 1) {
    if (deps.readName(pid) === 'claude') return pid;
    const pp = deps.readPpid(pid);
    if (!pp || pp === pid || pid === 1) break;
    pid = pp;
  }
  return null;
}

function attachedAgentLabel(deps, claudePid) {
  const dir = join(deps.attachSessionsRoot(), `claude-${claudePid}`);
  const agents = deps.readdir(dir).filter((e) => e.isDirectory() && deps.exists(join(dir, e.name, 'token')));
  if (agents.length === 0) return null;
  const name = agents[0].name;
  const kit = deps.readJson(join(dir, name, 'kit.json'));
  return cleanLabel(kit && kit.display_name) || cleanLabel(name);
}

function heldSlotLabel(deps, claudePid) {
  const all = deps.readJson(deps.heldSlotsPath());
  if (!all || typeof all !== 'object') return null;
  for (const [slot, e] of Object.entries(all)) {
    if (e && e.sessionKey === `claude-${claudePid}`) return cleanLabel(e.session) || cleanLabel(slot);
  }
  return null;
}

function cwdLabel(deps) {
  const cwd = deps.cwd();
  if (!cwd) return null;
  const home = deps.home();
  if (home && cwd === home) return '~';
  if (home && cwd.startsWith(`${home}/`)) return `~/${cwd.slice(home.length + 1)}`;
  return basename(cwd) || null;
}

/** @returns {{ label: string|null, via: string }} */
export function detectCallerSource(env = process.env, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const fromSession = cleanLabel(env.QUOX_SESSION);
  if (fromSession) return { label: fromSession, via: 'QUOX_SESSION' };
  const fromStream = cleanLabel(env.QUOX_STREAM);
  if (fromStream) return { label: fromStream, via: 'QUOX_STREAM' };

  let claudePid = null;
  try { claudePid = findClaudeAncestor(deps, deps.pid()); } catch { claudePid = null; }
  if (claudePid) {
    const agent = attachedAgentLabel(deps, claudePid);
    if (agent) return { label: agent, via: 'attached_agent' };
    const slot = heldSlotLabel(deps, claudePid);
    if (slot) return { label: slot, via: 'held_slot' };
  }

  let parent = null;
  try {
    const pp = deps.readPpid(deps.pid());
    parent = pp ? deps.readName(pp) : null;
  } catch { parent = null; }
  const who = claudePid ? 'claude' : cleanLabel(parent, 24);
  const where = cwdLabel(deps);
  if (who && where) return { label: cleanLabel(`${who} in ${where}`), via: 'process' };
  if (who) return { label: who, via: 'process' };
  return { label: null, via: 'none' };
}
