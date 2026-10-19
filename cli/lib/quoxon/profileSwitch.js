// PROFILE-SWITCH (owner 2026-10-16): switch this window between logged-in profiles with one y, never automatically.
import { askText } from './ask.js';

/**
 * The App's api, swappable in place: every reader (and every controller built at mount) goes through this proxy,
 * so a profile switch replaces ref.current.live and the whole window follows. Methods are bound to the live api.
 */
export function liveApi(ref) {
  return new Proxy({}, {
    get(_, k) {
      const a = ref.current?.live;
      if (a == null) return undefined;
      const v = a[k];
      return typeof v === 'function' ? v.bind(a) : v;
    },
    has(_, k) { const a = ref.current?.live; return a != null && k in Object(a); },
  });
}

/** The ask card offering to switch an agent-login window to a human login. */
export const switchAskLine = (profile, human) => askText('Switch?', {
  title: `This window is an agent login (${profile}).`,
  action: `switch this window to your login '${human}' (same conversation, attach, slot and groups)`,
});

/** The ask card for a /slot name that does not exist (the near misses are said on the line above). */
export const slotCreateAskLine = (nm) => askText('Create it?', { title: `No slot ${nm}.`, action: `create and hold slot ${nm}` });

/** A local run request (the shared run card): sign a profile in with the real `quox login`, terminal handed over. */
export function loginRunRequest(name, why, now = Date.now()) {
  return { id: null, cmd: `quox login -p ${name}`, why, who: 'Quox', runnable: true, refuse: null, danger: null, expiresAt: now + 120000 };
}

/** A safe profile name to put on a command line (letters, digits, . _ -). */
export const okProfileName = (n) => /^[A-Za-z0-9._-]{1,64}$/.test(String(n || ''));

/**
 * /profile chooser rows (PROFILE-CHOOSER): signed-in profiles first (this window's marked), then profiles on this
 * machine that are not signed in, then the current login's orgs (the window's org marked). Each row carries `pick`:
 * { profile } switches this window in place, { login } offers `quox login -p`, { org } goes through /org switch
 * (window-scoped since #1034, confirmed first). Nothing here writes the shared default profile.
 */
export function profileChooserRows({ current, humanProfiles = [], loginCandidates = [], orgs = [], orgId = null }) {
  const names = [...new Set([current, ...humanProfiles].filter(okProfileName))];
  const later = loginCandidates.filter(n => okProfileName(n) && !names.includes(n));
  const orgList = (Array.isArray(orgs) ? orgs : []).map(o => ({ id: o.id, name: o.name || o.slug || o.id, slug: o.slug || null, role: o.role || null }));
  const w = Math.min(28, Math.max(8, ...[...names, ...later].map(n => n.length + 8), ...orgList.map(o => [...o.name].length + 4)));
  const rows = [];
  for (const n of names) rows.push({ key: `${n === current ? '* ' : '  '}${`profile ${n}`.padEnd(w)}`, text: n === current ? 'this window' : 'signed in: switch this window to it', pick: { profile: n } });
  for (const n of later) rows.push({ key: `  ${`profile ${n}`.padEnd(w)}`, text: 'not signed in: offers quox login', pick: { login: n } });
  for (const o of orgList) rows.push({ key: `${o.id === orgId ? '* ' : '  '}${`org ${o.name}`.padEnd(w)}`, text: `${o.slug || o.id}${o.role ? `  (${o.role})` : ''}${o.id === orgId ? '  this window' : ''}`, pick: { org: o } });
  return rows;
}
