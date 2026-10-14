/**
 * Getting started: EVERY line the setup guide shows lives in this file, so the owner can review the whole
 * first impression in one place (FIRST_RUN_JOURNEY.md, "Copy review"). House voice: no em dashes, no
 * double hyphens in prose, `Quox` mixed case, nothing claimed that the code does not do.
 *
 * Functions take the facts they print (a URL, a size, a provider name); nothing here computes anything.
 */

export const LABEL = 'Getting started';
export const LABEL_SUB = 'setup guide · no AI yet, every line here is scripted';

// The Q says HELLO itself, decoded in beside the mark right after the intro (qmotion.js HelloIntro); the
// guide then carries on with GREETING_REST. GREETING is the whole sentence, for anywhere that shows it at once.
export const HELLO = "Hi, I'm Quox.";
export const GREETING_REST = 'I run AI agents for you on your own machine, and I keep receipts you can check for what they do.';
export const GREETING = `${HELLO} ${GREETING_REST}`;
export const QUESTION = 'What would you like help with?';
export const EXAMPLES = ['watch my servers', 'automate something', 'code with agents', 'sort my email', 'just look around'];
export const INPUT_PLACEHOLDER = 'Type anything, or a number from the list';

/** One tailored line per intent: what Quox will do for that. */
export const INTENT_LINES = {
  servers: 'Quox can keep an eye on your servers, tell you what changed, and ask you before it touches anything.',
  automate: 'Quox can run that as a workflow on a schedule, with an approval step wherever you want one.',
  code: 'Quox can run coding agents on your repos, and every change they make leaves a receipt you can check.',
  email: 'Quox can sort your inbox and draft replies. Nothing is sent without your say so.',
  explore: 'Good plan. Once your Quox is running I will show you around, with real agents and real receipts.'
};

/** Off-script: an honest deferral, shown instantly (no model is running yet). */
export const DEFERRAL = 'I can answer that properly once your Quox is running.';

// The install time is NOT promised as a number until it has been measured on a clean machine (C2 exit).
export const OFFER = "To do that I need a QuoxCORE, the engine your agents run in. It runs here in Docker, it's free for your own use, and the first install builds from source, so it takes a while.";
export const OFFER_ASK = 'Set it up now? (Y/n)';
export const ALREADY = 'Already have one? /connect server <url>';
export const DECLINED = 'No problem. Run quox any time and we will pick up here.';
export const DECLINED_HINT = 'Type yes to set up now, /connect server <url> to use one you have, or /exit.';

export const RESUME = 'Picking up where we left off.';
export const resumeRequest = (text) => `You asked: "${text}"`;

// ---- /connect server ---------------------------------------------------------------------------
export const CONNECT_USAGE = 'Usage: /connect server <url>   for example /connect server https://quox.example.com';
export const connectBadUrl = (u) => `That does not look like a server address: ${u}. Use the full URL, starting with https://`;
export const connectHandoff = (url) => `Connecting to ${url}. Sign in with your QuoxCORE email and password.`;
export const CONNECT_DONE = 'Signed in. Starting Quox.';
export const connectFailed = (url) => `Sign-in to ${url} did not complete. Check the address, then try /connect server again.`;
export const CONNECT_INTENT_LINE = 'Great. Point me at it with /connect server <url> and sign in, and we go straight to your agents.';

// ---- preflight ---------------------------------------------------------------------------------
export const PREFLIGHT_TITLE = 'Checking this machine';
export const PREFLIGHT_RETRY = 'r to check again · q to stop';
export const PREFLIGHT_RETRY_DRY = 'r to check again · c to continue anyway (dry run) · q to stop';
export const PREFLIGHT_CONTINUED = 'Continuing anyway: dry run, so nothing will be installed on this machine.';
export const PREFLIGHT_OK = 'This machine is ready.';
export const PREFLIGHT_FAIL = 'Fix the items above, then press r to check again.';
export const SETUP_DOCS = 'https://quox.ai/docs/setup';

export const CHECK = {
  docker: {
    name: 'DOCKER',
    ok: (v) => `Docker ${v}, daemon reachable`,
    missing: 'Docker is not installed',
    missingFix: 'Install Docker, then press r.',
    missingLink: 'https://docs.docker.com/get-docker/',
    perm: 'Docker is installed, but this user cannot reach the daemon',
    permFix: 'Run: sudo usermod -aG docker $USER && newgrp docker   then press r.',
    down: 'Docker is installed, but the daemon is not running',
    downFix: 'Start Docker (Docker Desktop, or: sudo systemctl start docker), then press r.',
    link: 'https://docs.docker.com/engine/install/'
  },
  compose: {
    name: 'COMPOSE',
    ok: (v) => `Compose v${String(v).replace(/^v/, '')}`,
    missing: 'Docker Compose v2 was not found',
    missingFix: 'Install the Compose plugin (it ships with Docker Desktop), then press r.',
    old: (v) => `Compose ${v} is too old, v2 is needed`,
    link: 'https://docs.docker.com/compose/install/'
  },
  tools: {
    name: 'TOOLS',
    ok: 'git and openssl found',
    missing: (list) => `Not found: ${list.join(', ')}`,
    fix: (list) => `Install ${list.join(' and ')} with your package manager, then press r.`,
    link: 'https://quox.ai/docs/setup'
  },
  disk: {
    name: 'DISK',
    ok: (gb) => `${gb} GB free`,
    low: (gb, rec) => `${gb} GB free, ${rec} GB recommended (it may run out while building)`,
    fail: (gb, min) => `${gb} GB free, at least ${min} GB needed`,
    fix: (min) => `Free up space until at least ${min} GB is available, then press r.`,
    link: 'https://quox.ai/docs/setup'
  },
  ram: {
    name: 'MEMORY',
    ok: (gb) => `${gb} GB of RAM`,
    low: (gb, rec) => `${gb} GB of RAM, ${rec} GB recommended (it will run, slowly)`,
    fail: (gb, min) => `${gb} GB of RAM, at least ${min} GB needed`,
    fix: (min) => `Quox needs a machine with at least ${min} GB of RAM.`,
    link: 'https://quox.ai/docs/setup'
  },
  ports: {
    name: 'PORTS',
    ok: (n) => `${n} ports free`,
    busy: (list) => `In use: ${list.length > 5 ? `${list.slice(0, 4).join(', ')} and ${list.length - 4} more` : list.join(', ')}`,
    ownInstall: 'In use by the Quox being installed here',
    quoxFix: 'Quox looks like it is already running here. Use it with /connect server https://localhost:3000, or stop it first.',
    fix: (p) => `Stop whatever is using port ${p} (see: ss -ltnp 'sport = :${p}'), then press r.`,
    link: 'https://quox.ai/docs/setup'
  },
  running: 'checking'
};

// ---- credential --------------------------------------------------------------------------------
export const CRED_TITLE = 'Which AI should your agents use?';
export const CRED_HINT = '↑↓ to choose · Enter to pick';
export const CRED_OPTIONS = {
  chatgpt: { label: 'Sign in with ChatGPT', note: 'coming soon' },
  openai: { label: 'OpenAI API key', note: '' },
  anthropic: { label: 'Claude API key', note: '' },
  ollama: { label: 'Ollama on this machine', note: 'found at localhost:11434' },
  // B3: offered even when nothing answers locally; the user enters the LAN URL of the machine running it.
  ollamaLan: { label: 'Ollama on another machine', note: 'enter its URL' },
  skip: { label: 'Skip for now', note: 'agents will be limited' }
};
export const credPrompt = (label) => `Paste your ${label}. It stays in memory only: never written to disk, history or the transcript.`;
export const CRED_INPUT_HINT = 'Enter to use it · Esc to go back';
export const credHeld = (label, fp) => `${label} held in memory (fingerprint ${fp}). It is stored in your Quox vault after install, never on disk here.`;
export const credConsent = (label) => `${label} is a cloud AI: your messages and tool results are sent to it, so Quox needs your OK once. After install, /consent grant openai records it (or Settings > Privacy in the dashboard). A local model (Ollama) needs no consent.`;
export const CRED_EMPTY = 'Nothing was pasted. Paste the key, or Esc to choose again.';
export const CRED_OLLAMA = 'Ollama it is. The Quox server runs in Docker and cannot reach "localhost", so after install connect it by this machine\'s LAN address: start Ollama with OLLAMA_HOST=0.0.0.0, then /connect ollama http://<lan-ip>:11434';
export const OLLAMA_URL_PROMPT = 'The Ollama URL on your network, for example http://<lan-ip>:11434. Not a secret. On that machine, start Ollama with OLLAMA_HOST=0.0.0.0 and allow port 11434.';
export const OLLAMA_URL_HINT = 'Enter to use it · Esc to go back';
export const OLLAMA_URL_BAD = 'That does not look like an Ollama URL. Use http://<host>:11434, or Esc to choose again.';
export const ollamaChosen = (url) => `Ollama it is, at ${url}. After install, run /connect ollama ${url} so the server checks it and lists its models.`;
export const CRED_SKIPPED = 'Skipped. Until you add an AI your agents are limited: they cannot think or answer for themselves. Add one later with /connect.';
export const CRED_CHATGPT_SOON = 'Sign in with ChatGPT is coming soon. Pick another option for now.';

// ---- install -----------------------------------------------------------------------------------
export const INSTALL_TITLE = 'Installing Quox';
export const INSTALL_DRY = 'dry run: nothing is downloaded, built or started';
export const INSTALL_HINT = 'v to show the log · Ctrl+C to stop (you can pick it up again)';
export const STAGES = {
  fetch: 'Fetch the source',
  configure: 'Configure secrets and certificates',
  build: 'Build the images',
  start: 'Start the services',
  health: 'Wait until healthy'
};
/** Z2H-IMAGES: the build stage relabels itself once setup.sh says whether it is downloading or building. */
export const BUILD_LABELS = { download: 'Download the images', build: 'Build the images' };
export const INSTALL_RERUN_HINT = 'It is safe to run the installer again: finished steps are kept and the build is cached.';
export const INSTALL_LOG_PATH = (p) => `Full install log: ${p}`;
export const INSTALL_FAILED = (stage) => `The install stopped at: ${stage}. Press v for the log, r to try again.`;
export const INSTALL_NOT_YET = 'Installing from here arrives in the next release. For now, run this in another terminal:';
export const INSTALL_COMMAND = 'curl -fsSL https://get.quox.ai | sh';
export const INSTALL_NOT_YET_AFTER = 'Then run quox again and type /connect server https://localhost:3000';
export const INSTALL_KEY_GONE = 'Your key was not kept: it only ever lived in memory. You will add it again after install.';
export const installWhere = (dir) => `Installing into ${dir}`;
export const installScriptLead = (url, bytes) => `Installer ${url} (${Math.max(1, Math.round(bytes / 1024))} KB), SHA256`;
export const installScript = (url, sha, bytes) => `${installScriptLead(url, bytes)} ${sha}`;
export const INSTALL_STOP_ASK = 'Stop the install? You can pick it up next time. (y/N)';
export const INSTALL_STOP_KEEP = 'Carrying on.';
export const INSTALL_STOPPED = 'Install stopped. Run quox to pick up where you left off.';
export const INSTALL_EARLIER = 'done earlier';
export const INSTALL_HEALTH_ONLY = 'Your Quox was already started last time, so this only checks that it is healthy.';
export const INSTALL_DEGRADED = 'Some services are still starting. Press r to check again in a minute, or v for the log.';
export const INSTALL_FAIL_HINT = 'v log · r try again · Ctrl+C stop';

// ---- owner account (C2c) -----------------------------------------------------------------------
export const OWNER_TITLE = 'Your owner account';
export const OWNER_WHY = 'This account owns your Quox. You sign in to the dashboard with it.';
export const OWNER_EMAIL_PLACEHOLDER = 'your email address';
export const OWNER_EMAIL_BAD = 'That does not look like an email address.';
export const OWNER_PW_PROMPT = 'Choose a password: 12 or more characters with upper and lower case, a number and a symbol. Or press Enter on an empty line and I will make a strong one.';
export const OWNER_PW_HINT = 'Enter to use it · Enter on empty to generate one · Esc to change the email';
export const ownerPwShownOnce = (pw) => `Your password, shown once: ${pw}`;
export const OWNER_PW_SAVE = 'Save it in your password manager now. Quox keeps only a sign-in token on this machine, never the password.';
export const OWNER_EXISTS = 'This Quox already has an owner. Enter that account\'s email and password to sign in.';

// ---- finishing ---------------------------------------------------------------------------------
export const FINISH_TITLE = 'Finishing';
export const FIN = {
  account: { name: 'ACCOUNT', running: 'creating your owner account', ok: (e) => `owner ${e}`, existing: (e) => `existing owner ${e}` },
  signin: { name: 'SIGN-IN', running: 'signing you in', ok: (org) => `signed in${org ? ` to ${org}` : ''}, token saved` },
  vault: {
    name: 'AI KEY', running: (label) => `testing your ${label}, then storing it in your vault`,
    skipped: 'no key to store', ollama: 'Ollama: add it to your vault with quox vault create --type ollama'
  },
  link: { name: 'DASHBOARD', running: 'making your one-time sign-in link', ok: 'one-time link ready (10 minutes, single use)', fail: (e) => `no link (${e}), sign in with your owner account instead` }
};
export const KEY_GONE_AFTER = 'The key is gone from this terminal\'s memory now.';
export const keyNotStored = (provider) => `Add it again any time with /connect ${provider}.`;

// ---- finale ------------------------------------------------------------------------------------
export const FINALE_DRY_BANNER = 'Dry run: this is the planned finish. Nothing was installed.';
export const FINALE_RUNNING = 'Your Quox is running.';
export const REPLAY_TOUR = 'Give me a short tour of what you can do here.';
export const finaleReplay = (text) => text ? `Your first real turn sends what you asked: "${text}"` : 'Your first real turn: a short tour of what your agents can do.';
export const FINALE_REPLAY_DRY = '(the reply and its receipt appear here once the install is real)';
export const finaleDashboard = (url) => `Your dashboard is ready: ${url} (one-time sign-in link)`;
export const finaleDashboardPlain = (url) => `Your dashboard is ready: ${url} (sign in with your owner account)`;
// When the line does not fit the terminal, the URL goes on its own unwrapped line so it stays clickable.
export const FINALE_DASHBOARD_LEAD = 'Your dashboard is ready (one-time sign-in link, 10 minutes):';
export const FINALE_DASHBOARD_LEAD_PLAIN = 'Your dashboard is ready (sign in with your owner account):';
export const FINALE_CERT = 'Your browser will warn about the certificate the first time: it is the self-signed one this install made for you.';
export const FINALE_PROOF = 'Everything you just did is there, with the proof.';
export const FINALE_TIPS_TITLE = 'Three things to try:';
export const TIPS = {
  servers: ['/observers shows what Quox can see right now, and what it cannot', '/connect shows what is connected and adds AI keys safely', 'Just run quox any time; your conversations are kept on your server'],
  automate: ['/skills lists what your agents already know how to do', '/approvals shows anything waiting for your yes', 'Just run quox any time; your conversations are kept on your server'],
  code: ['/attach <agent> sends your turns to one agent, /detach comes back', '/connect shows what is connected and adds AI keys safely', 'Just run quox any time; your conversations are kept on your server'],
  email: ['/approvals shows anything waiting for your yes; nothing is sent without it', '/connect shows what is connected and adds AI keys safely', 'Just run quox any time; your conversations are kept on your server'],
  explore: ['/help lists every command', '/attach <agent> sends your turns to one agent, /detach comes back', 'Just run quox any time; your conversations are kept on your server']
};
TIPS.offscript = TIPS.explore;
export const FINALE_TIPS = TIPS.explore; // the dry run and any intent without its own set
// K2: one gentle, honest next connection that fits what they said they wanted.
export const K2 = {
  servers: 'You said you want to watch your servers. None are connected yet. Add your first with /hosts add (it needs no AI), or on the dashboard Fleet page.',
  automate: 'You said you want to automate something. Already use n8n? Bring a workflow across with: quox workflow import-n8n --file <path>',
  code: 'You said you want to code with agents. Connect GitHub so they can see your repos: quox vault create --type github',
  email: 'You said you want help with email. Connect your mailbox: quox mail connect --provider gmail (or outlook, icloud)',
  explore: 'Want your agents to do more? /connect shows what is connected and what you can add.'
};
K2.offscript = K2.explore;
export const k2NoAi = (provider) => `Your agents have no AI yet, so they cannot answer for themselves. Connect one now? /connect ${provider}`;
export const FINALE_EXIT = 'Enter to start talking to your Quox';
export const FINALE_EXIT_DRY = 'Enter to finish';

// ---- help, misc --------------------------------------------------------------------------------
export const HELP = [
  ['/connect server <url>', 'use a QuoxCORE you already have'],
  ['/exit', 'leave; next time we pick up here']
];
export const SLASH_UNKNOWN = 'Only /connect server, /help and /exit work until your Quox is running.';
export const BYE = 'See you soon. Run quox to pick up where you left off.';
export const NO_SERVER_PRINT = 'Run quox (without --print) to get started.';
export const FINALE_HOSTS_NO_AI = 'No AI needed to add a host: /hosts add shows the one command to run on that machine.';
