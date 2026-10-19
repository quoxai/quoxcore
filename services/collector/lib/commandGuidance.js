'use strict';
/**
 * QUOXON-ENGINE lane N, class 5 ("can't, and doesn't say how"): when a request maps to a
 * TUI or CLI command, the answer names the exact real command.
 *
 * Grounded in two generated snapshots, never in model memory:
 *  - config/cliCommandTree.json   (cli/scripts/export-command-tree.mjs, from `quox --help`)
 *  - config/tuiSlashRegistry.json (cli/scripts/export-tui-slash.mjs, the TUI /help registry)
 * Exact CLI forms with flags come from the TUI registry's own detail text (e.g. /slot says
 * it runs `quox slot checkout <name> --create --session <session>`), and every suggested
 * `quox` form is checked against the command tree before it is returned.
 *
 * Used by the quox_command_lookup tool and by the grounding contract, which appends the
 * real command when an answer says it cannot do something (or was asked how) and names none.
 */
const path = require('path');
const fs = require('fs');

let _tui = null;
function loadTuiRegistry() {
  if (_tui) return _tui;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'tuiSlashRegistry.json'), 'utf8'));
    _tui = Array.isArray(raw && raw.commands) ? raw.commands : [];
  } catch { _tui = []; }
  return _tui;
}
let _tree = null;
function loadTree() {
  if (_tree) return _tree;
  try { _tree = require('./answerGrounding.js').loadCommandTree() || {}; } catch { _tree = {}; }
  return _tree;
}

const STOP = new Set(('a an the and or but if then so to of in on at by for with from as is are was were be it its this that i me my we our you your '
  + 'what which who how when where why can could would should will do does did please just also there here about into up out only one get give show tell ok '
  + 'yes no not said say it\'s im i\'m use using want need like let quox command commands cli tui terminal').split(/\s+/));
const SYN = {
  new: 'create', make: 'create', add: 'create', creat: 'create', created: 'create', creating: 'create', setup: 'create',
  join: 'checkout', claim: 'checkout', take: 'checkout', hold: 'checkout',
  remove: 'delete', rm: 'delete', del: 'delete',
  show: 'list', ls: 'list', view: 'list',
  slots: 'slot', agents: 'agent', approvals: 'approval', grants: 'grant', skills: 'skill',
  // #913: the roadmap is the `plan` CLI group; users say QuoxPlan, roadmap or stream.
  quoxplan: 'plan', roadmap: 'plan', stream: 'plan',
};
function norm(w) {
  let s = String(w || '').toLowerCase();
  if (SYN[s]) return SYN[s];
  if (s.length > 4 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  return SYN[s] || s;
}
function toks(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w && w.length > 1 && !STOP.has(w)).map(norm);
}

/** A name the user gave ("slot QUOX1", "make the slot quox1"): the word after a known noun. */
function nameArg(query, noun) {
  const re = new RegExp(`\\b${noun}s?\\s+(?:called\\s+|named\\s+)?([A-Za-z][A-Za-z0-9_-]{1,40})\\b`, 'i');
  const m = String(query || '').match(re);
  if (!m) return null;
  const w = m[1];
  if (STOP.has(w.toLowerCase()) || SYN[w.toLowerCase()] || /^(?:create|delete|list|checkout|address|pool)$/i.test(w)) return null;
  return w;
}

function fill(template, name) {
  if (!name) return template;
  return template.replace(/<name>|<slot>|<agent>|<id>/, name);
}

/** -> true when `quox <verb> [<sub>]` exists in the generated tree. */
function realCli(form, tree = loadTree()) {
  const t = String(form || '').trim().split(/\s+/);
  if (t[0] !== 'quox' || !t[1]) return false;
  if (!Object.prototype.hasOwnProperty.call(tree, t[1])) return false;
  const subs = Array.isArray(tree[t[1]]) ? tree[t[1]] : [];
  return !subs.length || !t[2] || t[2].startsWith('<') || t[2].startsWith('-') || subs.includes(t[2]) ? true : !/^[a-z][a-z-]*$/.test(t[2]);
}

/**
 * -> { tui: [{command, usage, desc}], cli: [{command, source}], matched: boolean }
 * Deterministic. Only active TUI commands and real CLI verbs are returned.
 */
function lookupCommands(query, { max = 3 } = {}) {
  const q = toks(query);
  const qs = new Set(q);
  const tree = loadTree();
  const tui = loadTuiRegistry().filter((e) => e.status === 'active');
  const scored = [];
  // Domain nouns the user named that are CLI groups (calendar, slot...): a TUI match must be
  // about that domain, or "connect my calendar" would suggest /connect (model providers).
  // Only a verb named as itself is a domain: 'setup' normalises to 'create' and must not turn every
  // "create ..." ask into a domain-less one (#913: "create a QuoxPlan stream" fell through to /clear).
  const domains = [...qs].filter((w) => Object.keys(tree).some((v) => norm(v) === w && norm(v) === v.toLowerCase()));
  for (const e of tui) {
    let score = 0;
    if (domains.length) {
      const about = new Set([norm(e.id), ...toks(`${e.desc} ${e.detail || ''}`)]);
      if (!domains.some((d) => about.has(d))) continue;
    }
    const id = norm(e.id);
    if (qs.has(id)) score += 4;
    for (const a of e.aliases || []) if (qs.has(norm(a))) score += 3;
    const descT = new Set(toks(`${e.desc} ${e.detail || ''}`));
    for (const w of qs) if (w !== id && descT.has(w)) score += 1;
    if (score >= 4) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id));
  const out = { tui: [], cli: [], matched: false };
  const seenCli = new Set();
  const pushCli = (command, source) => { if (!seenCli.has(command) && out.cli.length < max && realCli(command, tree)) { seenCli.add(command); out.cli.push({ command, source }); } };
  for (const { e } of scored.slice(0, 1)) {
    const name = nameArg(query, e.id);
    out.tui.push({ command: fill(e.usage, name), usage: e.usage, desc: e.desc });
    for (const m of String(e.detail || '').matchAll(/`(quox [^`]+)`/g)) pushCli(fill(m[1], name), 'tui-detail');
  }
  // CLI leaves: verb match, then subcommand match
  const leaves = [];
  for (const [verb, subs] of Object.entries(tree)) {
    if (!qs.has(norm(verb))) continue;
    const list = Array.isArray(subs) && subs.length ? subs : [null];
    let anySub = false;
    for (const sub of list) {
      // #913: a sub named like its group ("plan plan") is not matched by the group word itself.
      const s = sub ? (norm(sub) !== norm(verb) && qs.has(norm(sub)) ? 3 : 0) : 1;
      if (sub && s) anySub = true;
      leaves.push({ verb, sub, s });
    }
    // #913: the ask is only the group ("quox plan") and no subcommand matched: the group itself is the answer.
    if (list[0] !== null && !anySub && q.length && q.every((w) => w === norm(verb))) leaves.push({ verb, sub: null, s: 2 });
  }
  leaves.sort((a, b) => b.s - a.s);
  for (const l of leaves.filter((x) => x.s > 0).slice(0, max)) {
    // qortex/brain-note-count: append a name only to a leaf that takes a positional argument, and
    // never the subcommand itself ("brain status status", "status total" were invented this way).
    const leafKey = `${l.verb}${l.sub ? ` ${l.sub}` : ''}`;
    const takesArg = (leafDetails(leafKey)?.arguments || []).length > 0;
    const raw = takesArg ? nameArg(query, l.verb) : null;
    const name = raw && (!l.sub || norm(raw) !== norm(l.sub)) ? raw : null;
    pushCli(`quox ${leafKey}${name ? ` ${name}` : ''}`, 'cli-tree');
  }
  out.matched = out.tui.length > 0 || out.cli.length > 0;
  return out;
}

/** A leaf's options and arguments from the vendored CLI tree, or null (never-class leaves give only the refusal). */
function leafDetails(leafPath) {
  try {
    const { loadTree: lt, classifyLeaf } = require('./quoxCli/policy.js');
    const key = String(leafPath || '').replace(/^quox\s+/, '').trim().toLowerCase().replace(/\s+/g, ' ');
    const leaf = lt().leaves[key];
    if (!leaf) return null;
    const cls = classifyLeaf(key);
    if (cls.class === 'never') return { leaf: `quox ${key}`, class: 'never', reason: cls.reason };
    const { refusedOption } = require('./quoxCli/validate.js');
    return {
      leaf: `quox ${key}`,
      class: cls.class,
      description: leaf.description || '',
      arguments: (leaf.args || []).map((a) => ({ name: a.name, required: !!a.required, variadic: !!a.variadic })),
      options: (leaf.options || []).filter((o) => o.long && !refusedOption(o.long, key)).map((o) => ({ flag: o.long, takes: o.value === 'none' ? 'nothing (a true/false flag)' : o.value, required: !!o.mandatory })),
    };
  } catch { return null; }
}

const quox_command_lookup = {
  name: 'quox_command_lookup',
  description: 'Find the exact real Quox command for something the user wants to do: the TUI slash command and the `quox` CLI form, from the generated command registries. Use it whenever you cannot do the thing yourself or the user asks how, and give the user the command it returns. Read-only.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What the user wants to do, in their words (e.g. "create slot QUOX1").' },
      leaf: { type: 'string', description: 'Optional: an exact command (e.g. "contacts list") to get its options and arguments.' },
    },
    required: ['query'],
  },
  execute: async (input) => {
    const q = input && typeof input.query === 'string' ? input.query.slice(0, 300) : '';
    const leafIn = input && typeof input.leaf === 'string' ? input.leaf.slice(0, 120) : '';
    if (!q && !leafIn) return { success: false, error: 'query is required' };
    const details = [];
    const d0 = leafIn ? leafDetails(leafIn) : null;
    if (d0) details.push(d0);
    const r = q ? lookupCommands(q) : { tui: [], cli: [], matched: false };
    for (const c of r.cli) { const d = leafDetails(c.command); if (d && !details.some((x) => x.leaf === d.leaf)) details.push(d); }
    if (details.length) r.leaf_details = details;
    if (details.length && !r.matched) return { success: true, matched: true, tui: [], cli: [], leaf_details: details, note: 'Use only the options listed here.' };
    if (!r.matched) return { success: true, matched: false, tui: [], cli: [], note: 'No TUI or CLI command matches that. Say there is no command for it; do not invent one.' };
    return { success: true, matched: true, ...r, note: 'Give the user these exact commands. Never name a command that is not listed here or in another tool result.' };
  },
};

module.exports = { lookupCommands, loadTuiRegistry, nameArg, realCli, quox_command_lookup, tokens: toks, normWord: norm };
