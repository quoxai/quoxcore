'use strict';
/**
 * D3: per-turn tool selection for the API chat paths (openai, anthropic-api, ollama).
 *
 * The full grant for an agent (quox: ~156 tools, ~121k chars of schema) used to ride on
 * every model round. Here a cheap, deterministic ranker picks a small relevant subset for
 * the turn, schemas are compacted, and one meta tool (`more_tools`) lets the model ask
 * for a tool it was not offered; the new tool is offered from the NEXT model round.
 *
 * Governance does not move:
 *  - the pool is whatever resolveStreamToolSet already resolved (agent grant, QuoxHat
 *    manifest, provider cap); an offer is always a subset of it, never wider;
 *  - every offered call still goes through dispatchGovernedToolCall -> executeTool
 *    (RBAC, QuoxHat membership, GOV-4 policy, approval gate);
 *  - a call to a tool that was not offered on the turn is refused in the loop and never
 *    reaches executeTool (see governedToolDispatch.handleOfferGate);
 *  - more_tools is a catalogue read: names and one-line descriptions, no effect.
 *
 * State-changing tools (writes, notifiers, exec) stay out of the offer unless the user's
 * own message asks for a change, or the agent's role needs the tool (quox delegates).
 * Evidence: QXC_0b70b794 (2026-10-12 21:53 UTC, OpenAI path) wrote 3 memory rows and an
 * inbox item when the user only stated a decision and asked "Reply OK".
 */

const MORE_TOOLS_NAME = 'more_tools';
const DEFAULT_CAP = 16;
const OLLAMA_CAP = 8;
const MORE_TOOLS_LIMIT = 6;
const DESC_MAX = 240;
const PARAM_DESC_MAX = 120;

const STATE_CHANGE_RULE = 'Only call tools that change state when the user asks for that change.';
// QUOXON-PARITY claim rules (#815, #810): a claim needs a tool result behind it. Every
// API path (openai, anthropic-api, ollama, compat) gets these via buildTurnSystemPrompt,
// and the Claude CLI path via its own prompt, so the contract is the same on every provider.
const APPROVAL_CLAIM_RULE = 'Never say an approval card or approval request exists unless a tool result in this conversation contains its approval id. A refusal (HTTP 403, refused, denied) is not an approval: say the action was refused and nothing ran.';
const SAFETY_CLAIM_RULE = 'Never state a safety, threat or DEFCON level, or that an agent is halted, unless a tool returned it in this conversation (safety_status reads the real DEFCON level and kill switches).';
// #811: "inbox" means mail. InboxQ tools (inbox_zones, inbox_search) answer mail questions;
// approvals waiting on the user are list_approvals / inbox_pending; LUCID is not the mailbox.
const INBOX_ROUTING_RULE = 'Questions about the user\'s inbox, mail or email are answered from InboxQ (inbox_accounts, inbox_zones, inbox_search), not from LUCID; approvals waiting on the user are list_approvals or inbox_pending.';
// #817 / #818: names, ids, counts, ages, recency and agent capabilities are read, not recalled.
// lib/answerGrounding.js checks the finished answer against the turn's tool results.
const GROUNDING_RULE = 'Name a quox command, dashboard surface, id, count, total or age only as a tool result in this conversation gives it; never invent one. A page of results is not the total: use the tool\'s total field. For "most recent" or "latest" use a tool that returns timestamps (query_envelopes, get_envelope_chain), not notes or session search. Describe what an agent can do only from agent_directory.';
const CLAIM_RULES = [APPROVAL_CLAIM_RULE, SAFETY_CLAIM_RULE, INBOX_ROUTING_RULE, GROUNDING_RULE];

// Read tools every agent gets when they are in its pool (bounded to half the cap).
// time_now first: tiny schema, and models otherwise guess the time and DST (QUOXON 2026-10-12).
const CORE_TOOLS = ['time_now', 'memory_search', 'fleet_status', 'inbox_pending', 'list_approvals'];
// What an agent's role needs on every turn, writers included (the role is the ask).
const AGENT_DEFAULTS = {
  quox: ['delegate_to_agent'],
  lucid: ['lucid_situation', 'lucid_item'],
};

// Name tokens that mark a tool as state-changing. Unknown verbs count as reads: a
// misclassification changes only what is OFFERED, never what executeTool permits.
const WRITE_TOKENS = new Set([
  'save', 'create', 'update', 'delete', 'remove', 'send', 'post', 'thread', 'like', 'repost',
  'add', 'set', 'tick', 'approve', 'deny', 'exec', 'execute', 'activate', 'deactivate', 'deploy',
  'import', 'dial', 'batch', 'log', 'record', 'register', 'propose', 'change', 'manage', 'move',
  'restore', 'install', 'start', 'stop', 'capture', 'upload', 'notification', 'note', 'apply',
  'accept', 'raise', 'end', 'sudo', 'ssh', 'say', 'assign', 'generate', 'admin', 'orchestrate',
  'reach', 'delegate', 'load', 'setup', 'complete', 'switch', 'like',
]);
const WRITE_NAMES = new Set(['proxmox_vm_action', 'commitment_resolve', 'action_add', 'action_move', 'action_update', 'action_delete', 'quox_cli_write']);
// QUOXON-REACH: reads whose names carry a write token. install_status reports version and
// service health; reach_agent computes an agent's blast radius. Neither changes anything.
const READ_NAMES = new Set(['install_status', 'reach_agent']);
// QUOXON-PARITY: capability REQUESTS, not changes. hat_propose_switch files a HITL item and
// never switches; hat_load_bundle loads only a bundle the ACTIVE hat already defines. They are
// how an agent asks for a capability it lacks, so every path offers them like reads (the
// Claude subscription path used them on 2026-10-13 while the OpenAI loop could not see them).
const CAPABILITY_TOOLS = ['hat_catalogue', 'hat_propose_switch', 'hat_load_bundle'];
const CAPABILITY_NAMES = new Set(CAPABILITY_TOOLS);
// Knowledge: the Qortex brain search. Offered whenever the user asks what the agent knows or
// thinks, or points at a page (an opinion is better grounded in what we already know).
const KNOWLEDGE_TOOL = 'quoxbrain_search';
const KNOWLEDGE_RE = /\b(what do (?:you|u|ya) (?:know|think|reckon)|what(?:'s| is) your (?:opinion|take|view)|(?:your|any) (?:thoughts|opinion|views?)|opinion|tell me about|know about|remind me|recall|background on|history of|why did we|what did we (?:decide|say)|our (?:project|product|plan|roadmap|decision|stack))\b/i;
// A capability the agent may not hold: hats, modes, privilege, or a specialist domain.
const CAPABILITY_RE = /\b(hats?|mode|privileged?|permission|access|security|vulnerab\w*|nsoc|switch|flip|lack|missing|don'?t have|can'?t)\b/i;

// Skills: the governed skill catalogue. Offered when the user asks about the agent's skills
// (parity run 20261013T070218Z: on the 8-tool cap the task words outranked the catalogue).
const SKILL_TOOLS = ['skills_list', 'skill_view'];
const SKILL_RE = /\b(?:skills?|crystals?|playbooks?)\b/i;

// QUOXON-PARITY lane E1 (#809, #810, #811): the user's words name a CLI-readable surface,
// so its read tool is offered first, on every provider cap (ollama's 8 included). Reads only;
// routed tools are bounded to half the cap so the ranked matches still get room.
const INTENT_ROUTES = [
  [/\b(?:receipts?|envelopes?)\b/i, ['ward_verify']],
  [/\b(?:ward|witness\w*|tamper\w*)\b/i, ['ward_status', 'ward_verify']],
  [/\bgrants?\b/i, ['standing_grants_list']],
  [/\b(?:seo|crawl\w*|search console|gsc|sitemap|indexing)\b/i, ['quoxseo_summary', 'quoxseo_issues']],
  [/\b(?:inbox|mail|e-?mails?|mailbox)\b/i, ['inbox_zones', 'inbox_search', 'inbox_accounts']],
  [/\b(?:defcon|safety|kill.?switch\w*|e-?stop\w*|halted|threat level)\b/i, ['safety_status']],
  // #818: recency of actions and evidence needs timestamps; peers' capabilities need the registry.
  [/\b(?:most recent|latest|last|newest)\b[\s\S]*\b(?:actions?|envelopes?|events?|evidence|receipts?)\b|\bevidence chain\b/i, ['query_envelopes', 'get_envelope_chain']],
  [/\b(?:agents?|specialists?)\b[\s\S]*\b(?:can|talk|handles?|does|do|capabilit\w*|available|which|who)\b|\b(?:which|what|who)\b[\s\S]*\b(?:agents?|specialists?)\b/i, ['agent_directory']],
  [/\bmemor\w*\b[\s\S]*\b(?:history|revisions?|versions?)\b|\b(?:history|revisions?|versions?)\b[\s\S]*\bmemor\w*/i, ['memory_history', 'memory_search']],
];
// QUOXON-ASK lane J: the CLI reach fallback. When the user's words name a quox CLI
// group (or say "quox <verb>" / "cli") and NO pool tool matches by name, quox_cli is
// offered so the ask can still be done; a dedicated tool that matches by name wins.
// quox_cli_write rides the same rule but stays a write (offered only on write intent).
const CLI_TOOLS = ['quox_cli', 'quox_cli_write'];
// Group names that are ordinary words or never-class groups: they never signal CLI intent.
const CLI_GENERIC_GROUPS = new Set(['status', 'health', 'open', 'run', 'file', 'tag', 'chat', 'setup', 'config', 'done', 'watch', 'wrap',
  'tips', 'x', 'server', 'motion', 'scope', 'service', 'login', 'logout', 'signup', 'completion', 'tui', 'account', 'doctor', 'build',
  'policy', 'prompt', 'role', 'team', 'tool', 'dashboard', 'claude', 'codex', 'gemini', 'onboard', 'whoami', 'sitrep', 'sessions']);
let _cliGroups = null;
function cliGroups() {
  if (_cliGroups) return _cliGroups;
  _cliGroups = new Set();
  try {
    const tree = require('../config/cliLeafTree.json');
    for (const k of Object.keys(tree.leaves || {})) {
      const g = k.split(' ')[0];
      if (!CLI_GENERIC_GROUPS.has(g)) { _cliGroups.add(g); _cliGroups.add(stem(g)); }
    }
  } catch { /* no tree: the fallback only fires on an explicit "quox <verb>" */ }
  return _cliGroups;
}
let _cliVerbs = null;
/** The leaf verbs (last word of each leaf), stemmed, minus anything that is also a group name. */
function cliVerbs() {
  if (_cliVerbs) return _cliVerbs;
  _cliVerbs = new Set();
  try {
    const keys = Object.keys(require('../config/cliLeafTree.json').leaves || {});
    const groups = new Set(keys.map((k) => k.split(' ')[0]));
    for (const k of keys) { const v = k.split(' ').pop(); if (!groups.has(v)) _cliVerbs.add(stem(v)); }
  } catch { /* no tree */ }
  for (const v of ['list', 'show', 'get', 'read', 'view', 'search', 'status', 'run', 'set', 'what', 'which', 'verify', 'verified']) _cliVerbs.add(stem(v));
  // Context words that say WHERE, not WHAT (org_directory must not swallow "for this org").
  for (const v of ['org', 'orgs', 'organization', 'organisation', 'quox', 'instance', 'install', 'account', 'yesterday', 'today', 'week']) _cliVerbs.add(stem(v));
  return _cliVerbs;
}
const CLI_EXPLICIT_RE = /\bquox\s+[a-z][a-z-]+|\b(?:cli|command line)\b/i;
function hasCliIntent(message) {
  const m = String(message || '');
  if (CLI_EXPLICIT_RE.test(m)) return true;
  const groups = cliGroups();
  return tokens(m).some((t) => groups.has(t) || groups.has(stem(t)));
}

function routedToolNames(message) {
  const m = String(message || '');
  const out = [];
  for (const [re, names] of INTENT_ROUTES) if (re.test(m)) for (const n of names) if (!out.includes(n)) out.push(n);
  return out;
}

// The user's own words asking for a change. Matched on the CURRENT message only.
const WRITE_INTENT_RE = /\b(switch|flip|swap|enable|disable|remember|memori[sz]e|save|store|record|note (?:this|that|down)|log (?:this|that|it)|create|make|add|send|post|tweet|publish|notify|alert me|email (?:to|him|her|them)|update|change|edit|set|delete|remove|cancel|approve|deny|reject|execute|exec|restart|start|stop|deploy|install|tick|mark|schedule|book|call|dial|write|apply|move|assign|import|upload|capture|reboot|rename|delegate|run)\b/i;

// A URL or bare domain in the user's own message ("cli.quox.ai", "https://x.io/a"):
// the user is pointing at a page, so the read-only page reader must be offered.
const URL_RE = /\bhttps?:\/\/[^\s<>"']+|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<>"']*)?(?=$|[\s,;:!?)'"])/i;
const URL_READ_TOOL = 'web_read';
function hasUrlInMessage(message) {
  const m = String(message || '').match(URL_RE);
  if (!m) return false;
  // "e.g." / "i.e." / version-like "v2.1" are not domains: need an alphabetic TLD of 2+ letters, checked by the regex.
  return !/^(?:e\.g|i\.e)$/i.test(m[0]);
}

const STOP = new Set(('a an the and or but if then so to of in on at by for with from as is are was were be been being it its this that these those '
  + 'i me my we our you your he she they them their what which who whom how when where why can could would should will shall do does did done '
  + 'please use tool tools any some all no not just also there here about into over up down out only one get give show tell me ok reply yes').split(/\s+/));

// Small, explicit query expansions (user words -> tool vocabulary).
const SYNONYMS = {
  remember: ['memory', 'save'], memorise: ['memory', 'save'], memorize: ['memory', 'save'], recall: ['memory', 'search'],
  notify: ['notification', 'send'], alert: ['alert', 'notification'],
  certificate: ['tls', 'cert'], cert: ['tls'], ssl: ['tls'],
  approval: ['approval', 'pending', 'inbox'], pending: ['pending', 'inbox'],
  container: ['docker'], vm: ['proxmox'], hypervisor: ['proxmox'],
  roadmap: ['quoxplan'], stream: ['quoxplan'], phase: ['quoxplan'],
  mail: ['email'], inbox: ['inbox', 'email'],
  host: ['fleet'], server: ['fleet'], hosts: ['fleet'], fleet: ['fleet', 'status'],
  metric: ['metrics'], cpu: ['metrics'], prometheus: ['metrics'],
  situation: ['lucid', 'situation'], sitrep: ['lucid', 'situation'], awareness: ['lucid'],
  tweet: ['x', 'post'], twitter: ['x'],
  agent: ['delegate', 'agent'], specialist: ['delegate'],
  fetch: ['web', 'read'], website: ['web', 'read'], webpage: ['web', 'read'], url: ['web', 'read'], link: ['web', 'read'],
  browse: ['web', 'read'], browsing: ['web', 'read'], site: ['web', 'read'], domain: ['web', 'read'],
};

function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('es') && /(sses|ches|shes|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  return w;
}

function tokens(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && w.length > 1 && !STOP.has(w));
}

/** Weighted query terms: the current message counts 3, recent user turns 1. */
function queryTerms(message, history) {
  const terms = new Map();
  const add = (w, weight) => {
    const s = stem(w);
    terms.set(s, Math.max(terms.get(s) || 0, weight));
    for (const syn of SYNONYMS[w] || SYNONYMS[s] || []) terms.set(syn, Math.max(terms.get(syn) || 0, weight));
  };
  const recent = (Array.isArray(history) ? history : []).filter((m) => m && m.role === 'user').slice(-3);
  for (const m of recent) for (const w of tokens(typeof m.content === 'string' ? m.content : '')) add(w, 1);
  for (const w of tokens(message)) add(w, 3);
  return terms;
}

function nameTokens(name) {
  return String(name || '').toLowerCase().split(/[_\-.]+/).filter(Boolean);
}

function isStateChangingTool(tool) {
  const name = String(tool && tool.name || '').toLowerCase();
  if (!name || name === MORE_TOOLS_NAME) return false;
  if (CAPABILITY_NAMES.has(name)) return false;
  if (READ_NAMES.has(name)) return false;
  if (WRITE_NAMES.has(name)) return true;
  return nameTokens(name).some((t) => WRITE_TOKENS.has(t));
}

function hasWriteIntent(message) {
  return WRITE_INTENT_RE.test(String(message || ''));
}

/**
 * First sentence of a description: up to the first [.!?] followed by whitespace and an
 * uppercase letter (or the end), so "v2.1" and "e.g. for" never cut. Capped.
 */
function firstSentence(text, max = DESC_MAX) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const m = s.match(/^(.*?[.!?])(?=\s+[A-Z(`"']|$)/);
  let out = m ? m[1] : s;
  if (out.length > max) out = `${out.slice(0, max - 1).trimEnd()}…`;
  return out;
}

function compactSchema(schema) {
  if (Array.isArray(schema)) return schema.map(compactSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'examples' || k === 'example') continue;
    if (k === 'description') { if (typeof v === 'string' && v) out.description = firstSentence(v, PARAM_DESC_MAX); continue; }
    if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)) {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) out.properties[pk] = compactSchema(pv);
      continue;
    }
    if (['items', 'anyOf', 'oneOf', 'allOf', 'additionalProperties', 'not'].includes(k)) { out[k] = compactSchema(v); continue; }
    out[k] = v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
  }
  return out;
}

/**
 * The model-facing definition: name and parameter names/types/required/enums exact,
 * descriptions cut to their first sentence, examples dropped. Never mutates the source.
 */
function compactTool(tool) {
  const out = { name: tool.name };
  const d = firstSentence(tool.description);
  if (d) out.description = d;
  out.input_schema = compactSchema(tool.input_schema || tool.inputSchema || { type: 'object', properties: {} });
  return out;
}

const MORE_TOOLS_DEF = {
  name: MORE_TOOLS_NAME,
  description: 'Find more tools when none offered fits the task: give what you need to do; the tools returned can be called on your next step.',
  input_schema: { type: 'object', properties: { query: { type: 'string', description: 'What you need to do, in a few words.' } }, required: ['query'] },
};

function scoreTool(tool, terms) {
  const nameSet = new Set(nameTokens(tool.name).map(stem));
  const descSet = new Set(tokens(firstSentence(tool.description)).map(stem));
  let score = 0;
  for (const [t, w] of terms) {
    if (nameSet.has(t)) score += 2 * w;
    else if (descSet.has(t)) score += w;
  }
  return score;
}

/** Rank pool tools against terms; ties keep the pool order (deterministic). */
function rank(pool, terms) {
  return pool
    .map((tool, idx) => ({ tool, idx, score: scoreTool(tool, terms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
}

/**
 * -> { offered: tool[], poolSize, writeIntent, withheld: string[] }
 * offered keeps the original definitions (compaction happens at the model boundary).
 */
function selectTurnTools({ pool, message = '', history = [], agent = '', cap = DEFAULT_CAP } = {}) {
  const list = (Array.isArray(pool) ? pool : []).filter((t) => t && t.name && t.name !== MORE_TOOLS_NAME);
  const max = Math.max(1, Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_CAP);
  const writeIntent = hasWriteIntent(message);
  const roleNeeds = new Set(AGENT_DEFAULTS[String(agent || '').toLowerCase()] || []);
  const eligible = (t) => roleNeeds.has(t.name) || writeIntent || !isStateChangingTool(t);
  const byName = new Map(list.map((t) => [t.name, t]));
  const picked = [];
  const seen = new Set();
  const take = (t) => { if (t && !seen.has(t.name) && picked.length < max && eligible(t)) { seen.add(t.name); picked.push(t); } };

  const terms = queryTerms(message, history);
  const ranked = rank(list, terms);
  // 0. a URL in the user's message: the read-only page reader (egress-guarded) comes first
  const url = hasUrlInMessage(message);
  if (url) take(byName.get(URL_READ_TOOL));
  // 0b. knowledge / opinion (or a URL to have an opinion on): the brain search
  if (url || KNOWLEDGE_RE.test(String(message || ''))) take(byName.get(KNOWLEDGE_TOOL));
  // 0c. a capability the agent may lack: the hat tools (inspect, then propose)
  if (CAPABILITY_RE.test(String(message || ''))) { take(byName.get('hat_catalogue')); take(byName.get('hat_propose_switch')); }
  // 0d. the skill catalogue, when the user asks about skills
  if (SKILL_RE.test(String(message || ''))) for (const n of SKILL_TOOLS) take(byName.get(n));
  // 0e. a CLI-readable surface the user named: its read tool (bounded to half the cap)
  { let routed = 0; for (const n of routedToolNames(message)) { if (routed >= Math.ceil(max / 2)) break; const t = byName.get(n); if (t && !seen.has(n)) { take(t); if (seen.has(n)) routed++; } } }
  // 1. the strongest matches first (at least a third of the cap), so core never crowds them out
  const strong = Math.max(1, Math.floor(max / 3));
  for (const r of ranked.filter((x) => eligible(x.tool)).slice(0, strong)) take(r.tool);
  // 1b. a CLI capability no pool tool matches by name: the CLI reach tool (lane J)
  if (hasCliIntent(message)) {
    // Nouns from the user's own message; verbs (list, show, get...) name-match dozens of
    // tools and say nothing about whether a DEDICATED tool covers the thing asked about.
    const verbs = cliVerbs();
    const nouns = new Set(tokens(message).map(stem).filter((t) => !verbs.has(t))); // literal words, no synonyms
    const nameHit = ranked.some((r) => !CLI_TOOLS.includes(r.tool.name) && nameTokens(r.tool.name).some((t) => nouns.has(stem(t))));
    if (!nameHit || CLI_EXPLICIT_RE.test(String(message || ''))) for (const n of CLI_TOOLS) take(byName.get(n));
  }
  // 2. what the agent's role needs
  for (const n of roleNeeds) take(byName.get(n));
  // 3. core reads, bounded to half the cap
  let core = 0;
  for (const n of CORE_TOOLS) { if (core >= Math.ceil(max / 2)) break; const t = byName.get(n); if (t && !seen.has(n)) { take(t); if (seen.has(n)) core++; } }
  // 4. the rest of the ranked matches
  for (const r of ranked) take(r.tool);
  // 5. a pool whose eligible tools all fit the cap is offered whole (nothing to gain by guessing)
  const eligibleAll = list.filter(eligible);
  if (eligibleAll.length <= max) for (const t of eligibleAll) take(t);

  const withheld = writeIntent ? [] : ranked.filter((r) => !eligible(r.tool)).map((r) => r.tool.name);
  return { offered: picked, poolSize: list.length, writeIntent, withheld };
}

/**
 * The per-turn offer the loops consult. tools() is what the model sees this round
 * (compact definitions + more_tools); isOffered() gates dispatch; moreTools() widens
 * the offer for the next round, within the same pool and the same write rule.
 */
function createToolOffer({ pool, message = '', history = [], agent = '', cap = DEFAULT_CAP, compact = true, onWiden } = {}) {
  const list = (Array.isArray(pool) ? pool : []).filter((t) => t && t.name && t.name !== MORE_TOOLS_NAME);
  const sel = selectTurnTools({ pool: list, message, history, agent, cap });
  const offered = new Map(sel.offered.map((t) => [t.name, t]));
  const maxOffered = Math.max(cap * 3, cap + MORE_TOOLS_LIMIT);
  const roleNeeds = new Set(AGENT_DEFAULTS[String(agent || '').toLowerCase()] || []);
  const eligible = (t) => roleNeeds.has(t.name) || sel.writeIntent || !isStateChangingTool(t);
  const shape = (t) => (compact ? compactTool(t) : { name: t.name, description: t.description, input_schema: t.input_schema || t.inputSchema || { type: 'object', properties: {} } });

  return {
    tools() {
      return [...[...offered.values()].map(shape), MORE_TOOLS_DEF];
    },
    isOffered(name) { return offered.has(name); },
    offeredNames() { return [...offered.keys()]; },
    summary() { return { offered: offered.size, pool: list.length, writeIntent: sel.writeIntent, names: [...offered.keys()] }; },
    /** The more_tools call. -> a tool result (success, tools[{name, description}], withheld, note). */
    moreTools(input) {
      const q = input && typeof input.query === 'string' ? input.query.slice(0, 300) : '';
      const terms = queryTerms(q, []);
      const ranked = rank(list.filter((t) => !offered.has(t.name)), terms);
      const added = [];
      const withheld = [];
      for (const r of ranked) {
        if (!eligible(r.tool)) { withheld.push(r.tool.name); continue; }
        if (added.length >= MORE_TOOLS_LIMIT || offered.size >= maxOffered) break;
        offered.set(r.tool.name, r.tool);
        added.push({ name: r.tool.name, description: firstSentence(r.tool.description) });
      }
      // QUOXON-PARITY: the capability may live on another hat. When the search adds nothing,
      // the hat tools (inspect, propose) are offered so the agent can ask instead of giving up.
      // Keyword matches on a generic verb ("read") can look like hits, so the hat tools ride
      // along on every more_tools answer (outside the per-call limit) until they are offered.
      const searchFound = added.length > 0;
      let hatHint = false;
      for (const n of CAPABILITY_TOOLS) {
        const t = list.find((x) => x.name === n);
        if (!t) continue;
        hatHint = true;
        if (!offered.has(n) && offered.size < maxOffered) { offered.set(n, t); added.push({ name: n, description: firstSentence(t.description) }); }
      }
      if (added.length && typeof onWiden === 'function') {
        try { onWiden(added.map((a) => a.name)); } catch { /* telemetry only */ }
      }
      const notes = [];
      notes.push(searchFound ? 'These tools can be called on your next step.' : 'No other tool on this hat matches that.');
      if (hatHint) notes.push('If the capability is still missing, hat_catalogue shows which hat carries it and hat_propose_switch asks the user to switch (a human approves); say what is missing rather than guessing.');
      else if (!searchFound) notes.push('Answer with what you have or say what is missing.');
      if (withheld.length) notes.push(`State-changing tools (${withheld.slice(0, 6).join(', ')}) are offered only when the user asks for that change.`);
      return { success: true, tools: added, withheld: withheld.slice(0, 10), note: notes.join(' ') };
    },
  };
}

/**
 * The /chat/stream wiring: build the offer for one governed API turn, record it on the
 * turn (trace `tools offered: N of M`) and in the log. -> the offer.
 */
function buildStreamToolOffer({ provider, pool, history, message, agent, trace, turnId, profile, log = console }) {
  const onWiden = typeof trace === 'function'
    ? (names) => { try { trace({ protocol: 'volt', label: `tools added: ${names.length}`, ref: null, detail: names.join(', ') }); } catch { /* telemetry only */ } }
    : undefined;
  const offer = createToolOffer({ pool, message, history, agent, cap: capForProvider(provider), onWiden });
  const sum = offer.summary();
  if (typeof trace === 'function') {
    try { trace({ protocol: 'volt', label: `tools offered: ${sum.offered} of ${sum.pool}`, ref: null, detail: sum.names.join(', ') }); } catch { /* telemetry only */ }
  }
  log.log?.(`[ToolOffer] turn=${turnId || '-'} agent=${agent} provider=${provider} offered=${sum.offered}/${sum.pool} write_intent=${sum.writeIntent} profile=${profile || '-'} tools=${sum.names.join(',')}`);
  return offer;
}

/**
 * QUOXON-PARITY: the catalogue path (the Claude subscription CLI, which lists tools in its
 * prompt and calls them through `quox tool exec`; it has no per-round offer to widen).
 * Same pool and the SAME eligibility rule as createToolOffer, so the set a model may try is
 * identical on every path: every eligible tool (what an API offer reaches via more_tools),
 * state-changing tools only when the user asks for a change or the role needs them.
 * -> { offered, poolSize, writeIntent, withheld }
 */
function selectCatalogueTools({ pool, message = '', agent = '' } = {}) {
  const list = (Array.isArray(pool) ? pool : []).filter((t) => t && t.name && t.name !== MORE_TOOLS_NAME);
  const writeIntent = hasWriteIntent(message);
  const roleNeeds = new Set(AGENT_DEFAULTS[String(agent || '').toLowerCase()] || []);
  const eligible = (t) => roleNeeds.has(t.name) || writeIntent || !isStateChangingTool(t);
  return {
    offered: list.filter(eligible),
    poolSize: list.length,
    writeIntent,
    withheld: list.filter((t) => !eligible(t)).map((t) => t.name),
  };
}

/** The catalogue path's trace + log line, the same shape as buildStreamToolOffer's. -> tools */
function buildCatalogueTools({ provider, pool, message, agent, trace, turnId, log = console }) {
  const sel = selectCatalogueTools({ pool, message, agent });
  if (typeof trace === 'function') {
    try { trace({ protocol: 'volt', label: `tools offered: ${sel.offered.length} of ${sel.poolSize}`, ref: null, detail: sel.offered.map((t) => t.name).join(', ') }); } catch { /* telemetry only */ }
  }
  log.log?.(`[ToolOffer] turn=${turnId || '-'} agent=${agent} provider=${provider} path=catalogue offered=${sel.offered.length}/${sel.poolSize} write_intent=${sel.writeIntent}`);
  return sel.offered;
}

// Self-hosted model servers (small local context windows): Ollama and the B5
// openai_compatible self-hosted presets. Hosted presets (OpenRouter, HF, Groq,
// Together, Custom) are treated like OpenAI.
const SMALL_LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'vllm']);
const isSmallLocalProvider = (provider) => SMALL_LOCAL_PROVIDERS.has(String(provider || '').toLowerCase());

/** Per-provider cap: small local context windows get fewer tools. */
function capForProvider(provider) {
  return isSmallLocalProvider(provider) ? OLLAMA_CAP : DEFAULT_CAP;
}

// quox#908 (backported for ee3457cb9's auto-delegate read check, verbatim from 4fc9ac431):
// actions of otherwise-read tools that change state.
const TOOL_WRITE_ACTIONS = {
  grafana_dashboards: ['annotate'],
  alerts_manage: ['silence'],
  keeper_schedule_manage: ['create', 'update', 'delete'],
  brain_garden_apply: ['archive'],
  continuity: ['commit'],
  docker_fleet_container_action: ['start', 'stop', 'restart'],
  proxmox_vm_action: ['start', 'stop', 'reboot', 'shutdown'],
};
function isWriteAction(toolName, input) {
  const writes = TOOL_WRITE_ACTIONS[String(toolName || '')];
  if (!writes) return false;
  const a = input && typeof input === 'object' ? String(input.action || '').toLowerCase() : '';
  return writes.includes(a);
}

module.exports = {
  MORE_TOOLS_NAME,
  MORE_TOOLS_DEF,
  DEFAULT_CAP,
  OLLAMA_CAP,
  STATE_CHANGE_RULE,
  APPROVAL_CLAIM_RULE,
  SAFETY_CLAIM_RULE,
  INBOX_ROUTING_RULE,
  GROUNDING_RULE,
  CLAIM_RULES,
  CORE_TOOLS,
  AGENT_DEFAULTS,
  CAPABILITY_TOOLS,
  KNOWLEDGE_TOOL,
  SKILL_TOOLS,
  INTENT_ROUTES,
  routedToolNames,
  selectCatalogueTools,
  buildCatalogueTools,
  isStateChangingTool,
  isWriteAction,
  TOOL_WRITE_ACTIONS,
  hasWriteIntent,
  hasUrlInMessage,
  firstSentence,
  compactTool,
  selectTurnTools,
  createToolOffer,
  capForProvider,
  isSmallLocalProvider,
  buildStreamToolOffer,
};
