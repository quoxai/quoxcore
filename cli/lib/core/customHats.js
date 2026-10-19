/**
 * CUSTOM-HATS (owner 2026-10-17): pure helpers that build and edit a custom hat definition.
 * Shared by `quox hat create|edit` (cli/lib/commands/hat.js) and the quox window's /hat new|edit
 * (cli/lib/quoxon). No I/O, no chalk: safe to import anywhere.
 */

/** The two tools an orchestrator needs to reach the agents a hat lists. */
export const DELEGATION_TOOLS = ['delegate_to_agent', 'agent_directory'];
export const HAT_MODES = ['permissive', 'restrictive'];
export const HAT_OFFERS = ['members', 'authorized'];
const HARD_CAP = 128;

/** "a, b,,c" -> ['a','b','c'] (trimmed, lowercased, deduped, order kept). */
export function parseList(v) {
  if (v === undefined || v === null || v === true) return [];
  const out = [];
  for (const raw of String(v).split(',')) {
    const x = raw.trim().toLowerCase();
    if (x && !out.includes(x)) out.push(x);
  }
  return out;
}

/** Every tool name a hat names: explicit, bundles, on-demand reads. */
export function memberTools(def) {
  const t = def?.tools || {};
  const names = [
    ...(Array.isArray(t.explicit) ? t.explicit : []),
    ...(Array.isArray(t.bundles) ? t.bundles.flatMap(b => (Array.isArray(b?.tools) ? b.tools : [])) : []),
    ...(Array.isArray(t.on_demand_reads) ? t.on_demand_reads : []),
  ];
  return [...new Set(names)];
}

function emptyDefinition() {
  return {
    schema_version: 1,
    purpose: '',
    agents: { orchestrator: 'quox', specialists: [] },
    tools: { explicit: [], bundles: [], connector_families: [] },
    budgets: { initial_tool_target: 12, max_manifest: 32 },
    transitions: { allowed: 'any', confirm: 'none', privileged: false },
  };
}

function ensureDelegationTools(def) {
  const specialists = def.agents?.specialists || [];
  if (!specialists.length) return [];
  const explicit = def.tools.explicit;
  const added = DELEGATION_TOOLS.filter(t => !explicit.includes(t));
  explicit.unshift(...added);
  return added;
}

function fitBudgets(def) {
  const b = def.budgets || (def.budgets = {});
  const need = (def.tools.explicit || []).length;
  if (!Number.isInteger(b.max_manifest) || b.max_manifest < need) b.max_manifest = Math.min(HARD_CAP, Math.max(32, need));
  if (!Number.isInteger(b.initial_tool_target) || b.initial_tool_target < 1) b.initial_tool_target = Math.min(12, b.max_manifest);
  if (b.initial_tool_target > b.max_manifest) b.initial_tool_target = b.max_manifest;
}

/**
 * Restrictive = the hat AUTHORIZES only its members (+ the delegation pair); this binds every agent
 * working under the hat, the hat's own agents included when delegated to. Permissive = the agent's
 * own grant is the ceiling (the default). A deny list carried from --from is kept either way.
 */
export function applyMode(def, mode) {
  if (mode === undefined || mode === null) return;
  if (!HAT_MODES.includes(mode)) throw new Error(`--mode must be ${HAT_MODES.join(' or ')} (got '${mode}')`);
  const deny = Array.isArray(def.authz?.deny) ? def.authz.deny : null;
  if (mode === 'permissive') {
    if (deny) def.authz = { mode: 'permissive', deny };
    else delete def.authz;
    return;
  }
  def.authz = { mode: 'restrictive', allow: [...new Set([...memberTools(def), ...DELEGATION_TOOLS])], ...(deny ? { deny } : {}) };
}

/**
 * The definition a new custom hat starts from: a copy of --from (or an empty hat), with
 * --agents / --tools REPLACING the lists, the delegation tools added when the hat lists agents,
 * the offer set (default 'members': a custom hat offers its orchestrator only what it lists),
 * and budgets widened to fit. Pure: never mutates base.
 */
export function buildCustomDefinition({ base = null, name = '', purpose, agents, tools, mode, offer } = {}) {
  const def = base ? JSON.parse(JSON.stringify(base)) : emptyDefinition();
  def.schema_version = 1;
  def.agents = { orchestrator: 'quox', ...(def.agents || {}) };
  if (!Array.isArray(def.agents.specialists)) def.agents.specialists = [];
  def.tools = { ...(def.tools || {}) };
  def.tools.explicit = Array.isArray(def.tools.explicit) ? [...def.tools.explicit] : [];
  if (agents !== undefined) def.agents.specialists = [...agents];
  if (tools !== undefined) def.tools.explicit = [...tools];
  const autoAdded = ensureDelegationTools(def);
  const o = offer === undefined ? 'members' : offer;
  if (!HAT_OFFERS.includes(o)) throw new Error(`--offer must be ${HAT_OFFERS.join(' or ')} (got '${o}')`);
  def.tools.offer = o;
  if (purpose !== undefined && String(purpose).trim()) def.purpose = String(purpose).trim();
  if (!def.purpose || base) {
    if (purpose === undefined || !String(purpose).trim()) def.purpose = `${name || 'Custom'} work${def.agents.specialists.length ? ` with ${def.agents.specialists.join(', ')}` : ''}`;
  }
  fitBudgets(def);
  applyMode(def, mode);
  return { definition: def, autoAdded };
}

/**
 * Apply `quox hat edit` options to a copy of a definition. Returns the new definition and a
 * human list of changes (empty = nothing to do). --agents/--tools replace; --add-* / --remove-*
 * adjust. A restrictive allow list follows tool adds/removes so the hat keeps authorizing exactly
 * its members.
 */
export function applyHatEdits(current, opts = {}) {
  const def = JSON.parse(JSON.stringify(current || {}));
  def.agents = { orchestrator: 'quox', ...(def.agents || {}) };
  def.tools = { ...(def.tools || {}) };
  let specialists = Array.isArray(def.agents.specialists) ? [...def.agents.specialists] : [];
  let explicit = Array.isArray(def.tools.explicit) ? [...def.tools.explicit] : [];
  const changes = [];
  const beforeAgents = [...specialists];
  const beforeTools = new Set(memberTools(def));

  if (opts.agents !== undefined) specialists = [...opts.agents];
  for (const a of opts.addAgents || []) if (!specialists.includes(a)) specialists.push(a);
  if ((opts.removeAgents || []).length) specialists = specialists.filter(a => !opts.removeAgents.includes(a));
  if (opts.tools !== undefined) explicit = [...opts.tools];
  for (const t of opts.addTools || []) if (!explicit.includes(t)) explicit.push(t);
  if ((opts.removeTools || []).length) {
    explicit = explicit.filter(t => !opts.removeTools.includes(t));
    if (Array.isArray(def.tools.bundles)) def.tools.bundles = def.tools.bundles.map(b => ({ ...b, tools: (b.tools || []).filter(t => !opts.removeTools.includes(t)) }));
  }
  def.agents.specialists = specialists;
  def.tools.explicit = explicit;
  const autoAdded = (opts.removeTools || []).some(t => DELEGATION_TOOLS.includes(t)) ? [] : ensureDelegationTools(def);

  const agentsAdded = specialists.filter(a => !beforeAgents.includes(a));
  const agentsRemoved = beforeAgents.filter(a => !specialists.includes(a));
  if (agentsAdded.length) changes.push(`agents +${agentsAdded.join(', +')}`);
  if (agentsRemoved.length) changes.push(`agents -${agentsRemoved.join(', -')}`);
  const afterTools = new Set(memberTools(def));
  const toolsAdded = [...afterTools].filter(t => !beforeTools.has(t));
  const toolsRemoved = [...beforeTools].filter(t => !afterTools.has(t));
  if (toolsAdded.length) changes.push(`tools +${toolsAdded.join(', +')}`);
  if (toolsRemoved.length) changes.push(`tools -${toolsRemoved.join(', -')}`);

  if (opts.purpose !== undefined && String(opts.purpose).trim() && String(opts.purpose).trim() !== def.purpose) {
    def.purpose = String(opts.purpose).trim();
    changes.push('purpose');
  }
  if (opts.offer !== undefined) {
    if (!HAT_OFFERS.includes(opts.offer)) throw new Error(`--offer must be ${HAT_OFFERS.join(' or ')} (got '${opts.offer}')`);
    if ((def.tools.offer || 'authorized') !== opts.offer) { def.tools.offer = opts.offer; changes.push(`offer ${opts.offer}`); }
  }
  const prevMode = def.authz?.mode === 'restrictive' ? 'restrictive' : 'permissive';
  if (opts.mode !== undefined) {
    applyMode(def, opts.mode);
    if (opts.mode !== prevMode) changes.push(`mode ${opts.mode}`);
  } else if (prevMode === 'restrictive' && Array.isArray(def.authz?.allow) && (toolsAdded.length || toolsRemoved.length)) {
    const allow = new Set(def.authz.allow);
    for (const t of toolsAdded) allow.add(t);
    for (const t of toolsRemoved) allow.delete(t);
    def.authz = { ...def.authz, allow: [...allow] };
  }
  fitBudgets(def);
  return { definition: def, changes, autoAdded };
}

