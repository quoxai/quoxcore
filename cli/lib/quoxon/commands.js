/**
 * The single registry behind /help and slash-command dispatch. Anything shown
 * as active here is wired in app.js; planned entries are listed dim under
 * "Coming" and refuse to run. Add a command here first, or it does not exist.
 */
import { topicList } from './tips.js';

export const GROUPS = ['Talk', 'Approvals', 'Skills', 'Conversation', 'Connect', 'Verbose', 'Context', 'Awareness'];

// Argument suggestions after `/command ` (slash/args.js): levels in order, first match wins.
const ARGS = {
  model: [
    { after: [], src: 'model.connected', choices: [
      { value: 'fav', desc: 'favourites: add, rm, or a number' },
      { value: 'default', desc: 'the model new sessions start on' },
      { value: 'auto', desc: 'server policy picks' },
      { value: 'list', desc: 'what is connected' }] },
    { after: ['fav'], src: 'model.favs', choices: [
      { value: 'add', desc: 'add <provider> <model>' },
      { value: 'rm', desc: 'remove by number or model' }] },
    { after: ['fav', 'add'], src: 'model.connected' },
    { after: ['fav', 'add', '*'], src: 'model.models', of: 2 },
    { after: ['fav', 'rm'], src: 'model.favs' },
    { after: ['fav', '*'], choices: [] },
    { after: ['default'], src: 'model.connected',
      choices: [{ value: 'clear', desc: 'no default' }] },
    { after: ['default', '*'], src: 'model.models', of: 1 },
    { after: ['*'], src: 'model.models', of: 0 },
    { after: ['*', '*'], choices: ['compact', 'full'] }
  ],
  connect: [{ after: [], src: 'providers' }],
  org: [
    { after: [], choices: [
      { value: 'switch', desc: 'move this session to another org' },
      { value: 'list', desc: 'your orgs' }] },
    { after: ['switch'], src: 'orgs' }
  ],
  attach: [{ after: [], src: 'agents' }],
  slot: [{ after: [], src: 'slots' }],
  dragon: [{ after: [], choices: ['explain', 'ask', 'sleep', 'fly', 'hero', 'fire', 'classic'] }],
  tips: [{ after: [], choices: topicList().map(t => ({ value: t.topic, desc: `${t.count} tip${t.count === 1 ? "" : "s"}` })) }],
  'tip-settings': [{ after: [], choices: [
    { value: 'off', desc: 'no tips' },
    { value: 'core', desc: 'free features only' },
    { value: 'all', desc: 'everything shipped' }] }],
  hosts: [{ after: [], choices: [{ value: 'add', desc: 'print the one install command' }] }]
};

export const REGISTRY = [
  // Talk (keys)
  { id: 'type', kind: 'key', group: 'Talk', usage: 'just type', desc: 'ask Quox anything; CommanderQ routes it to the right agent', status: 'active' },
  { id: 'enter', kind: 'key', group: 'Talk', usage: 'Enter', desc: 'send; while Quox works, steer the running turn if this server supports it, else queue it', status: 'active',
    detail: 'Idle: sends. During a turn: steers when the server supports it (shown here once known), delivered at the next model boundary (never kills a running tool). If the server cannot steer, or the turn already finished, it is queued instead and you are told.' },
  { id: 'tab', kind: 'key', group: 'Talk', usage: 'Tab', desc: 'queue your message to run after this turn', status: 'active',
    detail: 'Queued messages show above the composer. Up (empty composer) pulls the last one back to edit. After an interrupt they wait; press Enter on an empty composer to send the next one.' },
  { id: 'esc', kind: 'key', group: 'Talk', usage: 'Esc', desc: 'ask the server to stop the turn (idle: Esc Esc clears the draft to history)', status: 'active',
    detail: 'Asks the server to stop before the next model call or tool; you see "stopping" until the server confirms. A tool already dispatched finishes and is reported, never hidden. Until the server route exists the stream is aborted locally and you are told work already sent may still finish.' },
  { id: 'newline', kind: 'key', group: 'Talk', usage: 'Shift+Enter / Ctrl+J', desc: 'new line in the composer (a trailing \\ then Enter also works)', status: 'active' },
  { id: 'editor', kind: 'key', group: 'Talk', usage: 'Ctrl+G', desc: 'edit the draft in $EDITOR', status: 'active' },
  { id: 'stash', kind: 'key', group: 'Talk', usage: 'Ctrl+S', desc: 'stash the draft; on an empty composer, restore it', status: 'active' },
  { id: 'undo', kind: 'key', group: 'Talk', usage: 'Ctrl+_', desc: 'undo in the composer', status: 'active' },
  { id: 'paste', kind: 'key', group: 'Talk', usage: 'paste', desc: 'long pastes collapse to [Pasted text #N +L lines] and expand on send', status: 'active' },
  { id: 'ctrlc', kind: 'key', group: 'Talk', usage: 'Ctrl+C', desc: 'clear the draft; during a turn interrupt; twice when idle quits', status: 'active' },
  // Approvals
  { id: 'approvals', kind: 'command', group: 'Approvals', usage: '/approvals', desc: 'list what is waiting for you', server: true, cap: 'approvals', status: 'active' },
  { id: 'approve', kind: 'command', group: 'Approvals', usage: '/approve N', desc: 'approve item N from the list', server: true, cap: 'approvals', status: 'active',
    detail: 'Run /approvals first. Mid-turn approval cards also take a (approve), d (deny), o (open); they arm after 300 ms and never default to approve.' },
  { id: 'deny', kind: 'command', group: 'Approvals', usage: '/deny N', desc: 'deny item N from the list', server: true, cap: 'approvals', status: 'active' },
  // Skills and rules
  { id: 'skills', kind: 'command', group: 'Skills', usage: '/skills [name]', desc: 'list your org\'s governed skills, or show one as a card', needs: ['skills'], cap: 'skills', status: 'active',
    detail: 'Lists your org skills (reusable procedures an agent follows; not Crystals, which are deterministic replays) with edition and one-line description. /skills <name> shows its card: purpose, version and review state, tests (results only when run-tests recorded them), the agents it is for, where it came from, recorded use, and how to run it.' },
  { id: 'skill', kind: 'command', group: 'Skills', usage: '/skill <name> [args]', desc: 'ask Quox to run a skill (governed: approvals still apply)', server: true, cap: 'skills', status: 'active',
    detail: 'Sends "Run the skill <name> with: <args>" as a normal turn, so CommanderQ runs it through the usual governed path. Nothing is executed from here, and approval cards work as always.' },
  { id: 'rules', kind: 'command', group: 'Skills', usage: '/rules [files|off|on|N]', desc: 'which rules win: advisory QUOX.md, the dev pack, enforced server policy', status: 'active',
    detail: '/rules shows the precedence: QUOX.md and the dev pack only guide; armed governance policies on the server are enforced and win. /rules files shows the QUOX.md text. QUOX.md in this directory and parents up to the git root, plus ~/.quox/QUOX.md, are sent with each turn as your rules. World-writable files and symlinks leaving your home or repo are ignored. /rules N shows page N.' },
  // Conversation
  { id: 'clear', kind: 'command', group: 'Conversation', usage: '/clear', desc: 'fresh conversation and a clear screen; rules and memory kept, /resume goes back', status: 'active', aliases: ['new', 'reset'],
    detail: 'Clears the screen and starts a new conversation. Your QUOX.md rules, attached agent, model choice and Quox memory stay as they are. The previous conversation is kept on the server: /resume lists it.' },
  { id: 'resume', kind: 'command', group: 'Conversation', usage: '/resume [id|name]', desc: 'pick a recent conversation and carry on where it left off', status: 'active', needs: ['conversations', 'conversationTurns'],
    detail: 'Alone: a picker of your recent conversations (title, agent, age); Up/Down and Enter resume, Esc cancels. With an id (or the start of one) or a /rename name it resumes directly. The last turns are shown as history and your next message continues that conversation. Also at launch: quox --resume [id|name] or quox --conversation <id>.' },
  { id: 'compact', kind: 'command', group: 'Conversation', usage: '/compact [show]', desc: 'summarise the conversation on the server, keeping decisions', status: 'active', needs: ['compactConversation'],
    detail: 'The server summarises this conversation with your AI provider, keeping decisions, and the summary becomes the start of the conversation for later turns. Shows the token change and the first lines of the summary; /compact show prints all of it. Refused while a turn runs, and when the org has not given AI processing consent. Asking "compact this conversation" in words only suggests it.' },
  { id: 'consent', kind: 'command', group: 'Conversation', usage: '/consent [grant [provider]]', desc: 'AI data sharing consent: see where you stand, or give your OK and carry on', status: 'active', needs: ['consentStatus'],
    detail: 'Cloud AI providers (OpenAI and other hosted ones) receive your messages and tool results, so Quox needs your OK first; it is personal, not an admin setting. /consent shows where you stand. /consent grant [provider] records your OK (the same as quox consent grant --provider <name>, or Settings > Privacy in the dashboard) and, if a message just failed for lack of it, sends that message again. A local model (Ollama) never needs it.' },
  { id: 'help', kind: 'command', group: 'Conversation', usage: '/help [command]', desc: 'this reference, or detail for one command or key', status: 'active',
    detail:
      'Type / to open the command list. After a command and a space, the next word is ' +
      'suggested too (providers, live model ids, orgs, agents, slots, options): Up and Down' +
      ' choose, Tab completes, Esc closes, and keep typing to narrow. Suggestions that ' +
      'cannot be fetched are simply left out.' },
  { id: 'note', kind: 'command', group: 'Conversation', usage: '/note <text>', desc: 'jot an observation for the dev observer (also: // text); not sent to Quox', status: 'active',
    detail: 'Records your text in the dev transcript only: not sent to the model or the server, no turn, not in chat history. Needs dev transcripts on (touch ~/.config/quox/dev-transcripts). Up to 2000 characters.' },
  { id: 'bang', kind: 'key', group: 'Talk', usage: '!<command>', desc: 'run a shell command here without leaving (!quox <args> runs this quox as you); output stays on your screen', status: 'active',
    detail: 'A line starting with ! runs on this machine in the current directory via your shell and prints inline: "$ <command>", the output, then "exit N". It is never sent to Quox, starts no turn and needs no approval, because it is your own command. !quox <args> (or !q <args>) runs THIS quox binary with your current profile, so !quox inbox list works as you; bare quox and tui need the terminal and are refused. Ctrl+C stops it (SIGTERM, then SIGKILL after 2 s) without quitting; one command at a time; stdin is closed, so a command that waits for input gets end-of-file; 120 s limit (QUOX_BANG_TIMEOUT_MS); output is capped at 2000 lines / 256 KB. !! is reserved. Only the command line and exit code go in the dev transcript, never the output.' },
  { id: 'share', kind: 'command', group: 'Talk', usage: '/share [N]', desc: 'attach the output of your last ! command (or the Nth-last) to your next message', status: 'active',
    detail: 'Command output is not shared with Quox by default, because it can contain secrets. /share attaches the latest ! result to your next message (up to 16 KB, and it says when it was cut); /share 2 picks the one before. A line "shared with Quox: output of `<command>`" appears when it is sent.' },
  { id: 'copy', kind: 'command', group: 'Conversation', usage: '/copy [N|code]', desc: 'copy the last answer (raw markdown) to the clipboard; N = Nth-last, code = last code block', status: 'active',
    detail: 'Uses the OSC 52 terminal escape (works over SSH in most terminals; wrapped for tmux). Needs a terminal that allows OSC 52. Mouse selection is untouched: select and copy with your terminal as usual.' },
  { id: 'dragon', kind: 'command', group: 'Conversation', usage: '/dragon [explain|ask [question]|sleep|fly|hero|fire|classic]', desc: 'the Q comes alive; /dragon explain gives the simplest possible explanation of the last output, /dragon ask [question] answers one question just as simply, /dragon sleep is a katakana screensaver (any key wakes)', status: 'active', args: ARGS.dragon,
    detail: 'Plain /dragon plays the dragon (googly eyes, a talking smile, tail sway and whip, then fire from its mouth); classic and hero are the same show, /dragon fire is the breath alone. explain and ask are ordinary turns on whichever AI you have selected (tools and approvals still apply); the answer stays in the conversation as "Dragon explains" or "Dragon answers". With no AI connected you get the usual connect card. /dragon ask with no question waits for your next line. /dragon sleep hides the screen under katakana with the dragon asleep; any key wakes it and is not typed, an approval wakes it, Ctrl+C quits. It only changes what is drawn, never the conversation. Quiet motion or NO_COLOR shows a still screen.' },
  { id: 'dragon-fly', kind: 'command', group: 'Conversation', usage: '/dragon-fly', desc: 'the dragon flies across the screen, wings beating (same as /dragon fly)', status: 'active',
    detail: 'One 9 second pass of the dragon in flight, wings beating; Esc stops it early. It only changes what is drawn, never the conversation. Quiet motion or NO_COLOR shows a single still frame instead.' },
  { id: 'sound', kind: 'command', group: 'Conversation', usage: '/sound [profile|test]', desc: 'earcons for approvals, failures and long turns: Silent | Minimal | Operational | Full', status: 'active',
    detail: 'Same setting as the dashboard (your account\'s soundProfile). Minimal (default) sounds for approvals, critical alerts and failures; Operational adds a short tick when a turn over 20 s finishes or the terminal is in the background. Over SSH only the terminal bell rings, for approvals and critical alerts. QUOX_SOUND=off mutes this terminal; --print never makes sound.' },
  { id: 'tip', kind: 'command', group: 'Conversation', usage: '/tip', desc: 'a "did you know" tip about something Quox can do on this install', status: 'active',
    detail: 'Shows one tip at a time and rotates through all of them before repeating. Only features that are shipped (stable or beta) and ready on this server are offered, and things you already use are skipped. One tip also shows under the greeting on launch. /tip-settings off stops them.' },
  { id: 'tips', kind: 'command', group: 'Conversation', usage: '/tips [topic or words]', desc: 'search the tips: /tips social media, /tips integrations; alone lists the topics', status: 'active', args: ARGS.tips,
    detail: 'Bare /tips lists the topics with how many tips each has. /tips <words> ranks tips by topic, title, text and command and shows up to 5; add "more" at the end for the rest. It respects /tip-settings: tips your setting hides are counted, not shown. /tip still gives one random tip.' },
  { id: 'tip-settings', kind: 'command', group: 'Conversation', usage: '/tip-settings [off|core|all]', desc: 'tips: off = none, core = free features only, all = everything shipped (default); saved on this profile', status: 'active', args: ARGS['tip-settings'],
    detail: 'Alone shows the current setting. Saved to your CLI profile, so it survives restarts. core limits tips to the free tier; all includes plugin features your install can use.' },
  { id: 'about', kind: 'command', group: 'Conversation', usage: '/about', desc: 'who we are, terms, privacy, licence and docs links', status: 'active' },
  { id: 'quit', kind: 'command', group: 'Conversation', usage: '/quit', desc: 'leave; finished work is kept and /resume picks the conversation up', status: 'active', aliases: ['exit'],
    detail: 'Idle: leaves at once; the conversation stays on the server for /resume (or quox --resume). During a turn it asks first, because leaving disconnects the turn and the server stops it before its next step (a tool already running finishes and is recorded). /quit again within 5 s leaves anyway.' },
  { id: 'restart', kind: 'command', group: 'Conversation', usage: '/restart', desc: 'restart into the latest installed quox and resume this conversation', status: 'active',
    detail: 'Re-runs the quox on your PATH in this terminal with the same arguments and profile, plus --resume for this conversation. During a turn it asks first: restarting disconnects the turn and the server stops it before its next step (this server cannot reattach a running turn yet); /restart again within 5 s goes ahead. When a newer build is installed than the one running, a dim line says so (checked at most once a minute, no network).' },
  { id: 'demo', kind: 'command', group: 'Conversation', usage: '/demo', desc: 'play the simulated demo journey on its own (same as quox --demo --autoplay); nothing real runs', status: 'active',
    detail: 'Hands the terminal to the autoplay demo: a scripted journey with a simulated server, no input needed, nothing real runs and nothing is sent. Quit it to come back to your normal client; this conversation stays on the server for /resume. During a turn it asks first, like /restart.' },
  { id: 'gripe', kind: 'command', group: 'Conversation', usage: '/gripe <text>', desc: 'file a GitHub issue through the GRIPE agent; shows it first, /gripe! files at once', needs: ['gripe'], status: 'active', aliases: ['gripe!'],
    detail: 'The same governed path as `quox gripe`: the GRIPE agent files the issue through your org\'s GitHub connector (default repo quoxai/quox). /gripe <text> shows what would be filed and asks; /gripe! (alone, within 2 minutes) files it, or /gripe! <text> files straight away. The issue link is shown when one comes back; with no link it says so and treats it as not filed.' },
  { id: 'sessions', kind: 'command', group: 'Conversation', usage: '/sessions [all]', desc: 'your recent conversations; /sessions all shows everything live in your org', needs: ['conversations'], status: 'active',
    detail: '/sessions all is the same overview as `quox sessions`: every live tmux session, conversation, held slot and running objective, loop or workflow in your org, grouped by agent, with how to attach. Bare /sessions lists recent conversations from the server. Names set with /rename are kept on this machine (~/.config/quox/sessions.json) because the server has no rename route yet.' },
  { id: 'dashboard', kind: 'command', group: 'Conversation', usage: '/dashboard [page]', desc: 'open the web dashboard already signed in (one-time link); pages: sessions approvals agents lucid inbox seo settings', needs: ['dashboardLink'], status: 'active',
    detail: 'Creates a sign-in link for this profile that is valid for 10 minutes and works once, then opens it in your default browser. Over SSH it only prints the link (the browser would open on the wrong machine); terminals that support hyperlinks make it clickable. The link is a credential: it is shown on screen only and never written to the dev transcript or history. An older server without one-time links gets the plain dashboard URL and you sign in as usual. Also: quox dashboard [page].' },
  { id: 'rename', kind: 'command', group: 'Conversation', usage: '/rename [name]', desc: 'name this session (shown in the top rule); alone shows the current name', status: 'active',
    detail: 'Also settable at launch with quox -n <name>. The name is kept on this machine, keyed by conversation, and shown in /sessions.' },
  { id: 'slot', kind: 'command', group: 'Conversation', usage: '/slot <name>', desc: 'give this session a slot address (checks out the slot)', needs: ['checkoutSlot'], cap: 'slots', status: 'active', args: ARGS.slot,
    detail: 'Checks out the slot, creating it if needed, as `quox slot checkout <name> --create --session <session>` does; typing it is your consent. Discord replies are not relayed into this window yet (no slot wait loop here).' },
  { id: 'attach', kind: 'command', group: 'Conversation', usage: '/attach [agent]', desc: 'send your turns to a specific agent; alone shows the current one', needs: ['agents'], cap: 'agents', status: 'active', args: ARGS.attach,
    detail: 'The agent name is checked against your org\'s agent list. Later turns go to that agent (the chat stream assistant field) until /detach.' },
  { id: 'detach', kind: 'command', group: 'Conversation', usage: '/detach', desc: 'back to CommanderQ', status: 'active' },
  { id: 'peek', kind: 'command', group: 'Conversation', usage: '/peek <id>', desc: 'look up an envelope, task or agent by id', status: 'planned' },
  { id: 'aside', kind: 'command', group: 'Conversation', usage: '/aside', desc: 'a read-only side question', status: 'planned' },
  // Connect
  { id: 'login', kind: 'command', group: 'Connect', usage: '/login', desc: 'sign in again without leaving quox (email, masked password, MFA code if asked)', status: 'active',
    detail: 'Opens a card here: your email (prefilled with the last one this profile used), then a masked password, then your authenticator code if the server asks for one. It is the same sign-in as quox login, so status, approvals and the digest come back without a restart. The password is never echoed, logged or saved. CLI sign-ins last 30 days, unless your admin set a shorter limit in the session policy.' },
  { id: 'connect', kind: 'command', group: 'Connect', usage: '/connect [provider]', desc: 'see what is connected; /connect openai adds a key safely', needs: ['connections'], cap: 'vault', status: 'active', args: ARGS.connect,
    detail: 'Alone: AI providers (OpenAI, Claude API, Ollama) and the integrations in your org vault, with real status from the server; anything it cannot read shows ? unknown. /connect openai (or anthropic) opens a secure card: paste the key, Enter tests it with the provider and saves it to your org vault as the default; Esc cancels. Keys typed there never reach chat, history or transcripts. A key pasted into the composer is never sent.' },
  { id: 'hosts', kind: 'command', group: 'Connect', usage: '/hosts add', desc: 'add a host to your fleet (works without an AI); /hosts lists them', status: 'active', args: ARGS.hosts,
    detail: '/hosts add prints the one command to run on the machine you want to add (the QuoxAgent installer served by your Quox, with a --host-id of your choice). /hosts lists the hosts your Quox knows, the same as quox fleet hosts. Neither needs an AI connected.' },
  { id: 'capabilities', kind: 'command', group: 'Connect', usage: '/capabilities [name]', desc: 'what this Quox can do here: ready, needs setup, not available, planned', status: 'active',
    detail: 'Asks the server (GET /api/v1/capabilities), which checks real service health, your plan, plugin install state and connected providers. Each gap says why and how to set it up; /capabilities <name> gives the one-line offer for one. If the server cannot answer, nothing is assumed.' },
  // Verbose
  { id: 'verbose', kind: 'command', group: 'Verbose', usage: '/verbose off|on|full', desc: 'protocol lines (AEE envelopes, VOLT tool offers, WARD): off (default) hides them, on = compact, full = adds thinking; saved', status: 'active',
    detail: 'off (default) keeps the screen to your conversation, the tool result lines and ONE AOCL footer per turn (layers, tool count, time). on shows the compact AEE / VOLT / AOCL / WARD protocol lines as they happen. full adds the thinking stream. Saved to your profile. The full list of tools offered to the model for the last turn is in /aocl.' },
  { id: 'proof', kind: 'command', group: 'Verbose', usage: '/proof [envelope]', desc: 'the evidence chain for the last tool call: AEE, AOCL, tool, WARD', server: true, cap: 'receipts', status: 'active',
    detail: 'Each link is read back from the server and drawn confirmed only when the read says so. WARD is the server-verified inclusion receipt; it can be slow on a large chain and is bounded, so a link may stay open.' },
  { id: 'aocl', kind: 'command', group: 'Verbose', usage: '/aocl', desc: 'every AOCL layer of the last turn: outcome, time, reason', status: 'active',
    detail: 'Each turn shows ONE AOCL line (layers accounted, passed, bypassed, time; red with the layer name on a reject). /aocl expands the last turn into all 11 layers, L0 ingress to L10 audit, as the server reported them.' },
  { id: 'reconcile', kind: 'command', group: 'Verbose', usage: '/reconcile', desc: 'check tool calls that ended with effect unknown against the server\'s record', server: true, cap: 'receipts', status: 'active' },
  // Awareness
  { id: 'roster', kind: 'command', group: 'Awareness', usage: '/roster [all]', desc: 'show or hide the live roster under the status line; all includes background work', needs: ['roster'], status: 'active',
    detail: 'The roster lists what needs you: pending approvals, then work you started (objectives, loops, manual workflows). Scheduled and event-driven workflows are hidden; background failures show once per workflow in the bar below. /roster all shows everything. Refreshed every 15 s from the server. Down on an empty composer focuses it; Enter peeks, s asks to stop (y confirms), Esc returns. A source the server cannot answer shows nothing and is named here.' },
  { id: 'workflow', kind: 'command', group: 'Skills', usage: '/workflow <name|id|run>', desc: 'the step flow of a workflow\'s latest run (or one run): state, timings, human gates', server: true, cap: 'workflows', status: 'active',
    detail: 'Steps come from the workflow definition and each state and duration from that run\'s recorded envelopes. A reached human gate shows amber. Enter on a workflow row in the roster shows the same flow.' },
  { id: 'crystal', kind: 'command', group: 'Skills', usage: '/crystal <workflow>', desc: 'is this workflow eligible to become a Crystal? checked against the real gate', server: true, cap: 'crystals', status: 'active',
    detail: 'Computed from the workflow\'s recorded runs with quoxflow\'s crystalliser rule: at least 3 runs, at least 80% successful, one action sequence. Says how many more successful runs are needed.' },
  { id: 'agents', kind: 'command', group: 'Awareness', usage: '/agents <name>', desc: 'an agent\'s card: role, tools, slot, last action and its WARD witness', server: true, cap: 'agents', status: 'active' },
  { id: 'memory', kind: 'command', group: 'Awareness', usage: '/memory <query>', desc: 'facts Quox remembers, each with where it came from, age, trust and conflicts', server: true, cap: 'memory', status: 'active' },
  { id: 'sitrep', kind: 'command', group: 'Awareness', usage: '/sitrep', desc: 'the situation now: approvals waiting, what needs you, running work, what Quox cannot see', server: true, cap: 'lucid', status: 'active',
    detail: 'Read from the server, no model call: approvals waiting (your Approvals inbox), what needs you from the LUCID situation (by urgency), work in motion, and the sources LUCID cannot see (silent, failing or not connected). A part the server cannot answer is named on the "Can\'t see" line, never shown as empty. Does not move your LUCID cursor. /away is the "since you were last here" digest. Asking "give me a sitrep" suggests it.' },
  { id: 'away', kind: 'command', group: 'Awareness', usage: '/away [since]', desc: 'what happened while you were away, and what Quox cannot see', server: true, cap: 'lucid', status: 'active',
    detail: 'A factual digest from the server since you last used quox on this profile (or since 90m, 3h, 2d, or an ISO time): approvals waiting and resolved, objectives and workflows finished or failed, LUCID alerts, new Qortex decisions, failed turns and agent activity, each with its source and time. Sources that could not be read or went silent are named on a "Can\'t see" line. Nothing is summarised by a model. At launch, after more than 2 h away, a short card shows the top 5. Asking "what did I miss" suggests it.' },
  { id: 'observers', kind: 'command', group: 'Awareness', usage: '/observers', desc: 'LUCID situation, what changed since you last looked, what Quox records about its own learning', needs: ['observers'], cap: 'lucid', status: 'active',
    detail: 'Facts only, read from persisted data: the LUCID situation (without moving your cursor), recent changes, lessons taught, and the reflect / learn / insight counters. Nothing is summarised by a model.' },
  // Context
  { id: 'org', kind: 'command', group: 'Context', usage: '/org [switch <name|id>]', desc: 'list your orgs (current marked), or switch this session to another one', needs: ['orgs'], status: 'active', args: ARGS.org,
    detail: '/org lists the orgs your login belongs to. /org switch <name or id> matches loosely, asks you to confirm with /org yes, then re-scopes the login (the same exchange as quox org switch) and starts a new conversation in that org; the status line shows the org. A switch only succeeds for orgs you are a member of; the server decides.' },
  { id: 'statusline', kind: 'key', group: 'Context', usage: 'status line', desc: 'profile · org · agent · model · mode, under the composer', status: 'active' },
  { id: 'status', kind: 'command', group: 'Context', usage: '/status', desc: 'profile, org, server and its health, model, agent, slot, session, version', status: 'active',
    detail: 'The provider and model shown are what the server last reported running (turn.started), not what was asked for. Server health is checked live. Asking "what is my status" in words prints the same panel as a tip.' },
  { id: 'cost', kind: 'command', group: 'Context', usage: '/cost', desc: 'tokens and cost per model for this session, from real usage', status: 'active', aliases: ['usage'],
    detail: 'Counts only what the server reported on turn.finished (input, output and cache tokens, cost when the provider gives one). Cost stays blank when the server did not report it, and says so; nothing is estimated. Asking "what is this costing" prints the same panel.' },
  { id: 'context', kind: 'command', group: 'Context', usage: '/context', desc: 'model, conversation tokens, rules, skills, memory and the attached agent', status: 'active',
    detail: 'Conversation tokens are the sum the server reported for this conversation in this session. Skills and memory are real calls to your server; anything it cannot answer shows ? with the reason. Asking "how much context have we used" prints the same panel.' },
  { id: 'doctor', kind: 'command', group: 'Context', usage: '/doctor', desc: 'the quox doctor checks plus chat checks, as rows', status: 'active', needs: ['doctorChecks'],
    detail: 'Runs the same checks as `quox doctor` (services, auth token, CLI version) in this process, then chat checks: the chat routes answer, a provider is connected, the capability contract.' },
  { id: 'server', kind: 'command', group: 'Context', usage: '/server', desc: 'your self-hosted install: version, health per service, disk, ports, last update', status: 'active', needs: ['serverStatus'],
    detail: 'The same read-only panel as `quox server status`, for the install Getting started recorded (or the one the running containers belong to). Changing the server is a terminal verb, never a chat action: quox server update (backup first, rolls back on failure), quox server rollback, quox server uninstall, quox server doctor, quox server diag. Each takes --dry-run to show the plan first.' },
  { id: 'config', kind: 'command', group: 'Context', usage: '/config', desc: 'settings: theme, motion, verbose, model; saved on this profile', status: 'active', aliases: ['settings'],
    detail: 'An interactive card: Up/Down pick a setting, Left/Right or Space change it (saved at once to this CLI profile), Enter on Model opens /model, Esc closes. Theme replaces the env-only QUOX_THEME; if QUOX_THEME is set in your shell it still wins and the card says so.' },
  { id: 'profile', kind: 'command', group: 'Context', usage: '/profile', desc: 'switch profile or org without leaving', status: 'planned' },
  { id: 'model', kind: 'command', group: 'Context', usage: '/model [provider [model] [compact|full]|auto|<n>|fav|default|list]', desc: 'choose the provider/model for your next turns: a chooser, numbered favourites, a saved default', needs: ['connections'], status: 'active', args: ARGS.model,
    detail:
      'Alone: opens a chooser (arrow keys, Enter selects for this session). Favourites are ' +
      'listed first, numbered, then the live models of each CONNECTED provider (listed by ' +
      'the provider, never from a fixed list). In the chooser f toggles a favourite, d ' +
      'makes the highlighted model your default, Esc closes; current and default are ' +
      'marked. /model list prints what is connected with real status from your org vault ' +
      '(the same source as /connect). /model openai, /model openai gpt-5.4-mini, /model ' +
      'anthropic, /model auto (server policy) pick directly. Favourites: /model fav lists ' +
      'them, /model fav add <provider> <model>, /model fav rm <n|model>, /model <n> or ' +
      '/model fav <n> switch at once. Default: /model default shows it, /model default ' +
      '<provider> <model> sets it, /model default clear removes it; new sessions start on ' +
      'it when its provider is connected (otherwise you are told once and the usual rules ' +
      'apply). A model id missing from the live list is kept with a warning, because new ' +
      'models appear before lists update. Favourites and the default are saved to your ' +
      'account on the server (your user preferences), so they follow you across machines; ' +
      'this profile keeps a copy for offline use. Same for every provider. The choice is ' +
      'sent with each turn; the server decides, and the status line shows what it actually ' +
      'ran. A provider that is not connected is refused with a /connect offer. quox ' +
      '--provider openai does the same for one run. A trailing compact or full picks the ' +
      'prompt profile: compact is a short system prompt for small or local models (the ' +
      'default on Ollama, LM Studio and vLLM), full is the default elsewhere; --prompt-' +
      'profile does the same for one --print run.' },
  { id: 'mentions', kind: 'key', group: 'Context', usage: '@mention', desc: 'complete agents, hosts, tasks and receipts', status: 'planned' }
];

const norm = (s) => String(s || '').trim().toLowerCase().replace(/^\//, '');

export function findEntry(name) {
  const n = norm(name);
  if (!n) return null;
  return REGISTRY.find(e => e.id === n || e.aliases?.includes(n) || norm(e.usage.split(/\s/)[0]) === n || e.usage.toLowerCase() === n) || null;
}

/** Slash commands only. */
export const commandNames = () => REGISTRY.filter(e => e.kind === 'command' && e.status === 'active').flatMap(e => ['/' + e.id, ...(e.aliases || []).map(a => '/' + a)]);

/** Pure help model: [{ kind: 'head'|'row'|'dim'|'gap'|'plain', key?, text? }]. */
const capView = (e, caps = {}) => {
  if (e.id === 'enter' && caps.steer === false) return { ...e, desc: 'send; while Quox works, queue it (this server cannot steer a running turn)', detail: 'This server has no steer route: Enter during a turn queues your message as the next turn.' };
  if (e.id === 'esc' && caps.interrupt === false) return { ...e, desc: 'disconnect from the turn (this server cannot stop it; idle: Esc Esc clears the draft)', detail: 'This server has no interrupt route: Esc aborts only your stream. Work already sent may still finish and be charged.' };
  return e;
};

export function helpModel(topic, caps = {}) {
  if (topic) {
    const e0 = findEntry(topic);
    const e = e0 && capView(e0, caps);
    if (!e) return [{ kind: 'plain', text: `No help for "${topic}". Try /help` }];
    return [
      { kind: 'head', text: e.usage },
      { kind: 'plain', text: e.desc },
      ...(e.detail ? [{ kind: 'plain', text: e.detail }] : []),
      ...(e.status === 'planned' ? [{ kind: 'dim', text: 'Planned, not built yet.' }] : [])
    ];
  }
  const out = [];
  for (const g of GROUPS) {
    const active = REGISTRY.filter(e => e.group === g && e.status === 'active').map(e => capView(e, caps));
    if (!active.length) continue;
    if (out.length) out.push({ kind: 'gap' });
    out.push({ kind: 'head', text: g });
    for (const e of active) out.push({ kind: 'row', key: e.usage, text: e.desc });
  }
  const planned = REGISTRY.filter(e => e.status === 'planned');
  if (planned.length) {
    out.push({ kind: 'gap' }, { kind: 'head', text: 'Coming', dim: true });
    for (const e of planned) out.push({ kind: 'dim', key: e.usage, text: e.desc });
  }
  out.push({ kind: 'gap' }, { kind: 'dim', text: '/help <command> for detail, e.g. /help esc' });
  return out;
}

/** Nearest real slash commands for a mistyped one (prefix, substring, then edit distance). */
export function suggestCommands(input, max = 3) {
  const q = norm(input);
  if (!q) return [];
  const names = [...new Set(commandNames())];
  const lev = (a, b) => { const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) dp[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return dp[a.length][b.length]; };
  return names.map(n => { const k = n.slice(1); const rel = q.startsWith(k) || k.startsWith(q) || q.includes(k) || k.includes(q); return { n, d: rel ? 0 : lev(q, k), len: Math.abs(k.length - q.length) }; })
    .filter(x => x.d <= Math.max(2, Math.floor(q.length / 3)))
    .sort((a, b) => a.d - b.d || a.len - b.len || a.n.localeCompare(b.n)).slice(0, max).map(x => x.n);
}
