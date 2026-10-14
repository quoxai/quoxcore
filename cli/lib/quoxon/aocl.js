/**
 * QUOXON-AOCL: one compact AOCL line per turn, and the full per-layer table on demand (/aocl).
 *
 * The server sends ONE `aocl.summary` per streamed turn ({ layers:[{id,outcome,ms,reason}],
 * total, accounted, passed, bypassed, rejected, rejected_at, ms, verdict? }) and an
 * `aocl.verdict` when L8 flags text that was already on screen. Older servers send only
 * per-layer `trace` rows (protocol aocl, label "L1 identity complete"); those are folded
 * into the same line so nothing is lost, and the line says how many layers were reported.
 */

export const LAYER_NAMES = {
  L0: 'ingress', L1: 'identity', L2: 'router', L3: 'policy', L4: 'planner', L5: 'context',
  L6: 'shape', L7: 'delegate', L8: 'verify', L9: 'assemble', L10: 'audit'
};
const ORDER = Object.keys(LAYER_NAMES);
const OUTCOME_WORD = { complete: 'passed', bypass: 'bypassed', reject: 'rejected', not_run: 'not run' };
const OUTCOME_GLYPH = { complete: '✔', bypass: '○', reject: '✖', not_run: '?' };

/** A per-layer AOCL trace row (folded into the one-line summary instead of a row per layer). */
export const isLayerTrace = (ev) => ev?.protocol === 'aocl' && /^L(?:10|[0-9])\b/.test(String(ev.label || ''));

const fmtMs = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  return n < 10 ? `${Math.round(n * 10) / 10} ms` : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`;
};

/** Normalise a server summary (tolerant of missing fields). */
export function normaliseSummary(ev) {
  const layers = Array.isArray(ev?.layers) ? ev.layers.filter(l => l && l.id).map(l => ({ id: String(l.id), outcome: String(l.outcome || 'not_run'), ms: Number(l.ms) || 0, ...(l.reason ? { reason: String(l.reason) } : {}) })) : [];
  const count = (o) => layers.filter(l => l.outcome === o).length;
  const rejected = layers.filter(l => l.outcome === 'reject');
  return {
    layers,
    total: Number(ev?.total) || 11,
    accounted: Number.isFinite(Number(ev?.accounted)) ? Number(ev.accounted) : layers.filter(l => l.outcome !== 'not_run').length,
    passed: Number.isFinite(Number(ev?.passed)) ? Number(ev.passed) : count('complete'),
    bypassed: Number.isFinite(Number(ev?.bypassed)) ? Number(ev.bypassed) : count('bypass'),
    rejected: Number.isFinite(Number(ev?.rejected)) ? Number(ev.rejected) : rejected.length,
    rejectedAt: ev?.rejected_at || (rejected[0] && rejected[0].id) || null,
    ms: Number.isFinite(Number(ev?.ms)) ? Number(ev.ms) : null,
    verdict: ev?.verdict || null,
    legacy: Boolean(ev?.legacy)
  };
}

/** Build a summary from legacy per-layer trace rows (a server without aocl.summary). */
export function summaryFromTraces(traces) {
  const layers = [];
  for (const t of traces || []) {
    const m = String(t.label || '').match(/^(L(?:10|[0-9]))\b.*?\b(complete|bypass|reject)\b/);
    if (!m || layers.some(l => l.id === m[1])) continue;
    const ms = String(t.detail || '').match(/(\d+(?:\.\d+)?)\s*ms/);
    layers.push({ id: m[1], outcome: m[2], ms: ms ? Number(ms[1]) : 0 });
  }
  layers.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  const ms = layers.reduce((n, l) => n + l.ms, 0);
  return normaliseSummary({ layers, total: 11, accounted: layers.length, ms, legacy: true });
}

/**
 * The one line: "AOCL 11/11 ✔ · 9 passed · 2 bypassed · 34 ms" (the caller draws the ▤ icon).
 * -> { segs: [{ t, tone }] } where tone is 'ok' | 'fail' | 'warn' | 'text'.
 */
export function aoclLineSegs(sum) {
  const s = sum || normaliseSummary({});
  const segs = [{ t: `${s.accounted}/${s.total} `, tone: 'text' }];
  if (s.rejected > 0) {
    const rl = s.layers.find(l => l.id === s.rejectedAt);
    segs.push({ t: '✖', tone: 'fail' }, { t: ` ${[s.rejectedAt || 'a layer', LAYER_NAMES[s.rejectedAt]].filter(Boolean).join(' ')} rejected${rl && rl.reason ? `: ${rl.reason}` : ''}`, tone: 'fail' });
  } else if (s.accounted < s.total) {
    segs.push({ t: '⚠', tone: 'warn' }, { t: ` only ${s.accounted} of ${s.total} reported`, tone: 'warn' });
  } else {
    segs.push({ t: '✔', tone: 'ok' });
  }
  segs.push({ t: ` · ${s.passed} passed`, tone: 'text' });
  if (s.bypassed) segs.push({ t: ` · ${s.bypassed} bypassed`, tone: 'text' });
  if (s.verdict && s.verdict.verdict === 'warned') segs.push({ t: ` · ${s.verdict.layer || 'L8'} warned`, tone: 'warn' });
  if (s.toolsOffered != null) segs.push({ t: ` · ${s.toolsOffered} tool${s.toolsOffered === 1 ? '' : 's'}`, tone: 'text' });
  if (s.ms != null) segs.push({ t: ` · ${fmtMs(s.ms)}`, tone: 'text' });
  if (s.legacy) segs.push({ t: ' · server sent no summary', tone: 'warn' });
  return { segs };
}

export const aoclLineText = (sum) => 'AOCL ' + aoclLineSegs(sum).segs.map(x => x.t).join('');

/** The /aocl table: [text, tone] rows, one per layer, for the last turn. */
export function aoclTableLines(sum) {
  if (!sum) return [['No AOCL record yet. Send a message, then /aocl shows every layer of that turn.', 'warn']];
  const out = [[`▤ AOCL last turn │ ${aoclLineText(sum).slice(5)}`, sum.rejected ? 'error' : 'accent']];
  const byId = Object.fromEntries(sum.layers.map(l => [l.id, l]));
  for (const id of ORDER) {
    const l = byId[id] || { id, outcome: 'not_run', ms: 0 };
    const word = OUTCOME_WORD[l.outcome] || l.outcome;
    const line = `${OUTCOME_GLYPH[l.outcome] || '·'} ${id.padEnd(4)}${LAYER_NAMES[id].padEnd(10)}${word.padEnd(10)}${fmtMs(l.ms).padStart(8)}${l.reason ? `   ${l.reason}` : ''}`;
    out.push([line, l.outcome === 'reject' ? 'error' : l.outcome === 'not_run' ? 'warn' : l.outcome === 'complete' ? 'ok' : 'accent']);
  }
  if (sum.toolsOffered != null) { // the VOLT "tools offered" list, on demand instead of opening every turn
    out.push([`tools offered to the model: ${sum.toolsOffered}${sum.toolsTotal != null ? ` of ${sum.toolsTotal}` : ''}`, 'accent']);
    let row = '  ';
    for (const t of String(sum.toolsList || '').split(/,\s*/).filter(Boolean)) {
      if (row.length + t.length + 2 > 76 && row.trim()) { out.push([row.replace(/,?\s*$/, ''), 'text']); row = '  '; }
      row += t + ', ';
    }
    if (row.trim()) out.push([row.replace(/,?\s*$/, ''), 'text']);
  }
  if (sum.verdict) out.push([`${sum.verdict.layer || 'L8'} ${sum.verdict.verdict}: ${sum.verdict.reason || ''}${sum.verdict.delivered ? ' (the text was already shown)' : ''}`, sum.verdict.verdict === 'blocked' ? 'error' : 'warn']);
  if (sum.legacy) out.push(['This server sent per-layer traces only, no aocl.summary: layers it did not report are shown as not run.', 'warn']);
  return out;
}

/** The note shown when L8 flags an answer that is already on screen. */
export function verdictNote(v) {
  const reason = v?.reason ? `: ${v.reason}` : '';
  if (v?.verdict === 'blocked') return { text: `✖ AOCL ${v.layer || 'L8'} blocked this answer after it was shown${reason}. Do not act on it.`, tone: 'error' };
  return { text: `⚠ AOCL ${v?.layer || 'L8'} flagged this answer${reason}.`, tone: 'warn' };
}
