/**
 * The single registry behind /help and slash-command dispatch. Anything shown
 * as active here is wired in app.js; planned entries are listed dim under
 * "Coming" and refuse to run. Add a command here first, or it does not exist.
 */
import { topicList } from './tips.js';
import { devObserverOn } from './devObserver.js';
import { SHORT } from './commandShort.js';

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
  fleet: [{ after: [], src: 'fleetHosts' }],
  replay: [{ after: [], src: 'conversations' }],
  org: [
    { after: [], choices: [
      { value: 'switch', desc: 'move this session to another org' },
      { value: 'back', desc: 'return to the org you were in before' },
      { value: 'list', desc: 'your orgs' }] },
    { after: ['switch'], src: 'orgs' }
  ],
  hat: [
    { after: [], choices: [
      { value: 'new', desc: 'make a hat of your own' },
      { value: 'edit', desc: 'change one of your hats' },
      { value: 'delete', desc: 'remove one of your hats' }] }
  ],
  attach: [{ after: [], src: 'agents' }],
  agents: [
    { after: [], src: 'agents', choices: [{ value: 'list', desc: 'pick from all agents (list sec narrows it)' }] },
    { after: ['list'], choices: [] },
    { after: ['*'], choices: [{ value: 'tools', desc: 'the tools this agent may use' }] }
  ],
  which: [{ after: [], choices: [
    { value: 'profile', desc: 'login name, human or agent' }, { value: 'org', desc: 'the org this window is in' },
    { value: 'agent', desc: 'who your turns go to' }, { value: 'hat', desc: 'the hat on your last turn' },
    { value: 'model', desc: 'provider and model' }, { value: 'slot', desc: 'slot and its live stream' },
    { value: 'conversation', desc: 'conversation id and name' }] }],
  slot: [{ after: [], src: 'slots', choices: [{ value: 'log', desc: 'recent messages in the held slot' }] }],
  mode: [{ after: [], choices: [{ value: 'ask', desc: 'ask first (the default)' }, { value: 'plan', desc: 'plan only: investigates and proposes, changes nothing' }] }],
  say: [{ after: [], src: 'slots' }],
  broadcast: [{ after: [], choices: [{ value: '--slots', desc: 'only these slots, comma separated' }, { value: '--priority', desc: 'urgent shows red' }, { value: '--ack', desc: 'ask recipients to /ack' }] }],
  send: [{ after: [], src: 'slots' }, { after: ['*'], src: 'files', of: 'partial' }],
  dragon: [{ after: [], choices: ['explain', 'ask', 'sleep', 'fly', 'hero', 'fire', 'classic'] }],
  tips: [{ after: [], choices: topicList().map(t => ({ value: t.topic, desc: `${t.count} tip${t.count === 1 ? "" : "s"}` })) }],
  whatsnew: [{ after: [], choices: [{ value: 'all', desc: 'every command and entry, regardless of seen' }, { value: 'on', desc: 'show the card at startup when something is new' }, { value: 'off', desc: 'stop the startup card' }] }],
  'tip-settings': [{ after: [], choices: [
    { value: 'off', desc: 'no tips' },
    { value: 'core', desc: 'free features only' },
    { value: 'all', desc: 'everything shipped' }] }],
  hosts: [{ after: [], choices: [{ value: 'add', desc: 'print the one install command' }] }],
  row: [
    { after: [], choices: [
      { value: 'new', desc: 'make a row, step by step (y/N cards)' },
      { value: 'add', desc: 'a live line above the status bar' },
      { value: 'edit', desc: 'change a row, step by step' },
      { value: 'reload', desc: 'pick up rows changed by quox rows' },
      { value: 'list', desc: 'your rows and what they show now' },
      { value: 'rm', desc: 'remove a row' },
      { value: 'test', desc: 'show a row\'s raw value' },
      { value: 'on', desc: 'show rows' },
      { value: 'off', desc: 'hide and pause all rows' }] },
    { after: ['rm'], src: 'rows' },
    { after: ['test'], src: 'rows' },
    { after: ['edit'], src: 'rows' },
    { after: ['add', '*'], choices: [
      { value: 'url', desc: 'fetch JSON from a URL' },
      { value: 'cmd', desc: 'run a shell command (this machine only)' }] },
    { after: ['add', '*', 'url'], choices: [] },
    { after: ['add', '*', 'cmd'], choices: [] },
    { after: ['add'], choices: [] }
  ]
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
  { id: 'undo-key', kind: 'key', group: 'Talk', usage: 'Ctrl+_', desc: 'undo in the composer', status: 'active' },
  { id: 'paste', kind: 'key', group: 'Talk', usage: 'paste', desc: 'long pastes collapse to [Pasted text #N +L lines] and expand on send', status: 'active' },
  { id: 'ctrlc', kind: 'key', group: 'Talk', usage: 'Ctrl+C', desc: 'clear the draft; during a turn interrupt; twice when idle quits', status: 'active' },
  // Approvals
  { id: 'approvals', kind: 'command', group: 'Approvals', usage: '/approvals [mine|agents|old|<agent>|N]', desc: 'the questions waiting for you, one at a time', server: true, cap: 'approvals', status: 'active' },
  { id: 'walkthrough', kind: 'command', new: true, group: 'Approvals', usage: '/walkthrough', desc: 'walk through what is waiting for you one question at a time: what it does, why, my advice, then your choice (same as /approvals walkthrough)', server: true, cap: 'approvals', status: 'active' },
  { id: 'yestoall', kind: 'command', new: true, group: 'Approvals', usage: '/yestoall', desc: 'approve everything waiting for you (same as /approve all; privileged ones still ask)', server: true, cap: 'approvals', status: 'active' },
  { id: 'approve', kind: 'command', group: 'Approvals', usage: '/approve N | 1 y 2 n | agent <name>', desc: 'approve item N from the list, or everything one agent asked', server: true, cap: 'approvals', status: 'active',
    detail: 'Run /approvals first. Mid-turn approval cards also take a (approve), d (deny), o (open); they arm after 300 ms and never default to approve.' },
  { id: 'deny', kind: 'command', group: 'Approvals', usage: '/deny N [reason] | agent <name> [reason]', desc: 'deny item N (or all of one agent) with an optional reason the requester sees', server: true, cap: 'approvals', status: 'active' },
  { id: 'answer', kind: 'command', group: 'Approvals', usage: '/answer 3 b ["note"] | 1 y 2 n', desc: 'answer a decision a session asked (quox ask): pick its option, with an optional note the asker gets', server: true, cap: 'approvals', status: 'active',
    detail: 'Run /approvals first: decisions are listed first, one line each, with who asked, the options (a) (b) (c), what is recommended and how long is left. /answer 3 b picks option b of item 3; /answer 3 b "after Friday" adds a note. After /approvals 3 you can leave the number off: /answer b. y/n questions also take /approve 3, and /deny 3 <reason> declines with a reason. /approve all never answers a decision for you.' },
  { id: 'authenticate', kind: 'command', group: 'Approvals', usage: '/authenticate', desc: 'enter your PIN once: a person is present for 10 minutes', server: true, cap: 'approvals', status: 'active',
    detail: 'A typed y cannot prove a person typed it, so approvals an agent raised (or high-risk ones) and /override need your step-up PIN. /authenticate asks for it once and keeps a "human present" window open for 10 minutes (shown in gold above the status line), so those do not ask again. Set the PIN in the dashboard (Settings > Account > Approval PIN); it cannot be set from here. Agent logins cannot use this: a person approves from their phone or a human session.' },
  { id: 'authorise', kind: 'command', group: 'Approvals', usage: '/authorise N', desc: 'approve item N with your PIN', server: true, cap: 'approvals', status: 'active', aliases: ['authorize'],
    detail: 'Like /approve N, but asks for your step-up PIN first when there is no live human-present window. The digits are never shown, saved, or sent anywhere except the PIN check.' },
  { id: 'override', kind: 'command', group: 'Approvals', usage: '/override <block id|last> <reason>', desc: 'override ONE blocked action (PIN, recorded and witnessed)', server: true, cap: 'approvals', status: 'active',
    detail: 'When a policy block refuses an action (safety level, budget cap, AOCL or WARD deny), a person with a fresh PIN can override that one action. The reason, your name and the block are recorded and witnessed. Today only safety blocks (E-STOP, DEFCON RED dispatch refusals) are honoured by a gate; other block types are recorded but stay blocked, and the answer says so. "last" is the most recent block this window saw.' },
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
  { id: 'challenge', kind: 'command', group: 'Conversation', usage: '/challenge [focus]', desc: 'an adversarial review of the last answer by a different provider (costs one extra model turn)', status: 'active', needs: ['connections'],
    detail: 'Brutaloop on demand. Sends the last answer and that turn\'s tool calls and receipts to ONE review turn on a different connected provider (else a different model on the same provider; it says which). The reviewer lists factual errors, unsupported claims, missed failures and unsafe actions, each with a severity and the evidence it rests on, and does not rewrite anything. Read-only, but it costs one extra model turn. Afterwards "Resolve these? y/N": y sends the findings back to the agent that answered, as a normal turn, to fix or rebut each one. The optional focus narrows the review, e.g. /challenge security.' },
  { id: 'spawn', kind: 'command', group: 'Conversation', usage: '/spawn <cores>c <ram>G <disk>G <lifespan> for <objective> | list | done <vmid>', desc: 'ask HYPERION for a disposable VM (posts to slot provisioner; lifespan required, max 24h)', status: 'active', needs: ['slotSay', 'slotStream'], cap: 'slots',
    detail: 'Order is loose and plain words work: /spawn 4 cores 8G 20G for 2h to test the installer. Lifespan is required (max 24h); at most 3 live VMs per session. You see one card (resources, lifespan, objective, and that it posts to HYPERION); y posts the request to slot provisioner signed by this session, waits for HYPERION\'s lease reply and prints the vmid, IP, user and how to connect. The lease is stored locally with its expiry and released with "done <vmid>" at expiry, or on /spawn done <vmid>. There is no server-side slot reminder, so expiry runs in this window: if it is closed, the VM is released on the next start, and /spawn list shows overdue leases in red.' },
  { id: 'consent', kind: 'command', group: 'Conversation', usage: '/consent [grant [provider]]', desc: 'AI data sharing consent: see where you stand, or give your OK and carry on', status: 'active', needs: ['consentStatus'],
    detail: 'Cloud AI providers (OpenAI and other hosted ones) receive your messages and tool results, so Quox needs your OK first; it is personal, not an admin setting. /consent shows where you stand. /consent grant [provider] records your OK (the same as quox consent grant --provider <name>, or Settings > Privacy in the dashboard) and, if a message just failed for lack of it, sends that message again. A local model (Ollama) never needs it.' },
  { id: 'help', kind: 'command', group: 'Conversation', usage: '/help [command]', desc: 'this reference, or detail for one command or key', status: 'active',
    detail:
      'Type / to open the command list. After a command and a space, the next word is ' +
      'suggested too (providers, live model ids, orgs, agents, slots, options): Up and Down' +
      ' choose, Tab completes, Esc closes, and keep typing to narrow. Suggestions that ' +
      'cannot be fetched are simply left out.' },
  { id: 'note', kind: 'command', group: 'Conversation', usage: '/note <text>', desc: 'jot an observation for the dev observer (also: // text); not sent to Quox', status: 'active', dev: true,
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
  { id: 'mouse', kind: 'command', new: true, group: 'Conversation', usage: '/mouse [on|off]', desc: 'clicks: a ◆ sender to reply, a card\'s y / n / c to answer, select text in your draft (off by default)', status: 'active',
    detail: 'Saved for this profile. On: click a ◆ sender line to start /say to that slot, click y approve, n deny or c chat on a card (or y/N/c on an ask) to answer exactly as the key would, and click, drag or double-click in your draft to place the cursor or select (Backspace deletes, typing replaces). A click never runs a command: a run request still needs y or typing run. While it is on the terminal sends clicks and the wheel to Quox, so hold Shift (Option on macOS) to select or copy text, and Shift+wheel or the scrollbar to scroll back.' },
  { id: 'tip', kind: 'command', group: 'Conversation', usage: '/tip', desc: 'a "did you know" tip about something Quox can do on this install', status: 'active',
    detail: 'Shows one tip at a time and rotates through all of them before repeating. Only features that are shipped (stable or beta) and ready on this server are offered, and things you already use are skipped. One tip also shows under the greeting on launch. /tip-settings off stops them.' },
  { id: 'tips', kind: 'command', group: 'Conversation', usage: '/tips [topic or words]', desc: 'search the tips: /tips social media, /tips integrations; alone lists the topics', status: 'active', args: ARGS.tips,
    detail: 'Bare /tips lists the topics with how many tips each has. /tips <words> ranks tips by topic, title, text and command and shows up to 5; add "more" at the end for the rest. It respects /tip-settings: tips your setting hides are counted, not shown. /tip still gives one random tip.' },
  { id: 'tip-settings', kind: 'command', group: 'Conversation', usage: '/tip-settings [off|core|all]', desc: 'tips: off = none, core = free features only, all = everything shipped (default); saved on this profile', status: 'active', args: ARGS['tip-settings'],
    detail: 'Alone shows the current setting. Saved to your CLI profile, so it survives restarts. core limits tips to the free tier; all includes plugin features your install can use.' },
  { id: 'whatsnew', kind: 'command', group: 'Conversation', usage: '/whatsnew [all|on|off]', desc: 'new commands since you last looked, plus release notes; on/off controls the startup card', status: 'active', args: ARGS.whatsnew,
    detail: 'Quox shows a short "What\'s new" box once when you start a newer version than last time. /whatsnew lists the latest 10 entries with a command to try; /whatsnew all lists every entry.' },
  { id: 'welcome', kind: 'command', group: 'Conversation', usage: '/welcome', desc: 'Show the welcome screen again', status: 'active' },
  { id: 'about', kind: 'command', group: 'Conversation', usage: '/about', desc: 'who we are, terms, privacy, licence and docs links', status: 'active' },
  { id: 'quit', kind: 'command', group: 'Conversation', usage: '/quit', desc: 'leave; finished work is kept and /resume picks the conversation up', status: 'active', aliases: ['exit'],
    detail: 'Idle: leaves at once; the conversation stays on the server for /resume (or quox --resume). During a turn it asks first, because leaving disconnects the turn and the server stops it before its next step (a tool already running finishes and is recorded). /quit again within 5 s leaves anyway.' },
  { id: 'restart', kind: 'command', group: 'Conversation', usage: '/restart [auto [on|off]]', desc: 'restart into the latest installed quox and resume this conversation', status: 'active',
    detail: 'Re-runs the quox on your PATH in this terminal with the same arguments and profile, plus --resume for this conversation. During a turn it asks first: restarting disconnects the turn and the server stops it before its next step (this server cannot reattach a running turn yet); /restart again within 5 s goes ahead. When a newer build is installed than the one running, a dim line says so (checked at most once a minute, no network). /restart auto on restarts for you when that happens and you are idle (5 s countdown, any key cancels); bare /restart auto toggles. Saved per profile, off by default.' },
  { id: 'update', kind: 'command', new: true, group: 'Conversation', usage: '/update', desc: 'update quox to the latest version, then restart', status: 'active',
    detail: 'Checks how this quox was installed (npm, a git checkout, or this box\'s shared CLI tree) and the latest version, then shows what is new and asks y/N/c. y hands the terminal to the update (so npm prompts or sudo work), shows its exit status and, on success, restarts into this conversation like /restart (attach and slot carry over). A failed update keeps you in this conversation and says the command to run yourself. A git checkout updates only when clean and on main (git pull --ff-only, never stash or reset); this box\'s shared tree runs quox-cli-refresh, which updates quox for every session here. A self-hosted install updates with quox server update. Same as quox update in a shell.' },
  { id: 'demo', kind: 'command', group: 'Conversation', usage: '/demo', desc: 'play the simulated demo journey on its own (same as quox --demo --autoplay); nothing real runs', status: 'active',
    detail: 'Hands the terminal to the autoplay demo: a scripted journey with a simulated server, no input needed, nothing real runs and nothing is sent. Quit it to come back to your normal client; this conversation stays on the server for /resume. During a turn it asks first, like /restart.' },
  { id: 'feedback', kind: 'command', new: true, group: 'Conversation', usage: '/feedback <text>', desc: 'tell the Quox team something: sent to the quox.ai feedback API after you see it and say y', needs: ['feedback'], status: 'active',
    detail: '/feedback <text> shows exactly what will be sent (type feedback, your text, and the quox CLI version; no name, email, org or token) to https://api.quox.ai/api/feedback, the Quox team rather than your own Quox server, and asks y/N. y sends it; anything else leaves it unsent. The Quox site takes 5 a hour per address. /gripe is different: it files a GitHub issue through your org.' },
  { id: 'gripe', kind: 'command', group: 'Conversation', usage: '/gripe <text>', desc: 'file a GitHub issue through the GRIPE agent; shows it first, /gripe! files at once', needs: ['gripe'], status: 'active', aliases: ['gripe!'],
    detail: 'The same governed path as `quox gripe`: the GRIPE agent files the issue through your org\'s GitHub connector (default repo quoxai/quox). /gripe <text> shows what would be filed and asks; /gripe! (alone, within 2 minutes) files it, or /gripe! <text> files straight away. The issue link is shown when one comes back; with no link it says so and treats it as not filed.' },
  { id: 'sessions', kind: 'command', group: 'Conversation', usage: '/sessions [all|refs]', desc: 'everything live in your org by name and where it runs; refs adds ids, all adds every chat', needs: ['sessionsIndex'], status: 'active',
    detail: 'Each row leads with the session name and where it runs (host, or "host unknown" when the server does not know), then how long it has been up and when it was last active. Sections: terminal sessions, slots, work (objectives, loops, workflows) and chats. /sessions refs adds ids and attach commands under each row; /sessions all includes every chat from the last 24 h. The same data as `quox sessions`. Names set with /rename are kept on this machine (~/.config/quox/sessions.json).' },
  { id: 'active', kind: 'command', new: true, group: 'Conversation', usage: '/active [sessions|slots|agents]', desc: 'who is doing what: one line per active worker, grouped working / waiting on you / idle (same as `quox active`)', needs: ['sessionsIndex'], status: 'active',
    detail: 'One short summary over the live session index: each line is a name, what it is doing (its state reason, slot or agent, never invented), its state (working, waiting on you, idle Nm, asleep) and since when. Top 10 per group; /active all shows every one. /active sessions, /active slots and /active agents show one kind. A source the server could not read is named in one line. The same data as `quox active`.' },
  { id: 'dashboard', kind: 'command', group: 'Conversation', usage: '/dashboard [page]', desc: 'open the web dashboard already signed in (one-time link); pages: sessions approvals agents lucid inbox seo settings', needs: ['dashboardLink'], status: 'active',
    detail: 'Creates a sign-in link for this profile that is valid for 10 minutes and works once, then opens it in your default browser. Over SSH it only prints the link (the browser would open on the wrong machine); terminals that support hyperlinks make it clickable. The link is a credential: it is shown on screen only and never written to the dev transcript or history. An older server without one-time links gets the plain dashboard URL and you sign in as usual. Also: quox dashboard [page].' },
  { id: 'rename', kind: 'command', group: 'Conversation', usage: '/rename [name]', desc: 'name this session (shown in the top rule); alone shows the current name', status: 'active',
    detail: 'Also settable at launch with quox -n <name>. The name is kept on this machine, keyed by conversation, and shown in /sessions.' },
  { id: 'slot', kind: 'command', group: 'Conversation', usage: '/slot <name>', desc: 'give this session a slot address (checks out the slot)', needs: ['checkoutSlot'], cap: 'slots', status: 'active', args: ARGS.slot,
    detail: 'Checks out the slot, creating it if needed, as `quox slot checkout <name> --create --session <session>` does; typing it is your consent. While you hold it, every message to the slot (other windows, Discord, Matrix) shows here live, above the composer. /slot log [n] shows the last n messages. A start in the same folder offers to reattach the slot you last held. /config sets a bell for incoming lines.' },
  { id: 'say', kind: 'command', group: 'Conversation', usage: '/say <slot>[,<slot>...] <text>', desc: 'message one or more slots directly (no model turn); a,b,c sends each a copy naming everyone it went to', needs: ['slotSay'], cap: 'slots', status: 'active', aliases: ['ask'], args: ARGS.say,
    detail: 'Posts straight into the slot, signed as this window (your slot and name), and prints the line with ✔ once it is in the slot. Starting a line with @<slot> does the same.' },
  { id: 'join', kind: 'command', new: true, group: 'Conversation', usage: '/join <slot>', desc: 'join a slot as a group room (read and post without holding it)', needs: ['slotSay'], cap: 'slots', status: 'active', args: ARGS.say,
    detail: 'Subscribes this window to the slot\'s live stream; the last ~10 messages show first. Holding (/slot) stays separate and exclusive. Post with #<slot> <text> or /say; #<slot> alone makes it the default target (a bare # undoes it). /<slot> join, /<slot> leave and /join #<slot> work too. Your lines are signed with this session\'s name and person, never as a human profile.' },
  { id: 'leave', kind: 'command', group: 'Conversation', usage: '/leave <slot>', desc: 'leave a slot room you joined (does not release a hold)', needs: ['slotSay'], cap: 'slots', status: 'active', args: ARGS.say },
  { id: 'rooms', kind: 'command', new: true, group: 'Conversation', usage: '/rooms', desc: 'rooms (groups) this window has joined, with unread counts; also on the status line', needs: ['slotSay'], cap: 'slots', status: 'active', aliases: ['groups'] },
  { id: 'broadcast', kind: 'command', new: true, group: 'Conversation', usage: '/broadcast [--slots a,b] [--priority urgent] [--ack] <text>', desc: 'tell every held slot in this org at once, signed as you', needs: ['slotBroadcast'], cap: 'slots', status: 'active', aliases: ['roar'], args: ARGS.broadcast,
    detail: 'One server call delivers to every slot held in this org (never another org), or only --slots a,b. --priority urgent marks it red for recipients. --ack asks them to reply /ack <id>; you then see "Broadcast delivery: delivered N / acknowledged M / awaiting K" update. You get a framed card: how many sessions have it (stored in the slot, listening sessions see it at once) and a separate chat-rooms count (sent / sending / failed). /broadcast status <id> redraws it. Typing it is your consent. Not yet: --at (schedule), --fleet, --org, --voice.' },
  { id: 'page', kind: 'command', new: true, group: 'Conversation', usage: '/page <slot> <text>', desc: 'urgent message to one slot, acknowledgement requested', needs: ['slotBroadcast'], cap: 'slots', status: 'active', args: ARGS.say,
    detail: 'Like /broadcast to a single slot with --priority urgent --ack: it shows red there, asks them to /ack, and you see when they have.' },
  { id: 'ack', kind: 'command', new: true, group: 'Conversation', usage: '/ack <broadcast id>', desc: 'acknowledge a broadcast, as the slot this window holds', needs: ['slotAck'], cap: 'slots', status: 'active',
    detail: 'The id is in the broadcast line ("ack with /ack bc_...").' },
  { id: 'send', kind: 'command', group: 'Conversation', usage: '/send <slot> <file>', desc: 'send a local text file into a slot (64 KB cap)', needs: ['slotSay'], cap: 'slots', status: 'active', args: ARGS.send,
    detail: 'Text files up to 64 KB go inline; the receiving window shows the name and the first lines, /slot log shows the rest. Secret-shaped values (keys, tokens, passwords) are found first: you are asked y/N, and a yes sends them redacted. Binary and larger files are refused (slots have no attachment store yet). Tab completes the path.' },
  { id: 'attach', kind: 'command', group: 'Conversation', usage: '/attach [agent]', desc: 'send your turns to a specific agent; alone shows the current one', needs: ['agents'], cap: 'agents', status: 'active', aliases: ['summon'], args: ARGS.attach,
    detail: 'The agent name is checked against your org\'s agent list. Later turns go to that agent (the chat stream assistant field) until /detach.' },
  { id: 'detach', kind: 'command', group: 'Conversation', usage: '/detach', desc: 'back to CommanderQ', status: 'active' },
  { id: 'peek', kind: 'command', new: true, group: 'Conversation', usage: '/peek <id>', desc: 'look up an envelope, inbox item, objective, run, WARD receipt or agent by id', status: 'active',
    detail: 'Works out what the id is from its shape and asks only the read endpoints that fit: a ULID is tried as an envelope, inbox item, objective and workflow run at once; a UUID as a WARD receipt; a name as an agent. Shows a compact card and the quox command for the full record. Nothing found says what was tried and what each answered. Read only, in this window\'s org. Also: quox peek <id>.' },
  { id: 'aside', kind: 'command', new: true, group: 'Conversation', usage: '/aside <question>', desc: 'a read-only side question: no tools, not added to this conversation', status: 'active',
    detail: 'Asks the model with no tools at all and no conversation id, so it cannot change anything and the answer never enters this conversation\'s history: your next message carries on as if the aside never happened. The last few exchanges go along as read-only context, so you can ask about what was just said. The answer shows in its own violet block marked read only. Also: quox aside "<question>" (no context).' },
  // Connect
  { id: 'login', kind: 'command', group: 'Connect', usage: '/login', desc: 'sign in again without leaving quox (email, masked password, MFA code if asked)', status: 'active',
    detail: 'Opens a card here: your email (prefilled with the last one this profile used), then a masked password, then your authenticator code if the server asks for one. It is the same sign-in as quox login, so status, approvals and the digest come back without a restart. The password is never echoed, logged or saved. CLI sign-ins last 30 days by default; an org session policy can set a shorter limit.' },
  { id: 'profile', kind: 'command', new: true, group: 'Connect', usage: '/profile [name]', desc: 'switch profile or org without leaving: a chooser of your profiles and this login\'s orgs, for this window only', status: 'active',
    detail: '/profile alone names this window\'s profile and opens a chooser: the signed-in profiles (this window\'s marked *), profiles on this machine that are not signed in, then this login\'s orgs. Up/Down and Enter switch; an org asks y/N first, like /org. Every switch is for this window only: the shared default profile and org in your quox config stay as they were, so other windows and scripts are untouched. /profile <name> also switches straight away. /profile <name> switches this window to that profile in place (or restarts into it carrying the conversation, attach, slot and org). /login <name> does the same when that profile is already signed in. A profile that is not signed in gets a run card for quox login -p <name>. An agent-login window that hits approvals or a step-up offers the switch as a y/N card; it never switches on its own.' },
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
  { id: 'prove', kind: 'command', new: true, group: 'Verbose', usage: '/prove', desc: 'independently check that the last turn\'s tool calls really did what they said: receipt chain plus a read-back of the effect', server: true, cap: 'receipts', status: 'active',
    detail: 'For each tool call of the last turn: the receipt chain is re-read from the server (as in /proof), and where the tool is a write we know how to read back (today: slot_create, memory_save) the effect is read from the system of record. ✔ proven = the chain agrees and the effect is there (or it was a read and the chain agrees). ⚠ unproven = it cannot be shown from here (no read mapping for that write, a read failed, no receipt). ✖ contradicts = the call failed, the server recorded a failure, or the effect is not there. Nothing is assumed: an unmapped write is never called proven. /proof is unchanged and shows one call\'s chain.' },
  { id: 'replay', kind: 'command', new: true, group: 'Verbose', usage: '/replay [run or conversation id] [page]', desc: 'rebuild an earlier run from the audit trail: decisions, tools with args, outputs and receipts, in order, paged', server: true, cap: 'receipts', status: 'active', args: ARGS.replay,
    detail: 'Alone: the last turn of this conversation (your question, each tool with its args summary, output and receipt id, then the answer). With a conversation id: its saved messages (the server does not link tool envelopes to a conversation). With an envelope or correlation id: that run\'s tool calls and guard decisions straight from the AEE audit trail. Six steps a page; add a page number for the next. Read-only: it reconstructs what was recorded and never re-executes anything, and sandbox re-execution is not available.' },
  { id: 'aocl', kind: 'command', group: 'Verbose', usage: '/aocl', desc: 'every AOCL layer of the last turn: outcome, time, reason', status: 'active',
    detail: 'Each turn shows ONE AOCL line (layers accounted, passed, bypassed, time; red with the layer name on a reject). /aocl expands the last turn into all 11 layers, L0 ingress to L10 audit, as the server reported them.' },
  { id: 'reconcile', kind: 'command', group: 'Verbose', usage: '/reconcile', desc: 'check tool calls that ended with effect unknown against the server\'s record', server: true, cap: 'receipts', status: 'active' },
  // Awareness
  { id: 'roster', kind: 'command', group: 'Awareness', usage: '/roster [all]', desc: 'show or hide the live roster under the status line; all includes background work', needs: ['roster'], status: 'active',
    detail: 'The roster lists what needs you: pending approvals, then work you started (objectives, loops, manual workflows). Scheduled and event-driven workflows are hidden; background failures show once per workflow in the bar below. /roster all shows everything. Refreshed every 15 s from the server. Down on an empty composer focuses it; Enter peeks, s asks to stop (y confirms), Esc returns. A source the server cannot answer shows nothing and is named here.' },
  { id: 'workflow', kind: 'command', group: 'Skills', usage: '/workflow <name|id|run>', desc: 'the step flow of a workflow\'s latest run (or one run): state, timings, human gates', server: true, cap: 'workflows', status: 'active',
    detail: 'Steps come from the workflow definition and each state and duration from that run\'s recorded envelopes. A reached human gate shows amber. Enter on a workflow row in the roster shows the same flow.' },
  { id: 'crystal', kind: 'command', group: 'Skills', usage: '/crystal <workflow>', desc: 'is this workflow eligible to become a Crystal? checked against the real gate', server: true, cap: 'crystals', status: 'active',
    detail: 'Computed from the workflow\'s recorded runs with quoxflow\'s crystalliser rule: at least 3 runs, at least 80% successful, one action sequence. Says how many more successful runs are needed. Related: /crystallize turns what you just did in this conversation into a new skill.' },
  { id: 'undo', kind: 'command', group: 'Awareness', usage: '/undo [last]', desc: 'reverse the last thing Quox did, if Quox knows how (one card, y/n)', status: 'active', server: true, cap: 'receipts',
    detail: 'Finds the last state-changing tool call of this conversation that has a receipt, reads the receipt back, says what it did and what reversing it means, and on y runs the registered inverse and prints the outcome. Known inverses today: slot_checkout (release the slot), inbox_move (mail undo), notesq_create (delete the note). The target is bound from the call itself or from the server\'s own record of it, and only when exactly one record fits; otherwise nothing runs and you get the by-hand route. Anything else says plainly that Quox can\'t reverse it automatically. Ctrl+_ still undoes composer typing.' },
  { id: 'wish', kind: 'command', group: 'Skills', usage: '/wish <description>', desc: 'describe something Quox cannot do yet; Quox drafts a governed spec, you decide (one card, y/n)', status: 'active',
    detail: 'Quox drafts a short spec through a normal turn: what it does, which existing tools or APIs it would use, the hat and permissions, what tests prove it, and which shape fits (skill, workflow, power or code). On y, a skill is created through skill_manage (experimental, queued for human review) and a workflow through the workflow tool, inactive; a power or anything that needs code is filed as a feature request with the spec. Nothing installs code: that goes through the normal build and review path.' },
  { id: 'agents', kind: 'command', group: 'Awareness', usage: '/agents [list [text] | <name> [tools]]', desc: 'pick an agent from the list, or show one\'s card: role, tools, slot, last action and its WARD witness', server: true, cap: 'agents', status: 'active', aliases: ['agent'], args: ARGS.agents,
    detail: '/agents or /agents list opens a picker (name, role, status); Enter shows that agent\'s card; /agents list sec narrows it. /agents <name> shows the card, /agents <name> tools lists the tools it may use. /agent is the same command.' },
  { id: 'which', kind: 'command', new: true, group: 'Context', usage: '/which [profile|org|agent|hat|model|slot|conversation]', desc: 'what this window is using right now: login, org, agent, hat, model, slot, conversation', status: 'active', args: ARGS.which,
    detail: 'Alone prints one block; with a word prints just that line. Reads what this window already holds (the hat shows after your first turn), no model call.' },
  { id: 'crystallize', kind: 'command', group: 'Skills', usage: '/crystallize [what]', desc: 'turn what was just accomplished into a permanent reusable skill (rules, tools, tests)', status: 'active',
    detail: 'One model call drafts a skill from the conversation: rules, the tools used, and tests. The server skill firewall checks it first, then one preview card; y saves it to your skills and prints /skills <name>. Related: /crystal checks whether an existing workflow is eligible to become a Crystal; /crystallize writes a new skill from this conversation.' },
  { id: 'automate', kind: 'command', group: 'Skills', usage: '/automate [task]', desc: 'turn this conversation (or a task you name) into a persistent workflow', status: 'active',
    detail: 'One model call drafts a workflow from the conversation: trigger, schedule, steps, approval gates and failure handling. You get one preview card; y creates it in the workflow store and activates its trigger, then prints the id and /workflow <id>. Nothing is created before y.' },
  { id: 'watch', kind: 'command', new: true, group: 'Awareness', usage: '/watch <what> [for <condition>] | list | stop <id>', desc: 'turn a site, repo, server, page, metric or condition into an ongoing observer', status: 'active',
    detail: '/watch quox.ai for downtime, /watch gitea health, /watch competitor pricing page https://... Shows one preview card (what, how often, what triggers it, where it notifies); y creates a scheduled agent check (default every 15 min, min 5) that stays quiet until the condition is met and then raises it in your Approvals inbox. /watch list shows your watches, /watch stop <id> ends one.' },
  { id: 'fleet', kind: 'command', new: true, group: 'Awareness', usage: '/fleet [host]', desc: 'computers, agents, missions and SubFleets in one block, with health; /fleet <host> shows one', server: true, cap: 'fleet', status: 'active', aliases: ['soar'], args: ARGS.fleet,
    detail: 'Read-only, no model call. Computers merge the QuoxAgent heartbeats with the Bastion host registry (the same reads as quox fleet agents and quox fleet hosts) and count healthy, degraded, unhealthy and offline, naming anything that is not healthy. Agents are your org agents, missions are running or waiting objectives and loops. SubFleets are designed but have no API in this Quox yet, so that row says so. A source that cannot be read is named on the "Can\'t see" line, never shown as zero. Moving work is not a command: ask in plain words.' },
  { id: 'memory', kind: 'command', group: 'Awareness', usage: '/memory <query>', desc: 'facts Quox remembers, each with where it came from, age, trust and conflicts', server: true, cap: 'memory', status: 'active' },
  { id: 'sitrep', kind: 'command', group: 'Awareness', usage: '/sitrep', desc: 'the situation now: approvals waiting, what needs you, running work, what Quox cannot see', server: true, cap: 'lucid', status: 'active',
    detail: 'Read from the server, no model call: approvals waiting (your Approvals inbox), what needs you from the LUCID situation (by urgency), work in motion, and the sources LUCID cannot see (silent, failing or not connected). A part the server cannot answer is named on the "Can\'t see" line, never shown as empty. Does not move your LUCID cursor. /away is the "since you were last here" digest. Asking "give me a sitrep" suggests it.' },
  { id: 'away', kind: 'command', group: 'Awareness', usage: '/away [since]', desc: 'what happened while you were away, and what Quox cannot see', server: true, cap: 'lucid', status: 'active',
    detail: 'A factual digest from the server since you last used quox on this profile (or since 90m, 3h, 2d, or an ISO time): approvals waiting and resolved, objectives and workflows finished or failed, LUCID alerts, new Qortex decisions, failed turns and agent activity, each with its source and time. Sources that could not be read or went silent are named on a "Can\'t see" line. Nothing is summarised by a model. At launch, after more than 2 h away, a short card shows the top 5. Asking "what did I miss" suggests it.' },
  { id: 'vm', kind: 'command', group: 'Awareness', usage: '/vm <verb> <target> [args]', desc: 'Proxmox VMs via the HYPERION agent: list, info, doctor, start|stop|reboot|shutdown, snapshot, rehearse, pool', server: true, status: 'active',
    detail: 'Same verbs as quox vm. /vm list [--node n] [--type qemu|lxc]; /vm info <name|vmid>; /vm doctor <name|vmid> (why is it slow or unhealthy: verdict and ranked findings with evidence and a suggested fix, read only); /vm start|stop|reboot|shutdown <name|vmid>; /vm snapshot <name|vmid> [--name s]; /vm rehearse <name|vmid> [--check url:..|unit:..|cmd:..] [--keep-twin] [--no-wait] -- <command> (runs the command on a network-isolated twin and waits for pass/fail, minutes); /vm pool status|lease|done <vmid>|config. Every action goes through the governed tool route, so a held call prints its approval id and quox approvals result <id> to read the outcome; it is never re-submitted. Names match exactly; an ambiguous name lists the candidates.' },
  { id: 'hyperion', kind: 'command', new: true, group: 'Awareness', usage: '/hyperion', desc: 'which VMs HYPERION has out and who holds each one, one line per VM', server: true, status: 'active',
    detail: 'Read-only, no model call. One line per held VM: vmid, name, node, status, who holds it (pool lease or standing-grant lane), purpose and expiry or age. Same data as quox hyperion, which also shows node load, pool counts and the last 5 operations; quox hyperion deck is the live full-screen view. A VM nobody holds is not listed; a part the server cannot read is named, never shown as empty.' },
  { id: 'observers', kind: 'command', group: 'Awareness', usage: '/observers', desc: 'LUCID situation, what changed since you last looked, what Quox records about its own learning', needs: ['observers'], cap: 'lucid', status: 'active', aliases: ['observer', 'lucid'],
    detail: 'Facts only, read from persisted data: the LUCID situation (without moving your cursor), recent changes, lessons taught, and the reflect / learn / insight counters. Nothing is summarised by a model.' },
  { id: 'mind', kind: 'command', new: true, group: 'Awareness', usage: '/mind [implant]', desc: 'QuoxMind cognitive implants: status and last activity; /mind <id> for one', needs: ['mind'], status: 'active',
    detail: 'Read-only, no model call. /mind lists the 14 cognitive implants (sense, repobrain, memory, temporal, focus, value, guard, qortex, insight, executive, predict, reflect, dream, learn) with status and last activity; /mind predict shows one. An implant with nothing recorded says "no activity recorded". Same data as quox mind implants and quox mind implant <id>.' },
  // Context
  { id: 'hat', kind: 'command', new: true, group: 'Context', usage: '/hat [name|new|edit <hat>|delete <hat>]', desc: 'list the hats, change hat for this conversation, or make, edit and delete hats of your own', needs: ['hats', 'bindHat'], status: 'active', args: ARGS.hat,
    detail: '/hat lists the org hats with the one this conversation wears marked. /hat <name> takes the key or the name you see (/hat DevOps, /hat the devops hat, or a unique start of it) and switches this conversation now: you typed it, so there is no approval card. A privileged hat asks y/N first (or /hat yes). The switch is recorded on the server (quoxhat.binding.selected) and your next message runs on the new hat. Same as approving an agent\'s hat proposal, without asking a model. Custom hats: /hat new walks you through a hat of your own (name, a starting hat, the agents it keeps and adds); a custom hat offers a turn only its own tools and agents. /hat edit <hat> keeps or drops agents, adds some, and can rename it; /hat delete <hat> removes it and sends conversations wearing it back to the default hat. Built-in hats are not edited or deleted here. Esc cancels a walk and nothing is sent.' },
  { id: 'org', kind: 'command', group: 'Context', usage: '/org [switch <name|id> | back]', desc: 'list your orgs (current marked), switch this session to another one, or go back to the last one', needs: ['orgs'], status: 'active', args: ARGS.org,
    detail: '/org lists the orgs your login belongs to. /org switch <name or id> matches loosely, asks y/N (or /org yes), then re-scopes the login (the same exchange as quox org switch) and starts a new conversation in that org; the status line shows the org. /org back (or /org -) returns to the org you were in before, with the same single y/N. A switch only succeeds for orgs you are a member of; the server decides.' },
  { id: 'statusline', kind: 'key', group: 'Context', usage: 'status line', desc: 'profile · org · agent · model · mode, under the composer', status: 'active' },
  { id: 'r', kind: 'command', new: true, group: 'Conversation', usage: '/r <text>', desc: 'reply to whoever last messaged you (slot or room); also /reply', needs: ['slotSay'], cap: 'slots', status: 'active', aliases: ['reply'] },
  { id: 'poke', kind: 'command', new: true, group: 'Conversation', usage: '/poke <slot or session> [text]', desc: 'wake a session: an urgent page asking it to acknowledge (also /wake, /nudge, /ping)', needs: ['slotBroadcast'], cap: 'slots', status: 'active', aliases: ['wake', 'nudge', 'ping', 'slap', 'awaken'] },
  { id: 'afk', kind: 'command', new: true, group: 'Context', usage: '/afk [note]', desc: 'tell sessions you are away (they stop waiting on approvals, which still queue); /back then shows everything since, grouped', status: 'active',
    detail: 'Sets your presence on the server (per user and org): sessions saying into hitl, triage-q or this window\'s slot see "owner away since 15:54 UTC (note): approvals will queue"; `quox presence`, `quox slot list`, quox ask and agents see it too. Nothing is approved while you are away. /back or any typed message marks you present.' },
  { id: 'back', kind: 'command', new: true, group: 'Context', usage: '/back', desc: 'mark yourself present and show what happened since /afk (same as /away)', status: 'active' },
  { id: 'observe', kind: 'command', new: true, group: 'Context', usage: '/observe <text>', desc: 'a note to the observer: posts your text to the session that watches your window', status: 'active', dev: true },
  { id: 'huh', kind: 'command', new: true, group: 'Conversation', usage: '/huh [question]', desc: 'the dragon explains what just happened (same as /dragon explain)', status: 'active' },
  { id: 'sleep', kind: 'command', new: true, group: 'Conversation', usage: '/sleep', desc: 'mark yourself sleeping (sessions stop waiting on approvals, which still queue) and the dragon curls up (/dragon sleep)', status: 'active' },
  { id: 'mode', kind: 'command', new: true, group: 'Context', usage: '/mode [ask|plan]', desc: 'this window\'s mode: ask first (default) or plan only', status: 'active', args: ARGS.mode,
    detail: 'Alone it shows the current mode and the options. /mode plan: Quox investigates with read tools and proposes the steps and the exact commands, and runs nothing that changes state; the server enforces it, and the answer ends with "Run this plan now? y/N/c" (y switches back to ask and sends the go-ahead). /mode ask goes back. For this window only: kept across /restart, never saved to your profile. Auto mode is not available yet: it needs standing grants (planned).' },
  { id: 'slots', kind: 'command', new: true, group: 'Conversation', usage: '/slots [all]', desc: 'held slots: who holds them and where; free ones are summarised, /slots all lists them (same as /slot list)', needs: ['slots'], cap: 'slots', status: 'active' },
  { id: 'mirror', kind: 'command', new: true, group: 'Context', usage: '/mirror [agents]', desc: 'the Mirror: what CommanderQ sees about this org right now', needs: ['mirror'], status: 'active',
    detail: 'Read-only, no model call. The org-scoped Mirror the server builds from each service and injects into CommanderQ on every turn: identity, health, implants, capabilities, plugins, memory, codebase, and every value it could not read with the reason. /mirror agents lists the agents. For the QuoxMind implants alone use /mind.' },
  { id: 'health', kind: 'command', new: true, group: 'Context', usage: '/health', desc: 'Core dashboard summary: services, computers, agents, approvals, missions, failures, licence (also /core)', status: 'active', server: true, aliases: ['core'],
    detail: 'Read-only, no model call. The same server reads the Core dashboard overview uses: service health (GET /api/v1/health/aggregate), computers and agents (as /fleet), approvals and inbox (inbox stats), running objectives and loops, failed workflow runs in the last 24h, and the licence. A section that could not be read says "unavailable" and why, never zero. /status is the session panel; /collector-health still shows it.' },
  { id: 'status', kind: 'command', group: 'Context', usage: '/status', desc: 'profile, org, server and its health, model, agent, slot, session, version', status: 'active', aliases: ['collector-health'],
    detail: 'The provider and model shown are what the server last reported running (turn.started), not what was asked for. Server health is checked live. Asking "what is my status" in words prints the same panel as a tip.' },
  { id: 'cost', kind: 'command', group: 'Context', usage: '/cost', desc: 'tokens and cost per model for this session, from real usage', status: 'active', aliases: ['usage'],
    detail: 'Counts only what the server reported on turn.finished (input, output and cache tokens, cost when the provider gives one). Cost stays blank when the server did not report it, and says so; nothing is estimated. Asking "what is this costing" prints the same panel.' },
  { id: 'context', kind: 'command', new: true, group: 'Context', usage: '/context [off|on]', desc: 'model, tokens, rules, skills, memory, agent, and what the terminal block sent last turn', status: 'active',
    detail: 'Every message carries a small block (2 KB max, secrets masked) saying what this screen shows: your org, slot and model, the roster rows with their ids, waiting approvals, the last commands and their outcome, and the slash command names. /context shows what was sent last turn; /context off stops it for this session, /context on resumes. It goes to the same provider under the same AI-sharing consent as the chat itself. Conversation tokens are the sum the server reported for this conversation in this session. Skills and memory are real calls to your server; anything it cannot answer shows ? with the reason. Asking "how much context have we used" prints the same panel.' },
  { id: 'doctor', kind: 'command', group: 'Context', usage: '/doctor', desc: 'the quox doctor checks plus chat checks, as rows', status: 'active', needs: ['doctorChecks'],
    detail: 'Runs the same checks as `quox doctor` (services, auth token, CLI version) in this process, then chat checks: the chat routes answer, a provider is connected, the capability contract.' },
  { id: 'server', kind: 'command', group: 'Context', usage: '/server', desc: 'your self-hosted install: version, health per service, disk, ports, last update', status: 'active', needs: ['serverStatus'],
    detail: 'The same read-only panel as `quox server status`, for the install Getting started recorded (or the one the running containers belong to). Changing the server is a terminal verb, never a chat action: quox server update (backup first, rolls back on failure), quox server rollback, quox server uninstall, quox server doctor, quox server diag. Each takes --dry-run to show the plan first.' },
  { id: 'config', kind: 'command', group: 'Context', usage: '/config', desc: 'settings: theme, motion, verbose, model; saved on this profile', status: 'active', aliases: ['settings'],
    detail: 'An interactive card: Up/Down pick a setting, Left/Right or Space change it (saved at once to this CLI profile), Enter on Model opens /model, Esc closes. Theme replaces the env-only QUOX_THEME; if QUOX_THEME is set in your shell it still wins and the card says so.' },
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
  { id: 'row', kind: 'command', group: 'Context', usage: '/row [new|add|list|edit <id>|rm <id>|test <id>|reload|on|off]', desc: 'your own live lines above the status bar: stats from a URL, your Quox, a plugin or a command', status: 'active', args: ARGS.row,
    detail:
      '/row new walks you through one row with y/N cards and shows what it will say before saving; /row edit <id> changes one. ' +
      'Without a template a row reads the status-row contract: JSON {"text", "value", "tone", "trend", "link"} or plain text ' +
      '(quox rows contract prints it). quox rows add|edit|remove|test|share|import does the same from a shell; /row reload picks it up at once (open windows re-read every minute). ' +
      'Rows never carry secrets, and a row from a share bundle never runs a command. ' +
      '/row add <id> url <url> "<template>" [every 60s] [label X] [colour ok] puts one line above the status bar, ' +
      'refreshed on a timer. /row add <id> cmd "<shell cmd>" "<template>" does the same from a command. The template ' +
      'fills {{path}} from the JSON (or {{text}} from plain output), plus count(path) and count(path[field=value]); ' +
      'numbers are shown compactly, for example {{count(runs[state=ok])}}/{{count(runs)}} ok. At most 3 rows, one line each. ' +
      'url rows follow your account (fetched from THIS machine, http or https only, no credentials sent unless the URL is ' +
      'your own Quox server). cmd rows stay on this machine and are never synced. A failing row shows a short red ' +
      '"warning" line and retries with backoff; it never blocks typing. /row test <id> shows the raw value; /row off hides and pauses all rows.' },
  { id: 'mentions', kind: 'key', new: true, group: 'Context', usage: '@mention', desc: 'complete agents, hosts, tasks and receipts as you type @', status: 'active',
    detail: 'Type @ at the start of a word: a list under the composer suggests agents, fleet hosts, tasks (your newest objectives) and receipts (the envelope ids of this session\'s tool calls), filtered as you type by id or name. Tab or Enter puts it in, Esc closes the list. The lists are fetched once per session on your first @ and then filtered locally, so typing never sends a request; receipts come from this session and need no request at all. /peek <id> shows what an id is.' }
];

// The palette row's one-line wording (commandShort.js); /help keeps the long desc.
for (const e of REGISTRY) if (e.kind === 'command' && !e.short && SHORT[e.id]) e.short = SHORT[e.id];

const norm = (s) => String(s || '').trim().toLowerCase().replace(/^\//, '');

/** Dev-only entries (/observe, /note) are invisible unless a dev observer is configured. */
export const entryVisible = (e) => !e.dev || devObserverOn();
/** REGISTRY minus entries hidden on this install. */
export const visibleRegistry = () => REGISTRY.filter(entryVisible);

export function findEntry(name, registry = visibleRegistry()) {
  const n = norm(name);
  if (!n) return null;
  return registry.find(e => e.id === n || e.aliases?.includes(n) || norm(e.usage.split(/\s/)[0]) === n || e.usage.toLowerCase() === n) || null;
}

/** Like findEntry but only a slash command: a key or topic that shares the first word (the "status line" key vs /status) never shadows the command. */
export function findCommandEntry(name) {
  const n = norm(name);
  if (!n) return null;
  return visibleRegistry().find(e => e.kind === 'command' && (e.id === n || e.aliases?.includes(n) || norm(e.usage.split(/\s/)[0]) === n)) || null;
}

/** Slash commands only. */
export const commandNames = () => visibleRegistry().filter(e => e.kind === 'command' && e.status === 'active').flatMap(e => ['/' + e.id, ...(e.aliases || []).map(a => '/' + a)]);

/** Pure help model: [{ kind: 'head'|'row'|'dim'|'gap'|'plain', key?, text? }]. */
const capView = (e, caps = {}) => {
  if (e.id === 'enter' && caps.steer === false) return { ...e, desc: 'send; while Quox works, queue it (this server cannot steer a running turn)', detail: 'This server has no steer route: Enter during a turn queues your message as the next turn.' };
  if (e.id === 'esc' && caps.interrupt === false) return { ...e, desc: 'disconnect from the turn (this server cannot stop it; idle: Esc Esc clears the draft)', detail: 'This server has no interrupt route: Esc aborts only your stream. Work already sent may still finish and be charged.' };
  return e;
};

/** /help status: the status rows under the composer, one line per item (there is no hover in a terminal). */
const STATUS_LINE_HELP = [
  { kind: 'gap' }, { kind: 'head', text: 'The status line, item by item' },
  { kind: 'row', key: '● agent X', text: 'the agent your turns go to (/attach); ○ agent: none when you talk to Quox itself' },
  { kind: 'row', key: '⬢ slot X', text: 'this window\'s own address, held by this session (/slot); others reach you with /say X' },
  { kind: 'row', key: '⬢ groups a 2, b', text: 'other slots joined as group rooms (/join, /leave, /groups); a number is unread lines' },
  { kind: 'row', key: 'profile X', text: 'the quox login this window uses (/profile)' },
  { kind: 'row', key: 'org X', text: 'the organisation everything here acts in' },
  { kind: 'row', key: 'mode ask first', text: 'risky actions wait for your approval; auto acts without asking, plan only plans' },
  { kind: 'row', key: 'rules: QUOX.md', text: 'project rules sent with every turn (/rules off drops them)' },
  { kind: 'row', key: '↻ auto-restart', text: 'restarts into a newer installed quox when you are idle (/restart auto)' },
  { kind: 'row', key: '── model ─', text: 'the divider under the composer names the provider and model (/model)' }
];

/** registry: the entries to list (default: this install's visible registry; tests pass a fixture). */
export function helpModel(topic, caps = {}, registry = visibleRegistry()) {
  if (topic) {
    const e0 = findEntry(topic, registry);
    const e = e0 && capView(e0, caps);
    if (!e) return [{ kind: 'plain', text: `No help for "${topic}". Try /help` }];
    const statusLine = norm(topic) === 'status' ? STATUS_LINE_HELP : [];
    return [
      { kind: 'head', text: e.usage },
      { kind: 'plain', text: e.desc },
      ...(e.detail ? [{ kind: 'plain', text: e.detail }] : []),
      ...(e.status === 'planned' ? [{ kind: 'dim', text: 'Planned, not built yet.' }] : []),
      ...statusLine
    ];
  }
  const out = [];
  for (const g of GROUPS) {
    const active = registry.filter(e => e.group === g && e.status === 'active').map(e => capView(e, caps));
    if (!active.length) continue;
    if (out.length) out.push({ kind: 'gap' });
    out.push({ kind: 'head', text: g });
    for (const e of active) out.push({ kind: 'row', key: e.usage, text: e.desc });
  }
  const planned = registry.filter(e => e.status === 'planned');
  if (planned.length) {
    out.push({ kind: 'gap' }, { kind: 'head', text: 'Coming', dim: true });
    for (const e of planned) out.push({ kind: 'dim', key: e.usage, text: e.desc });
  }
  out.push({ kind: 'gap' }, { kind: 'dim', text: '/help <command> for detail, e.g. /help esc' });
  return out;
}

/** Nearest real slash commands for a mistyped one (prefix, substring, then edit distance; a typo in the first letters of a longer command counts, so /drsg finds /dragon; a one-letter name like /r is not "inside" every word containing that letter). */
export function suggestCommands(input, max = 3) {
  const q = norm(input);
  if (!q) return [];
  const names = [...new Set(commandNames())];
  const lev = (a, b) => { const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) dp[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return dp[a.length][b.length]; };
  return names.map(n => { const k = n.slice(1); const rel = q.startsWith(k) || k.startsWith(q) || (k.length >= 2 && q.includes(k)) || (q.length >= 2 && k.includes(q)); const head = q.length >= 3 && k.length > q.length ? lev(q, k.slice(0, q.length)) + 0.5 : Infinity; return { n, d: rel ? 0 : Math.min(lev(q, k), head), len: Math.abs(k.length - q.length) }; })
    .filter(x => x.d <= Math.max(2, Math.floor(q.length / 3)))
    .sort((a, b) => a.d - b.d || a.len - b.len || a.n.localeCompare(b.n)).slice(0, max).map(x => x.n);
}

const HINT_SYNONYMS = { active: ['live', 'working', 'running', 'who'], working: ['live', 'active'], who: ['sessions', 'live'], online: ['live'], busy: ['live', 'working'], list: ['show'], quit: ['leave'], logout: ['leave'], help: ['commands'] };
const HINT_STOP = new Set(['the', 'and', 'for', 'with', 'your', 'you', 'this', 'that', 'what', 'new']);
/**
 * Hints for an unknown /word: the edit-distance neighbours (suggestCommands) first, else commands whose id, aliases or
 * description share a keyword with it (so /active finds /sessions, "everything live in your org"). Max 3.
 * -> [{ name: '/sessions', desc, kw }] (kw: matched by keyword, not spelling); a single result is a "strong" match the TUI offers as a y/N card.
 */
export function nearestCommands(input, max = 3) {
  const q = norm(input);
  const out = suggestCommands(input, max).map(n => ({ n, score: 100 }));
  const seen = new Set(out.map(x => findEntry(x.n)?.id));
  const toks = new Set(q.split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !HINT_STOP.has(t)));
  for (const t of [...toks]) for (const syn of HINT_SYNONYMS[t] || []) toks.add(syn);
  if (toks.size && !out.length) { // keyword hints only when spelling found nothing (the spelling line is pinned by FW1)
    const stem = (w) => w.slice(0, Math.max(4, w.length - 3));
    for (const e of visibleRegistry()) {
      if (e.kind !== 'command' || e.status !== 'active' || seen.has(e.id)) continue;
      const words = new Set(`${e.id} ${(e.aliases || []).join(' ')} ${e.desc || ''}`.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !HINT_STOP.has(w)));
      let score = 0;
      for (const t of toks) for (const w of words) if (w === t || (t.length >= 5 && w.length >= 5 && stem(t) === stem(w))) { score++; break; }
      if (score) out.push({ n: '/' + e.id, score, kw: true });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max).map(x => ({ name: x.n, kw: !!x.kw, desc: (findEntry(x.n)?.desc || '').split(/[;,(]/)[0].trim() }));
}

// Commands whose last argument is free text: a pasted line that the terminal wrapped is still one command.
const FREE_TEXT_CMDS = new Set(['ask', 'aside', 'afk', 'observe', 'roar', 'awaken', 'poke', 'wake', 'nudge', 'ping', 'slap', 'feedback', 'huh', 'r', 'reply', 'say', 'page', 'broadcast', 'gripe', 'gripe!', 'note', 'dragon', 'deny', 'wish', 'challenge']);
/** "/say a long\n text" -> { text: '/say a long text', lines: 2 }; null when it is not a wrapped free-text command. */
export function joinWrappedSlash(text) {
  const t = String(text || '');
  if (!t.startsWith('/') || !t.includes('\n')) return null;
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2 || !FREE_TEXT_CMDS.has(lines[0].slice(1).split(/\s+/)[0].toLowerCase())) return null;
  if (lines.slice(1).some(l => l.startsWith('/'))) return null;
  return { text: lines.join(' '), lines: lines.length };
}
