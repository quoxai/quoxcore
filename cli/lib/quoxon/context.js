/**
 * Where am I: the slot this session holds and the agent attached to it, for the
 * status line. Reads directory names and slot labels only, never token contents.
 * Layout mirrors lib/core/callerSource.js (~/.quox/attach/sessions/claude-<pid>/<agent>/,
 * ~/.quox/held-slots.json sessionKey claude-<pid>).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const clean = (v, n = 32) => String(v == null ? '' : v).replace(/[^\w .:@+\-/~]/g, '').trim().slice(0, n) || null;

const defaults = {
  readName: (pid) => { try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return null; } },
  readPpid: (pid) => {
    try {
      const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const p = parseInt(s.slice(s.lastIndexOf(')') + 2).trim().split(/\s+/)[1], 10);
      return Number.isFinite(p) ? p : null;
    } catch { return null; }
  },
  attachRoot: () => join(homedir(), '.quox', 'attach', 'sessions'),
  heldSlotsPath: () => join(homedir(), '.quox', 'held-slots.json'),
  readdir: (d) => { try { return readdirSync(d, { withFileTypes: true }); } catch { return []; } },
  readJson: (p) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } },
  exists: existsSync,
  pid: () => process.pid
};

function claudeAncestor(d, start) {
  let pid = start;
  for (let hop = 0; hop < 24; hop++) {
    if (d.readName(pid) === 'claude') return pid;
    const pp = d.readPpid(pid);
    if (!pp || pp === pid || pid === 1) break;
    pid = pp;
  }
  return null;
}

/** -> { slot: string|null, agent: string|null } ; env wins, then the attach/slot files of the claude ancestor. */
export function detectSlotAgent(env = process.env, overrides = {}) {
  const d = { ...defaults, ...overrides };
  let slot = clean(env.QUOX_SLOT);
  let agent = clean(env.QUOX_AGENT);
  if (slot && agent) return { slot, agent };
  let pid = null;
  try { pid = claudeAncestor(d, d.pid()); } catch { pid = null; }
  if (pid) {
    if (!agent) {
      const dir = join(d.attachRoot(), `claude-${pid}`);
      const found = d.readdir(dir).filter(e => e.isDirectory() && d.exists(join(dir, e.name, 'token')));
      if (found.length) {
        const kit = d.readJson(join(dir, found[0].name, 'kit.json'));
        agent = clean(kit && kit.display_name) || clean(found[0].name);
      }
    }
    if (!slot) {
      const all = d.readJson(d.heldSlotsPath());
      if (all && typeof all === 'object') {
        for (const [name, e] of Object.entries(all)) {
          if (e && e.sessionKey === `claude-${pid}`) { slot = clean(name); break; }
        }
      }
    }
  }
  return { slot, agent };
}
