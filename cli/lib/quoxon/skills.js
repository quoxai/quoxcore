/** /skills and /skill helpers (pure). Skills are the org's QSKL procedural skills (not Crystals); running goes through a normal governed turn. */
const one = (s, n = 80) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

export function findSkill(all, name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return all.find(s => String(s.name || '').toLowerCase() === n) || all.find(s => String(s.id || '').toLowerCase() === n) || null;
}

export function skillRows(all, width = 76) {
  const nameW = Math.min(28, Math.max(4, ...all.map(s => [...String(s.name || s.id || '')].length)));
  return all.map(s => {
    const status = s.edition || s.status || 'unknown';
    const head = `${String(s.name || s.id).padEnd(nameW)}  ${status.padEnd(12)}`;
    const room = Math.max(0, width - head.length - 2);
    return `${head}  ${one(s.description, room)}`.trimEnd();
  });
}

export function skillDetail(s) {
  const out = [`${s.name || s.id}  (${s.edition || s.status || 'unknown'}${s.version != null ? ' v' + s.version : ''})`];
  if (s.description) out.push(one(s.description, 400));
  for (const [k, label] of [['category', 'category'], ['decayState', 'decay'], ['sourceWorkflowId', 'workflow'], ['createdAt', 'created']]) if (s[k]) out.push(`${label}: ${s[k]}`);
  if (Array.isArray(s.tags) && s.tags.length) out.push(`tags: ${s.tags.join(', ')}`);
  out.push(`Run it: /skill ${s.name || s.id} [args]`);
  return out;
}

/** The turn text that asks CommanderQ to run a skill. Governed: approvals apply as for any tool. */
export const skillPrompt = (name, args) => `Run the skill ${name}${args ? ` with: ${args}` : ''}`;
