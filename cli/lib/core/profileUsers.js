/**
 * #1034: which OTHER quox processes on this machine use a given CLI profile. `quox org switch` changes the shared
 * profile's default org, so it names the sessions that will follow it (a TUI `/org switch` only moves its own window).
 * Linux /proc only; elsewhere the answer is an empty list. Reads argv and the single QUOX_PROFILE env field, nothing else.
 */
import { readdirSync, readFileSync } from 'node:fs';

const isQuox = (a) => /(^|\/)quox(\.js|\.mjs)?$/.test(String(a || ''));

/** The profile a process selected: a name, '' for "the config default", or null when it is not quox. */
export function profileOf({ argv = [], env = {} }) {
  const at = argv.slice(0, 2).findIndex(isQuox);
  if (at < 0) return null;
  const rest = argv.slice(at + 1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-p' || a === '--profile') return rest[i + 1] || '';
    if (a.startsWith('--profile=')) return a.slice('--profile='.length);
  }
  return env.QUOX_PROFILE || '';
}

export function otherProfileUsers({ profile, defaultProfile, procs, selfPids = [] }) {
  const self = new Set(selfPids);
  return procs.filter(p => {
    if (self.has(p.pid)) return false;
    const sel = profileOf(p);
    if (sel === null) return false;
    return sel === profile || (sel === '' && profile === defaultProfile);
  });
}

/** Live processes of this user: [{ pid, argv, env: { QUOX_PROFILE? } }]. */
export function listProcs(root = '/proc') {
  let dirs;
  try { dirs = readdirSync(root).filter(d => /^\d+$/.test(d)); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    try {
      const argv = readFileSync(`${root}/${d}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (!argv.slice(0, 2).some(isQuox)) continue;
      let env = {};
      try {
        const line = readFileSync(`${root}/${d}/environ`, 'utf8').split('\0').find(l => l.startsWith('QUOX_PROFILE='));
        if (line) env = { QUOX_PROFILE: line.slice('QUOX_PROFILE='.length) };
      } catch { /* not ours to read */ }
      out.push({ pid: Number(d), argv, env });
    } catch { /* exited */ }
  }
  return out;
}
