/**
 * Pure helpers for /agents (list picker, card, tools), /which, and the loose-command fallback.
 * No I/O: app.js feeds real data in and prints what comes out.
 */
import { findEntry, suggestCommands } from '../commands.js';

/** Words that are verbs of /agents, never agent names. */
export const AGENT_RESERVED = new Set(['list', 'tools', 'show']);

/**
 * /agents argument -> { mode: 'list', filter } | { mode: 'card', name } | { mode: 'tools', name } | { mode: 'usage', text }.
 * `list [filter]`, `show <name>`, `<name> [tools [list]]`, `tools [list] <name>` (name optional only for list).
 */
export function parseAgentsArgs(arg) {
  const t = String(arg || '').trim().split(/\s+/).filter(Boolean);
  const lc = t.map(x => x.toLowerCase());
  if (!t.length) return { mode: 'list', filter: '' };
  if (lc[0] === 'list') return { mode: 'list', filter: t.slice(1).join(' ') };
  if (lc[0] === 'show') return t.length > 1 ? { mode: 'card', name: t.slice(1).join(' ') } : { mode: 'usage', text: 'Usage: /agents show <name>' };
  if (lc[0] === 'tools') {
    const rest = lc[1] === 'list' ? t.slice(2) : t.slice(1);
    return rest.length ? { mode: 'tools', name: rest.join(' ') } : { mode: 'usage', text: 'Usage: /agents <name> tools' };
  }
  const last = lc[lc.length - 1];
  if (last === 'tools' && t.length > 1) return { mode: 'tools', name: t.slice(0, -1).join(' ') };
  if (last === 'list' && lc[lc.length - 2] === 'tools' && t.length > 2) return { mode: 'tools', name: t.slice(0, -2).join(' ') };
  return { mode: 'card', name: t.join(' ') };
}

/** Agents matching the filter text (id, name or role), filter case-insensitive. */
export function filterAgents(list, filter) {
  const q = String(filter || '').trim().toLowerCase();
  const rows = Array.isArray(list) ? list : [];
  if (!q) return rows;
  return rows.filter(a => [a.agent_id, a.name, a.role].some(v => String(v || '').toLowerCase().includes(q)));
}

const clipTo = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** One picker row: name, short role, status. */
export const agentPickerRow = (a) => ({
  key: String(a.name || a.agent_id),
  text: `${a.role ? clipTo(String(a.role), 48) : 'no role recorded'} · ${a.status || 'status not reported'}`
});

/** Tool names grouped by their prefix (github_list_repos -> github) when the prefix is shared by 2+; the rest under "other". */
export function toolLines(data) {
  const nm = data?.name || data?.id || 'agent';
  if (!Array.isArray(data?.tools)) return [[`${nm}: could not read tools${data?.toolsErr ? ` (${data.toolsErr})` : ''}`, 'warn']];
  if (!data.tools.length) return [[`${nm} has no tools assigned.`, 'plain']];
  const names = data.tools.map(x => (typeof x === 'string' ? x : x?.name || x?.tool_name || x?.tool_id || String(x)));
  const pref = (n) => (n.includes('_') ? n.split('_')[0] : null);
  const count = new Map();
  for (const n of names) { const p = pref(n); if (p) count.set(p, (count.get(p) || 0) + 1); }
  const groups = new Map();
  for (const n of [...names].sort()) {
    const p = pref(n); const g = p && count.get(p) > 1 ? p : 'other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(n);
  }
  const out = [[`${nm}: ${names.length} tool${names.length === 1 ? '' : 's'}`, 'plain']];
  const order = [...groups.keys()].filter(g => g !== 'other').sort().concat(groups.has('other') ? ['other'] : []);
  for (const g of order) out.push([`  ${g} (${groups.get(g).length}): ${groups.get(g).join(', ')}`, 'dim']);
  return out;
}

// ---- /which ------------------------------------------------------------------------------------------------
export const WHICH_KEYS = ['profile', 'org', 'agent', 'hat', 'model', 'slot', 'conversation'];
const WHICH_ALIAS = { provider: 'model', session: 'conversation', chat: 'conversation', login: 'profile', user: 'profile' };

/** d: { profile, agentLogin, org, agent, hat, model (text), slot, slotLive, conversationId, sessionName } -> [[key, text]] */
export function whichRows(d = {}) {
  return [
    ['profile', `${d.profile || '?'} (${d.agentLogin ? 'agent login' : 'human login'})`],
    ['org', d.org || '? not in this login'],
    ['agent', d.agent || 'CommanderQ (quox)'],
    ['hat', d.hat || 'none reported yet (shows after your first message; quox hat list for the org\'s hats)'],
    ['model', d.model || '?'],
    ['slot', d.slot ? `${d.slot} (${d.slotLive ? 'live stream connected' : 'live stream not connected'})` : 'none (/slot <name>)'],
    ['conversation', `${d.conversationId || 'new (starts with your next message)'}${d.sessionName ? ` · ${d.sessionName}` : ''}`]
  ];
}

/** arg -> { rows: [[key,text]] } | { error } */
export function whichReply(arg, d) {
  const q = String(arg || '').trim().toLowerCase();
  const rows = whichRows(d);
  if (!q) return { rows };
  const key = WHICH_ALIAS[q] || q;
  const hit = rows.find(r => r[0] === key);
  return hit ? { rows: [hit] } : { error: `/which ${q}: not one I know. Try /which ${WHICH_KEYS.join(' | ')}` };
}

// ---- loose slash commands ----------------------------------------------------------------------------------
/** Commands that only read: safe to run for the user from a loosely typed line. Everything else is suggested. */
export const LOOSE_SAFE = new Set(['help', 'status', 'context', 'cost', 'agents', 'skills', 'memory', 'sitrep', 'away', 'workflow', 'crystal', 'proof', 'reconcile', 'tips', 'whatsnew', 'which', 'doctor', 'hat']);

/**
 * Unknown `/cmd words...`. Looks for a later word that is a real active command or alias.
 * -> { run: '/x args' } | { suggest: '/x' } | { ask: 'words' } | null (fall back to the near-miss / Try /help line)
 */
export function looseCommand(cmd, restArg) {
  const words = String(restArg || '').trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const e = findEntry(words[i].replace(/^\//, ''));
    if (!e || e.kind !== 'command' || e.status !== 'active') continue;
    const rest = words.slice(i + 1).join(' ');
    if (LOOSE_SAFE.has(e.id)) return { run: `/${e.id}${rest ? ` ${rest}` : ''}`, name: `/${e.id}` };
    return { suggest: `/${e.id}${rest ? ` ${rest}` : ''}` };
  }
  if (words.length && !suggestCommands(cmd).length) return { ask: `${String(cmd).replace(/^\//, '')} ${words.join(' ')}` };
  return null;
}
