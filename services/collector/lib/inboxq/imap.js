'use strict';

/**
 * InboxQ IMAP fetch — the sync-side read path.
 *
 * Deliberately SEPARATE from toolExecutors/email.js's readMailbox (which backs
 * the email_read agent tool and is heavily tested). Sync needs UID-cursor
 * semantics readMailbox does not: honour UIDVALIDITY, fetch only messages with
 * UID greater than the stored cursor, and report the mailbox's uidValidity +
 * the highest UID seen so the worker can advance its cursor durably.
 *
 * Testing seam mirrors email.js exactly: ImapFlow + simpleParser are passed in
 * as call arguments so vitest can inject fakes without relying on module-cache
 * identity across the repo's CJS/ESM hybrid.
 *
 * SECURITY: handed a plaintext password solely to open the connection. Never
 * logs it, never includes it in a thrown error, never returns it.
 */

const RealImapFlow = require('imapflow').ImapFlow;
const realSimpleParser = require('mailparser').simpleParser;

function parseAddress(envFrom) {
  const f = envFrom && envFrom[0];
  if (!f) return { fromAddr: '', fromName: '' };
  return { fromAddr: f.address || '', fromName: f.name || '' };
}

// codex F06: never parse an unbounded blob. Attachments are materialised by
// simpleParser before we take a 2KB snippet, so a large multipart message can
// exhaust collector memory. Skip the parse above this size and keep the header
// row (empty snippet) rather than blowing up the process.
const MAX_PARSE_BYTES = 256 * 1024;

// P1b: the full (parsed) body is bounded independently of the snippet, so a
// large-but-parseable message can still store a usable body without growing
// the store unbounded. Truncation is byte-based (UTF-8) with a trailing
// marker so a truncated body is never mistaken for a complete one.
const MAX_BODY_BYTES = 512 * 1024;

function boundBody(str) {
  if (!str) return null;
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= MAX_BODY_BYTES) return str;
  const truncated = buf.slice(0, MAX_BODY_BYTES).toString('utf8');
  return `${truncated}\n\n[... truncated, exceeded ${MAX_BODY_BYTES} bytes ...]`;
}

// codex F01: strip HTML tags in LINEAR time. The old /<[^>]+>/g on a body of
// many '<' with no '>' backtracks quadratically (measured 2.2s on a 32KB
// attacker email, blocking the shared event loop). A single-pass scan over a
// bounded input can never do that.
function linearStripHtml(html, maxIn = 20000) {
  const s = String(html || '').slice(0, maxIn);
  let out = '';
  let inTag = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<') inTag = true;
    else if (c === '>') inTag = false;
    else if (!inTag) out += c;
  }
  return out;
}

// Owner ask: "are we handling attachments... at least need to see they are
// there". Metadata only — filename/contentType/size — NEVER the bytes.
// Bounded at MAX_ATTACHMENTS so a message with a pathological number of parts
// cannot bloat the response/store row.
const MAX_ATTACHMENTS = 20;

/**
 * Extract lightweight attachment metadata from simpleParser's parsed object.
 * Inline/cid parts with no filename (typically embedded signature/logo
 * images referenced from the HTML body, not something a user would think of
 * as "an attachment") are skipped so the list stays meaningful; a real
 * attachment that happens to carry contentDisposition:'inline' but DOES have
 * a filename is still kept.
 */
function extractAttachmentMeta(parsed) {
  const list = Array.isArray(parsed?.attachments) ? parsed.attachments : [];
  const out = [];
  for (const a of list) {
    if (out.length >= MAX_ATTACHMENTS) break;
    const filename = (a && a.filename) ? String(a.filename) : null;
    const isInlineNoName = !filename && (a?.contentDisposition === 'inline' || a?.related);
    if (isInlineNoName) continue;
    const size = typeof a?.size === 'number' ? a.size : (a?.content ? a.content.length : 0);
    out.push({
      filename: filename || 'attachment',
      contentType: (a && a.contentType) || 'application/octet-stream',
      size,
    });
  }
  return out;
}

/**
 * Cheap phishing-help ask (owner): SURFACE signals only, this pass never
 * changes classification/auto-screen — a false SPF/DKIM/DMARC read on
 * legitimate mail must never silently screen it. `security` is additive data
 * on the message; `phishingRisk` is a cheap 0/1/2 tier for a row badge.
 *
 * DEFAULT_SECURITY is the defensive fallback for every early-return path
 * below (no source, oversized, unparseable) — a message with no evidence
 * reads as 'none' per mechanism (SPF/DKIM/DMARC absent), never 'fail'.
 */
const DEFAULT_SECURITY = Object.freeze({
  spf: 'none', dkim: 'none', dmarc: 'none', displayNameSpoof: false, punycode: false,
});

/** Normalise a raw spf=/dkim=/dmarc= (or bare Received-SPF) token into one of
 * 'pass'|'fail'|'softfail'|'none'|'unknown'. Defensive: anything not one of
 * the recognised RFC 7001/7208 result words (neutral, temperror, permerror,
 * policy, ...) reads as 'unknown' rather than being mis-mapped to fail/pass. */
function normalizeAuthResult(token) {
  const t = (token || '').toString().trim().toLowerCase();
  if (!t) return 'unknown';
  if (t === 'pass') return 'pass';
  if (t === 'softfail') return 'softfail';
  if (t === 'fail') return 'fail';
  if (t === 'none') return 'none';
  return 'unknown';
}

/** Extract a raw header value from mailparser's parsed.headers Map, defensive
 * against the header being absent or shaped as a string/object/array. */
function getRawHeader(parsed, name) {
  const headers = parsed?.headers;
  if (!headers || typeof headers.get !== 'function') return null;
  const v = headers.get(name);
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(String).join(' ');
  if (typeof v === 'object' && v.value != null) return String(v.value);
  return String(v);
}

/** Parse spf=/dkim=/dmarc= tokens out of an Authentication-Results header
 * value. A header commonly stacks multiple results from multiple hops
 * (Gmail/Outlook chains); the FIRST occurrence of each mechanism is used,
 * matching the outermost (most recent, most trusted) hop's verdict. */
function parseAuthenticationResults(headerVal) {
  const out = { spf: 'none', dkim: 'none', dmarc: 'none' };
  if (!headerVal) return out;
  const str = String(headerVal);
  for (const key of ['spf', 'dkim', 'dmarc']) {
    const m = str.match(new RegExp(`\\b${key}=([a-z-]+)`, 'i'));
    if (m) out[key] = normalizeAuthResult(m[1]);
  }
  return out;
}

/** Parse a standalone Received-SPF header (some servers/relays write this
 * instead of, or alongside, Authentication-Results' spf= token). */
function parseReceivedSpf(headerVal) {
  if (!headerVal) return 'unknown';
  const first = String(headerVal).trim().split(/\s+/)[0];
  return normalizeAuthResult(first);
}

/**
 * displayNameSpoof: the classic "PayPal Support <x@random.ru>" pattern — a
 * From display name that names an email address or bare domain differing
 * from the ACTUAL From address's domain. Conservative on purpose: only a
 * name containing something that looks like a domain is checked, and it must
 * differ from the real domain — a name that merely mentions a brand word
 * with no domain-shaped token (e.g. "PayPal Support") is never flagged, to
 * keep false positives on legitimate mail low.
 */
function detectDisplayNameSpoof(fromName, actualDomain) {
  if (!fromName || !actualDomain) return false;
  const name = String(fromName);
  const emailMatch = name.match(/[\w.+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i);
  if (emailMatch) return emailMatch[1].toLowerCase() !== actualDomain;
  const domainMatch = name.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,})\b/i);
  if (domainMatch) return domainMatch[1].toLowerCase() !== actualDomain;
  return false;
}

/** punycode: any label of the From address's domain is an IDN-encoded
 * (xn--) label — a classic homograph-attack shape (e.g. "xn--pypal-4ve.com"
 * rendering as a lookalike of paypal.com). */
function detectPunycode(actualDomain) {
  if (!actualDomain) return false;
  return actualDomain.split('.').some((label) => label.startsWith('xn--'));
}

/** Cheap 0/1/2 phishing-risk tier for a row badge. Deliberately narrow so it
 * cannot itself drive classification/auto-screen: 2 = a strong, hard-to-fake
 * signal (DMARC fail, punycode domain, or a spoofed display name); 1 = a
 * soft signal (no/unenforced DMARC policy — common on plenty of legitimate
 * small-business mail, so it stays advisory only); 0 = no signal. */
function computePhishingRisk(security) {
  if (!security) return 0;
  if (security.dmarc === 'fail' || security.punycode || security.displayNameSpoof) return 2;
  if (security.dmarc === 'none' || security.dmarc === 'softfail') return 1;
  return 0;
}

/** Build the `security` object for one parsed message. Never throws — every
 * lookup is defensive against an absent header or malformed From address. */
function computeSecurity(parsed) {
  const authResults = parseAuthenticationResults(getRawHeader(parsed, 'authentication-results'));
  let spf = authResults.spf;
  if (spf === 'none') {
    const receivedSpf = getRawHeader(parsed, 'received-spf');
    if (receivedSpf) spf = parseReceivedSpf(receivedSpf);
  }

  const fromValue = parsed?.from?.value?.[0] || {};
  const fromAddr = (fromValue.address || '').toString().toLowerCase();
  const fromName = fromValue.name || '';
  const actualDomain = fromAddr.includes('@') ? fromAddr.split('@')[1] : '';

  return {
    spf,
    dkim: authResults.dkim,
    dmarc: authResults.dmarc,
    displayNameSpoof: detectDisplayNameSpoof(fromName, actualDomain),
    punycode: detectPunycode(actualDomain),
  };
}

/**
 * §1a (INBOXQ_CLASSIFIER_IMPROVEMENTS.md): the List-Unsubscribe header is the
 * old classifier's single most reliable legitimate-bulk-mail signal, and the
 * new sync path never read it. `source: true` already fetches the full raw
 * MIME message, so the header is already present in what simpleParser sees —
 * this extracts it from the SAME parse pass that builds the snippet, rather
 * than paying for a second parse.
 */
async function parseMessageSource(source, simpleParser) {
  const empty = { snippet: '', hasListUnsub: false, bodyHtml: null, bodyText: null, attachments: [], security: DEFAULT_SECURITY, phishingRisk: 0 };
  if (!source) return empty;
  if (source.length > MAX_PARSE_BYTES) return empty; // F06: bounded — do not parse
  try {
    const parsed = await simpleParser(source);
    const raw = parsed?.text || (parsed?.html ? linearStripHtml(parsed.html) : '') || '';
    const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 2000);
    const hasListUnsub = Boolean(parsed?.headers && typeof parsed.headers.has === 'function' && parsed.headers.has('list-unsubscribe'));
    // P1b: the full body, bounded to MAX_BODY_BYTES (never unbounded).
    const bodyHtml = boundBody(parsed?.html || null);
    const bodyText = boundBody(parsed?.text || null);
    // Attachment METADATA only (filename/contentType/size) — never the bytes.
    const attachments = extractAttachmentMeta(parsed);
    // Phishing-help signals (owner ask): surfaced as DATA only — see the
    // doc comments on computeSecurity/computePhishingRisk above.
    const security = computeSecurity(parsed);
    const phishingRisk = computePhishingRisk(security);
    return { snippet, hasListUnsub, bodyHtml, bodyText, attachments, security, phishingRisk };
  } catch {
    return empty;
  }
}

/**
 * @param {object} opts
 * @param {string}  opts.host
 * @param {number}  [opts.port=993]
 * @param {string}  opts.user
 * @param {string}  opts.pass                 plaintext (never logged/returned)
 * @param {string}  [opts.folder='INBOX']
 * @param {number}  [opts.sinceUid=0]         fetch UIDs strictly greater than this
 * @param {string}  [opts.expectedUidvalidity] cursor's stored uidvalidity; a
 *                    mismatch forces a full (capped) resync from the start
 * @param {number}  [opts.limit=200]          max messages to return this pass
 * @param {Function}[opts.ImapFlow]
 * @param {Function}[opts.simpleParser]
 * @returns {Promise<{uidvalidity:string, highestUid:number, reset:boolean, messages:object[]}>}
 */
async function fetchSince({
  host, port, user, pass, folder = 'INBOX', sinceUid = 0,
  expectedUidvalidity = null, limit = 200,
  ImapFlow = RealImapFlow, simpleParser = realSimpleParser,
}) {
  const client = new ImapFlow({
    host,
    port: Number(port) || 993,
    secure: true,
    auth: { user, pass },
    logger: false,
    socketTimeout: 20000,
  });

  // codex F02: ImapFlow is an EventEmitter that can emit 'error' AFTER connect
  // (a stalled or severed socket mid-SEARCH/FETCH). With no listener Node
  // rethrows it as an uncaughtException and the collector's handler exits the
  // whole process. Attaching a listener prevents the crash; racing the
  // operation against it rejects promptly into the worker's failure path
  // instead of hanging to socketTimeout.
  let onError;
  const errorPromise = new Promise((_resolve, reject) => {
    onError = () => reject(new Error('imap_connection_error'));
  });
  client.on('error', onError);

  let lock = null;
  const operation = (async () => {
    await client.connect();
    lock = await client.getMailboxLock(folder);

    const uidvalidity = String(client.mailbox?.uidValidity ?? '');
    // UIDVALIDITY changed under us (mailbox recreated) => the old cursor is
    // meaningless; resync from the beginning (capped by limit). The worker is
    // responsible for clearing old-generation rows (see syncWorker F03).
    const reset = Boolean(expectedUidvalidity) && expectedUidvalidity !== uidvalidity;
    const effectiveSince = reset ? 0 : (Number(sinceUid) || 0);

    // UID search for everything strictly greater than the cursor. imapflow's
    // range "N+1:*" selects UIDs from N+1 upward. codex F08: a SEARCH error is
    // NOT swallowed into an empty result — that would masquerade as a
    // successful empty poll and clear the failure streak forever. Let it throw.
    const lower = effectiveSince + 1;
    let uids = await client.search({ uid: `${lower}:*` }, { uid: true }) || [];
    // Defensive: some servers echo the boundary UID; keep only strictly-greater.
    uids = uids.filter((u) => Number(u) > effectiveSince).sort((a, b) => a - b);
    // A COLD START (no cursor yet, effectiveSince === 0) must fetch the NEWEST
    // window, not the oldest. A large mailbox's lowest UIDs are its oldest mail
    // (2012-era on a decades-old inbox), so slicing the FIRST `limit` seeded a
    // fresh account with ancient mail and never reached recent messages within
    // the cap — exactly wrong for triage, which wants the most recent at the top.
    // Once a cursor IS set, every remaining UID is genuinely new, so take them
    // oldest-first to advance the cursor without skipping any.
    const targetUids = effectiveSince === 0
      ? uids.slice(-Math.max(1, limit))
      : uids.slice(0, Math.max(1, limit));

    const messages = [];
    let highestUid = effectiveSince;

    if (targetUids.length > 0) {
      // labels/emailId (Gmail X-GM-EXT-1): harmless no-op on servers that lack the
      // extension (imapflow only populates them when supported). On Gmail the sync
      // source is [Gmail]/All Mail, so `labels` carries the message's Gmail labels
      // (Inbox/Sent/custom) and `emailId` is the stable X-GM-MSGID.
      const fetchOptions = { envelope: true, source: true, uid: true, labels: true, emailId: true, flags: true };
      for await (const msg of client.fetch(targetUids.join(','), fetchOptions, { uid: true })) {
        const { snippet, hasListUnsub, bodyHtml, bodyText, attachments, security, phishingRisk } = await parseMessageSource(msg.source, simpleParser);
        const { fromAddr, fromName } = parseAddress(msg.envelope?.from);
        const dateObj = msg.envelope?.date ? new Date(msg.envelope.date) : null;
        messages.push({
          uid: Number(msg.uid),
          messageId: msg.envelope?.messageId || null,
          fromAddr,
          fromName,
          subject: msg.envelope?.subject || '',
          dateTs: dateObj && !isNaN(dateObj.getTime()) ? dateObj.getTime() : null,
          snippet,
          hasListUnsub,
          bodyHtml,
          bodyText,
          attachments,
          security,
          phishingRisk,
          labels: msg.labels ? [...msg.labels] : null,
          gmailId: msg.emailId || null,
          seen: Boolean(msg.flags && msg.flags.has('\\Seen')),
        });
        if (Number(msg.uid) > highestUid) highestUid = Number(msg.uid);
      }
    }

    return { uidvalidity, highestUid, reset, messages };
  })();

  try {
    return await Promise.race([operation, errorPromise]);
  } finally {
    client.off('error', onError);
    try { if (lock) lock.release(); } catch { /* non-fatal */ }
    try { await client.logout(); } catch { /* non-fatal */ }
  }
}

// P1c: on-demand + bulk body backfill for messages ingested before body
// capture existed (P1b). A single fetchByUids call is bounded to this many
// UIDs so a wrong/huge request can never open one IMAP fetch that drags in
// an unbounded number of messages.
const MAX_BACKFILL_UIDS = 100;

/**
 * Fetch and parse ONLY the given UIDs from one folder — the backfill-side
 * counterpart to fetchSince's cursor-driven fetch. Same connection shape,
 * error-listener guard, and mailbox-lock pattern as fetchSince, so a stalled
 * or severed socket fails the same way (rejects into the caller's failure
 * path instead of crashing the process or hanging to socketTimeout).
 *
 * @param {object} opts
 * @param {string}  opts.host
 * @param {number}  [opts.port=993]
 * @param {string}  opts.user
 * @param {string}  opts.pass      plaintext (never logged/returned)
 * @param {string}  [opts.folder='INBOX']
 * @param {number[]}opts.uids      UIDs to fetch (capped at MAX_BACKFILL_UIDS)
 * @param {Function}[opts.ImapFlow]
 * @param {Function}[opts.simpleParser]
 * @returns {Promise<Array<{uid:number, bodyHtml:?string, bodyText:?string, snippet:string, attachments:object[]}>>}
 */
async function fetchByUids({
  host, port, user, pass, folder = 'INBOX', uids = [],
  ImapFlow = RealImapFlow, simpleParser = realSimpleParser,
}) {
  const targetUids = (Array.isArray(uids) ? uids : [])
    .map((u) => Number(u))
    .filter((u) => Number.isFinite(u) && u > 0)
    .slice(0, MAX_BACKFILL_UIDS);
  if (targetUids.length === 0) return [];

  const client = new ImapFlow({
    host,
    port: Number(port) || 993,
    secure: true,
    auth: { user, pass },
    logger: false,
    socketTimeout: 20000,
  });

  // codex F02 pattern (fetchSince): guard against a post-connect 'error'
  // crashing the process; race the operation against it.
  let onError;
  const errorPromise = new Promise((_resolve, reject) => {
    onError = () => reject(new Error('imap_connection_error'));
  });
  client.on('error', onError);

  let lock = null;
  const operation = (async () => {
    await client.connect();
    lock = await client.getMailboxLock(folder);

    const results = [];
    // envelope: true (AQ-9E P1): fetchByUids now also returns the RFC
    // Message-ID of each fetched message, so a caller can verify the
    // identity of what the server actually handed back before trusting the
    // body -- a stale or misdirected uid must never be mistaken for the
    // message a stored row claims to be.
    for await (const msg of client.fetch(targetUids.join(','), { envelope: true, source: true, uid: true }, { uid: true })) {
      const { snippet, bodyHtml, bodyText, attachments, security, phishingRisk } = await parseMessageSource(msg.source, simpleParser);
      results.push({ uid: Number(msg.uid), messageId: msg.envelope?.messageId || null, bodyHtml, bodyText, snippet, attachments, security, phishingRisk });
    }
    return results;
  })();

  try {
    return await Promise.race([operation, errorPromise]);
  } finally {
    client.off('error', onError);
    try { if (lock) lock.release(); } catch { /* non-fatal */ }
    try { await client.logout(); } catch { /* non-fatal */ }
  }
}

/**
 * AQ-9E P1: re-resolve a message by its stable RFC Message-ID within a given
 * folder, for the case where an interactive move left the stored uid
 * unresolved (the server gave no COPYUID mapping). Searches HEADER
 * "Message-ID" (a substring match per RFC 3501) then fetches the matching
 * uid(s) -- the caller is still responsible for confirming the returned
 * messageId equals the one it searched for, since a HEADER search can in
 * principle over-match. Same connect/error-listener/logout guard pattern as
 * fetchByUids/fetchSince.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} [opts.port=993]
 * @param {string} opts.user
 * @param {string} opts.pass        plaintext (never logged/returned)
 * @param {string} [opts.folder='INBOX']
 * @param {string} opts.messageId   the RFC Message-ID to search for
 * @param {Function} [opts.ImapFlow]
 * @param {Function} [opts.simpleParser]
 * @returns {Promise<Array<{uid:number, messageId:?string, bodyHtml:?string, bodyText:?string, snippet:string, attachments:object[]}>>}
 */
async function fetchByMessageId({
  host, port, user, pass, folder = 'INBOX', messageId,
  ImapFlow = RealImapFlow, simpleParser = realSimpleParser,
}) {
  if (!messageId) return [];
  const client = new ImapFlow({
    host, port: Number(port) || 993, secure: true, auth: { user, pass }, logger: false, socketTimeout: 20000,
  });
  let onError;
  const errorPromise = new Promise((_resolve, reject) => { onError = () => reject(new Error('imap_connection_error')); });
  client.on('error', onError);
  let lock = null;
  const operation = (async () => {
    await client.connect();
    lock = await client.getMailboxLock(folder);
    const uids = (await client.search({ header: { 'message-id': messageId } }, { uid: true })) || [];
    if (uids.length === 0) return [];
    const results = [];
    for await (const msg of client.fetch(uids.join(','), { envelope: true, source: true, uid: true }, { uid: true })) {
      const { snippet, bodyHtml, bodyText, attachments, security, phishingRisk } = await parseMessageSource(msg.source, simpleParser);
      results.push({ uid: Number(msg.uid), messageId: msg.envelope?.messageId || null, bodyHtml, bodyText, snippet, attachments, security, phishingRisk });
    }
    return results;
  })();
  try {
    return await Promise.race([operation, errorPromise]);
  } finally {
    client.off('error', onError);
    try { if (lock) lock.release(); } catch { /* non-fatal */ }
    try { await client.logout(); } catch { /* non-fatal */ }
  }
}

/** List the folders/mailboxes available on an account (for connect/setup). */
async function listFolders({ host, port, user, pass, ImapFlow = RealImapFlow }) {
  const client = new ImapFlow({
    host, port: Number(port) || 993, secure: true, auth: { user, pass }, logger: false, socketTimeout: 20000,
  });
  // codex F02: same post-connect 'error' crash guard as fetchSince.
  let onError;
  const errorPromise = new Promise((_resolve, reject) => { onError = () => reject(new Error('imap_connection_error')); });
  client.on('error', onError);
  const operation = (async () => {
    await client.connect();
    const list = await client.list();
    return (list || []).map((m) => m.path).filter(Boolean);
  })();
  try {
    return await Promise.race([operation, errorPromise]);
  } finally {
    client.off('error', onError);
    try { await client.logout(); } catch { /* non-fatal */ }
  }
}

/**
 * P1: create a new IMAP mailbox (folder). Used when a custom InboxQ folder is
 * defined, so it is backed by a REAL server-side folder, not just a store row.
 * Same connect/error-listener/logout guard pattern as fetchSince/listFolders.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} [opts.port=993]
 * @param {string} opts.user
 * @param {string} opts.pass    plaintext (never logged/returned)
 * @param {string} opts.path    the full IMAP mailbox path to create (e.g. "INBOX.Wordfence")
 * @param {Function} [opts.ImapFlow]
 * @returns {Promise<{created:boolean, path:string}>}
 */
async function createImapFolder({ host, port, user, pass, path, ImapFlow = RealImapFlow }) {
  const client = new ImapFlow({
    host, port: Number(port) || 993, secure: true, auth: { user, pass }, logger: false, socketTimeout: 20000,
  });
  // codex F02 pattern: guard against a post-connect 'error' crashing the process.
  let onError;
  const errorPromise = new Promise((_resolve, reject) => { onError = () => reject(new Error('imap_connection_error')); });
  client.on('error', onError);
  const operation = (async () => {
    await client.connect();
    try {
      await client.mailboxCreate(path);
      return { created: true, path };
    } catch (e) {
      // Idempotent create: a mailbox that already exists on the server is a
      // success for our purposes (register it as a Quox folder), not a 502.
      // Without this, a folder the user already made (or re-made) can never be
      // registered because mailboxCreate throws ALREADYEXISTS every retry.
      const sig = `${e?.serverResponseCode || ''} ${e?.responseText || ''} ${e?.message || ''}`;
      if (/alreadyexists|already exists/i.test(sig)) return { created: false, existed: true, path };
      throw e;
    }
  })();
  try {
    return await Promise.race([operation, errorPromise]);
  } finally {
    client.off('error', onError);
    try { await client.logout(); } catch { /* non-fatal */ }
  }
}

/**
 * AQ-9E U3 (folder-first): like listFolders, but preserves the per-folder
 * DELIMITER and specialUse so the caller can build a correct hierarchy (the
 * bare-path listFolders drops the delimiter, forcing a guess). Separate export
 * so existing listFolders consumers are untouched. Returns
 * [{ path, delimiter, specialUse, subscribed }].
 */
async function listFoldersDetailed({ host, port, user, pass, ImapFlow = RealImapFlow }) {
  const client = new ImapFlow({
    host, port: Number(port) || 993, secure: true, auth: { user, pass }, logger: false, socketTimeout: 20000,
  });
  let onError;
  const errorPromise = new Promise((_resolve, reject) => { onError = () => reject(new Error('imap_connection_error')); });
  client.on('error', onError);
  const operation = (async () => {
    await client.connect();
    const list = await client.list();
    return (list || [])
      .filter((m) => m && m.path)
      .map((m) => ({
        path: m.path,
        delimiter: m.delimiter || null,
        specialUse: m.specialUse || null,
        subscribed: m.subscribed !== false,
        // flags (additive): lets folder auto-discovery skip \Noselect container
        // folders (e.g. Gmail's "[Gmail]" parent) that cannot be SELECTed/fetched.
        flags: m.flags ? [...m.flags] : [],
      }));
  })();
  try {
    return await Promise.race([operation, errorPromise]);
  } finally {
    client.off('error', onError);
    try { await client.logout(); } catch { /* non-fatal */ }
  }
}

/**
 * P1: move messages between folders using a SAFE UID MOVE only. NEVER a blind
 * copy+expunge — imapflow's messageMove() issues the server-side UID MOVE
 * (RFC 6851) where the server supports it, and only falls back to
 * copy+flag+expunge internally inside imapflow itself when the server lacks
 * MOVE; that fallback is never re-implemented here.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} [opts.port=993]
 * @param {string} opts.user
 * @param {string} opts.pass        plaintext (never logged/returned)
 * @param {string} [opts.folder='INBOX'] the SOURCE mailbox the uids live in
 * @param {number[]} opts.uids      UIDs to move
 * @param {string} opts.targetPath  destination mailbox path
 * @param {Function} [opts.ImapFlow]
 * @returns {Promise<{moved:number, uidMap:?Object<string,number>, destUidValidity:?string}>}
 *   uidMap maps each SOURCE uid (as a string key) to its NEW uid in the
 *   destination mailbox, taken from the server's COPYUID response (RFC
 *   4315). Only present when the server reported one (requires UIDPLUS);
 *   null when unavailable, never fabricated. AQ-9E P1: callers MUST use this
 *   mapping to update the stored (folder, uid) pair after a move -- the
 *   source uid is meaningless once the message lives in the destination
 *   mailbox, and silently keeping it would point at the WRONG message there.
 */
async function moveMessages({
  host, port, user, pass, folder = 'INBOX', uids, targetPath, ImapFlow = RealImapFlow,
}) {
  if (!Array.isArray(uids) || uids.length === 0) return { moved: 0, uidMap: null, destUidValidity: null };
  if (!targetPath) throw new Error('moveMessages requires targetPath');
  const client = new ImapFlow({
    host, port: Number(port) || 993, secure: true, auth: { user, pass }, logger: false, socketTimeout: 20000,
  });
  let onError;
  const errorPromise = new Promise((_resolve, reject) => { onError = () => reject(new Error('imap_connection_error')); });
  client.on('error', onError);
  let lock = null;
  const operation = (async () => {
    await client.connect();
    lock = await client.getMailboxLock(folder);
    // imapflow's messageMove resolves to {path, destination, uidValidity?,
    // uidMap?} when the server reports COPYUID, or a falsy value otherwise
    // (no UIDPLUS, or the server rejected the move). Never thrown here --
    // captured as an honestly unresolved mapping so the caller can mark the
    // destination location unresolved rather than crashing the whole move.
    const moveResult = await client.messageMove(uids, targetPath, { uid: true });
    // imapflow's messageMove returns literally `false` when the UID range does
    // not resolve (stale uids, nothing matched) — i.e. NOTHING moved. Treat
    // that as a failure rather than reporting moved:uids.length, which would
    // claim a success that never happened and corrupt the stored location.
    // Every caller wraps doMove in try/catch, so throwing is the safe signal.
    // A successful move without UIDPLUS returns a truthy object (no uidMap),
    // which is left untouched here.
    if (moveResult === false) throw new Error('imap_move_unresolved');
    let uidMap = null;
    if (moveResult && moveResult.uidMap instanceof Map && moveResult.uidMap.size > 0) {
      uidMap = {};
      for (const [srcUid, destUid] of moveResult.uidMap) uidMap[String(srcUid)] = Number(destUid);
    }
    const destUidValidity = (moveResult && moveResult.uidValidity != null) ? String(moveResult.uidValidity) : null;
    return { moved: uids.length, uidMap, destUidValidity };
  })();
  try {
    return await Promise.race([operation, errorPromise]);
  } finally {
    client.off('error', onError);
    try { if (lock) lock.release(); } catch { /* non-fatal */ }
    try { await client.logout(); } catch { /* non-fatal */ }
  }
}

// INBOXQ full-import (owner 2026-10-05): the COLD_START_LIMIT cap meant a large
// existing mailbox (e.g. 57k messages) only ever surfaced its newest 500 — the
// mailbox never mirrored reality the way a normal mail client does. indexOlder
// is the cheap IMPORT primitive, DECOUPLED from processing: it fetches ENVELOPES
// ONLY (uid / from / subject / date / message-id) for the UIDs strictly below a
// floor, newest-first, with NO body download, NO simpleParser and NO classifier.
// The backfill loop (syncWorker) walks the floor down in bounded batches so the
// WHOLE mailbox is indexed and movable/searchable; body capture and zone
// classification stay a separate, cost-bounded pass over what the user looks at.
const INDEX_BATCH = 1000;
async function indexOlder({
  host, port, user, pass, folder = 'INBOX', belowUid, limit = INDEX_BATCH,
  ImapFlow = RealImapFlow,
}) {
  const floor = Number(belowUid);
  if (!Number.isFinite(floor) || floor <= 1) {
    return { uidvalidity: null, messages: [], newFloor: 1, reachedBottom: true };
  }
  const client = new ImapFlow({
    host, port: Number(port) || 993, secure: true, auth: { user, pass },
    logger: false, socketTimeout: 30000,
  });
  // codex F02 pattern: a post-connect 'error' must reject, not crash the process.
  let onError;
  const errorPromise = new Promise((_resolve, reject) => { onError = () => reject(new Error('imap_connection_error')); });
  client.on('error', onError);

  let lock = null;
  const operation = (async () => {
    await client.connect();
    lock = await client.getMailboxLock(folder);
    const uidvalidity = String(client.mailbox?.uidValidity ?? '');
    let older = await client.search({ uid: `1:${floor - 1}` }, { uid: true }) || [];
    older = older.map(Number).filter((u) => Number.isFinite(u) && u > 0 && u < floor).sort((a, b) => a - b);
    if (older.length === 0) {
      return { uidvalidity, messages: [], newFloor: 1, reachedBottom: true };
    }
    const n = Math.max(1, Number(limit) || INDEX_BATCH);
    const batch = older.slice(-n); // the NEWEST n of the older UIDs — backfill walks downward
    const messages = [];
    // envelope ONLY — no `source`, so no body bytes cross the wire and no parse runs.
    // labels/emailId are Gmail X-GM-EXT-1 extras (no-op elsewhere): on Gmail the
    // backfill reads [Gmail]/All Mail, so each row carries its Gmail labels.
    for await (const msg of client.fetch(batch.join(','), { envelope: true, uid: true, labels: true, emailId: true }, { uid: true })) {
      const { fromAddr, fromName } = parseAddress(msg.envelope?.from);
      const d = msg.envelope?.date ? new Date(msg.envelope.date) : null;
      messages.push({
        uid: Number(msg.uid),
        messageId: msg.envelope?.messageId || null,
        fromAddr, fromName,
        subject: msg.envelope?.subject || null,
        dateTs: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null,
        snippet: null,
        labels: msg.labels ? [...msg.labels] : null,
        gmailId: msg.emailId || null,
      });
    }
    const newFloor = batch[0]; // lowest UID indexed this pass
    const reachedBottom = batch.length >= older.length; // nothing older than newFloor remains
    return { uidvalidity, messages, newFloor, reachedBottom };
  })();

  try {
    return await Promise.race([operation, errorPromise]);
  } finally {
    client.off('error', onError);
    try { if (lock) lock.release(); } catch { /* non-fatal */ }
    try { await client.logout(); } catch { /* non-fatal */ }
  }
}

// INBOXQ reverse-reflection (owner 2026-10-05): the lightweight read of a folder's
// CURRENT server state — every present UID and its \Seen flag, nothing else (no
// envelope, no body). The reconcile pass diffs this against the store to (a) remove
// messages the user deleted/moved away in another client, and (b) mirror read/unread.
// FETCH FLAGS is cheap (uid + a short flag set per message), so one call reflects a
// whole folder.
async function fetchFolderState({ host, port, user, pass, folder = 'INBOX', ImapFlow = RealImapFlow }) {
  const client = new ImapFlow({
    host, port: Number(port) || 993, secure: true, auth: { user, pass },
    logger: false, socketTimeout: 30000,
  });
  let onError;
  const errorPromise = new Promise((_resolve, reject) => { onError = () => reject(new Error('imap_connection_error')); });
  client.on('error', onError);
  let lock = null;
  const operation = (async () => {
    await client.connect();
    lock = await client.getMailboxLock(folder);
    const uidvalidity = String(client.mailbox?.uidValidity ?? '');
    const entries = [];
    if (client.mailbox && client.mailbox.exists > 0) {
      for await (const msg of client.fetch('1:*', { uid: true, flags: true }, { uid: true })) {
        entries.push({ uid: Number(msg.uid), seen: Boolean(msg.flags && msg.flags.has('\\Seen')) });
      }
    }
    return { uidvalidity, entries };
  })();
  try {
    return await Promise.race([operation, errorPromise]);
  } finally {
    client.off('error', onError);
    try { if (lock) lock.release(); } catch { /* non-fatal */ }
    try { await client.logout(); } catch { /* non-fatal */ }
  }
}

module.exports = {
  fetchSince, fetchByUids, fetchByMessageId, listFolders, listFoldersDetailed, createImapFolder, moveMessages,
  indexOlder, INDEX_BATCH, fetchFolderState,
  parseMessageSource, MAX_BODY_BYTES, MAX_BACKFILL_UIDS, MAX_ATTACHMENTS,
  // phishing-help signals (owner ask): exported for unit tests.
  computeSecurity, computePhishingRisk, parseAuthenticationResults, parseReceivedSpf,
};
