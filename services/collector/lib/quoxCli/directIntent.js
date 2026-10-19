'use strict';
/**
 * QUOXON-ASK J2 (quox#852): does the human's own message ask for THIS quox CLI change?
 *
 * The conservative act check behind a no-card quox_cli_write (owner policy: a direct ask
 * is the authorization). True only when the message names the leaf's thing (a group word
 * of its path, e.g. "slot") AND carries an action word for its verb or one of the flags
 * the call sets (checkout --create accepts "make", "create", "new"...). A question or an
 * ask about something else keeps the card. Replace with lane N's read-vs-act intent when
 * it lands; this stays as the floor.
 */

// Leaf verbs and flag names -> the plain words a person uses for them.
const ACTION_WORDS = {
  create: ['create', 'make', 'new', 'add', 'spin', 'start', 'setup'],
  add: ['add', 'create', 'make', 'new', 'put', 'register'],
  new: ['new', 'create', 'make', 'add'],
  checkout: ['checkout', 'claim', 'take', 'grab', 'reserve', 'hold'],
  release: ['release', 'free', 'drop', 'return', 'give'],
  say: ['say', 'tell', 'post', 'send', 'message', 'ping', 'write', 'greet'],
  post: ['post', 'say', 'send', 'publish'],
  send: ['send', 'post', 'say', 'message', 'email', 'mail'],
  set: ['set', 'change', 'update', 'make', 'switch', 'put'],
  update: ['update', 'change', 'edit', 'set', 'modify', 'rename'],
  edit: ['edit', 'change', 'update', 'modify'],
  rename: ['rename', 'call', 'name'],
  delete: ['delete', 'remove', 'drop', 'destroy', 'rm', 'kill', 'get rid'],
  remove: ['remove', 'delete', 'drop', 'rm'],
  enable: ['enable', 'turn', 'switch', 'activate', 'start'],
  disable: ['disable', 'turn', 'switch', 'deactivate', 'stop'],
  start: ['start', 'run', 'launch', 'kick', 'begin'],
  stop: ['stop', 'halt', 'end', 'kill'],
  restart: ['restart', 'reboot', 'bounce'],
  run: ['run', 'start', 'execute', 'launch', 'kick'],
  assign: ['assign', 'give', 'hand'],
  install: ['install', 'add', 'setup'],
  uninstall: ['uninstall', 'remove'],
  tick: ['tick', 'check', 'mark', 'complete', 'done'],
  note: ['note', 'add', 'log', 'record', 'write'],
  attach: ['attach', 'become', 'connect'],
  detach: ['detach', 'disconnect', 'leave'],
};
const IGNORED_FLAGS = new Set(['json', 'yes', 'profile', 'org', 'p']);
// #913: leaves named after their group, where people use another noun for the thing they act on.
const LEAF_THINGS = {
  'plan add': ['stream'],
};

function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
const words = (text) => String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);

function askMatchesLeaf(message, built, argv = []) {
  if (!message || !built || !built.leaf || !Array.isArray(built.leaf.path)) return false;
  const said = new Set(words(message));
  const path = built.leaf.path.map((p) => String(p).toLowerCase());
  // trust-c1 LOW (FND_01M4Z0E4W5263W9MNKMW263W9M): require the DEEPEST thing segment (the noun
  // immediately above the verb), not ANY segment. A broad group word shared by many leaves (e.g.
  // "org") plus a generic verb must NOT authorize a deep leaf like `org members add`; the human has
  // to name the specific noun ("member"). Unchanged for the common two-segment leaf.
  const last = path[path.length - 1];
  // #913: a leaf whose last segment is a noun (`plan phase <stream> <verb>`) takes its verb from the
  // positionals; the noun itself is then the specific thing (still the deepest noun, per trust-c1).
  const positionals = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : [];
  const positionalVerb = ACTION_WORDS[last] ? null : positionals.find((a) => typeof a === 'string' && ACTION_WORDS[a.toLowerCase()]);
  const specificSeg = positionalVerb ? last : (path.length >= 2 ? path[path.length - 2] : (path[0] || ''));
  const specificThings = [...specificSeg.split('-'), ...(LEAF_THINGS[path.join(' ')] || [])].map(stem);
  if (!specificThings.some((t) => said.has(t))) return false;
  const verbs = new Set(positionalVerb ? [positionalVerb.toLowerCase()] : last.split('-'));
  for (const a of argv) {
    if (typeof a === 'string' && a.startsWith('--')) {
      const name = a.slice(2).split('=')[0].replace(/^no-/, '');
      if (!IGNORED_FLAGS.has(name)) verbs.add(name);
    }
  }
  for (const v of verbs) {
    for (const w of [v, ...(ACTION_WORDS[v] || [])]) if (said.has(stem(w))) return true;
  }
  return false;
}

// approvals-glitch (2026-10-15): "1 works for me too, do that" answers the agent's own proposal
// ("add your email to the existing contact"), so the human's words alone name no leaf. A SHORT
// human yes (never a question) is read together with the agent's last message, which the human
// has just read and agreed to; the leaf must still match words of that proposal.
const AFFIRM_RE = /\b(yes|yep|yeah|yup|ok|okay|sure|please do|do (that|it|so)|go ahead|go for it|works for me|sounds good|that one|confirm(ed)?|proceed)\b/i;
function isAffirmation(message) {
  const m = String(message || '').trim();
  if (!m || m.includes('?') || m.length > 120) return false;
  return AFFIRM_RE.test(m);
}
function confirmedAsk(message, lastAssistantText) {
  const m = String(message || '');
  const a = typeof lastAssistantText === 'string' ? lastAssistantText.trim() : '';
  if (!a || !isAffirmation(m)) return m;
  return `${a.slice(0, 1200)}\n${m}`.slice(-2000);
}

module.exports = { askMatchesLeaf, ACTION_WORDS, isAffirmation, confirmedAsk };
