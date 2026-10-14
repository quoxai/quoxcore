/**
 * E3 Crystal eligibility, computed from a workflow's REAL execution history against quoxflow's
 * crystalliser gate. There is no read-only eligibility route (POST /api/skills/from-execution is the
 * check AND the crystallisation, a write), so the rule is ported here verbatim from
 * quoxflow/src/pipeline/crystalliser.ts (analyseExecutionHistory + extractVariables):
 *   >= 3 executions, >= 80% success, and every successful run follows one action sequence.
 * Input mirrors that route's legacy path: completed + failed executions; a run's action log is
 * output.action_log when the run recorded one, else the workflow definition's nodes (the route's
 * synthetic log). The quoxflow route also reads its own execution-history table, which this
 * client cannot see, so the card says what it counted.
 */
import { seg, fit, short, boxWidth, plural } from './model.js';

export const MIN_EXECUTIONS = 3;
export const MIN_SUCCESS_RATE = 0.8;

/** crystalliser.ts analyseExecutionHistory, same order of checks and same reasons. */
export function analyseExecutionHistory(executions) {
  const count = executions.length;
  const successCount = executions.filter(e => e.success).length;
  const successRate = count > 0 ? successCount / count : 0;
  if (count < MIN_EXECUTIONS) return { ready: false, reason: `Insufficient executions (${count}/${MIN_EXECUTIONS} required)`, confidence: 0, executionCount: count, successRate };
  if (successRate < MIN_SUCCESS_RATE) return { ready: false, reason: `Low success rate (${(successRate * 100).toFixed(0)}% < ${MIN_SUCCESS_RATE * 100}% required)`, confidence: 0, executionCount: count, successRate };
  const signatures = new Set(executions.filter(e => e.success).map(e => e.actionLog.map(a => a.action).join(',')));
  if (signatures.size > 1) return { ready: false, reason: `Inconsistent action structure across runs (${signatures.size} different patterns)`, confidence: 0, executionCount: count, successRate };
  const confidence = Math.min(Math.min(count / 10, 1) * 0.3 + successRate * 0.5 + 0.2, 1.0);
  return { ready: true, confidence, executionCount: count, successRate };
}

/** crystalliser.ts extractVariables: params that vary between successful runs, by action position. */
export function extractVariables(executions) {
  const ok = executions.filter(e => e.success && e.actionLog.length > 0);
  if (ok.length < 2) return [];
  const vars = [];
  ok[0].actionLog.forEach((first, idx) => {
    for (const key of Object.keys(first.params || {})) {
      const values = ok.map(e => e.actionLog[idx]?.params?.[key]).filter(v => v !== undefined);
      if (new Set(values.map(v => JSON.stringify(v))).size > 1) vars.push({ name: key, values });
    }
  });
  return vars;
}

/** Real executions (+ optional definition) -> crystalliser ExecutionRecords. */
export function toRecords(executions, def) {
  const synthetic = Array.isArray(def?.nodes) ? def.nodes.map(n => ({ action: n.type, params: n.config ?? n.data ?? {} })) : null;
  return executions
    .filter(e => e && (e.status === 'completed' || e.status === 'failed'))
    .map(e => {
      const log = Array.isArray(e.output?.action_log) ? e.output.action_log.map(a => ({ action: a.action, params: a.params || {} })) : synthetic;
      return { id: e.id, success: e.status === 'completed', actionLog: log || [], logKnown: Array.isArray(e.output?.action_log) };
    });
}

/** Successful runs still needed so both the count and the rate pass (consecutive successes from now). */
export function runsNeeded(count, successes) {
  for (let k = 0; k < 10000; k++) {
    const n = count + k, s = successes + k;
    if (n >= MIN_EXECUTIONS && s / n >= MIN_SUCCESS_RATE) return k;
  }
  return null;
}

/**
 * d: { workflow: { id, name }, executions: [...completed and failed], def }
 * -> view { box, rows }
 */
export function crystalCard(d, cols) {
  const w = boxWidth(cols, 66), inner = w - 4, nw = w < 58;
  const wf = d.workflow || {};
  const recs = toRecords(d.executions || [], d.def);
  const a = analyseExecutionHistory(recs);
  const n = recs.length, s = recs.filter(r => r.success).length;
  const pct = n ? Math.round((s / n) * 100) : 0;
  const okRuns = recs.filter(r => r.success);
  const sigs = new Set(okRuns.map(r => r.actionLog.map(x => x.action).join(',')));
  const unknownLogs = okRuns.some(r => !r.logKnown);
  const rows = [];
  const check = (pass, name, value) => [seg(pass === null ? '○' : pass ? '✔' : '✖', pass === null ? 'faint' : pass ? 'ok' : 'warn'), seg(' '), seg(name.padEnd(nw ? 10 : 14), pass === null ? 'muted' : 'value'), seg(fit(value, inner - (nw ? 12 : 16)), 'muted')];
  rows.push(check(n >= MIN_EXECUTIONS, 'runs', nw ? `${n} (needs ≥ ${MIN_EXECUTIONS})` : `${n}`.padEnd(11) + `needs ≥ ${MIN_EXECUTIONS}`));
  rows.push(check(n ? s / n >= MIN_SUCCESS_RATE : false, nw ? 'success' : 'success rate', nw ? `${pct}% ${s}/${n} (≥ 80%)` : `${pct}%  ${s}/${n}  needs ≥ 80%`));
  if (!okRuns.length) rows.push(check(null, 'structure', 'no successful run to compare'));
  else if (unknownLogs && sigs.size === 1) rows.push(check(true, 'structure', nw ? `${okRuns.length}/${okRuns.length} same steps` : `${okRuns.length}/${okRuns.length} same steps (definition, no run log)`));
  else rows.push(check(sigs.size === 1, 'structure', sigs.size === 1 ? (nw ? `${okRuns.length}/${okRuns.length} identical` : `${okRuns.length}/${okRuns.length} runs, identical action sequence`) : `${sigs.size} different action patterns`));
  const vars = a.ready ? extractVariables(recs) : [];
  if (a.ready) rows.push(check(true, 'variables', vars.length ? `${vars.map(v => v.name).join(', ')}${nw ? '' : ' (vary between runs)'}` : 'none vary between runs'));

  const crystal = (d.executions || []).find(e => e?.output?.crystal_id);
  let verdict;
  if (crystal) verdict = [seg(fit(`Already runs as Crystal ${short(crystal.output.crystal_id, 10)}${crystal.output.execution_mode ? ` (${crystal.output.execution_mode} replay)` : ''}`, inner), 'teal', true)];
  else if (a.ready) verdict = [seg(nw ? 'Eligible · meets the gate' : 'Eligible · meets the crystalliser gate', 'teal', true)];
  else if (/Inconsistent/.test(a.reason || '')) verdict = [seg(fit(`Not eligible: runs follow ${sigs.size} different action patterns`, inner), 'warn', true)];
  else {
    const k = runsNeeded(n, s);
    verdict = [seg(fit(k == null ? `Not eligible yet: ${a.reason}` : `Not eligible yet: needs ${plural(k, 'more successful run')}`, inner), 'warn', true)];
  }
  rows.push(verdict);
  rows.push([seg(fit(nw ? `from ${plural(n, 'recorded run')}` : `from ${plural(n, 'recorded run')} · quoxflow's rule, ≤ 500 per status`, inner), 'faint')]);
  return { box: { width: w, title: nw ? 'Crystal candidate' : `Crystal candidate · ${wf.name || wf.id || ''}`, right: '', border: 'teal' }, rows, analysis: a };
}
