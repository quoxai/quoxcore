/**
 * Local intent hints. When a message is plainly a client command in words, the turn is NOT intercepted
 * (the model still answers); the client only prints one dim `tip: /command` line above the answer.
 * Exact, anchored patterns on the whole message: anything with extra words is ordinary chat.
 */
const WORD = '([A-Za-z0-9][\\w.-]{0,39})';
// Questions answered by a local panel (/context, /cost, /status): the panel prints above the answer.
const PANELS = [
  [/^(?:how much (?:of (?:the|my|our) )?context (?:have (?:we|i) used|has been used|is (?:used|left)|are we using|am i using|do (?:we|i) have left)|what(?:'s| is) (?:the|my|our) context(?: usage)?|context usage)$/i, '/context'],
  [/^(?:what(?:'s| is) (?:this|it) costing(?: (?:me|us))?|how much (?:has|did) (?:this|it) cost(?: (?:me|us))?(?: so far)?|how much (?:have (?:i|we)|am i|are we) spen(?:t|ding)(?: so far)?|what(?:'s| is| has been) (?:the|my|our) (?:cost|spend|usage)(?: so far)?)$/i, '/cost'],
  [/^(?:what(?:'s| is) my status|what(?:'s| is) the status|show (?:me )?my status|status)$/i, '/status']
];
function PANEL_RULES() { return PANELS.map(([re, cmd]) => [re, () => cmd]); }

const RULES = [
  [new RegExp(`^attach(?: me)?(?: to)? ${WORD}$`, 'i'), (m) => `/attach ${m[1]}`],
  [/^rename (?:this|the|my) (?:session|conversation|chat) (?:to|as) ([\w.-]+(?: [\w.-]+){0,2})$/i, (m) => m[1].split(' ').some(w => /^(and|then|but|so|please)$/i.test(w)) ? null : `/rename ${m[1]}`],
  [/^(?:what(?:'s| is) running|what is running now)$/i, () => '/roster'],
  [/^(?:show|list|open) (?:my |the )?(?:pending )?approvals$/i, () => '/approvals'],
  [/^(?:what(?:'s| is)|show me what(?:'s| is)) (?:waiting|pending) (?:for )?(?:my )?approval$/i, () => '/approvals'],
  [/^(?:so )?(?:what (?:did i miss|have i missed)(?: (?:while|when) i was (?:away|out|gone|offline))?|what (?:happened|changed) (?:while|when) i was (?:away|out|gone|offline)|(?:did )?anything happen(?:ed)? while i was (?:away|out|gone|offline)|catch me up)$/i, () => '/away'],
  [/^(?:(?:give me |show me |can i get )?(?:a |the )?sit ?rep(?: please)?|what(?:'s| is) the situation(?: now)?|situation report(?: please)?)$/i, () => '/sitrep'],
  [/^(?:open|show|take me to|go to) (?:me )?(?:to )?(?:the |my )?(?:quox )?(?:web )?dashboard$/i, () => '/dashboard'],
  [/^detach(?: from (?:the )?agent)?$/i, () => '/detach'],
  [/^(?:start )?(?:a )?new conversation$/i, () => '/new'],
  [/^(?:please )?(?:compact|summari[sz]e and compact|compress) (?:this|the|our|my) (?:conversation|chat|session|context)(?: please)?$/i, () => '/compact'],
  [/^(?:please )?(?:update|upgrade) (?:the |my |this )?(?:quox )?(?:server|install|instance|quox)(?: (?:to (?:the )?latest|please))?$/i, () => 'quox server update --dry-run (in a terminal; shows the plan first)'],
  [/^(?:please )?roll ?back (?:the |my |this )?(?:quox )?(?:server|install|instance|update)$/i, () => 'quox server rollback --dry-run (in a terminal)'],
  [/^(?:please )?uninstall (?:the |my |this )?(?:quox )?(?:server|install|instance|quox)$/i, () => 'quox server uninstall --dry-run (in a terminal; lists what goes first)'],
  [/^(?:what version is (?:the |my )?(?:quox )?server(?: on| running)?|is (?:the |my )?(?:quox )?server (?:up to date|healthy)|server status)$/i, () => '/server'],
  [/^(?:make|create|write) (?:a )?(?:support|diag(?:nostic)?s?) bundle$/i, () => 'quox server diag (in a terminal; written locally, never uploaded)'],
  ...PANEL_RULES()
];

/** -> `tip: /attach seer` or null. */
export function intentHint(text) {
  const t = String(text || '').trim().replace(/[.?!]+$/, '').trim();
  if (!t || t.includes('\n') || t.startsWith('/')) return null;
  for (const [re, fmt] of RULES) { const m = re.exec(t); const r = m && fmt(m); if (r) return `tip: ${r}`; }
  return null;
}

/** -> '/context' | '/cost' | '/status' when the message asks a question a local panel answers, else null. */
export function intentPanel(text) {
  const t = String(text || '').trim().replace(/[.?!]+$/, '').trim();
  if (!t || t.includes('\n') || t.startsWith('/')) return null;
  for (const [re, cmd] of PANELS) if (re.test(t)) return cmd;
  return null;
}
