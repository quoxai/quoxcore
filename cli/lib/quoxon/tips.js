/**
 * "Did you know...?" tips (QUOXON-TIPS, plan v3.1 workstream N). One registry, one honesty gate.
 *
 * Every feature ships canned tips here. A tip is shown only when:
 *   - its maturity is stable or beta (prototype features NEVER show, whatever the install says), and
 *   - every capability it requires is `installed` on THIS install per GET /api/v1/capabilities
 *     (a missing or unreadable contract means only tips that require nothing can show), and
 *   - the /tip-settings mode allows its tier (off = none, core = free tier and stable only, all = everything shipped), and
 *   - the user is not already using the thing (skipIf signals, or its `try` slash command already run).
 *
 * `tier` is advisory and follows the capabilities catalog: a feature gated behind a plugin licence is
 * 'paid', everything in the open core is 'free'. When unsure of a product's shipped state mark it
 * 'prototype' (hidden) until docs/STATUS_AND_LIMITS_*.md says beta or better.
 *
 * The registry is plain data and `tipsJson()` exports it, so the dashboard and cli.quox.ai can reuse it.
 * Pure module: no I/O, no clock, rng injected.
 */

export const MODES = ['all', 'core', 'off'];
export const DEFAULT_MODE = 'all';
export const TIP_FOOTER = '(/tip for another · /tip-settings off to stop)';

// requires: capability ids from the server contract. skipIf: usage signals ('hosts' = fleet hosts already connected).
const BASE = [
  // ---- core: talking to Quox --------------------------------------------------------------
  { id: 'chat-attach', product: 'Agents', tier: 'free', maturity: 'beta', requires: ['agents'], skipIf: [],
    text: 'You can talk to a specialist agent directly instead of going through CommanderQ.', try: '/attach' },
  { id: 'chat-resume', product: 'Chat', tier: 'free', maturity: 'beta', requires: [], skipIf: [],
    text: 'Every conversation is kept on your server, so you can pick one up again later.', try: '/resume' },
  { id: 'chat-compact', product: 'Chat', tier: 'free', maturity: 'beta', requires: [], skipIf: [],
    text: 'A long conversation getting heavy? Quox can summarise it and keep the decisions.', try: '/compact' },
  { id: 'chat-copy', product: 'Chat', tier: 'free', maturity: 'beta', requires: [], skipIf: [],
    text: 'Copy the last code block from an answer straight to your clipboard.', try: '/copy code' },
  { id: 'chat-cost', product: 'Chat', tier: 'free', maturity: 'beta', requires: [], skipIf: [],
    text: 'See the tokens and cost of this session per model, from real usage and never an estimate.', try: '/cost' },
  { id: 'chat-model', product: 'Providers', tier: 'free', maturity: 'beta', requires: [], skipIf: [],
    text: 'Choose which AI provider and model answers your next turns, including a local Ollama.', try: '/model' },
  { id: 'chat-model-chooser', product: 'Providers', tier: 'free', maturity: 'beta',
    requires: [], skipIf: [],
    text: '/model alone opens a chooser: pick a model with the arrow keys, press f to ' +
      'favourite it and d to make it your default.',
    try: '/model' },
  { id: 'chat-model-favs', product: 'Providers', tier: 'free', maturity: 'beta',
    requires: [], skipIf: ['modelFavs'],
    text: 'Switching models is one step with favourites: save the ones you use, then ' +
      '/model 1 jumps to the first. They follow your account to other machines.',
    try: '/model fav add' },
  { id: 'chat-rows', product: 'Chat', tier: 'free', maturity: 'beta', requires: [], skipIf: ['rows'],
    text: 'Put your own live stats above the status bar: /row add watches a URL or a command and shows a line you template, like 12/14 pass.',
    try: '/row' },
  { id: 'chat-bang', product: 'Chat', tier: 'free', maturity: 'beta', requires: [], skipIf: [],
    text: 'Need a quick command without opening a new session? Start a line with ! and it runs here, like !quox inbox list. The output stays with you unless you /share it.', try: '!ls' },
  { id: 'chat-dashboard', product: 'Dashboard', tier: 'free', maturity: 'beta', requires: [], skipIf: [],
    text: 'Open the web dashboard already signed in, with a one-time link.', try: '/dashboard' },
  { id: 'chat-sessions', product: 'Chat', tier: 'free', maturity: 'beta', requires: [], skipIf: [],
    text: 'See every live session, conversation, held slot and running job in your org in one view.', try: '/sessions all' },
  { id: 'chat-doctor', product: 'Chat', tier: 'free', maturity: 'beta', requires: [], skipIf: [],
    text: 'Something feels off? Doctor checks services, sign-in, your provider and the CLI version.', try: '/doctor' },
  { id: 'chat-gripe', product: 'Gripe', tier: 'free', maturity: 'beta', requires: [], skipIf: [],
    text: 'Found something broken or missing? Type it as a gripe and Quox files a GitHub issue after showing you first.', try: '/gripe' },

  // ---- core: trust and evidence -----------------------------------------------------------
  { id: 'trust-approvals', product: 'Approvals', tier: 'free', maturity: 'beta', requires: ['approvals'], skipIf: [],
    text: 'Risky actions wait for your decision, and every decision is recorded with who, when and what.', try: '/approvals' },
  { id: 'trust-proof', product: 'Receipts', tier: 'free', maturity: 'beta', requires: ['receipts'], skipIf: [],
    text: 'Every tool call leaves an evidence chain you can read back and check.', try: '/proof' },
  { id: 'trust-vault-lend', product: 'Vault', tier: 'free', maturity: 'stable', requires: ['vault'], skipIf: [],
    text: 'Give AIs access to things without them ever knowing the credentials: the Vault lends a secret just in time and audits every lease by label, never by value.', try: 'quox vault list' },
  { id: 'trust-connect', product: 'Vault', tier: 'free', maturity: 'beta', requires: ['vault'], skipIf: [],
    text: 'Add an AI provider key safely. It goes into the Vault and never passes through the conversation.', try: '/connect openai' },

  // ---- core: knowledge and awareness ------------------------------------------------------
  { id: 'know-memory', product: 'Memory', tier: 'free', maturity: 'beta', requires: ['memory'], skipIf: [],
    text: 'Quox remembers facts for your org and shows where each one came from, how old it is and how far to trust it.', try: '/memory' },
  { id: 'know-qortex', product: 'Qortex', tier: 'free', maturity: 'beta', requires: ['qortex'], skipIf: [],
    text: 'Search your org knowledge for past decisions and history, with the stored entries cited.', try: 'quox brain search' },
  { id: 'know-sitrep', product: 'LUCID', tier: 'free', maturity: 'beta', requires: ['lucid'], skipIf: [],
    text: 'One command for the situation now: what waits for you, what is running, and what Quox cannot see.', try: '/sitrep' },
  { id: 'know-away', product: 'LUCID', tier: 'free', maturity: 'beta', requires: ['lucid'], skipIf: [],
    text: 'Been away? Get a factual digest of what happened since you last used Quox.', try: '/away' },

  // ---- core: automation -------------------------------------------------------------------
  { id: 'auto-workflow', product: 'Workflows', tier: 'free', maturity: 'beta', requires: ['workflows'], skipIf: [],
    text: 'See the step-by-step flow of a workflow run, with timings and the human gates it passed.', try: '/workflow' },
  { id: 'auto-crystal', product: 'Crystals', tier: 'free', maturity: 'beta', requires: ['crystals'], skipIf: [],
    text: 'A workflow that keeps succeeding can be turned into a Crystal. Quox checks it against the real rule.', try: '/crystal' },
  { id: 'auto-skills', product: 'Skills', tier: 'free', maturity: 'beta', requires: ['skills'], skipIf: [],
    text: 'Your org keeps a library of procedural skills that agents can look up and improve over time.', try: '/skills' },
  { id: 'auto-hat', product: 'QuoxHat', tier: 'free', maturity: 'beta', requires: [], skipIf: [],
    text: 'Hats decide which tools an agent may use on a turn, so a narrow job gets a narrow toolbox.', try: 'quox hat list' },

  // ---- paid plugins -----------------------------------------------------------------------
  { id: 'fleet-hosts', product: 'Fleet', tier: 'paid', maturity: 'beta', requires: ['fleet'], skipIf: ['hosts'],
    text: 'Give AIs access to any host: install QuoxAgent on it and add it to QuoxBastion. Commands run governed, and risky ones wait for your approval.', try: 'quox fleet hosts' },
  { id: 'seo-quoxseo', product: 'QuoxSEO', tier: 'paid', maturity: 'stable', requires: ['seo'], skipIf: [],
    text: 'Save money on SEO tools: QuoxSEO crawls your sites, joins Search Console data and shows signed change events.', try: 'quox seo status' },
  { id: 'mail-inboxq', product: 'InboxQ', tier: 'paid', maturity: 'beta', requires: ['mail'], skipIf: [],
    text: 'InboxQ sorts your mail into focus, fyi, auto and screened, and proposes filing or drafting for your approval.', try: 'quox mail zones' },
  { id: 'qlarity-inspect', product: 'QLarity', tier: 'paid', maturity: 'beta', requires: ['qlarity'], skipIf: [],
    text: 'Ask what a live page is really doing: computed styles, console, network errors and screenshots, all receipted.', try: 'quox qlarity screenshot' },
  { id: 'plan-quoxplan', product: 'QuoxPlan', tier: 'paid', maturity: 'beta', requires: ['plan'], skipIf: [],
    text: 'Keep your roadmap in QuoxPlan and read or update streams, phases and notes from here.', try: 'quox plan focus' },
  { id: 'slots-address', product: 'QuoxSlots', tier: 'paid', maturity: 'beta', requires: ['slots'], skipIf: [],
    text: 'Give this session a durable address that people can message while you are away.', try: '/slot' },

  // ---- more tips (QUOXON-TIPS search): social, integrations, models, parity, sessions --------
  { id: 'social-x-post', product: 'X', tier: 'paid', maturity: 'beta', requires: [], skipIf: [],
    plugins: ['x'],
    text: 'With the X plugin, ask for a post and Quox files an approval card. Nothing is published until you approve it.',
    try: 'quox x post' },
  { id: 'social-x-thread', product: 'X', tier: 'paid', maturity: 'beta', requires: [], skipIf: [],
    plugins: ['x'],
    text: 'Write a thread in a file, blank line between posts, and Quox files one approval card for the whole thread.',
    try: 'quox x thread' },
  { id: 'social-x-engage', product: 'X', tier: 'paid', maturity: 'beta', requires: [], skipIf: [],
    plugins: ['x'],
    text: 'Likes, reposts and deletes on X also wait for your approval, and a daily engagement budget caps them.',
    try: 'quox x like' },
  { id: 'social-linkedin', product: 'LinkedIn', tier: 'paid', maturity: 'beta', requires: [], skipIf: [],
    plugins: ['linkedin'],
    text: 'With the LinkedIn plugin, drafts go to your approvals first and publish only after you say yes.',
    try: 'quox linkedin post' },
  { id: 'integrations-vault-types', product: 'Vault', tier: 'free', maturity: 'stable', requires: ['vault'], skipIf: [],
    text: 'Not sure how to connect something? Ask which integration types your vault supports and what each needs.',
    try: 'quox vault create' },
  { id: 'integrations-vault-test', product: 'Vault', tier: 'free', maturity: 'stable', requires: ['vault'], skipIf: [],
    text: 'Check that every stored credential still works with one command. Secrets show masked, never in full.',
    try: 'quox vault test-all' },
  { id: 'integrations-lan-host', product: 'Fleet', tier: 'free', maturity: 'beta', requires: [], skipIf: ['hosts'],
    text: 'A machine on your LAN joins your fleet with one install command. /hosts add prints it, no AI needed.',
    try: '/hosts add' },
  { id: 'integrations-capabilities', product: 'Capabilities', tier: 'free', maturity: 'beta', requires: [], skipIf: [],
    text: 'Wondering what is ready here and what needs setup? Capabilities says why, and how to fix each gap.',
    try: '/capabilities' },
  { id: 'models-auto', product: 'Providers', tier: 'free', maturity: 'beta', requires: [], skipIf: [],
    text: 'Let your server policy choose the model for you instead of picking one yourself.',
    try: '/model auto' },
  { id: 'approvals-terminal', product: 'Approvals', tier: 'free', maturity: 'beta', requires: ['approvals'], skipIf: [],
    text: 'Decide what is waiting without leaving the terminal: /approvals lists it, /approve N or /deny N decides.',
    try: '/approve' },
  { id: 'trust-aocl', product: 'Receipts', tier: 'free', maturity: 'beta', requires: [], skipIf: [],
    text: 'Expand the last turn into every AOCL layer, L0 ingress to L10 audit, with outcome and time for each.',
    try: '/aocl' },
  { id: 'sessions-rename', product: 'Chat', tier: 'free', maturity: 'beta', requires: [], skipIf: [],
    text: 'Name this session so you can tell it apart in the top rule and find it again with /resume.',
    try: '/rename' },
  { id: 'sessions-cli', product: 'Chat', tier: 'free', maturity: 'stable', requires: [], skipIf: [],
    text: 'The same view of live sessions, held slots and running jobs is a plain command outside the terminal too.',
    try: 'quox sessions' },
  { id: 'chat-dragon', product: 'Chat', tier: 'free', maturity: 'beta', requires: [], skipIf: [],
    text: 'Lost in the last answer? The dragon explains it in the simplest possible words.',
    try: '/dragon explain' },
  { id: 'mail-search', product: 'InboxQ', tier: 'paid', maturity: 'beta', requires: ['mail'], skipIf: [],
    text: 'Ask in plain words to find an email. InboxQ searches your connected accounts for you.',
    try: 'quox mail list' },
  { id: 'security-engagement', product: 'QuoxSecurity', tier: 'free', maturity: 'beta', requires: [], skipIf: [],
    text: 'Run a security check as an engagement: scope targets, scanners and recorded findings, not a one-off script.',
    try: 'quox engagement list' },
  { id: 'safety-estop', product: 'Safety', tier: 'free', maturity: 'stable', requires: [], skipIf: [],
    text: 'An agent misbehaving? The kill switch stops that one agent at once, and a human releases it later.',
    try: 'quox safety status' },
  { id: 'spend-budget', product: 'Budgets', tier: 'free', maturity: 'beta', requires: [], skipIf: [],
    text: 'Put a budget on workflow spend and usage, by org, objective, execution or iteration.',
    try: 'quox budget' },

  { id: 'bang-share', product: 'Chat', tier: 'free', maturity: 'beta', requires: [], skipIf: [],
    text: 'Output of a ! command stays on your screen. /share attaches the latest one to your next message.',
    try: '/share' },

  // ---- not shipped: never shown (the gate holds even when the install reports the capability) ----
  { id: 'voice-phone-call', product: 'QuoxVoice', tier: 'paid', maturity: 'prototype', requires: ['voice'], skipIf: [],
    text: 'Quox can call you on the telephone.', try: 'quox voice calls' },
  { id: 'calendar-calendarq', product: 'Calendar-Q', tier: 'paid', maturity: 'prototype', requires: ['calendar'], skipIf: [],
    text: 'Read your agenda and let Quox propose events for your approval.', try: 'quox calendar agenda' }
];

export const SHOWN_MATURITY = ['stable', 'beta'];

// Search metadata per tip: title, topics, domain (a proof-matrix domain id, matrixDomains.json) and the
// optional matrixRef: the agent tool (x_post), CLI path (quox x post) or slash command (/aocl) the tip advertises.
const M = (title, domain, topics, matrixRef = null) => ({ title, domain, topics, matrixRef });
const META = {
  'chat-attach': M('Talk to a specialist agent', 'agents', ['agents', 'sessions', 'chat'], '/attach'),
  'chat-resume': M('Pick a conversation up again', 'chat', ['sessions', 'chat', 'memory'], '/resume'),
  'chat-compact': M('Compact a long conversation', 'chat', ['sessions', 'chat'], '/compact'),
  'chat-copy': M('Copy the last code block', 'chat', ['chat'], '/copy'),
  'chat-cost': M('See tokens and cost', 'providers', ['models', 'plans', 'chat'], '/cost'),
  'chat-model': M('Choose the provider and model', 'providers', ['models'], '/model'),
  'chat-model-chooser': M('The model chooser', 'providers', ['models'], '/model'),
  'chat-model-favs': M('Favourite models', 'providers', ['models'], '/model'),
  'chat-rows': M('Custom rows above the status bar', 'chat', ['chat'], '/row'),
  'chat-dashboard': M('Open the dashboard signed in', 'identity', ['plans', 'sessions'], '/dashboard'),
  'chat-sessions': M('Every live session in one view', 'sessions', ['sessions', 'fleet'], '/sessions'),
  'chat-doctor': M('Run Doctor', 'install', ['fleet', 'models'], '/doctor'),
  'chat-gripe': M('File a gripe', 'chat', ['sessions'], '/gripe'),
  'trust-approvals': M('Risky actions wait for you', 'approvals', ['approvals', 'security'], '/approvals'),
  'trust-proof': M('Read back the evidence chain', 'receipts', ['security', 'approvals'], '/proof'),
  'trust-vault-lend': M('Lend access without sharing secrets', 'vault', ['vault', 'security', 'integrations'], 'vault_list'),
  'trust-connect': M('Add a provider key safely', 'vault', ['vault', 'integrations', 'models'], '/connect'),
  'know-memory': M('Memory with provenance', 'memory', ['memory'], '/memory'),
  'know-qortex': M('Search your org knowledge', 'qortex', ['memory'], 'quox brain search'),
  'know-sitrep': M('The situation right now', 'lucid', ['sessions', 'approvals'], '/sitrep'),
  'know-away': M('What happened while you were away', 'lucid', ['sessions'], '/away'),
  'auto-workflow': M('Read a workflow run', 'workflows', ['approvals', 'plans'], '/workflow'),
  'auto-crystal': M('Turn a workflow into a Crystal', 'skills', ['plans'], '/crystal'),
  'auto-skills': M('The skills library', 'skills', ['memory'], '/skills'),
  'auto-hat': M('Hats narrow the toolbox', 'hats', ['security', 'agents'], 'quox hat list'),
  'fleet-hosts': M('Give AIs access to any host', 'fleet', ['fleet', 'security', 'approvals'], 'quox fleet hosts'),
  'seo-quoxseo': M('Self-host your SEO', 'seo', ['seo'], 'quoxseo_summary'),
  'mail-inboxq': M('InboxQ sorts your mail', 'mail', ['email', 'approvals'], 'quox mail zones'),
  'qlarity-inspect': M('Inspect a live page', 'browser', ['security'], 'quox qlarity screenshot'),
  'plan-quoxplan': M('Roadmap in QuoxPlan', 'plan', ['plans'], 'quox plan focus'),
  'slots-address': M('A durable address for this session', 'sessions', ['sessions'], '/slot'),
  'voice-phone-call': M('Quox calls you', 'voice', ['voice'], 'quox voice calls'),
  'calendar-calendarq': M('Your agenda', 'calendar', ['plans'], 'quox calendar agenda'),
  'social-x-post': M('Post to X with approval', 'social', ['social', 'x', 'twitter', 'approvals'], 'x_post'),
  'social-x-thread': M('Post an X thread', 'social', ['social', 'x', 'twitter', 'approvals'], 'x_thread'),
  'social-x-engage': M('Engagement on X is approved too', 'social', ['social', 'x', 'twitter', 'approvals'], 'x_budget_status'),
  'social-linkedin': M('Post to LinkedIn with approval', 'social', ['social', 'linkedin', 'approvals'], 'quox linkedin post'),
  'integrations-vault-types': M('Connect an integration', 'vault', ['integrations', 'vault'], 'vault_types'),
  'integrations-vault-test': M('Test every credential', 'vault', ['integrations', 'vault', 'security'], 'quox vault test-all'),
  'integrations-lan-host': M('Add a LAN machine', 'fleet', ['integrations', 'fleet', 'lan'], '/hosts'),
  'integrations-capabilities': M('What is ready here', 'install', ['integrations', 'plans'], '/capabilities'),
  'models-auto': M('Let policy pick the model', 'providers', ['models'], '/model'),
  'approvals-terminal': M('Decide approvals in the terminal', 'approvals', ['approvals'], 'list_approvals'),
  'trust-aocl': M('Every AOCL layer of a turn', 'receipts', ['security', 'approvals'], '/aocl'),
  'sessions-rename': M('Name this session', 'sessions', ['sessions'], '/rename'),
  'sessions-cli': M('Sessions from the shell', 'sessions', ['sessions', 'fleet'], 'quox sessions'),
  'chat-bang': M('Run a shell command with !', 'chat', ['chat', 'sessions'], '/share'),
  'bang-share': M('Share ! output with Quox', 'chat', ['chat', 'sessions'], '/share'),
  'chat-dragon': M('The dragon explains', 'chat', ['dragon'], '/dragon'),
  'mail-search': M('Find an email by asking', 'mail', ['email'], 'inbox_search'),
  'security-engagement': M('Security checks as engagements', 'security', ['security'], 'quox engagement list'),
  'safety-estop': M('The agent kill switch', 'safety', ['security', 'agents'], 'quox safety status'),
  'spend-budget': M('Budget your spend', 'spend', ['plans', 'models'], 'quox budget')
};

export const TIPS = BASE.map(t => ({ ...t, ...(META[t.id] || {}) }));

export const normaliseMode = (m) => (MODES.includes(String(m ?? '').trim().toLowerCase()) ? String(m).trim().toLowerCase() : null);

/** The slash command or quox verb a tip points at, e.g. '/sitrep' for '/sitrep now'. */
export const tryCommand = (tip) => String(tip.try || '').trim().split(/\s+/)[0];

/**
 * Is this tip allowed right now?
 *   ctx = { mode, contract, signals, used, plugins }
 *   plugins:  installed plugin ids for the org; a tip with `plugins: [...]` needs all of them (unread = hidden)
 *   contract: capabilityMap() result ({ id: { available } }) or null when the server cannot answer
 *   signals:  { hosts: number } cheap usage facts; unknown signals are absent, which never skips a tip
 *   used:     slash commands the user has already run (e.g. ['/sitrep'])
 */
export function eligible(tip, ctx = {}) {
  const mode = normaliseMode(ctx.mode) || DEFAULT_MODE;
  if (mode === 'off') return false;
  if (!SHOWN_MATURITY.includes(tip.maturity)) return false;
  if (mode === 'core' && (tip.tier !== 'free' || tip.maturity !== 'stable')) return false;
  for (const id of tip.requires || []) if (ctx.contract?.[id]?.available !== true) return false;
  // plugin-gated tips show only when the org's installed plugin list was read and has every one (unknown = hidden)
  for (const id of tip.plugins || []) if (!(ctx.plugins || []).includes(id)) return false;
  for (const sig of tip.skipIf || []) if (Number(ctx.signals?.[sig]) > 0) return false;
  if (tryCommand(tip).startsWith('/') && (ctx.used || []).includes(tryCommand(tip))) return false;
  return true;
}

export const eligibleTips = (ctx, tips = TIPS) => tips.filter(t => eligible(t, ctx));

/**
 * The next tip. Rotates without repeats until every eligible tip has been shown, then starts a new round
 * (never the one just shown first). ctx.seen = ids shown so far; ctx.rng defaults to Math.random.
 * -> { tip, seen } (persist `seen`), or { tip: null, seen } when nothing is eligible.
 */
export function nextTip(ctx = {}, tips = TIPS) {
  const rng = ctx.rng || Math.random;
  const pool = eligibleTips(ctx, tips);
  const seen = Array.isArray(ctx.seen) ? ctx.seen : [];
  if (!pool.length) return { tip: null, seen };
  let fresh = pool.filter(t => !seen.includes(t.id));
  let nextSeen = seen;
  if (!fresh.length) { // round complete: start over, but not with the tip that just ended the last round
    const last = seen[seen.length - 1];
    fresh = pool.length > 1 ? pool.filter(t => t.id !== last) : pool;
    nextSeen = [];
  }
  const tip = fresh[Math.min(fresh.length - 1, Math.floor(rng() * fresh.length))];
  return { tip, seen: [...nextSeen.filter(id => id !== tip.id), tip.id] };
}

/** The plain one-line form: "Tip: <text>  Try: <cmd>  (/tip for another · /tip-settings off to stop)". */
/** Beta tips carry a visible "(beta)" marker; stable tips show bare. */
export const BETA_MARK = '(beta)';
export const tipText = (tip) => (tip.maturity === 'beta' ? `${tip.text} ${BETA_MARK}` : tip.text);
export const tipLine = (tip) => `Tip: ${tipText(tip)}  Try: ${tip.try}  ${TIP_FOOTER}`;

/** Registry as JSON-safe data for `quox tips --json`, the dashboard and cli.quox.ai. */
export function tipsJson(tips = TIPS) {
  return {
    version: 2, modes: MODES, defaultMode: DEFAULT_MODE, shownMaturity: SHOWN_MATURITY,
    tips: tips.map(t => ({
      id: t.id, title: t.title, text: t.text, try: t.try, topics: [...(t.topics || [])], domain: t.domain,
      matrixRef: t.matrixRef ?? null, tier: t.tier, product: t.product, maturity: t.maturity,
      requires: [...t.requires], skipIf: [...t.skipIf]
    }))
  };
}

/** Tip counts by product, tier and maturity (for reports and drift checks). */
export function tipCounts(tips = TIPS) {
  const by = (k) => tips.reduce((o, t) => ((o[t[k]] = (o[t[k]] || 0) + 1), o), {});
  return { total: tips.length, product: by('product'), tier: by('tier'), maturity: by('maturity') };
}

/** /tip-settings [off|core|all] -> { mode?, text, tone }. mode is set only when the setting should be saved. */
export function tipSettingsReply(arg, current = DEFAULT_MODE) {
  const a = String(arg ?? '').trim().toLowerCase();
  const cur = normaliseMode(current) || DEFAULT_MODE;
  const about = { off: 'no tips', core: 'only tips about free, proven (stable) features', all: 'tips about everything that is shipped' };
  if (!a) return { text: `Tips: ${cur} (${about[cur]}). Change it with /tip-settings off|core|all`, tone: 'plain' };
  const m = normaliseMode(a);
  if (!m) return { text: 'Usage: /tip-settings off|core|all  (off = no tips, core = free features only, all = everything shipped)', tone: 'warn' };
  return { mode: m, text: `Tips set to ${m}: ${about[m]}.${m === 'off' ? ' /tip-settings all turns them back on.' : ''}`, tone: 'ok' };
}

// ---- /tips <query>: search by topic and free text -----------------------------------------
export const PAGE = 5;
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'to', 'of', 'for', 'in', 'on', 'my', 'how', 'do', 'i', 'with']);
const stem = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const words = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const queryTokens = (q) => words(q).filter(w => !STOP.has(w)).map(stem);

/** Rank score of one tip for the query tokens (0 = no match). Topic > domain > title > command > text. */
export function scoreTip(tip, tokens) {
  if (!tokens.length) return 0;
  const topics = (tip.topics || []).map(stem);
  const title = words(tip.title).map(stem);
  const text = words(`${tip.text} ${tip.product}`).map(stem);
  const cmd = words(`${tip.try} ${tip.matrixRef || ''}`).map(stem);
  let score = 0;
  for (const t of tokens) {
    let s = 0;
    if (topics.includes(t)) s = 10;
    else if (stem(String(tip.domain || '')) === t) s = 8;
    else if (title.includes(t)) s = 6;
    else if (cmd.includes(t)) s = 4;
    else if (text.includes(t)) s = 2;
    else if (t.length >= 3 && [...topics, ...title, ...cmd, ...text].some(w => w.startsWith(t))) s = 1;
    score += s;
  }
  return score;
}

// core = free tier AND stable (beta tips, which the matrix has not proven, are hidden under core)
const allowedByMode = (tip, mode) => mode !== 'off' && !(mode === 'core' && (tip.tier !== 'free' || tip.maturity !== 'stable'));

/**
 * Search the shipped tips. ctx = { mode }. Prototype tips never match. Tips the /tip-settings mode hides
 * are not returned but counted in `hidden`. -> { matches, hidden } (matches ranked best first).
 */
export function searchTips(query, ctx = {}, tips = TIPS) {
  const mode = normaliseMode(ctx.mode) || DEFAULT_MODE;
  const tokens = queryTokens(query);
  // ctx.plugins: installed plugin ids. Undefined = not checked (offline `quox tips`); a list gates plugin tips.
  const pluginOk = (t) => !ctx.plugins || (t.plugins || []).every(id => ctx.plugins.includes(id));
  const scored = tips.filter(t => SHOWN_MATURITY.includes(t.maturity) && pluginOk(t))
    .map((tip, i) => ({ tip, i, s: scoreTip(tip, tokens) })).filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i);
  const matches = scored.filter(x => allowedByMode(x.tip, mode)).map(x => x.tip);
  return { matches, hidden: scored.length - matches.length };
}

/** Topics of the shipped tips with counts the mode lets through: [{ topic, count }] biggest first. */
export function topicList(ctx = {}, tips = TIPS) {
  const mode = normaliseMode(ctx.mode) || DEFAULT_MODE;
  const by = new Map();
  for (const t of tips) {
    if (!SHOWN_MATURITY.includes(t.maturity) || !allowedByMode(t, mode)) continue;
    for (const topic of t.topics || []) by.set(topic, (by.get(topic) || 0) + 1);
  }
  return [...by].map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
}

const wrap = (text, width, indent) => {
  const out = []; let line = '';
  for (const w of String(text).split(/\s+/)) {
    if (line && line.length + 1 + w.length > width) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.map((l, i) => (i ? indent : '') + l);
};

/**
 * /tips [query] [more] -> { lines: [string], tone }. Bare: the topic list. With a query: up to 5 ranked tips;
 * a trailing "more" shows the rest. ctx = { mode }. Lines are at most 96 columns.
 */
export function tipsReply(arg, ctx = {}, tips = TIPS) {
  const raw = String(arg ?? '').trim();
  const mode = normaliseMode(ctx.mode) || DEFAULT_MODE;
  if (!raw) {
    const topics = topicList({ mode }, tips);
    if (!topics.length) {
      return { lines: [mode === 'off' ? 'Tips are off. /tip-settings all turns them back on.' : 'No tips to show.'], tone: 'warn' };
    }
    const lines = ['Tip topics (try /tips <topic> or /tips <any words>):'];
    lines.push(...wrap(topics.map(t => `${t.topic} (${t.count})`).join(' · '), 94, '  ').map((l, i) => (i ? l : `  ${l}`)));
    return { lines, tone: 'plain' };
  }
  const more = /\smore$|^more$/i.test(raw);
  const query = raw.replace(/\s*\bmore$/i, '').trim();
  if (!query) return tipsReply('', ctx, tips);
  const { matches, hidden } = searchTips(query, { mode, plugins: ctx.plugins }, tips);
  const hiddenNote = hidden ? `${hidden} tip${hidden === 1 ? '' : 's'} hidden by your tip-settings (${mode}). ` +
    '/tip-settings all shows them.' : '';
  if (!matches.length) {
    const lines = [`No tips match "${query}". /tips alone lists the topics.`];
    if (hiddenNote) lines.push(hiddenNote);
    return { lines, tone: 'warn' };
  }
  const shown = more ? matches.slice(PAGE) : matches.slice(0, PAGE);
  if (!shown.length) return { lines: [`No more tips for "${query}".`], tone: 'plain' };
  const head = `Tips for "${query}" (${matches.length}${more ? `, from ${PAGE + 1}` : ''}):`;
  const lines = [head];
  shown.forEach((t, i) => {
    const n = (more ? PAGE : 0) + i + 1;
    lines.push(...wrap(`${n}. ${t.title}: ${tipText(t)}`, 92, '   '));
    lines.push(`   Try: ${t.try}`);
  });
  const rest = more ? 0 : matches.length - shown.length;
  if (rest > 0) lines.push(`(${rest} more: /tips ${query} more)`);
  if (hiddenNote) lines.push(hiddenNote);
  // Structured form for the TUI: one framed tip per match; `tail` = the lines that follow the frames.
  return { lines, tone: 'plain', head, tips: shown.map(t => ({ text: `${t.title}: ${tipText(t)}`, cmd: t.try })), tail: [...(rest > 0 ? [`(${rest} more: /tips ${query} more)`] : []), ...(hiddenNote ? [hiddenNote] : [])] };
}
