/**
 * Shared constants + formatters between InboxQView and InboxQMessageReader
 * (kept out of both component files so neither has to import the other —
 * avoids a circular import between the view and its reader).
 */

// One accent colour per zone, used consistently for the folder dot, the
// overview tiles, the distribution bar and the reader's zone badge — the
// thread that makes "which zone is this" readable at a glance everywhere.
//
// `description` ("what lands here") and `howItWorks` ("how mail gets here")
// are the verbatim zone-card copy from the layout audit (section D): zones
// are InboxQ classifications, never mail-server folders, so this copy never
// claims a completed outcome ("Handled automatically") the way the old
// `hint` strings used to. `hint` now mirrors `description` and is the only
// text used for the nav tooltip and zone dot title.
export const ZONES = [
  {
    key: 'focus',
    label: 'Focus',
    color: '#38bdf8',
    description: 'Personal and business mail to check first.',
    howItWorks: 'InboxQ uses sender choices and rules to put mail here, including human-looking mail with no stronger match, with optional AI helping resolve uncertain Focus/FYI cases.',
    get hint() { return this.description; },
  },
  {
    key: 'fyi',
    label: 'FYI',
    color: '#a855f7',
    description: 'Newsletters, digests and lower-priority updates.',
    howItWorks: 'InboxQ uses newsletter, unsubscribe and update signals or learned sender choices to place mail here, with optional AI helping resolve uncertain Focus/FYI cases.',
    get hint() { return this.description; },
  },
  {
    key: 'auto',
    label: 'Auto',
    color: '#30ff90',
    description: 'Automated mail such as receipts, notifications and alerts.',
    howItWorks: 'InboxQ places mail here when automated-sender rules or learned sender choices match; this does not mean any work has been completed.',
    get hint() { return this.description; },
  },
  {
    key: 'screened',
    label: 'Screened',
    color: 'rgba(255,255,255,0.5)',
    description: 'Suspected junk, cold outreach and mail from blocked senders.',
    howItWorks: 'InboxQ places mail here when junk-folder signals, spam or cold-outreach rules, or your blocking and sender choices match.',
    get hint() { return this.description; },
  },
];

// Shared footer line for the zones/folders explanation (audit D): zones are
// suggestions the owner can correct, never a verdict.
export const ZONES_FOOTER_NOTE = 'Zones are suggestions. You can change a zone to correct InboxQ, and sender corrections help guide future classification.';

// First-run disclosure copy (audit D), reused by the nav's "Explain zones
// and folders" control and the Overview's own disclosure.
export const ZONES_VS_FOLDERS_TITLE = 'Zones and folders: what\'s the difference?';
export const ZONES_VS_FOLDERS_INTRO = 'InboxQ is your inbox management control panel. It syncs the IMAP folders you choose and automatically groups stored mail into four zones.';
export const ZONES_EXPLAINER = 'Focus, FYI, Auto and Screened are InboxQ classifications, not folders on your mail server. Rules and your sender choices assign the zones; optional AI helps with uncertain cases within your message budget.';
export const FOLDERS_EXPLAINER = 'INBOX and your custom folders are real IMAP locations. You choose which folders InboxQ syncs. Filing proposes a move to a real folder and runs after you approve.';
export const ZONES_VS_FOLDERS_EXAMPLE = 'The same message can have Folder: INBOX and Zone: Focus. Changing its zone to FYI leaves it in INBOX.';

// Zone colour overrides for BUTTONS (move/tint actions), distinct from the
// ZONES dot/badge colour above: Screened's rgba(255,255,255,0.5) reads fine
// as a quiet dot but is too weak for a control label, so buttons use a
// visible slate instead (InboxQ UX Pass 3, section D).
export const ZONE_BTN_TINT = {
  focus: '#38bdf8',
  fyi: '#a855f7',
  auto: '#30ff90',
  screened: '#94a3b8',
};

// Readable flag labels (>=12px text, not bare emoji) plus a colour so a row
// or the reader header carries real signal at a glance: amber for a
// deadline/review concern, cyan for an action ask.
export const FLAG_META = {
  needs_action: { glyph: '✎', label: 'Action needed', title: 'This message asks for a reply or action from you.', color: '#38bdf8' },
  has_deadline: { glyph: '⏰', label: 'Deadline', title: 'Mentions a date or deadline worth checking.', color: '#f59e0b' },
  review: { glyph: '\u{1F50E}', label: 'Worth a look', title: 'Lower priority, but carries an action signal worth a second look.', color: '#a855f7' },
};

// Phishing-signal badge metadata for message.phishingRisk (0 none, 1 soft
// authentication weakness, 2 strong signal: failed authentication, a spoofed
// display name, or a lookalike/punycode domain). Risk 0 has no entry here —
// every consumer skips the badge entirely rather than rendering a "0" state.
export const PHISH_META = {
  1: {
    glyph: '⚠',
    label: 'Possible phishing',
    tone: 'warn',
    title: 'Possible phishing: authentication weak (DMARC set to none or a softfail).',
  },
  2: {
    glyph: '⚠',
    label: 'Likely phishing',
    tone: 'danger',
    title: 'Likely phishing: failed authentication, a spoofed sender name, or a lookalike domain.',
  },
};

/** Tone for one SPF/DKIM/DMARC result, mapped onto the shared qx-pill
 * palette: pass is green, softfail is amber, fail is red, and none/unknown
 * stay neutral grey rather than implying a check that was never run. */
export function authResultTone(result) {
  if (result === 'pass') return 'success';
  if (result === 'softfail') return 'warn';
  if (result === 'fail') return 'danger';
  return 'ghost';
}

/** Short form for list rows: "14:32 today" for same-day, else "24 Sep 14:32". */
export function formatWhen(dateTs) {
  if (!dateTs) return '';
  const d = new Date(dateTs);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `${time} today`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

/** Full localized date, time AND zone for the reader header — the owner's
 * "so hard to read" complaint was about body text, but date/time/zone need
 * to be unambiguous too, so this always includes a short zone name. */
export function formatFullWhen(dateTs) {
  if (!dateTs) return '';
  const d = new Date(dateTs);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}

/** Attachment size, human scale: bytes under 1 KB, otherwise KB or MB with at
 * most one decimal place ("240 KB", "1.2 MB"). Returns '' for a missing or
 * invalid size rather than guessing. */
export function formatBytes(n) {
  if (typeof n !== 'number' || Number.isNaN(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${Number.isInteger(kb) ? kb : kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}
