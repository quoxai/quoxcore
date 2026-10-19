'use strict';

/**
 * QUOXON-LATENCY: per-turn latency breakdown for every provider path.
 *
 * The turn's frames already say most of what happened and when (turn.started, the AOCL
 * pre-layer traces, `tools offered: N of M`, tool.started / tool.finished, the first
 * text.delta). observe() is fed every frame the turn writes, so no provider loop needs
 * its own wiring; a path adds what only it can see with mark() / set() (the Claude CLI
 * path: process boot and the model's first byte).
 *
 * summary() is emitted as `turn.timing` just before turn.finished and logged as one
 * [TurnTiming] phase=summary line. All times are ms from t0 (the turn's start at the
 * collector). Never carries prompt or tool text: numbers, names and tool ids only.
 */

const AOCL_MS_RE = /(\d+(?:\.\d+)?)\s*ms\b/;
const OFFER_RE = /^tools offered: (\d+) of (\d+)/;
const MAX_TOOLS = 20;

function createTurnTiming({ t0 = Date.now(), now = Date.now } = {}) {
  const marks = {};
  const fields = {};
  let aoclPre = 0;
  let aoclSeen = false;
  let firstText = null;
  const open = new Map();
  const preTools = [];
  let toolCount = 0;

  const at = () => now() - t0;
  function mark(name) {
    if (typeof name !== 'string' || !name) return;
    if (marks[name] === undefined) marks[name] = at();
  }
  function set(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      if (typeof v === 'number' || typeof v === 'boolean' || v === null || typeof v === 'string') fields[k] = typeof v === 'string' ? v.slice(0, 80) : v;
    }
  }

  function observe(f) {
    try {
      if (!f || typeof f !== 'object' || typeof f.type !== 'string') return;
      switch (f.type) {
        case 'connected': mark('connected'); break;
        case 'turn.started':
          mark('turn_started');
          set({ provider: f.provider || null, model: f.model || null, agent: f.agent || null });
          break;
        case 'trace': {
          const label = typeof f.label === 'string' ? f.label : '';
          if (f.protocol === 'aocl' && firstText === null) {
            const m = AOCL_MS_RE.exec(String(f.detail || ''));
            if (m) { aoclPre += Number(m[1]); aoclSeen = true; }
          }
          const o = OFFER_RE.exec(label);
          if (o && marks.tools_offered === undefined) {
            mark('tools_offered');
            set({ tools_offered: Number(o[1]), tool_pool: Number(o[2]) });
          }
          break;
        }
        case 'tool.started':
          toolCount += 1;
          if (firstText === null && f.call_id) open.set(f.call_id, { tool: String(f.tool || 'tool').slice(0, 60), start: at() });
          break;
        case 'tool.finished':
        case 'approval.requested': {
          const o = f.call_id ? open.get(f.call_id) : null;
          if (o) {
            open.delete(f.call_id);
            if (preTools.length < MAX_TOOLS) preTools.push({ tool: o.tool, start_ms: o.start, ms: at() - o.start });
          }
          break;
        }
        case 'text.delta':
          if (firstText === null && typeof f.content === 'string' && f.content) {
            firstText = at();
            mark('first_text');
          }
          break;
        default: break;
      }
    } catch { /* timing is telemetry: it never breaks the turn */ }
  }

  function summary() {
    const out = { ...fields };
    for (const [k, v] of Object.entries(marks)) out[`${k}_ms`] = v;
    if (aoclSeen) out.aocl_pre_ms = Math.round(aoclPre);
    out.pre_answer_tools = preTools.slice();
    out.pre_answer_tool_ms = preTools.reduce((a, t) => a + t.ms, 0);
    out.tool_calls = toolCount;
    out.total_ms = at();
    return out;
  }

  function logLine(turnId) {
    const s = summary();
    const parts = Object.entries(s)
      .filter(([k]) => k !== 'pre_answer_tools')
      .map(([k, v]) => `${k}=${v === null ? 'n/a' : v}`);
    const tools = s.pre_answer_tools.map((t) => `${t.tool}:${t.ms}`).join(',');
    return `[TurnTiming] turn=${turnId || '-'} phase=summary ${parts.join(' ')}${tools ? ` pre_answer=${tools}` : ''}`;
  }

  return { observe, mark, set, summary, logLine };
}

module.exports = { createTurnTiming };
