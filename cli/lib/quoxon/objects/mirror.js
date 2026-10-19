/**
 * /mirror: the Mirror, what CommanderQ sees about this org right now. Read from GET /api/v1/mind/mirror,
 * the org-scoped object the collector builds from each owning service and injects into CommanderQ's
 * [SELF-KNOWLEDGE]. Sectioned: identity, health, implants, capabilities, plugins, memory, codebase,
 * then every unknown with its code, service and message. `/mirror agents` lists the agents.
 * Text wraps to width, never clipped. No grey roles: 'value' text, 'sky' headings, 'ok'/'warn' state.
 */
import { seg, boxWidth, len } from './model.js';

const age = (ms) => {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
};

/** Word-wrap to n display chars; a word longer than n is hard-split. Nothing is dropped. */
export function wrapText(text, n) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    let line = '';
    for (let w of para.split(/\s+/).filter(Boolean)) {
      while (len(w) > n) {
        if (line) { out.push(line); line = ''; }
        out.push([...w].slice(0, n).join('')); w = [...w].slice(n).join('');
      }
      if (!line) line = w;
      else if (len(line) + 1 + len(w) <= n) line += ' ' + w;
      else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out;
}

const ICON = { healthy: '✔', degraded: '⚠', weak: '⚠', collecting: '◐', 'license-required': '⛔', unreachable: '✖', 'not-reported': '◐' };
const unk = (u) => `unknown: ${u.code} (${u.service}: ${u.message})`;
const isUnk = (v) => v && typeof v === 'object' && v.unknown;

/** d: GET /api/v1/mind/mirror body (+ view: 'agents'). -> view { box, rows } */
export function mirrorCard(d, cols) {
  const w = boxWidth(cols, 100), inner = w - 4;
  const rows = [];
  const put = (t, role = 'value', indent = 0) => { const pad = ' '.repeat(indent); for (const l of wrapText(t, inner - indent)) rows.push([seg(pad + l, role)]); };
  const head = (t) => { if (rows.length) rows.push([seg(' ')]); rows.push([seg(t, 'sky', true)]); };
  const m = d?.mirror;
  const a = age(d?.age_ms);
  const right = `${a ? `${a} old · ` : ''}${d?.fresh ? 'fresh' : 'stale'}`;
  const box = (title) => ({ width: w, title, titleRole: 'value', right, rightRole: d?.fresh ? 'ok' : 'warn', border: d?.fresh ? 'indigo' : 'warn' });
  if (!m) {
    put(`The Mirror could not be read: ${d?.error || d?.reason || 'the server returned no mirror'}.`, 'warn'); // RESTORE-TUI: say the server's reason (an unbuilt mirror says why)
    return { box: { ...box('The Mirror'), right: 'not available', rightRole: 'warn', border: 'warn' }, rows };
  }

  if (d.view === 'agents') {
    const ag = m.capabilities?.agents;
    if (isUnk(ag)) put(`Agents ${unk(ag.unknown)}`, 'warn');
    else {
      put(`${ag.count} agents, ${ag.entitled} entitled for this org.`);
      rows.push([seg(' ')]);
      for (const x of ag.list || []) put(`${x.entitled === false ? '⛔' : '✔'} ${x.name || x.id} (${x.id})${x.role ? ` · ${x.role}` : ''}${x.level != null ? ` · level ${x.level}` : ''}${x.entitled === false ? ' · not entitled' : ''}`, x.entitled === false ? 'warn' : 'value');
    }
    return { box: box('The Mirror · agents'), rows };
  }

  head('Identity');
  put(`${m.identity?.name || 'CommanderQ'}: ${m.identity?.role || ''}. This is what CommanderQ is told about this org on every turn, built ${m.generatedAt || 'now'} from server reads.`);

  head('Health');
  if (isUnk(m.health)) put(unk(m.health.unknown), 'warn');
  else {
    const h = m.health;
    put(`${h.score}% · ${h.activeServices}/${h.totalServices} services up${h.down?.length ? ` · down: ${h.down.join(', ')}` : ''}${h.degraded?.length ? ` · degraded: ${h.degraded.join(', ')}` : ''}`, h.score >= 90 ? 'ok' : 'warn');
  }

  head('Implants');
  if (isUnk(m.implants)) put(unk(m.implants.unknown), 'warn');
  else {
    const s = m.implantSummary;
    if (s) put(`${s.healthy}/${s.total} healthy (${Object.entries(s.by_status || {}).map(([k, v]) => `${v} ${k}`).join(', ')})`);
    for (const i of m.implants || []) {
      const bad = i.status !== 'healthy';
      put(`${ICON[i.status] || '◐'} ${i.name}${i.tier ? ` [${i.tier}]` : ''} · ${i.status}${typeof i.health === 'number' ? ` ${i.health}` : ''}${i.metric ? ` · ${i.metric}` : ''}`, bad ? 'warn' : 'value', 1);
      if (i.reason && bad) put(`${i.reason.code} (${i.reason.service}: ${i.reason.message})`, 'warn', 4);
    }
  }

  head('Capabilities');
  const c = m.capabilities || {};
  put(isUnk(c.tools) ? `Tools ${unk(c.tools.unknown)}` : `Tools: ${c.tools.total} (${c.tools.platform} platform, ${c.tools.org} installed for this org)`, isUnk(c.tools) ? 'warn' : 'value');
  put(isUnk(c.workflows) ? `Workflows ${unk(c.workflows.unknown)}` : `Workflows: ${c.workflows}`, isUnk(c.workflows) ? 'warn' : 'value');
  put(isUnk(c.agents) ? `Agents ${unk(c.agents.unknown)}` : `Agents: ${c.agents.count} (${c.agents.entitled} entitled) · /mirror agents lists them`, isUnk(c.agents) ? 'warn' : 'value');

  head('Plugins');
  if (isUnk(m.plugins)) put(unk(m.plugins.unknown), 'warn');
  else put(`${m.plugins.installed} installed, ${m.plugins.enabled} enabled${m.plugins.list?.length ? `: ${m.plugins.list.map((p) => p.id).join(', ')}` : ''}`);

  head('Memory');
  if (isUnk(m.memory)) put(unk(m.memory.unknown), 'warn');
  else {
    const mm = m.memory;
    put(`${mm.total} memories, ${mm.entities} entities, ${mm.relations} relations, across ${mm.users} users of this org`);
    const types = Object.entries(mm.by_type || {}).sort((x, y) => y[1] - x[1]);
    if (types.length) put(types.map(([k, v]) => `${k} ${v}`).join(' · '), 'value', 1);
  }

  head('Codebase');
  const f = m.codebaseFabric || {};
  if (isUnk(f)) put(unk(f.unknown), 'warn');
  else {
    if (f.repobrain_unknown) put(`RepoBrain ${unk(f.repobrain_unknown)}`, 'warn');
    else {
      put(`RepoBrain: ${f.repos} repos indexed${f.indexedFiles != null ? `, ${f.indexedFiles} files` : ''}`);
      if (f.indexedFiles_reason) put(`files ${f.indexedFiles_reason.code} (${f.indexedFiles_reason.service}: ${f.indexedFiles_reason.message})`, 'warn', 1);
    }
    if (f.projects_unknown) put(`Scans ${unk(f.projects_unknown)}`, 'warn');
    else if (f.projectCount != null) put(`Scans: ${f.projectCount} projects, ${f.totalRoutes} routes, ${f.totalServices} services, invariants ${f.invariantStatus}${f.lastScan ? `, last ${f.lastScan}` : ''}`);
    if (f.lastScan_reason) put(`${f.lastScan_reason.code} (${f.lastScan_reason.service}: ${f.lastScan_reason.message})`, 'warn', 1);
  }

  const un = m.unknowns || [];
  head(`Unknown (${un.length})`);
  if (!un.length) put('Every section above was read from its service.', 'ok');
  for (const u of un) put(`${u.section}: ${u.code} (${u.service}: ${u.message})`, 'warn');
  return { box: box('The Mirror'), rows };
}

/** A failed fetch as one plain line: the HTTP status, the error code and the server's own reason. */
export function mirrorErrorNote(e) {
  const body = e?.body && typeof e.body === 'object' ? e.body : {};
  const reason = body.error || body.message || e?.message || 'failed';
  const code = body.code || (typeof e?.code === 'string' ? e.code : '');
  return `mirror: could not read the Mirror (${e?.status ? `HTTP ${e.status}: ` : ''}${code ? `${code}: ` : ''}${reason}). Nothing is assumed.`;
}
