/**
 * E2 workflow step flow from ONE real execution: the step list comes from the workflow definition
 * (GET /api/workflows/:id on quoxflow) in edge order, and each step's state and timing from that
 * execution's AEE envelopes (GET /api/executions/:id/envelopes: quox.flow.node.started | completed |
 * failed | skipped, keyed by payload.nodeId). Only the running step moves; a human gate
 * (approval:gate, human:task) that is reached shows amber. A step with no envelope is shown as
 * not reached, and when no envelopes could be read every state is '?', never guessed.
 */
import { seg, fit, dur, hhmm, short, parseTs } from './model.js';

export const isGateType = (type) => /^(approval|human|hitl)[:_-]|(^|:)(approval|hitl|human)(gate|task)?$/i.test(String(type || ''));

/** Definition nodes in execution order (Kahn over edges; definition order breaks ties). */
export function orderNodes(def) {
  const nodes = Array.isArray(def?.nodes) ? def.nodes : [];
  const edges = Array.isArray(def?.edges) ? def.edges : [];
  const ids = nodes.map(n => n.id);
  const indeg = new Map(ids.map(id => [id, 0]));
  for (const e of edges) if (indeg.has(e.target) && indeg.has(e.source)) indeg.set(e.target, indeg.get(e.target) + 1);
  const out = [], seen = new Set();
  const queue = ids.filter(id => indeg.get(id) === 0);
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id); out.push(id);
    for (const e of edges) if (e.source === id && indeg.has(e.target)) { indeg.set(e.target, indeg.get(e.target) - 1); if (indeg.get(e.target) === 0) queue.push(e.target); }
  }
  for (const id of ids) if (!seen.has(id)) out.push(id); // a cycle or dangling edge: keep definition order
  const byId = new Map(nodes.map(n => [n.id, n]));
  return out.map(id => byId.get(id));
}

/** nodeId -> { started, completed, failed, skipped, payload, nodeName, nodeType } from envelopes. */
export function nodeStates(envelopes) {
  const st = new Map();
  for (const e of envelopes || []) {
    const p = e?.payload || {};
    const id = p.nodeId;
    if (!id || !/^quox\.flow\.node\./.test(String(e.intent || ''))) continue;
    const s = st.get(id) || { id };
    const ts = parseTs(e.ts);
    const kind = String(e.intent).slice('quox.flow.node.'.length);
    if (kind === 'started') { if (s.started == null || ts < s.started) s.started = ts; s.nodeName ??= p.nodeName; s.nodeType ??= p.nodeType; }
    else if (kind === 'completed') { s.completed = ts; s.result = p; }
    else if (kind === 'failed') { s.failed = ts; s.error = p.error || p.message || null; }
    else if (kind === 'skipped') s.skipped = ts;
    st.set(id, s);
  }
  return st;
}

const triggerDetail = (n) => {
  const c = n?.config || {};
  return c.label || c.expression || c.event || c.path || '';
};

/**
 * d: { execution, envelopes: [] | null, def: { nodes, edges } | null, now }
 * -> view { rows } (no box: the lab draws this as an indented flow)
 */
export function stepFlow(d, cols) {
  const ex = d.execution || {};
  const now = d.now ?? Date.now();
  const nw = cols < 60;
  const rows = [];
  const status = String(ex.status || 'unknown');
  const head = [seg(ex.workflowName || ex.workflowId || 'workflow', 'value', true), seg('  ')];
  const meta = [`run ${short(ex.id, 10)}`, status];
  if (!nw && ex.startedAt) meta.push(`started ${hhmm(ex.startedAt)}`);
  head.push(seg(meta.join(' · '), status === 'failed' ? 'error' : 'muted'));
  rows.push(head);

  const states = d.envelopes ? nodeStates(d.envelopes) : null;
  let nodes = d.def ? orderNodes(d.def) : [];
  if (!nodes.length && states) nodes = [...states.values()].filter(s => !/_replay_\d+$/.test(s.id)).map(s => ({ id: s.id, name: s.nodeName, type: s.nodeType }));
  if (!nodes.length) {
    rows.push([seg(d.envelopes ? 'No step records for this run.' : 'Steps could not be read for this run (no definition or envelopes).', 'muted')]);
    return { rows };
  }
  const running = status === 'running' || status === 'paused';
  const nameW = Math.min(Math.max(12, Math.floor((cols - 8) * 0.45)), Math.max(8, ...nodes.map(n => [...String(n.name || n.id)].length)));
  for (const n of nodes) {
    const s = states?.get(n.id);
    const type = n.type || s?.nodeType || '';
    const gate = isGateType(type);
    let mark = '?', mrole = 'muted', nrole = 'value', det = '', drole = 'muted', bold = false;
    if (!states) { det = 'state not readable'; }
    else if (/^trigger/.test(type)) { mark = '●'; mrole = 'sky'; det = triggerDetail(n); }
    else if (s?.failed != null) { mark = '✖'; mrole = 'error'; det = fit(s.error ? `failed: ${s.error}` : 'failed', 60); drole = 'error'; }
    else if (s?.completed != null) {
      mark = '✓'; mrole = 'ok';
      const r = s.result || {};
      const bits = [];
      if (r.actions_taken != null) bits.push(`${r.actions_taken} action${r.actions_taken === 1 ? '' : 's'}`);
      if (s.started != null) bits.push(dur(s.completed - s.started));
      det = bits.join(' · ');
    } else if (s?.skipped != null) { mark = '○'; mrole = 'faint'; nrole = 'muted'; det = 'skipped'; }
    else if (s?.started != null && running) {
      if (gate) { mark = '◐'; mrole = 'warn'; det = 'waiting for approval'; drole = 'warn'; }
      else { mark = '◐'; mrole = 'sky'; bold = true; det = `running · ${dur(now - s.started)}`; }
    } else if (s?.started != null) { mark = '?'; det = `started, no end recorded (run ${status})`; drole = 'warn'; }
    else { mark = '○'; mrole = 'faint'; nrole = 'muted'; if (gate && running) { det = 'human gate'; drole = 'warn'; } }
    rows.push([seg(' │', 'faint')]);
    const nm = fit(n.name || n.id, nameW);
    const row = [seg(' '), seg(mark, mrole, bold), seg(' '), seg(nm, nrole, bold)];
    if (det) {
      const pad = nw ? '  ' : ' '.repeat(Math.max(2, nameW + 2 - [...nm].length));
      row.push(seg(pad), seg(fit(det, Math.max(6, cols - 6 - (nw ? [...nm].length + 2 : nameW + 2))), drole));
    }
    rows.push(row);
  }
  if (!running && (ex.duration != null || ex.completedAt)) {
    const total = ex.duration != null ? dur(ex.duration) : dur(parseTs(ex.completedAt) - parseTs(ex.startedAt));
    rows.push([seg(' ')]);
    if (status === 'failed') rows.push([seg('✖ ', 'error'), seg(fit(`failed${total ? ` after ${total}` : ''}${ex.error ? `: ${typeof ex.error === 'string' ? ex.error : ex.error.message || ''}` : ''}`, cols - 6), 'error')]);
    else rows.push([seg(status === 'completed' ? '✔ ' : '· ', status === 'completed' ? 'ok' : 'muted'), seg(`${status}${total ? ` in ${total}` : ''}${ex.envelopeCount != null ? ` · ${ex.envelopeCount} envelopes` : ''}`, 'muted')]);
  }
  return { rows };
}
