'use strict';

/**
 * QUOXON-LATENCY + parity: the per-turn tool offer for the Claude subscription CLI path.
 *
 * That path lists its tools in the system prompt and calls them through
 * `quox tool exec`. It used to list EVERY eligible tool with its description
 * (167 or 247 of 247, ~50k chars, ~63k-char prompts) while the API paths offered the
 * D3 selection (5-16). That was a parity gap and the largest prompt on any path.
 *
 * Now: the SAME selection the API paths offer (selectTurnTools, same cap), listed in
 * full, plus a compact index (name + argument names, no descriptions) of the remaining
 * eligible tools. The index is this path's more_tools: an API offer can widen to any
 * eligible tool, and so can this one, so reach and the write rule are unchanged.
 */

const {
  selectTurnTools, selectCatalogueTools, capForProvider,
} = require('./turnToolSelection.js');

// An argument with a fixed set of values carries them: the API paths send the enum in the
// schema, this path only had the name, so the model guessed (quoxlens_read action "list").
const ENUM_SHOWN = 12;
function argNames(t) {
  const schema = (t && (t.input_schema || t.inputSchema || t.parameters)) || {};
  const req = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties || {}).map(([k, p]) => {
    const notes = [];
    if (req.has(k)) notes.push('required');
    const values = p && Array.isArray(p.enum) ? p.enum : null;
    if (values && values.length) {
      const shown = values.slice(0, ENUM_SHOWN).join('|');
      notes.push(`one of: ${shown}${values.length > ENUM_SHOWN ? ` +${values.length - ENUM_SHOWN} more` : ''}`);
    }
    return notes.length ? `${k} (${notes.join(', ')})` : k;
  });
}

/** The index lines: `- name | args: a (required), b` (never a description). */
function renderToolIndex(tools) {
  return (Array.isArray(tools) ? tools : [])
    .filter((t) => t && t.name)
    .map((t) => { const a = argNames(t); return `- ${t.name}${a.length ? ` | args: ${a.join(', ')}` : ''}`; })
    .join('\n');
}

/** The offered catalogue lines: `- name | args: ... | description`, or `- name: description`. */
function renderToolCatalogue(tools) {
  return (Array.isArray(tools) ? tools : [])
    .filter((t) => t && t.name)
    .map((t) => { const a = argNames(t); return `- ${t.name}${a.length ? ` | args: ${a.join(', ')} |` : ':'} ${t.description || '(no description)'}`; })
    .join('\n');
}

/**
 * -> { offered, index, poolSize, writeIntent }
 * offered: the D3 selection (what every API path offers this turn).
 * index: every other eligible tool (same eligibility rule as the API offer's more_tools).
 */
function buildCliToolOffer({ provider = 'anthropic', pool, message = '', history = [], agent = '', trace, turnId, log = console, slotNames = [], terminal = false, plan = false, agentScope = null } = {}) {
  const list = Array.isArray(pool) ? pool : [];
  const sel = selectTurnTools({ pool: list, message, history, agent, cap: capForProvider(provider), slotNames, terminal, plan, agentScope });
  const cat = selectCatalogueTools({ pool: list, message, agent, slotNames, terminal, plan });
  const offeredNames = new Set(sel.offered.map((t) => t.name));
  const index = cat.offered.filter((t) => !offeredNames.has(t.name));
  if (typeof trace === 'function') {
    try { trace({ protocol: 'volt', label: `tools offered: ${sel.offered.length} of ${sel.poolSize}`, ref: null, detail: sel.offered.map((t) => t.name).join(', ') }); } catch { /* telemetry only */ }
  }
  log.log?.(`[ToolOffer] turn=${turnId || '-'} agent=${agent} provider=${provider} path=cli offered=${sel.offered.length}/${sel.poolSize} index=${index.length} write_intent=${sel.writeIntent} tools=${sel.offered.map((t) => t.name).join(',')}`);
  return { offered: sel.offered, index, poolSize: sel.poolSize, writeIntent: sel.writeIntent, delegationHints: sel.delegationHints || [] };
}

module.exports = { buildCliToolOffer, renderToolIndex, renderToolCatalogue, argNames };
