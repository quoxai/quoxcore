/**
 * E7 rules precedence: three layers that are visibly different and never confused.
 *   advisory  QUOX.md files this client found (sent as context; cannot grant or bypass anything)
 *   pack      the signed core dev pack on this machine (~/.claude/skills/.pack-version and
 *             .pack-rights.json, written by the collector's skill-pack installer): team guidance for
 *             coding agents, still advisory
 *   enforced  ARMED governance policies on the server (GET /orgs/:org/governance/policies): the only
 *             layer that can stop an action
 * The effective layer is the highest one that has rules. An unreadable layer is reported, and never
 * treated as empty when deciding what is effective.
 */
import { seg, fit, plural } from './model.js';

/** Pure: read the pack marker files through an injected reader (fs.readFileSync-like, may throw). */
export function packFrom(read) {
  let marker = null, rights = null;
  try { marker = String(read('.pack-version')).trim(); } catch { /* absent */ }
  try { rights = JSON.parse(read('.pack-rights.json')); } catch { /* absent */ }
  if (!marker && !rights) return { state: 'none' };
  let m = null;
  try { m = marker ? JSON.parse(marker) : null; } catch { m = null; }
  const version = rights?.version ?? m?.version ?? (marker && !m ? marker : null);
  return { state: 'installed', version: version != null ? String(version) : null, packId: rights?.packId ?? m?.packId ?? null, skills: Array.isArray(rights?.rights) ? rights.rights.length : null };
}

/**
 * d: { quoxmd: loadRules() result | null, enabled: boolean, pack: packFrom() result,
 *      policies: { ok: true, list } | { ok: false, error } }
 */
export function rulesLadder(d, cols) {
  const nw = cols < 66;
  const rows = [];
  const files = d.quoxmd?.files || [];
  const pol = d.policies || { ok: false, error: 'not read' };
  const armed = pol.ok ? (pol.list || []).filter(p => p.state === 'armed') : [];
  const staged = pol.ok ? (pol.list || []).filter(p => p.state === 'draft') : [];
  const layers = [
    { tag: 'advisory', role: 'muted', has: files.length > 0 && d.enabled !== false,
      src: !files.length ? 'no QUOX.md found' : d.enabled === false ? `QUOX.md (${files.length}) · off this session` : `QUOX.md (${plural(files.length, 'file')}${d.quoxmd?.truncated ? ', cut' : ''})`,
      scope: nw ? 'local' : 'you, this machine · guides only' },
    { tag: 'pack', role: 'teal', has: d.pack?.state === 'installed',
      src: d.pack?.state === 'installed' ? `core dev pack${d.pack.version ? ` v${d.pack.version}` : ''}${d.pack.skills != null && !nw ? ` · ${d.pack.skills} skills` : ''}` : 'not installed here',
      scope: nw ? 'team' : 'team, signed · guides only' },
    { tag: 'enforced', role: 'indigo', has: armed.length > 0, unknown: !pol.ok,
      src: pol.ok ? (armed.length ? `${plural(armed.length, 'governance policy', 'governance policies')} armed` : 'no armed policy') : `could not read (${fit(pol.error, 28)})`,
      scope: nw ? 'server' : 'server, cannot be bypassed' }
  ];
  const top = pol.ok ? [...layers].reverse().find(l => l.has) : null;
  rows.push([seg('rules ', 'muted'), seg(nw ? 'precedence, top wins' : 'precedence · the highest layer with rules wins', 'value', true)]);
  for (const l of [...layers].reverse()) {
    const on = top === l;
    const lose = top && !on && l.has;
    rows.push([
      seg(on ? '▸ ' : '  ', on ? 'value' : 'faint', true),
      seg(l.tag.padEnd(9), lose ? 'faint' : l.unknown ? 'warn' : l.role, on),
      seg(fit(l.src, nw ? cols - 14 : 34).padEnd(nw ? 0 : 35), l.unknown ? 'warn' : lose ? 'muted' : 'value', on),
      ...(nw ? [] : [seg(fit(l.scope, Math.max(0, cols - 50)), 'muted')])
    ]);
  }
  for (const p of armed.slice(0, 4)) rows.push([seg('    · ', 'faint'), seg(fit(`"${p.rule_text}"`, cols - 24), 'value'), seg(` → ${p.policy?.effect || 'enforced'}`, 'indigo')]);
  if (armed.length > 4) rows.push([seg(`    … ${armed.length - 4} more armed`, 'muted')]);
  if (staged.length) rows.push([seg(`    ${plural(staged.length, 'draft')} not armed (enforce nothing until armed)`, 'muted')]);
  let eff;
  if (!pol.ok) eff = [seg(nw ? 'effective: unknown (policies unreadable)' : 'effective: unknown · the server\'s policies could not be read, so nothing here is called enforced', 'warn')];
  else if (top?.tag === 'enforced') eff = [seg(nw ? 'effective: enforced (server wins)' : 'effective: enforced · server policy outranks pack and QUOX.md', 'indigo')];
  else if (top) eff = [seg(nw ? `effective: ${top.tag} (advisory only)` : `effective: ${top.tag} · advisory, guides the agent but enforces nothing`, top.role === 'muted' ? 'value' : top.role)];
  else eff = [seg('effective: none · no rules at any layer', 'muted')];
  rows.push(eff);
  rows.push([seg(nw ? '/rules files: the QUOX.md text' : '/rules files shows the QUOX.md text · /rules off|on', 'faint')]);
  return { rows };
}
