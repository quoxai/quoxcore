'use strict';
/**
 * QUOXON-ASK lane J: per-leaf policy for the quox_cli agent tools.
 *
 * Every invocable `quox` leaf classes to exactly one of:
 *   read      runs on quox_cli straight away (caller identity, witnessed)
 *   write     runs only on quox_cli_write, through the shared approval gate
 *   immediate runs on quox_cli_write without an approval card (owner decision
 *             2026-10-14: only `safety estop`, because stopping is the safe direction
 *             and an emergency stop must not wait on a card); still witnessed
 *   never     refused with a plain reason, on every tool
 *
 * Precedence, strictest first:
 *   1. the built-in NEVER-FLOOR below (credentials, interactive or host-local commands,
 *      approval resolution, hidden commands). A policy file can never loosen it.
 *   2. IMMEDIATE_PATHS (owner override).
 *   3. SITE-CLI's per-leaf policy (config/cliLeafPolicy.json, vendored by
 *      scripts/sync-cli-leaf-policy.mjs).
 *   4. a conservative default for leaves the file does not know: read only when the
 *      verb is in READ_VERBS, otherwise write; hidden commands never.
 *
 * Per call (classifyCall): a read leaf called with an option that changes state
 * (--set, --clear, --enable...) is a write for that call.
 */

const path = require('node:path');
const fs = require('node:fs');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');
const TREE_FILE = path.join(CONFIG_DIR, 'cliLeafTree.json');
const POLICY_FILE = path.join(CONFIG_DIR, 'cliLeafPolicy.json');

// Top-level groups that are never run from a conversation, with the reason.
const NEVER_GROUP_REASONS = {
  account: 'changes your own password or session',
  login: 'signs in; the tool already runs as you',
  logout: 'ends a session',
  signup: 'creates an account',
  mfa: 'multi-factor setup and backup codes are credentials',
  config: 'local CLI profiles and tokens, not your org',
  setup: 'first-time install setup on a host',
  server: 'manages a self-hosted install on its host, not from a conversation',
  dashboard: 'prints a one-time signed-in link, which is a credential',
  open: 'opens a browser on the server',
  tui: 'interactive terminal UI',
  completion: 'shell completion script',
  chat: 'an interactive conversation; you are already in one',
  claude: 'starts an interactive terminal session',
  wrap: 'starts an interactive terminal session',
  codex: 'starts an interactive terminal session',
  gemini: 'starts an interactive terminal session',
  motion: 'plays an animation in a terminal',
  watch: 'a live dashboard that never ends',
  onboard: 'an interactive wizard',
  doctor: 'diagnoses the machine it runs on, which here is the server',
  update: 'updates the quox CLI installed on the machine it runs on, which here is the server',
  integration: 'deprecated alias of vault; use the vault commands',
};
const NEVER_GROUPS = new Set(Object.keys(NEVER_GROUP_REASONS));

// Exact leaves that are never run, beyond the groups.
const NEVER_PATH_REASONS = {
  'sessions attach': 'attaches an interactive terminal',
  'agent exec': 'runs an agent tool as an attached agent; use the tool itself',
  'agent attach': 'attaches this session to an agent',
  'lucid deck': 'an interactive full-screen deck',
  // Owner never-list (2026-10-14): standing grants pre-approve future actions, so an
  // agent never creates one; deleting the org and changing the plugin trust root are
  // owner acts.
  'approvals grants create': 'creates a standing grant that pre-approves future actions',
  'contacts grant add': 'creates a standing grant that pre-approves future contact',
  'org delete': 'deletes the organization',
  // ContactsQ human-only reads (2026-10-15, proof contact-handoffs-masked): quox_cli runs as the
  // caller, so these would hand the model what ContactsQ shows humans only. Agents use their own
  // masked tools: contacts_handoffs (age, never the text), contacts_context (an approved lease).
  'contacts handoffs': 'handoff note text is shown to humans only; contacts_handoffs gives an agent the count and age',
  'contacts facts': 'a contact\'s facts reach an agent only through an approved context lease (contacts_context)',
  'contacts dsar': 'a full personal-data export is a human action in the ContactsQ view',
  'vault get': 'returns a credential value',
  'vault cross-org': 'reaches another organization\'s vault',
  'plugin trusted-keys add': 'changes which plugin signing keys this install trusts',
  'plugin trusted-keys remove': 'changes which plugin signing keys this install trusts',
  // ROWS (2026-10-17): a status row can fetch any URL or run a shell command on the machine it runs on, which here is
  // the server (an SSRF or a shell escape from a conversation). Rows are set up from your own terminal; an agent can
  // still read them (rows list) and remove one (an approval card).
  'rows add': 'status rows are set up from your own terminal (a row can fetch any URL or run a command where it runs, which here is the server)',
  'rows edit': 'status rows are set up from your own terminal (a row can fetch any URL or run a command where it runs, which here is the server)',
  'rows test': 'testing a row fetches a URL or runs a command on the machine it runs on, which here is the server',
  'rows import': 'importing rows is done from your own terminal, where any command row needs your yes',
};

// Any of these words anywhere in the path makes a leaf never.
const NEVER_WORD_REASONS = {
  login: 'authentication', logout: 'authentication', signup: 'authentication',
  password: 'credentials', passwd: 'credentials', mint: 'mints a credential', reveal: 'reveals a secret',
  rotate: 'rotates a credential', 'break-glass': 'emergency access override', 'backup-codes': 'credentials',
  impersonate: 'acts as another user', 'self-update': 'replaces the CLI on the server',
  upload: 'reads a file from the server disk', purge: 'irreversible bulk delete',
  // An agent never resolves an approval, even with your session: approvals are yours to give.
  approve: 'resolves an approval, which only you can do', deny: 'resolves an approval, which only you can do', respond: 'resolves an approval, which only you can do',
};

// The verbs a built-in default treats as reads (spec, conservative on purpose).
const READ_VERBS = new Set(['list', 'show', 'get', 'status', 'search', 'stats', 'read', 'view', 'info', 'whoami', 'health']);

// Owner override (2026-10-14): runs without an approval card, still witnessed.
const IMMEDIATE_PATHS = new Set(['safety estop']);

// Options that turn a masked read into a raw one: never run for an agent, even on a read leaf.
const NEVER_OPTION_REASONS = {
  'contacts show': { full: 'raw phone numbers, emails and notes are shown to humans only' },
  'rows list': { now: 'fetching each row runs its URL or command on the server; plain rows list reads them' },
};

// Options that change state even on a leaf whose verb reads (mail watch active --set,
// vault repos --set/--clear, quoxchat availability --online/--offline).
const MUTATING_OPTION_WORDS = new Set(['set', 'unset', 'clear', 'online', 'offline', 'enable', 'disable', 'delete', 'remove', 'add', 'reset', 'apply', 'force', 'write', 'purge']);

let _tree = null;
let _policy;
function loadTree() {
  if (!_tree) _tree = JSON.parse(fs.readFileSync(TREE_FILE, 'utf8'));
  return _tree;
}
/** The vendored SITE-CLI policy, or null when the file is absent (built-in default then). */
function loadPolicy() {
  if (_policy === undefined) {
    try {
      const raw = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8'));
      const byPath = new Map();
      for (const r of raw.rows || []) if (r && typeof r.path === 'string') byPath.set(r.path, r);
      _policy = { rows: raw.rows || [], byPath };
    } catch (err) {
      if (err && err.code !== 'ENOENT') console.warn('[quox_cli] cliLeafPolicy.json unreadable, using the built-in default:', err.message);
      _policy = null;
    }
  }
  return _policy;
}

// #914: leaves inside a never-group that are org-level, not host-level, and ride the normal
// policy class (write = an approval card). `quox server config app-url` sets the public URL
// emails and sign-in links use; asking about it must reach a card, not "I have no tool".
const GROUP_FLOOR_EXEMPT = new Set(['server config app-url']);

function neverFloor(pathKey, leaf) {
  const words = pathKey.split(' ');
  if (NEVER_GROUPS.has(words[0]) && !GROUP_FLOOR_EXEMPT.has(pathKey)) return `quox ${words[0]}: ${NEVER_GROUP_REASONS[words[0]]}`;
  if (NEVER_PATH_REASONS[pathKey]) return NEVER_PATH_REASONS[pathKey];
  for (const w of words) if (NEVER_WORD_REASONS[w]) return NEVER_WORD_REASONS[w];
  if (leaf && leaf.hidden) return 'an internal command not meant to be run by hand';
  return null;
}

/**
 * -> { class: 'read'|'write'|'never'|'immediate', reason, source: 'floor'|'override'|'policy'|'default' }
 */
function classifyLeaf(pathKey, { tree = loadTree(), policy = loadPolicy() } = {}) {
  const leaf = tree && tree.leaves ? tree.leaves[pathKey] : null;
  if (!leaf) return { class: 'never', reason: 'not a quox command', source: 'floor' };
  const floor = neverFloor(pathKey, leaf);
  if (floor) return { class: 'never', reason: floor, source: 'floor' };
  if (IMMEDIATE_PATHS.has(pathKey)) return { class: 'immediate', reason: 'an emergency stop runs at once (stopping is the safe direction); it is still witnessed', source: 'override' };
  const row = policy && policy.byPath ? policy.byPath.get(pathKey) : null;
  if (row) return { class: row.class, reason: row.reason || row.class, source: 'policy' };
  const verb = pathKey.split(' ').pop();
  return READ_VERBS.has(verb)
    ? { class: 'read', reason: `"${verb}" reads`, source: 'default' }
    : { class: 'write', reason: `"${verb}" may change state, so it needs an approval`, source: 'default' };
}

/** Escalate a read leaf to write for one call when an argv option changes state. */
function classifyCall(leafClass, leafArgv, pathKey) {
  if (!leafClass || leafClass.class !== 'read') return leafClass;
  const neverOpts = (pathKey && NEVER_OPTION_REASONS[pathKey]) || null;
  for (const a of leafArgv || []) {
    if (a === '--') break;
    const m = /^--(?:no-)?([a-z0-9-]+)/.exec(a);
    if (!m) continue;
    if (neverOpts && neverOpts[m[1]]) return { class: 'never', reason: neverOpts[m[1]], source: 'floor' };
    if (m[1].split('-').some((w) => MUTATING_OPTION_WORDS.has(w))) {
      return { class: 'write', reason: `--${m[1]} changes state, so this call needs an approval`, source: 'call' };
    }
  }
  return leafClass;
}

module.exports = {
  loadTree,
  loadPolicy,
  classifyLeaf,
  classifyCall,
  NEVER_GROUPS,
  NEVER_GROUP_REASONS,
  NEVER_PATH_REASONS,
  NEVER_WORD_REASONS,
  READ_VERBS,
  IMMEDIATE_PATHS,
  MUTATING_OPTION_WORDS,
};
