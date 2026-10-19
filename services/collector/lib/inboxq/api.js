'use strict';

/**
 * InboxQ governed HTTP surface.
 *
 * Design: pure handler functions (async (reqCtx, deps) -> { status, json }) so
 * every path is unit-testable without express or a live server, plus a thin
 * registerInboxqRoutes(app, deps) that wires them onto the collector app with
 * the standard gate stack (requireServiceOrUserAuth -> resolve caller org ->
 * per-org licence check -> handler -> AEE witness).
 *
 * INVARIANTS enforced here:
 *  - org is ALWAYS the server-resolved caller org (resolveOrgId), NEVER a body
 *    field. A client cannot ask for another org's mail.
 *  - every route is licence-gated on 'inboxq' for that org.
 *  - v1 performs NO external mail effects EXCEPT the one P1 adds: an approved
 *    'file' proposal executes a real, safe IMAP UID MOVE (never COPY+EXPUNGE)
 *    to the target folder's real IMAP path. 'block'/'draft' proposals remain
 *    decision-only (approving records the human decision; no mail effect) —
 *    sender-blocking-as-a-rule and draft-send are separate, deferred work.
 *  - consequential actions emit an AEE envelope (quox.inbox.*).
 */

const store = require('./store');
const { classify, ZONES } = require('./classify');
const { fetchSince, fetchByUids, fetchByMessageId, listFolders, listFoldersDetailed, createImapFolder, moveMessages } = require('./imap');
const { resolveEmailCredential } = require('./credential');
const { buildReport } = require('./report');
const { syncAccount, backfillAccount, reconcileAccountFolders, reconcileAccountPresence } = require('./syncWorker');

// FIX-2 (owner 2026-10-07): the manual Sync button used to run only a forward
// pull of INBOX (none of the folder-discovery / full-import / reflection the
// background scheduler does) AND block the event loop for ~12s. In-flight guard
// so a user mashing Sync can't stack full-pipeline runs on one account.
const inFlightSync = new Set();
// ContactsQ P3b: additive, fail-soft sender identity (lib/contactsq/identity.js never throws; absent => no-op).
const contactIdentity = require('../contactsq/identityShim.js');
const { MATCH_TYPES: RULE_MATCH_TYPES, matchRule, findMatchingRule } = require('./rules');

function ok(json) { return { status: 200, json }; }
function bad(msg, status = 400) { return { status, json: { error: msg } }; }

// GMAIL labels-as-folders (owner 2026-10-05). A Gmail account syncs the single
// [Gmail]/All Mail archive and presents its LABELS as "folders". isGmailAccount
// keys off that: reconcileAccountFolders points a detected Gmail account at
// '[Gmail]/All Mail'. gmailLabelName turns raw IMAP label tokens into the names
// a human expects (the leading backslash system labels).
const GMAIL_ALL_MAIL = '[Gmail]/All Mail';
const GMAIL_LABEL_NAMES = {
  '\\Inbox': 'Inbox', '\\Sent': 'Sent', '\\Draft': 'Drafts', '\\Drafts': 'Drafts',
  '\\Starred': 'Starred', '\\Important': 'Important', '\\Trash': 'Trash',
  '\\Junk': 'Spam', '\\Spam': 'Spam', '\\All': 'All Mail', '\\Flagged': 'Starred',
};
function isGmailAccount(account) {
  return Boolean(account && Array.isArray(account.folders) && account.folders.includes(GMAIL_ALL_MAIL));
}
function gmailLabelName(label) {
  if (GMAIL_LABEL_NAMES[label]) return GMAIL_LABEL_NAMES[label];
  // Gmail category labels come as "CATEGORY_PROMOTIONS" etc.
  if (/^CATEGORY_/.test(label)) return label.replace(/^CATEGORY_/, '').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
  return label; // a user's own custom label — show as-is
}

// --- pure handlers ---------------------------------------------------------

async function hListAccounts(ctx) {
  const accounts = store.listAccounts(ctx.orgId).map(redactAccount);
  return ok({ accounts });
}

async function hCreateAccount(ctx, deps) {
  const { credentialId, emailAddress, displayName, folders } = ctx.body || {};
  if (!credentialId) return bad('credentialId required');
  // Verify the credential resolves for this org BEFORE persisting the account,
  // so a mis-typed credential id fails fast instead of silently never syncing.
  // The email address is DERIVED from the resolved credential when the caller
  // does not supply one, so the onboarding "connect" flow only needs a picked
  // credential (the browser never sees the secret username, so it cannot send it).
  //
  // Safe-by-default: a new account is NEVER auto-populated with every
  // discovered mailbox folder. For a crucial inbox, silently pulling Sent,
  // Archive, and every custom folder on first connect is a bigger blast
  // radius than the human asked for. The default is INBOX only; the human
  // opts into more folders afterwards via hAvailableFolders/hUpdateAccountFolders.
  // An explicit `folders` array on the request body is still honoured (a
  // caller who already knows what it wants is not "everything by default").
  let explicitFolders = Array.isArray(folders) && folders.length ? folders : null;
  let finalEmail = (emailAddress || '').trim() || null;
  try {
    const cred = await (deps.resolveCredential || defaultResolve)(ctx.orgId, credentialId);
    if (!cred.imap_host || !cred.username || !cred.password) return bad('credential_incomplete: email_account needs imap_host, username, password', 422);
    if (!finalEmail) finalEmail = cred.username || cred.from || null;
    if (!finalEmail) return bad('credential has no username/from to derive the mailbox address; pass emailAddress', 422);
  } catch (e) {
    return bad(`credential check failed: ${e.message}`, 422);
  }
  const existed = store.getAccountByAddress(ctx.orgId, finalEmail);
  const account = store.createAccount({
    orgId: ctx.orgId,
    credentialId,
    emailAddress: finalEmail,
    displayName: displayName || null,
    folders: explicitFolders || ['INBOX'],
    createdBy: ctx.userId || null,
  });
  // codex F15: reconnecting (e.g. after a credential repair) must clear any
  // retirement/backoff so sync can resume — otherwise retired folders stay dead
  // with no recovery path.
  if (existed) store.clearRetirement(ctx.orgId, account.id);
  deps.audit?.({ type: 'action', intent: 'quox.inbox.account.connect', corr: account.id, payload: { orgId: ctx.orgId, emailAddress: finalEmail } });
  return ok({ account: redactAccount(account) });
}

async function hDeleteAccount(ctx, deps) {
  const removed = store.deleteAccount(ctx.orgId, ctx.params.accountId);
  if (!removed) return bad('account not found', 404);
  deps.audit?.({ type: 'action', intent: 'quox.inbox.account.disconnect', corr: ctx.params.accountId, payload: { orgId: ctx.orgId } });
  return ok({ removed: true });
}

/**
 * List the REAL mailbox folders available on the account's IMAP server (not
 * the account's currently-synced `folders` list). This is the picker source
 * for the human to opt into more folders after the safe INBOX-only default —
 * resolves the credential the SAME way hSync does, so a bad/rotated
 * credential fails with a clear error rather than a silent empty list.
 */
async function hAvailableFolders(ctx, deps) {
  const account = store.getAccount(ctx.orgId, ctx.params.accountId);
  if (!account) return bad('account not found', 404);
  let cred;
  try {
    cred = await (deps.resolveCredential || defaultResolve)(ctx.orgId, account.credentialId);
    if (!cred.imap_host || !cred.username || !cred.password) return bad('credential_incomplete', 422);
  } catch (e) {
    return bad(`credential check failed: ${e.message}`, 422);
  }
  let folders;
  try {
    folders = await (deps.listFolders || listFolders)({ host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password });
  } catch (e) {
    return bad(`imap folder list failed: ${e.message}`, 502);
  }
  deps.audit?.({ type: 'action', intent: 'quox.inbox.folders.list', corr: account.id, payload: { orgId: ctx.orgId, count: folders.length } });
  return ok({ folders });
}

/**
 * Human opts an account into a specific set of folders to sync (the write
 * side of the safe-by-default INBOX-only connect flow). Replaces the whole
 * set rather than appending, matching the picker UI (checked = synced).
 */
async function hUpdateAccountFolders(ctx, deps) {
  const { folders } = ctx.body || {};
  const account = store.getAccount(ctx.orgId, ctx.params.accountId);
  if (!account) return bad('account not found', 404);
  let updated;
  try {
    updated = store.updateAccountFolders(ctx.orgId, ctx.params.accountId, folders);
  } catch (e) {
    return bad(e.message, 422);
  }
  if (!updated) return bad('account not found', 404);
  deps.audit?.({ type: 'action', intent: 'quox.inbox.account.folders_update', corr: account.id, payload: { orgId: ctx.orgId, folders } });
  return ok({ account: redactAccount(updated) });
}

async function hListMessages(ctx) {
  const { accountId = null, zone = null, limit = 50, offset = 0 } = ctx.query || {};
  const messages = store.listMessages(ctx.orgId, { accountId, zone, limit: Number(limit), offset: Number(offset) });
  const zones = store.countByZone(ctx.orgId, accountId);
  return ok({ messages: contactIdentity.enrichMessages(ctx.orgId, messages), zones });
}

/**
 * INBOXQ-AGENT (P2b): bounded keyword/field search, the one query path BOTH
 * the UI and the `inbox_search` agent tool use (INBOXQ_AGENT_DESIGN.md §A) —
 * so "find wordfence mail" always means the same thing regardless of who
 * asked. Echoes a normalised `matchSpec` back so a caller (the tool) can hand
 * the EXACT same spec to `inbox_propose_move`, which re-runs this search at
 * propose time and freezes the result — the batch-approval mechanism.
 */
async function hSearchMessages(ctx, deps) {
  const { accountId, from, fromDomain, subject, text, zone, folder, flag, limit } = ctx.query || {};
  if (!accountId) return bad('accountId required');
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);
  // GMAIL: the UI's folder rows ARE labels, so a `folder` selection on a Gmail
  // account is a LABEL filter, not a physical-folder filter (every Gmail message
  // lives in [Gmail]/All Mail). Route it to the label filter instead.
  const gmail = isGmailAccount(account);
  const labelFilter = gmail && folder ? folder : null;
  const folderFilter = gmail ? null : (folder || null);
  const matchSpec = {
    accountId,
    from: from || null, fromDomain: fromDomain || null, subject: subject || null,
    text: text || null, zone: zone || null, folder: folderFilter, label: labelFilter, flag: flag || null,
  };
  const { total, messages } = store.searchMessages(ctx.orgId, {
    accountId, from, fromDomain, subject, text, zone, folder: folderFilter, label: labelFilter, flag,
    limit: limit !== undefined ? Number(limit) : 50,
  });
  deps.audit?.({ type: 'action', intent: 'quox.inbox.search', corr: accountId, payload: { orgId: ctx.orgId, total, matchSpec } });
  return ok({ total, messages: contactIdentity.enrichMessages(ctx.orgId, messages), matchSpec });
}

/**
 * Fetch a single message's full detail, INCLUDING the (bounded) body captured
 * at sync time. Distinct from hListMessages, whose store.listMessages call
 * deliberately excludes body_html/body_text so list responses stay
 * snippet-sized — this is the only read path that returns the body.
 */
async function hGetMessage(ctx, deps) {
  const msg = store.getMessage(ctx.orgId, ctx.params.id);
  if (!msg) return bad('message not found', 404);
  deps.audit?.({ type: 'action', intent: 'quox.inbox.message.read', corr: msg.id, payload: { orgId: ctx.orgId } });
  return ok({ message: contactIdentity.enrichMessage(ctx.orgId, msg) });
}

/**
 * P1c: on-demand body fetch for a single stored message that has none —
 * either it was ingested before P1b shipped body capture, or synced before
 * that column existed. INSERT OR IGNORE means a plain re-sync never
 * backfills these rows, so this route re-opens IMAP for the ONE message the
 * human is actually reading right now, resolving the credential the SAME way
 * hSync does. A message that already has a body is a no-op (no IMAP call).
 *
 * AQ-9E P1 (move-identity fix): a stored row's (folder, uid) pair is only
 * trustworthy for a direct uid fetch when uid is resolved. When an
 * interactive move left it unresolved (uid: null — see updateMessageFolder),
 * the message is re-resolved within its stored folder by its stable RFC
 * Message-ID instead of guessing a uid. Either way, once a candidate body is
 * fetched its Message-ID is checked against the row's own message_id (when
 * one is known): a mismatch (or a case where identity cannot be confirmed
 * after a move) is refused rather than risked — never store or return a body
 * that might belong to a different message.
 */
async function hFetchMessageBody(ctx, deps) {
  const msg = store.getMessage(ctx.orgId, ctx.params.id);
  if (!msg) return bad('message not found', 404);
  if (msg.bodyHtml || msg.bodyText) {
    return ok({ message: msg });
  }
  const account = store.getAccount(ctx.orgId, msg.accountId);
  if (!account) return bad('account not found', 404);
  let cred;
  try {
    cred = await (deps.resolveCredential || defaultResolve)(ctx.orgId, account.credentialId);
    if (!cred.imap_host || !cred.username || !cred.password) return bad('credential_incomplete', 422);
  } catch (e) {
    return bad(`credential check failed: ${e.message}`, 422);
  }

  let found;
  if (msg.uid == null) {
    // The location is unresolved (an interactive move whose server gave no
    // COPYUID mapping). Never guess a uid after a move; a message_id is
    // REQUIRED to safely re-resolve it, otherwise this is an honest dead end.
    if (!msg.messageId) {
      return bad('message location unresolved after a move, and no message_id to re-resolve by; a resync is needed', 409);
    }
    try {
      const results = await (deps.fetchByMessageId || fetchByMessageId)({
        host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password,
        folder: msg.folder, messageId: msg.messageId,
      });
      found = (results || [])[0] || null;
    } catch (e) {
      return bad(`fetch failed: ${e.message}`, 502);
    }
  } else {
    let fetched;
    try {
      fetched = await (deps.fetchByUids || fetchByUids)({
        host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password,
        folder: msg.folder, uids: [msg.uid],
      });
    } catch (e) {
      return bad(`fetch failed: ${e.message}`, 502);
    }
    found = fetched.find((m) => Number(m.uid) === Number(msg.uid)) || null;
  }

  if (!found || (!found.bodyHtml && !found.bodyText)) {
    return bad('message body not available from the mail server', 502);
  }
  // Identity check: when the row carries a message_id, the fetched message's
  // message_id MUST match exactly, or the body is refused (never a
  // wrong-but-successful result). A row with no message_id and an already-
  // resolved uid falls through unchecked, same pre-existing behaviour as
  // before this fix for messages genuinely lacking a Message-ID header.
  if (msg.messageId) {
    if (!found.messageId || found.messageId !== msg.messageId) {
      return bad('message identity could not be confirmed; refusing to return a possibly mismatched body', 409);
    }
  }
  store.updateMessageBody(ctx.orgId, msg.id, { bodyHtml: found.bodyHtml, bodyText: found.bodyText, attachments: found.attachments, security: found.security, phishingRisk: found.phishingRisk });
  deps.audit?.({ type: 'action', intent: 'quox.inbox.message.fetch_body', corr: msg.id, payload: { orgId: ctx.orgId } });
  return ok({ message: store.getMessage(ctx.orgId, msg.id) });
}

/**
 * P1c: bulk backfill for an account's already-stored, still-bodyless
 * messages (the ~370 pre-P1b rows). Bounded per call (default 50, hard cap
 * 100) and grouped by folder so each folder is one IMAP connection/fetch
 * rather than one per message. A per-folder IMAP failure is caught so the
 * other folders still process; the failed rows simply stay in the
 * "remaining" count for a retry.
 */
async function hBackfillBodies(ctx, deps) {
  const { accountId, limit = 50 } = ctx.body || {};
  if (!accountId) return bad('accountId required');
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);
  const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit)) || 50, 100));

  const rows = store.listMessagesMissingBody(ctx.orgId, accountId, { limit: safeLimit });
  const byFolder = new Map();
  for (const r of rows) {
    if (!byFolder.has(r.folder)) byFolder.set(r.folder, []);
    byFolder.get(r.folder).push(r);
  }

  let backfilled = 0;
  if (byFolder.size > 0) {
    let cred;
    try {
      cred = await (deps.resolveCredential || defaultResolve)(ctx.orgId, account.credentialId);
    } catch {
      cred = null;
    }
    if (cred && cred.imap_host && cred.username && cred.password) {
      for (const [folder, folderRows] of byFolder) {
        try {
          const fetched = await (deps.fetchByUids || fetchByUids)({
            host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password,
            folder, uids: folderRows.map((r) => r.uid),
          });
          const byUid = new Map(fetched.map((m) => [Number(m.uid), m]));
          for (const r of folderRows) {
            const found = byUid.get(Number(r.uid));
            if (found && (found.bodyHtml || found.bodyText)) {
              store.updateMessageBody(ctx.orgId, r.id, { bodyHtml: found.bodyHtml, bodyText: found.bodyText, attachments: found.attachments, security: found.security, phishingRisk: found.phishingRisk });
              backfilled += 1;
            }
          }
        } catch (e) {
          // A single folder's IMAP failure must not abort the other folders —
          // its rows simply stay counted in `remaining` for a later retry.
          console.error(`[inboxq] backfill-bodies: folder "${folder}" failed:`, e?.message);
        }
      }
    }
  }

  const remaining = store.countMessagesMissingBody(ctx.orgId, accountId);
  deps.audit?.({ type: 'action', intent: 'quox.inbox.messages.backfill_bodies', corr: accountId, payload: { orgId: ctx.orgId, backfilled, remaining } });
  return ok({ backfilled, remaining });
}

async function hZones(ctx) {
  return ok({ zones: store.countByZone(ctx.orgId, ctx.query?.accountId || null) });
}

/**
 * FIX-2 (owner 2026-10-07): the FULL manual-sync pipeline for one account —
 * (1) discover every real folder, (2) forward-pull + classify new mail,
 * (3) a bounded backfill nudge toward the whole mailbox, (4) reflect external
 * deletes/moves/read-state. Each step is isolated so one failing never aborts
 * the rest. This is what the Sync button now runs (previously it did only step
 * 2 on INBOX). reconcileIntervalMs:0 forces reflection on an explicit sync.
 */
async function runFullSync(orgId, account, deps = {}) {
  const resolveCredential = (acc) => (deps.resolveCredential || defaultResolve)(acc.orgId, acc.credentialId);
  const llm = typeof deps.llmForOrg === 'function' ? deps.llmForOrg(orgId) : (deps.llm || null);
  let hydrated = account;
  const result = {};
  try {
    const disc = await reconcileAccountFolders({ store, account: hydrated, resolveCredential, listFoldersDetailed: deps.listFoldersDetailed });
    if (disc && Array.isArray(disc.folders)) hydrated = { ...hydrated, folders: disc.folders };
    result.discovery = disc;
  } catch (e) { result.discoveryError = e?.message || String(e); }
  try {
    result.summary = await syncAccount({
      store, account: hydrated, resolveCredential,
      fetchSince: deps.fetchSince || fetchSince, classify: deps.classify || classify, llm,
      budget: { remaining: deps.perSyncLlmBudget ?? 25 }, now: deps.now || Date.now(),
      moveMessages: deps.moveMessages || moveMessages,
    });
  } catch (e) { result.syncError = e?.message || String(e); }
  try { result.backfill = await backfillAccount({ store, account: hydrated, resolveCredential, indexOlder: deps.indexOlder, now: deps.now || Date.now() }); } catch (e) { result.backfillError = e?.message || String(e); }
  try { result.reconcile = await reconcileAccountPresence({ store, account: hydrated, resolveCredential, fetchFolderState: deps.fetchFolderState, reconcileIntervalMs: 0, now: deps.now || Date.now() }); } catch (e) { result.reconcileError = e?.message || String(e); }
  return result;
}

async function hSync(ctx, deps) {
  const accountId = ctx.body?.accountId || ctx.params?.accountId;
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);

  // Inline mode (tests / callers that need the result synchronously).
  if (deps.inline) {
    const result = await runFullSync(ctx.orgId, account, deps);
    deps.audit?.({ type: 'action', intent: 'quox.inbox.sync', corr: account.id, payload: { orgId: ctx.orgId, folders: result.summary?.folders } });
    return ok({ summary: result.summary, pipeline: result });
  }

  // Prod: run the full pipeline DETACHED so the request returns at once — a big
  // mailbox (discovery + backfill + reflection) never hangs the request or holds
  // the event loop for the whole duration. In-flight guard stops stacked runs.
  const key = `${ctx.orgId}:${account.id}`;
  if (inFlightSync.has(key)) return ok({ started: false, status: 'already_syncing' });
  inFlightSync.add(key);
  runFullSync(ctx.orgId, account, deps)
    .catch((e) => console.error('[inboxq] manual full sync failed:', e?.message || e))
    .finally(() => inFlightSync.delete(key));
  deps.audit?.({ type: 'action', intent: 'quox.inbox.sync', corr: account.id, payload: { orgId: ctx.orgId, started: true } });
  return ok({ started: true, status: 'syncing' });
}

/**
 * Live sync progress (self-audit gap d). The detached full sync returns
 * {started:true} at once, so the UI had only blind timed reloads and the owner
 * saw no sign it was working ("I feel like it did nothing"). This read-only
 * endpoint lets the dashboard poll real progress: whether a run is in flight
 * (inFlightSync), how many messages are stored so far, and how many of the
 * account's folders have finished backfilling. Cheap counts, no IMAP calls.
 */
async function hSyncStatus(ctx) {
  const accountId = ctx.query?.accountId || ctx.params?.accountId;
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);
  const syncing = inFlightSync.has(`${ctx.orgId}:${account.id}`);
  const stored = store.countMessages(ctx.orgId, accountId);
  const states = store.listFolderStates(ctx.orgId, accountId);
  const syncedFolders = Array.isArray(account.folders) ? account.folders.length : 0;
  const total = Math.max(syncedFolders, states.length);
  const backfilled = states.filter((s) => s.backfillDone).length;
  return ok({ syncing, stored, folders: { total, backfilled } });
}

async function hGenerateReport(ctx, deps) {
  const accountId = ctx.body?.accountId || ctx.params?.accountId;
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);
  // codex F11: sample the recent window, but ALSO pull every action-flagged
  // message regardless of date so future-dated spam can't push a real action
  // item out of the window and make the report falsely read "clear". Merge
  // unique by id, and tell buildReport the true total so it qualifies coverage.
  const recent = store.listMessages(ctx.orgId, { accountId, limit: 500 });
  const flagged = [
    ...store.listMessagesByFlag(ctx.orgId, { accountId, flag: 'needs_action', limit: 300 }),
    ...store.listMessagesByFlag(ctx.orgId, { accountId, flag: 'has_deadline', limit: 300 }),
    ...store.listMessagesByFlag(ctx.orgId, { accountId, flag: 'review', limit: 300 }),
  ];
  const byId = new Map();
  for (const m of [...recent, ...flagged]) byId.set(m.id, m);
  const messages = [...byId.values()];
  const totalStored = store.countMessages(ctx.orgId, accountId);
  const { bodyMd, counts, refs, structured } = buildReport({ account, messages, totalStored });
  const report = store.saveReport({ orgId: ctx.orgId, accountId, reportDate: new Date().toISOString().slice(0, 10), bodyMd, counts: { ...counts, refs }, structured });
  deps.audit?.({ type: 'action', intent: 'quox.inbox.report', corr: report.id, payload: { orgId: ctx.orgId, counts } });
  return ok({ report });
}

async function hLatestReport(ctx) {
  const accountId = ctx.query?.accountId;
  if (!accountId) return bad('accountId required');
  const report = store.getLatestReport(ctx.orgId, accountId);
  return ok({ report: report || null });
}

async function hListWatches(ctx) {
  return ok({ watches: store.listWatches(ctx.orgId, { activeOnly: ctx.query?.activeOnly === '1' }) });
}

async function hCreateWatch(ctx, deps) {
  const { accountId = null, label, match } = ctx.body || {};
  if (!label || !match) return bad('label and match required');
  const watch = store.createWatch({ orgId: ctx.orgId, accountId, label, match, createdBy: ctx.userId || null });
  deps.audit?.({ type: 'action', intent: 'quox.inbox.watch.create', corr: watch.id, payload: { orgId: ctx.orgId, label } });
  return ok({ watch });
}

async function hSetWatchActive(ctx) {
  const { active } = ctx.body || {};
  const changed = store.setWatchActive(ctx.orgId, ctx.params.watchId, active !== false);
  if (!changed) return bad('watch not found', 404);
  return ok({ updated: true });
}

async function hListProposals(ctx) {
  return ok({ proposals: store.listProposals(ctx.orgId, { status: ctx.query?.status || null, accountId: ctx.query?.accountId || null }) });
}

// INBOXQ-AGENT (P2b): 'rezone'/'folder_create'/'rule' join the original
// file|block|draft set — see store.js PROPOSAL_KINDS and hResolveProposal's
// execution switch below for what each kind actually does on approve.
const PROPOSAL_KINDS = ['file', 'block', 'draft', 'rezone', 'folder_create', 'rule'];

async function hCreateProposal(ctx, deps) {
  const { accountId, kind, payload, createdVia } = ctx.body || {};
  if (!accountId || !kind) return bad('accountId and kind required');
  if (!PROPOSAL_KINDS.includes(kind)) return bad(`kind must be one of ${PROPOSAL_KINDS.join('|')}`);
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);
  // createdVia distinguishes an agent-raised batch from a human-authored one
  // in the UI/audit trail (INBOXQ_AGENT_DESIGN.md §A item 4); createdBy stays
  // the human session's user id regardless — the chatting user is still the
  // actor of record, the agent id is only the "via".
  const proposal = store.createProposal({ orgId: ctx.orgId, accountId, kind, payload: payload || {}, createdBy: ctx.userId || null, createdVia: createdVia || 'ui' });
  // Optionally mirror into the shared Approvals (inbox_items) queue when wired.
  let approvalItemId = null;
  if (typeof deps.createApprovalItem === 'function') {
    try {
      approvalItemId = await deps.createApprovalItem({ orgId: ctx.orgId, kind: 'approval', title: `InboxQ ${kind} proposal`, payload: { proposalId: proposal.id, kind, payload, what: { action: `InboxQ ${kind}`, target: `mailbox ${account.email || account.id || accountId}`, summary: `apply the InboxQ ${kind} proposal ${proposal.id} to mailbox ${account.email || account.id || accountId}` } } });
      if (approvalItemId) store.setProposalStatus(ctx.orgId, proposal.id, 'proposed', { approvalItemId });
    } catch { /* approval mirroring best-effort; proposal still visible in InboxQ */ }
  }
  deps.audit?.({ type: 'action', intent: 'quox.inbox.propose', corr: proposal.id, payload: { orgId: ctx.orgId, kind } });
  return ok({ proposal: store.getProposal(ctx.orgId, proposal.id) });
}

async function hResolveProposal(ctx, deps) {
  const { decision } = ctx.body || {};
  if (!['approve', 'deny'].includes(decision)) return bad('decision must be approve|deny');
  const proposal = store.getProposal(ctx.orgId, ctx.params.proposalId);
  if (!proposal) return bad('proposal not found', 404);
  if (proposal.status !== 'proposed') {
    return bad(`proposal already ${proposal.status}`, 409);
  }
  const status = decision === 'approve' ? 'approved' : 'denied';
  // codex F04: atomic transition from 'proposed' only — a concurrent/repeat
  // resolve changes 0 rows and returns 409 rather than flipping a decision.
  // Resolver identity is persisted. The human-actor gate is enforced at the
  // route layer (requireHuman middleware); ctx.userId is the human id.
  const changed = store.setProposalStatus(ctx.orgId, proposal.id, status, { expectedStatus: 'proposed', resolvedBy: ctx.userId || 'unknown' });
  if (!changed) return bad('proposal already resolved', 409);
  deps.audit?.({ type: 'action', intent: `quox.inbox.proposal.${status}`, corr: proposal.id, payload: { orgId: ctx.orgId, resolvedBy: ctx.userId || 'unknown' } });

  // INBOXQ-AGENT (P2b): an APPROVED proposal now executes for FOUR kinds —
  // 'file' (P1's real, safe IMAP UID MOVE, never COPY+EXPUNGE), 'rezone'
  // (Quox-side zone reassignment, no IMAP), 'block' (the SAME shared
  // executor the instant human "Block sender" route calls — see
  // runSenderBlock/runDomainBlock below), and 'folder_create' (the same IMAP
  // CREATE the direct hCreateFolder route runs). 'draft' and 'rule' stay
  // decision-only: draft-send is out of control-panel scope entirely, and
  // 'rule' is reserved for the P3 rules engine (INBOXQ_AGENT_DESIGN.md §F) —
  // no executor exists for it yet, so approving one only records the human
  // decision. Every executor here follows the SAME honesty contract: any
  // execution error marks the proposal 'failed' — NEVER 'applied' — and no
  // data is lost (a retry is always a new, safe proposal).
  if (status === 'approved') {
    let executed = null;
    try {
      if (proposal.kind === 'file') {
        const { moved } = await executeFileProposal(ctx.orgId, proposal, deps);
        executed = { moved };
      } else if (proposal.kind === 'rezone') {
        const { rezoned } = await executeRezoneProposal(ctx.orgId, proposal);
        executed = { rezoned };
      } else if (proposal.kind === 'block') {
        executed = await executeBlockProposal(ctx.orgId, proposal, deps);
      } else if (proposal.kind === 'folder_create') {
        const { folder } = await executeFolderCreateProposal(ctx.orgId, proposal, deps);
        executed = { folder };
      }
    } catch (e) {
      store.setProposalStatus(ctx.orgId, proposal.id, 'failed', { expectedStatus: 'approved' });
      deps.audit?.({ type: 'action', intent: 'quox.inbox.proposal.failed', corr: proposal.id, payload: { orgId: ctx.orgId, error: e.message } });
      return { status: 502, json: { proposal: store.getProposal(ctx.orgId, proposal.id), executed: false, error: e.message } };
    }
    if (executed) {
      store.setProposalStatus(ctx.orgId, proposal.id, 'applied', { expectedStatus: 'approved' });
      deps.audit?.({ type: 'action', intent: 'quox.inbox.proposal.applied', corr: proposal.id, payload: { orgId: ctx.orgId, ...executed } });
      return ok({ proposal: store.getProposal(ctx.orgId, proposal.id), executed: true, ...executed });
    }
  }

  return ok({
    proposal: store.getProposal(ctx.orgId, proposal.id),
    executed: false,
    ...(status === 'approved' ? { note: `${proposal.kind} decision recorded; execution for this kind is out of scope` } : {}),
  });
}

/**
 * Resolve a proposal's payload.folder reference (an inboxq_folders id, name,
 * or imap_path) to the folder record. Thin delegation to store.js's
 * canonical implementation (also used by the rules engine — see
 * syncWorker.js / hApplyRules below) so every "resolve a folder reference"
 * path in InboxQ runs identical behaviour.
 */
function resolveFolderRef(orgId, accountId, folderRef) {
  return store.resolveFolderRef(orgId, accountId, folderRef);
}

/**
 * AQ-9E P1 (move-identity fix): resolve the REAL destination uid for one
 * moved message from imap.js moveMessages' result, or null when the server
 * reported no COPYUID mapping. Every updateMessageFolder call after a real
 * IMAP move goes through this (never the stale source uid), so a message
 * either lands on its true new location or is marked explicitly unresolved.
 */
function destUidFor(moveResult, srcUid) {
  if (!moveResult || !moveResult.uidMap) return null;
  const v = moveResult.uidMap[String(srcUid)];
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

/** Companion to destUidFor: the destination mailbox's uidvalidity, or null. */
function destUidValidityOf(moveResult) {
  return (moveResult && moveResult.destUidValidity) || null;
}

/**
 * Execute an approved 'file' proposal: resolve the target folder + credential,
 * then move every referenced message from its CURRENT stored folder to the
 * target folder's real IMAP path via a safe UID MOVE, grouped by source
 * folder (a batch may span more than one). Throws on any failure — the caller
 * (hResolveProposal) is responsible for the applied/failed status transition.
 */
async function executeFileProposal(orgId, proposal, deps) {
  const { messageIds, folder: folderRef, createFolder: createFolderIfMissing } = proposal.payload || {};
  if (!Array.isArray(messageIds) || messageIds.length === 0) throw new Error('proposal_missing_message_ids');
  const account = store.getAccount(orgId, proposal.accountId);
  if (!account) throw new Error('account_not_found');
  let targetFolder = resolveFolderRef(orgId, account.id, folderRef);
  // INBOXQ-AGENT §A: inbox_propose_move may ask for a folder that does not
  // exist yet (createFolderIfMissing) — the IMAP CREATE runs INSIDE this same
  // approval, via the identical internal hCreateFolder uses, so one Approve
  // click covers both the folder creation and the move.
  if (!targetFolder && createFolderIfMissing && folderRef) {
    targetFolder = await createFolderInternal(orgId, account.id, String(folderRef), deps, proposal.createdBy || null);
    deps.audit?.({ type: 'action', intent: 'quox.inbox.folder.create', corr: targetFolder.id, payload: { orgId, accountId: account.id, name: targetFolder.name, imapPath: targetFolder.imapPath } });
  }
  if (!targetFolder) throw new Error('target_folder_not_found');

  const messages = messageIds.map((id) => store.getMessage(orgId, id)).filter(Boolean);
  if (messages.length === 0) throw new Error('no_messages_to_move');

  const cred = await (deps.resolveCredential || defaultResolve)(orgId, account.credentialId);
  if (!cred.imap_host || !cred.username || !cred.password) throw new Error('credential_incomplete');

  const doMove = deps.moveMessages || moveMessages;
  const bySourceFolder = new Map();
  for (const m of messages) {
    if (!bySourceFolder.has(m.folder)) bySourceFolder.set(m.folder, []);
    bySourceFolder.get(m.folder).push(m);
  }

  let moved = 0;
  for (const [sourceFolder, msgs] of bySourceFolder) {
    const uids = msgs.map((m) => m.uid);
    const res = await doMove({
      host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password,
      folder: sourceFolder, uids, targetPath: targetFolder.imapPath,
    });
    moved += (res && typeof res.moved === 'number') ? res.moved : uids.length;
    for (const m of msgs) {
      store.updateMessageFolder(orgId, m.id, { folder: targetFolder.imapPath, uid: destUidFor(res, m.uid), uidvalidity: destUidValidityOf(res) });
    }
  }
  return { moved, targetFolder };
}

/**
 * Execute an approved 'rezone' proposal: `store.updateMessageZone` +
 * `store.recordUserMove` reputation feedback for every frozen message id,
 * IDENTICAL to what a human drag-refile does (hMoveMessage), just applied to
 * a whole batch behind one approval. Quox-side only — no IMAP effect, per
 * INBOXQ_AGENT_DESIGN.md §A. Throws (never partially-silent) when no
 * message resolves, so the caller can mark the proposal 'failed' honestly.
 */
async function executeRezoneProposal(orgId, proposal) {
  const { messageIds, toZone } = proposal.payload || {};
  if (!Array.isArray(messageIds) || messageIds.length === 0) throw new Error('proposal_missing_message_ids');
  if (!toZone || !ZONES.includes(toZone)) throw new Error('proposal_invalid_zone');
  const messages = messageIds.map((id) => store.getMessage(orgId, id)).filter(Boolean);
  if (messages.length === 0) throw new Error('no_messages_to_rezone');
  let rezoned = 0;
  for (const m of messages) {
    const fromZone = m.zone;
    if (store.updateMessageZone(orgId, m.id, toZone)) {
      rezoned += 1;
      try {
        store.recordUserMove({ orgId, accountId: m.accountId, fromAddr: m.fromAddr, toZone, fromZone });
      } catch { /* reputation feedback is best-effort; the rezone itself must still count */ }
    }
  }
  return { rezoned };
}

// --- folders (P1) ------------------------------------------------------------

async function hListFolders(ctx) {
  const accountId = ctx.query?.accountId || null;
  if (!accountId) return bad('accountId required');
  return ok({ folders: store.listFolders(ctx.orgId, accountId) });
}

/**
 * AQ-9E U3 (P2 folder-first): the real IMAP folder tree, enriched so the human
 * can trust it. Each node carries hierarchy (depth/parent, built from the
 * server's own delimiter), the stored message count, coverage (watched = in the
 * account's synced-folders set), and reconcile state (lastReconcileAt + health).
 *
 * The live folder list is best-effort: if the IMAP LIST fails we do NOT pretend
 * the tree is verified — we fall back to the UNION of everything InboxQ already
 * knows (account folders, custom filing folders, folders holding stored mail,
 * folders with a sync cursor) and return live:false. Never infer that a folder
 * vanished from an interrupted scan.
 */
async function hFolderTree(ctx, deps) {
  const accountId = ctx.query?.accountId || ctx.body?.accountId || null;
  if (!accountId) return bad('accountId required');
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);

  // GMAIL: present labels AS the folder tree (owner 2026-10-05). Gmail has no
  // folders — one message lives in All Mail and carries labels. Each label is a
  // tree node the UI renders exactly like a folder; selecting it filters by
  // label (hSearchMessages). System labels get friendly names; Inbox is pinned
  // first. `gmail:true` lets the UI label the group ("Labels" not "Folders").
  if (isGmailAccount(account)) {
    const labels = store.listLabels(ctx.orgId, account.id);
    const order = (l) => (l === '\\Inbox' ? 0 : l === '\\Sent' ? 1 : l === '\\Starred' ? 2 : l === '\\Important' ? 3 : 10);
    const nodes = labels
      .sort((a, b) => (order(a.label) - order(b.label)) || (b.count - a.count))
      .map((l) => ({ path: l.label, name: gmailLabelName(l.label), depth: 0, stored: l.count, watched: true, label: true }));
    return ok({ live: true, gmail: true, folders: nodes });
  }

  // Facts from the store — always available, never a live dependency.
  const counts = store.countByFolder(ctx.orgId, account.id);
  const statesByFolder = Object.fromEntries(store.listFolderStates(ctx.orgId, account.id).map((s) => [s.folder, s]));
  const watched = new Set(account.folders || []);

  // Best-effort live folder set.
  let live = true;
  let detailed = [];
  try {
    const cred = await (deps.resolveCredential || defaultResolve)(ctx.orgId, account.credentialId);
    if (!cred.imap_host || !cred.username || !cred.password) throw new Error('credential_incomplete');
    const doList = deps.listFoldersDetailed || listFoldersDetailed;
    detailed = await doList({ host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password });
  } catch (e) {
    live = false;
    detailed = [];
  }

  const delimByPath = new Map();
  for (const d of detailed) delimByPath.set(d.path, d.delimiter || null);

  let paths;
  if (live) {
    paths = detailed.map((d) => d.path).filter(Boolean);
  } else {
    const known = new Set();
    for (const f of (account.folders || [])) known.add(f);
    for (const f of store.listFolders(ctx.orgId, account.id)) known.add(f.imapPath);
    for (const f of Object.keys(counts)) known.add(f);
    for (const f of Object.keys(statesByFolder)) known.add(f);
    paths = Array.from(known).filter(Boolean);
  }

  // One fallback delimiter for paths the live list didn't annotate: '/' if any
  // path uses it, else '.' (the Dovecot/Plesk default our stored paths use).
  const fallbackDelim = paths.some((p) => p.includes('/')) ? '/' : '.';
  const folders = paths
    .slice()
    .sort()
    .map((path) => {
      const delim = delimByPath.get(path) || fallbackDelim;
      const parts = delim ? path.split(delim) : [path];
      const depth = parts.length - 1;
      const name = parts[parts.length - 1] || path;
      const parent = depth > 0 ? parts.slice(0, -1).join(delim) : null;
      const st = statesByFolder[path] || null;
      return {
        path,
        name,
        depth,
        parent,
        delimiter: delim,
        stored: counts[path] || 0,
        watched: watched.has(path),
        lastReconcileAt: st ? st.lastSyncAt : null,
        consecutiveFailures: st ? st.consecutiveFailures : 0,
        retired: st ? !!st.retired : false,
      };
    });

  return ok({ live, folders });
}

/**
 * Create a durable filing folder: infer the account's IMAP naming
 * convention, run the real IMAP CREATE, then persist the record. Shared by
 * the direct human route (hCreateFolder), an approved 'folder_create'
 * proposal (executeFolderCreateProposal), and inbox_propose_move's
 * createFolderIfMissing leg (executeFileProposal) — one implementation, so
 * every "create this folder" path runs identical IMAP behaviour. Throws on
 * any failure; each caller maps the error to its own surface (an HTTP status
 * for the route, a 'failed' proposal status for the executors).
 */
async function createFolderInternal(orgId, accountId, name, deps, createdBy = null) {
  const account = store.getAccount(orgId, accountId);
  if (!account) throw new Error('account_not_found');

  // Case-insensitive collision check BEFORE creating anything server-side.
  // Some IMAP servers (e.g. iCloud) are case-sensitive, so a naive create
  // would make a genuine duplicate mailbox when the user's requested name
  // differs only by case from a folder we already know about (either a
  // tracked inboxq_folders record, or a folder already synced from the
  // server that was never "created" via the app). Reuse the existing one
  // instead — never silently create a server duplicate.
  const wantLower = String(name).toLowerCase();
  const existingFolderRecord = store.listFolders(orgId, accountId)
    .find((f) => f.name.toLowerCase() === wantLower || f.imapPath.toLowerCase() === wantLower);
  if (existingFolderRecord) return existingFolderRecord;

  const existing = Array.isArray(account.folders) ? account.folders : [];
  const existingSyncedPath = existing.find((f) => String(f).toLowerCase() === wantLower);
  if (existingSyncedPath) {
    // A real server folder already exists under this name (case-insensitive)
    // but has no inboxq_folders row yet (never "created" via the app) —
    // persist a record pointing at the REAL path so future refs (and the
    // folders_json synced list) agree on one canonical casing, without
    // calling createImapFolder again.
    return store.createFolder({ orgId, accountId, name: existingSyncedPath, imapPath: existingSyncedPath, createdBy });
  }

  // Match the account's existing IMAP folder naming convention: Plesk-style
  // servers namespace custom folders as "INBOX.<name>"; other servers use a
  // bare top-level name. Infer from the account's already-discovered folders
  // rather than hardcoding one server's convention.
  const usesInboxPrefix = existing.some((f) => /^INBOX\./i.test(f));
  const imapPath = usesInboxPrefix ? `INBOX.${name}` : name;

  let cred;
  try {
    cred = await (deps.resolveCredential || defaultResolve)(orgId, account.credentialId);
  } catch (e) {
    throw new Error(`credential check failed: ${e.message}`);
  }
  if (!cred.imap_host || !cred.username || !cred.password) throw new Error('credential_incomplete');

  await (deps.createImapFolder || createImapFolder)({
    host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password, path: imapPath,
  });

  const folder = store.createFolder({ orgId, accountId, name, imapPath, createdBy });

  // Add the new folder to the account's synced folder list immediately. Every
  // dashboard destination dropdown (File, Rules, bulk move) reads
  // account.folders, so without this a just-created folder stays invisible until
  // the next full sync re-discovers it — the "folder I just created is not
  // listed" bug. Best-effort: the folder itself already exists if this fails.
  try {
    const current = Array.isArray(account.folders) ? account.folders : ['INBOX'];
    if (!current.includes(imapPath)) {
      store.updateAccountFolders(orgId, accountId, [...current, imapPath]);
    }
  } catch { /* non-fatal: the folder was created; the list refreshes on next sync */ }

  return folder;
}

async function hCreateFolder(ctx, deps) {
  const { accountId, name } = ctx.body || {};
  if (!accountId || !name) return bad('accountId and name required');
  let folder;
  try {
    folder = await createFolderInternal(ctx.orgId, accountId, name, deps, ctx.userId || null);
  } catch (e) {
    if (e.message === 'account_not_found') return bad('account not found', 404);
    if (e.message === 'credential_incomplete' || e.message.startsWith('credential check failed')) return bad(e.message, 422);
    return bad(`imap folder create failed: ${e.message}`, 502);
  }
  deps.audit?.({ type: 'action', intent: 'quox.inbox.folder.create', corr: folder.id, payload: { orgId: ctx.orgId, accountId, name, imapPath: folder.imapPath } });
  return ok({ folder });
}

/**
 * Execute an approved 'folder_create' proposal via the SAME internal
 * createFolderInternal the direct route uses. proposal.accountId carries the
 * target account (set at propose time); payload only needs the folder name.
 */
async function executeFolderCreateProposal(orgId, proposal, deps) {
  const { name } = proposal.payload || {};
  if (!name) throw new Error('proposal_missing_name');
  const folder = await createFolderInternal(orgId, proposal.accountId, name, deps, proposal.createdBy || null);
  return { folder };
}

async function hDeleteFolder(ctx, deps) {
  // v1/P1: this UNLINKS the InboxQ folder RECORD only. It does NOT delete the
  // real IMAP mailbox — a folder may still hold messages, and blind mailbox
  // deletion from a governance record with no UI confirmation of data loss is
  // unsafe. A guarded "also delete the IMAP mailbox" action is future work.
  const removed = store.deleteFolder(ctx.orgId, ctx.params.folderId);
  if (!removed) return bad('folder not found', 404);
  deps.audit?.({ type: 'action', intent: 'quox.inbox.folder.delete', corr: ctx.params.folderId, payload: { orgId: ctx.orgId } });
  return ok({ removed: true });
}

/**
 * User refiles a message (drags it from one zone to another). This is the
 * feedback-loop write side of the learning layer (§3.3): it both updates the
 * stored message's zone AND records the move against the sender's reputation
 * row, so future mail from this sender inherits the correction.
 */
async function hMoveMessage(ctx, deps) {
  const { toZone } = ctx.body || {};
  if (!toZone || !ZONES.includes(toZone)) return bad(`toZone must be one of ${ZONES.join('|')}`);
  const msg = store.getMessage(ctx.orgId, ctx.params.id);
  if (!msg) return bad('message not found', 404);
  const fromZone = msg.zone;
  const updated = store.updateMessageZone(ctx.orgId, msg.id, toZone);
  if (!updated) return bad('message not found', 404);
  try {
    store.recordUserMove({ orgId: ctx.orgId, accountId: msg.accountId, fromAddr: msg.fromAddr, toZone, fromZone });
  } catch { /* reputation feedback is best-effort; the move itself must still succeed */ }
  deps.audit?.({ type: 'action', intent: 'quox.inbox.message.move', corr: msg.id, payload: { orgId: ctx.orgId, fromZone, toZone } });
  return ok({ message: { ...msg, zone: toZone } });
}

/**
 * Re-run the classification pipeline (reputation verdict, then classify())
 * over an account's already-synced mail, so classifier improvements and
 * newly-learned reputation apply retroactively. Bounded to the store's
 * listMessages cap (500) per call — a large mailbox is reclassified across
 * multiple calls rather than loading everything into memory at once.
 */
async function hReclassify(ctx, deps) {
  const { accountId } = ctx.body || {};
  if (!accountId) return bad('accountId required');
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);
  const doClassify = deps.classify || classify;
  const llm = typeof deps.llmForOrg === 'function' ? deps.llmForOrg(ctx.orgId) : (deps.llm || null);
  const messages = store.listMessages(ctx.orgId, { accountId, limit: 500 });
  const counts = {};
  let updated = 0;
  for (const m of messages) {
    const repVerdict = store.getReputationVerdict(ctx.orgId, { accountId, fromAddr: m.fromAddr });
    const cls = repVerdict.verdict
      ? { zone: repVerdict.verdict, flags: [], by: 'reputation' }
      : await doClassify(
        { folder: m.folder, fromAddr: m.fromAddr, fromName: m.fromName, subject: m.subject, snippet: m.snippet },
        { llm, budget: deps.budget || null },
      );
    if (cls.zone !== m.zone) {
      store.updateMessageZone(ctx.orgId, m.id, cls.zone);
      updated += 1;
    }
    counts[cls.zone] = (counts[cls.zone] || 0) + 1;
  }
  deps.audit?.({ type: 'action', intent: 'quox.inbox.reclassify', corr: accountId, payload: { orgId: ctx.orgId, counts, updated, total: messages.length } });
  return ok({ counts, updated, total: messages.length });
}

/**
 * Domain-scope block execution: mark the domain blocked + screen every
 * currently-stored message at that domain. Pure store mutation, no IMAP —
 * see the "no best-effort IMAP move for domain scope" note below. Shared by
 * the instant human route (hBlockSender) and an approved 'block' proposal
 * (executeBlockProposal) so both paths run IDENTICAL mutation logic.
 *
 * No best-effort IMAP move for domain scope: a domain block spans an
 * unbounded set of senders/messages, and blindly IMAP-moving all of them is
 * a bigger, riskier mail effect than the single-sender case below. The zone
 * re-classification above is the source of truth and is sufficient for the
 * request to succeed; a real IMAP move for a domain block is deferred work.
 */
/**
 * Resolve a real Junk/Spam folder to move blocked mail into (owner 2026-10-07).
 * Block was effectively a no-op on an account that had not synced a junk folder
 * (e.g. examplepools folders=["INBOX"]): the mail was re-zoned "screened" but NEVER
 * physically moved, so it stayed in INBOX and looked like the block "came back".
 * Now: (1) an already-synced junk folder; else (2) a real one on the server
 * (special-use \\Junk, or a spam/junk/bulk name), added to the synced set; else
 * (3) create one. Returns its imapPath, or null only if the server refuses both
 * discovery and creation.
 */
async function resolveJunkFolder(orgId, account, deps) {
  const synced = Array.isArray(account.folders) ? account.folders : [];
  const already = synced.find((f) => /\b(spam|junk|bulk)\b/i.test(f));
  if (already) return already;
  let detailed = [];
  try {
    const cred = await (deps.resolveCredential || defaultResolve)(orgId, account.credentialId);
    if (cred && cred.imap_host && cred.username && cred.password) {
      detailed = await (deps.listFoldersDetailed || listFoldersDetailed)({ host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password });
    }
  } catch { /* fall through to create */ }
  const found = (detailed || []).find((f) => f && f.path && (f.specialUse === '\\Junk' || /\b(spam|junk|bulk)\b/i.test(f.path)));
  if (found) {
    try {
      if (!synced.includes(found.path)) store.updateAccountFolders(orgId, account.id, [...synced, found.path]);
    } catch { /* non-fatal: the move below still works against the real path */ }
    return found.path;
  }
  try {
    const folder = await createFolderInternal(orgId, account.id, 'Junk', deps, null);
    return folder.imapPath;
  } catch { return null; }
}

/**
 * Shared best-effort IMAP move of a block target's currently-stored mail into
 * the account's Junk/Spam folder, used by BOTH runSenderBlock and
 * runDomainBlock so sender and domain blocks physically move mail the same way.
 * Owner audit 2026-10-07: a domain block used to only re-zone to 'screened'
 * (no server move), so blocked mail "came back" in other clients and read as
 * unmoved. The caller's zone screening is the source of truth and must still
 * succeed, so every failure here is logged and surfaced via junkFailed, never
 * thrown. junkMoved is the REAL server move count, never the requested count.
 * `matcher` selects which stored messages belong to the block target.
 */
async function moveBlockedToJunk(orgId, account, matcher, deps) {
  let junkFolder = null;
  let junkMatched = 0;
  let junkMoved = 0;
  let junkFailed = false;
  try {
    junkFolder = await resolveJunkFolder(orgId, account, deps);
    if (junkFolder) {
      const matching = store.listMessages(orgId, { accountId: account.id, limit: 500 })
        .filter((m) => m.folder !== junkFolder && matcher(m));
      junkMatched = matching.length;
      if (matching.length) {
        const cred = await (deps.resolveCredential || defaultResolve)(orgId, account.credentialId);
        if (cred && cred.imap_host && cred.username && cred.password) {
          const doMove = deps.moveMessages || moveMessages;
          const bySourceFolder = new Map();
          for (const m of matching) {
            if (!bySourceFolder.has(m.folder)) bySourceFolder.set(m.folder, []);
            bySourceFolder.get(m.folder).push(m);
          }
          for (const [sourceFolder, msgs] of bySourceFolder) {
            const uids = msgs.map((m) => m.uid);
            const res = await doMove({
              host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password,
              folder: sourceFolder, uids, targetPath: junkFolder,
            });
            for (const m of msgs) {
              store.updateMessageFolder(orgId, m.id, { folder: junkFolder, uid: destUidFor(res, m.uid), uidvalidity: destUidValidityOf(res) });
            }
            junkMoved += (res && typeof res.moved === 'number') ? res.moved : uids.length;
          }
        } else {
          // A Junk folder exists and mail matched, but there is no usable
          // credential to move it: honestly a failed move, not a clean one.
          junkFailed = true;
        }
      }
    }
  } catch (e) {
    junkFailed = true;
    // Best-effort only: never fail the block on an IMAP or credential problem,
    // but record it so the caller reports the real outcome.
    console.error('[inboxq] block: best-effort IMAP move failed:', e?.message);
  }
  return { junkFolder, junkMatched, junkMoved, junkFailed };
}

/**
 * Domain-scope block execution. markBlocked sets the human-marked-bad
 * reputation signal (the next sync's fast-path screens future mail from this
 * domain), screenDomainMessages re-zones currently-stored mail to 'screened',
 * and moveBlockedToJunk physically moves that mail to Junk (best-effort),
 * matching the SAME `%@<domain>` set screenDomainMessages screens. providerRule
 * stays 'none': no server-side rule yet, so a blocked domain can still arrive
 * in other clients until the provider-rule work (P5) lands.
 */
async function runDomainBlock(orgId, account, normalizedDomain, deps = {}) {
  store.markBlocked({ orgId, accountId: account.id, target: normalizedDomain, type: 'domain' });
  const screened = store.screenDomainMessages(orgId, account.id, normalizedDomain);
  const suffix = '@' + normalizedDomain;
  const { junkFolder, junkMatched, junkMoved, junkFailed } = await moveBlockedToJunk(
    orgId, account,
    (m) => (m.fromAddr || '').toString().trim().toLowerCase().endsWith(suffix),
    deps,
  );
  return { screened, junkFolder, junkMatched, junkMoved, junkFailed, providerRule: 'none' };
}

/**
 * Sender-scope block execution:
 * 1. markBlocked sets the human-marked-bad reputation signal so the NEXT
 *    sync's fast-path (getReputationVerdict, consulted in syncWorker.js
 *    before classify()) screens future mail from this sender immediately.
 * 2. screenSenderMessages re-zones this sender's currently-stored messages to
 *    'screened' right away — the source of truth for why same-sender rows
 *    vanish from Focus/FYI; this alone makes the request succeed.
 * 3. moveBlockedToJunk performs the OPTIONAL best-effort IMAP move to a
 *    Junk/Spam folder; any failure is logged and surfaced via junkFailed.
 * Shared by the instant human route (hBlockSender) and an approved 'block'
 * proposal (executeBlockProposal) so an agent-initiated block runs the exact
 * same screen+junk-move the human "Block sender" button does.
 */
async function runSenderBlock(orgId, account, normalized, deps) {
  store.markBlocked({ orgId, accountId: account.id, target: normalized, type: 'sender' });
  const screened = store.screenSenderMessages(orgId, account.id, normalized);
  const { junkFolder, junkMatched, junkMoved, junkFailed } = await moveBlockedToJunk(
    orgId, account,
    (m) => (m.fromAddr || '').toString().trim().toLowerCase() === normalized,
    deps,
  );
  return { screened, junkFolder, junkMatched, junkMoved, junkFailed, providerRule: 'none' };
}

/**
 * Instant, human-authoritative "Block sender" — a HUMAN clicking Block
 * executes immediately, with NO approval queue. Separate from the
 * agent-initiated hCreateProposal(kind:'block') / hResolveProposal path (see
 * executeBlockProposal below), which still gates an agent's block suggestion
 * behind human approval; this route never touches inboxq_proposals. Both
 * paths call the SAME runDomainBlock/runSenderBlock mutation functions above,
 * so they can never diverge in what a block actually does.
 */
async function hBlockSender(ctx, deps) {
  const { fromAddr, accountId, scope = 'sender', domain: domainOverride } = ctx.body || {};
  if (!accountId) return bad('fromAddr and accountId required');
  if (!['sender', 'domain'].includes(scope)) return bad('scope must be sender|domain');
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);

  if (scope === 'domain') {
    // Domain scope: derive the domain from fromAddr when no explicit domain
    // is supplied, so an existing "Block sender" UI can add a second button
    // that reuses the same fromAddr the user already selected.
    const derived = domainOverride || (fromAddr ? fromAddr.toString().split('@')[1] : '');
    const normalizedDomain = (derived || '').toString().trim().toLowerCase();
    if (!normalizedDomain) return bad('domain required (pass fromAddr or domain)');

    const outcome = await runDomainBlock(ctx.orgId, account, normalizedDomain, deps);
    deps.audit?.({ type: 'action', intent: 'quox.inbox.sender.block', corr: accountId, payload: { orgId: ctx.orgId, scope, target: normalizedDomain, screened: outcome.screened, junkMoved: outcome.junkMoved } });
    return ok({ ok: true, scope, target: normalizedDomain, ...outcome });
  }

  if (!fromAddr) return bad('fromAddr and accountId required');
  const normalized = fromAddr.toString().trim().toLowerCase();
  if (!normalized) return bad('fromAddr required');

  const outcome = await runSenderBlock(ctx.orgId, account, normalized, deps);

  deps.audit?.({ type: 'action', intent: 'quox.inbox.sender.block', corr: accountId, payload: { orgId: ctx.orgId, scope, fromAddr: normalized, screened: outcome.screened, junkMoved: outcome.junkMoved, junkFailed: outcome.junkFailed, providerRule: outcome.providerRule } });
  return ok({ ok: true, scope, target: normalized, sender: normalized, ...outcome });
}

/**
 * Execute an approved 'block' proposal via the SAME runDomainBlock/
 * runSenderBlock functions the instant human route calls — the whole point
 * of the refactor: an agent-proposed block, once approved, does exactly what
 * the big red Block button does, never a lesser or different action.
 * proposal.accountId carries the target account; payload carries scope +
 * target (or the legacy fromAddr shape hCreateProposal already accepted).
 */
async function executeBlockProposal(orgId, proposal, deps) {
  const { scope = 'sender', target, fromAddr, domain: domainOverride } = proposal.payload || {};
  if (!['sender', 'domain'].includes(scope)) throw new Error('proposal_invalid_scope');
  const account = store.getAccount(orgId, proposal.accountId);
  if (!account) throw new Error('account_not_found');

  if (scope === 'domain') {
    const derived = target || domainOverride || (fromAddr ? fromAddr.toString().split('@')[1] : '');
    const normalizedDomain = (derived || '').toString().trim().toLowerCase().replace(/^@/, '');
    if (!normalizedDomain) throw new Error('domain_required');
    const outcome = await runDomainBlock(orgId, account, normalizedDomain, deps);
    return { scope, target: normalizedDomain, ...outcome };
  }

  const raw = target || fromAddr;
  const normalized = (raw || '').toString().trim().toLowerCase();
  if (!normalized) throw new Error('fromAddr_required');
  const outcome = await runSenderBlock(orgId, account, normalized, deps);
  return { scope, target: normalized, ...outcome };
}

/**
 * P1 manual sort: instant, human-authoritative "Move to folder" — a HUMAN
 * clicking/dragging a message onto a folder executes immediately, with NO
 * approval queue, mirroring hBlockSender's contract above. Distinct from the
 * agent-gated 'file' proposal path (hCreateProposal/hResolveProposal +
 * executeFileProposal): this route performs the real, safe IMAP UID MOVE
 * (never COPY+EXPUNGE, via the SAME imap.js moveMessages helper
 * executeFileProposal uses) directly, on the human's say-so alone.
 *
 * Per-message failure isolation: a messageId that does not resolve (unknown,
 * or belongs to another org) is skipped into `failed` without aborting the
 * batch; the resolved messages are grouped by their CURRENT stored folder
 * (a batch may span more than one source folder, same as executeFileProposal)
 * and each source folder's IMAP move is attempted independently — one
 * folder's IMAP error only fails the ids in that folder, the rest still move.
 */
async function hMoveToFolder(ctx, deps) {
  const { messageIds, folder: folderRef, accountId } = ctx.body || {};
  if (!accountId || !folderRef) return bad('folder and accountId required');
  if (!Array.isArray(messageIds) || messageIds.length === 0) return bad('messageIds required');
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);
  const targetFolder = resolveFolderRef(ctx.orgId, account.id, folderRef);
  if (!targetFolder) return bad('target folder not found', 404);

  let cred;
  try {
    cred = await (deps.resolveCredential || defaultResolve)(ctx.orgId, account.credentialId);
    if (!cred.imap_host || !cred.username || !cred.password) return bad('credential_incomplete', 422);
  } catch (e) {
    return bad(`credential check failed: ${e.message}`, 422);
  }

  const failed = [];
  const bySourceFolder = new Map();
  for (const id of messageIds) {
    // org-scoped AND account-scoped lookup: a cross-org, cross-account (an id
    // belonging to a DIFFERENT mailbox in the same org), or unknown id simply
    // fails in isolation. Account-scoping matters because the move runs against
    // THIS account's credentials and source folder — a sibling account's uid
    // would move the wrong mail and then corrupt that account's stored location.
    const m = store.getMessage(ctx.orgId, id);
    if (!m || m.accountId !== accountId) { failed.push(id); continue; }
    if (!bySourceFolder.has(m.folder)) bySourceFolder.set(m.folder, []);
    bySourceFolder.get(m.folder).push(m);
  }

  const doMove = deps.moveMessages || moveMessages;
  // AQ-9E U2: `moved` is the ARRAY of moved message ids (the frontend needs the
  // ids to know WHICH rows to clear — a bare count can't tell success rows from
  // failed ones), and `moves` carries the undo-log entries this batch created.
  const moved = [];
  const moves = [];
  for (const [sourceFolder, msgs] of bySourceFolder) {
    const uids = msgs.map((m) => m.uid);
    try {
      const res = await doMove({
        host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password,
        folder: sourceFolder, uids, targetPath: targetFolder.imapPath,
      });
      for (const m of msgs) {
        const destUid = destUidFor(res, m.uid);
        const destUidValidity = destUidValidityOf(res);
        store.updateMessageFolder(ctx.orgId, m.id, { folder: targetFolder.imapPath, uid: destUid, uidvalidity: destUidValidity });
        moved.push(m.id);
        // Record a reversible move: pre-move identity (to put it back) + post-move
        // location (to find it). message_ref carries the RFC Message-ID so undo
        // can re-resolve when the destination uid was never confirmed.
        const moveId = store.recordMove(ctx.orgId, {
          accountId, messageId: m.id, messageRef: m.messageId || null,
          fromFolder: sourceFolder, fromUid: m.uid, fromUidvalidity: m.uidvalidity || null,
          toFolder: targetFolder.imapPath, toUid: destUid, toUidvalidity: destUidValidity,
          kind: 'move',
        });
        moves.push({ id: moveId, messageId: m.id, fromFolder: sourceFolder, toFolder: targetFolder.imapPath });
      }
    } catch (e) {
      // This source folder's IMAP move failed — isolate the failure to its
      // own ids and keep processing any other source folders in the batch.
      for (const m of msgs) failed.push(m.id);
    }
  }

  deps.audit?.({ type: 'action', intent: 'quox.inbox.messages.move_to_folder', corr: accountId, payload: { orgId: ctx.orgId, folder: targetFolder.imapPath, moved: moved.length, failed: failed.length } });
  return ok({ moved, failed, moves });
}

/**
 * AQ-9E U2: reverse a recorded move. Looks up the undo-log entry (org-scoped),
 * performs the reverse IMAP move from the destination folder back to the source
 * folder, updates the stored location, and marks the move undone. Idempotent-
 * safe: a move already undone 409s rather than moving anything a second time.
 * The destination UID to reverse is the recorded to_uid; when that was never
 * confirmed (null), it is re-resolved by Message-ID in the destination folder
 * (and a message that still cannot be located honestly 409s rather than moving
 * the wrong mail).
 */
async function hUndoMove(ctx, deps) {
  const { moveId } = ctx.body || {};
  if (!moveId) return bad('moveId required');
  const move = store.getMove(ctx.orgId, moveId);
  if (!move) return bad('move not found', 404);
  if (move.undone) return bad('move already undone', 409);
  const account = store.getAccount(ctx.orgId, move.accountId);
  if (!account) return bad('account not found', 404);

  // #3 stale-move guard: the recorded destination is only safe to reverse while
  // the message is still where this move left it. If it has since moved again
  // (its stored folder no longer matches move.toFolder), undoing would act on
  // the wrong mail — refuse rather than move whatever now sits at the old uid.
  const stored = store.getMessage(ctx.orgId, move.messageId);
  if (!stored) return bad('message not found', 404);
  if (stored.folder !== move.toFolder) return bad('move superseded by a later change', 409);

  let cred;
  try {
    cred = await (deps.resolveCredential || defaultResolve)(ctx.orgId, account.credentialId);
    if (!cred.imap_host || !cred.username || !cred.password) return bad('credential_incomplete', 422);
  } catch (e) {
    return bad(`credential check failed: ${e.message}`, 422);
  }

  // Find the message's CURRENT uid in the destination folder.
  let curUid = move.toUid;
  if (curUid == null) {
    if (!move.messageRef) return bad('unresolved_location', 409);
    try {
      const doFetch = deps.fetchByMessageId || fetchByMessageId;
      const hits = await doFetch({
        host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password,
        folder: move.toFolder, messageId: move.messageRef,
      });
      const hit = Array.isArray(hits) ? hits.find((h) => h && h.messageId === move.messageRef) : null;
      if (!hit || hit.uid == null) return bad('unresolved_location', 409);
      curUid = hit.uid;
    } catch (e) {
      return bad(`undo re-resolve failed: ${e.message}`, 422);
    }
  }

  const doMove = deps.moveMessages || moveMessages;
  let res;
  try {
    res = await doMove({
      host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password,
      folder: move.toFolder, uids: [curUid], targetPath: move.fromFolder,
    });
  } catch (e) {
    return bad(`undo move failed: ${e.message}`, 502);
  }

  const newUid = destUidFor(res, curUid);
  const newUidValidity = destUidValidityOf(res);
  store.updateMessageFolder(ctx.orgId, move.messageId, { folder: move.fromFolder, uid: newUid, uidvalidity: newUidValidity });
  store.markMoveUndone(ctx.orgId, moveId);
  deps.audit?.({ type: 'action', intent: 'quox.inbox.move.undo', corr: move.accountId, payload: { orgId: ctx.orgId, moveId, messageId: move.messageId, restoredTo: move.fromFolder } });
  return ok({ ok: true, moveId, messageId: move.messageId, restoredTo: move.fromFolder, uid: newUid });
}

/** AQ-9E U2: recent undoable moves for an account (newest first). */
async function hListMoves(ctx) {
  const { accountId, limit } = ctx.query || {};
  const moves = store.listRecentMoves(ctx.orgId, { accountId: accountId || null, limit: limit ? Number(limit) : 20 });
  return ok({ moves });
}

/**
 * P1 manual sort: instant, human-authoritative "Trust sender" — the ALLOW
 * mirror of hBlockSender above, with no approval queue. Sets the dedicated
 * `trusted` reputation flag (store.markSenderTrusted), which
 * getReputationVerdict now honours as its FIRST-checked fast path (wins over
 * a stale blocked/spam signal — see store.js), then re-zones this sender's
 * currently-stored Screened/FYI/Auto mail back to 'focus' right away
 * (store.restoreSenderMessages) — the source of truth for the human seeing
 * the sender's mail return to Focus immediately, independent of any future
 * sync/reclassify pass. Pure store mutation, no IMAP effect (best-effort:
 * nothing external is required for a trust decision to take hold).
 */
async function hTrustSender(ctx, deps) {
  const { fromAddr, accountId } = ctx.body || {};
  if (!fromAddr || !accountId) return bad('fromAddr and accountId required');
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);
  const normalized = fromAddr.toString().trim().toLowerCase();
  if (!normalized) return bad('fromAddr required');

  store.markSenderTrusted({ orgId: ctx.orgId, accountId: account.id, fromAddr: normalized });
  const restored = store.restoreSenderMessages(ctx.orgId, account.id, normalized);

  deps.audit?.({ type: 'action', intent: 'quox.inbox.sender.trust', corr: accountId, payload: { orgId: ctx.orgId, fromAddr: normalized, restored } });
  return ok({ ok: true, restored });
}

/** GET /senders/blocked?accountId= -> { blocked: [{target,type,blockedAt}] }. */
async function hListBlocked(ctx) {
  const accountId = ctx.query?.accountId || null;
  if (!accountId) return bad('accountId required');
  return ok({ blocked: store.listBlocked(ctx.orgId, accountId) });
}

/** POST /senders/unblock {target, type, accountId} -> { ok, target, type }. */
async function hUnblock(ctx, deps) {
  const { target, type = 'sender', accountId } = ctx.body || {};
  if (!target || !accountId) return bad('target and accountId required');
  if (!['sender', 'domain'].includes(type)) return bad('type must be sender|domain');
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);
  const changed = store.unblock(ctx.orgId, accountId, target, type);
  if (!changed) return bad('not blocked', 404);
  deps.audit?.({ type: 'action', intent: 'quox.inbox.sender.unblock', corr: accountId, payload: { orgId: ctx.orgId, target, type } });
  return ok({ ok: true, target, type });
}

// --- rules (P3: user-defined auto-sort, the owner's "spamfilter-blocker") -----
//
// See lib/inboxq/rules.js for match semantics. Applied on every sync
// (syncWorker.js, BEFORE reputation-block, AFTER trusted-sender allow) and
// against a backlog of already-stored mail via hApplyRules below.

/** GET /rules?accountId= -> { rules }. */
async function hListRules(ctx) {
  const accountId = ctx.query?.accountId || null;
  if (!accountId) return bad('accountId required');
  return ok({ rules: store.listRules(ctx.orgId, accountId) });
}

/** POST /rules {accountId, matchType, matchValue, action, targetFolder?, priority?, enabled?} -> { rule }. */
async function hCreateRule(ctx, deps) {
  const { accountId, matchType, matchValue, action, targetFolder, priority, enabled } = ctx.body || {};
  if (!accountId) return bad('accountId required');
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);
  let rule;
  try {
    rule = store.createRule({
      orgId: ctx.orgId,
      accountId,
      matchType,
      matchValue,
      action,
      targetFolder: targetFolder || null,
      enabled: enabled !== undefined ? Boolean(enabled) : true,
      priority: priority !== undefined ? Number(priority) : 0,
      createdBy: ctx.userId || null,
    });
  } catch (e) {
    return bad(e.message, 422);
  }
  deps.audit?.({ type: 'action', intent: 'quox.inbox.rule.create', corr: rule.id, payload: { orgId: ctx.orgId, accountId, matchType, matchValue, action, targetFolder: targetFolder || null } });
  return ok({ rule });
}

/** PATCH /rules/:ruleId {matchType?, matchValue?, action?, targetFolder?, priority?, enabled?} -> { rule }. */
async function hUpdateRule(ctx, deps) {
  const ruleId = ctx.params.ruleId;
  const existing = store.getRule(ctx.orgId, ruleId);
  if (!existing) return bad('rule not found', 404);
  const { matchType, matchValue, action, targetFolder, priority, enabled } = ctx.body || {};
  let rule;
  try {
    rule = store.updateRule(ctx.orgId, ruleId, {
      matchType, matchValue, action,
      targetFolder: targetFolder !== undefined ? (targetFolder || null) : undefined,
      priority, enabled,
    });
  } catch (e) {
    return bad(e.message, 422);
  }
  if (!rule) return bad('rule not found', 404);
  deps.audit?.({ type: 'action', intent: 'quox.inbox.rule.update', corr: rule.id, payload: { orgId: ctx.orgId, ruleId: rule.id, enabled: rule.enabled } });
  return ok({ rule });
}

/** DELETE /rules/:ruleId -> { removed }. */
async function hDeleteRule(ctx, deps) {
  const ruleId = ctx.params.ruleId;
  const removed = store.deleteRule(ctx.orgId, ruleId);
  if (!removed) return bad('rule not found', 404);
  deps.audit?.({ type: 'action', intent: 'quox.inbox.rule.delete', corr: ruleId, payload: { orgId: ctx.orgId } });
  return ok({ removed: true });
}

/**
 * POST /rules/preview {matchType, matchValue, accountId} -> { matchCount, sample }.
 * D4: a DRY-RUN over the account's already-STORED messages so the UI can show
 * "this would match N" before the human saves the rule — never touches IMAP,
 * never mutates anything. Same scan window as hReclassify/hApplyRules (the
 * account's most recent 500 stored messages, store.listMessages' own cap) —
 * matchCount and sample are honest counts within that window, not a claim
 * about the account's entire mail history.
 */
async function hPreviewRule(ctx) {
  const { matchType, matchValue, accountId } = ctx.body || {};
  if (!accountId) return bad('accountId required');
  if (!RULE_MATCH_TYPES.includes(matchType)) return bad(`matchType must be one of: ${RULE_MATCH_TYPES.join(', ')}`);
  if (!matchValue || !matchValue.toString().trim()) return bad('matchValue required');
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);
  const candidateRule = { matchType, matchValue, enabled: true };
  const rows = store.listMessages(ctx.orgId, { accountId, limit: 500 });
  const matches = rows.filter((m) => matchRule(candidateRule, m));
  return ok({
    matchCount: matches.length,
    sample: matches.slice(0, 10).map((m) => ({ id: m.id, fromAddr: m.fromAddr, fromName: m.fromName, subject: m.subject, dateTs: m.dateTs })),
  });
}

/**
 * POST /rules/apply {accountId, ruleId?} -> { applied, moved, screened, blocked }.
 * The user-triggered backlog pass: apply enabled rules (or just `ruleId`, if
 * given) to the account's already-stored mail, not just future sync ingest.
 * Same first-match-wins, highest-priority-first evaluation as the sync
 * path (findMatchingRule), over the same scanned window as hReclassify
 * (store.listMessages' 500-row cap). 'move' rules perform a real IMAP move
 * (best-effort: a credential failure downgrades to screen/block-only for
 * this pass, never a hard error); every message is failure-isolated by
 * grouping IMAP moves per (target folder, source folder) so one group's
 * failure never aborts the rest of the batch.
 */
async function hApplyRules(ctx, deps) {
  const { accountId, ruleId } = ctx.body || {};
  if (!accountId) return bad('accountId required');
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);

  let rules = store.listRules(ctx.orgId, accountId).filter((r) => r.enabled);
  if (ruleId) {
    rules = rules.filter((r) => r.id === ruleId);
    if (rules.length === 0) return bad('rule not found or disabled', 404);
  }
  if (rules.length === 0) return ok({ applied: 0, moved: 0, screened: 0, blocked: 0 });

  const messages = store.listMessages(ctx.orgId, { accountId, limit: 500 });

  // Resolving the credential is best-effort here: a screen/block-only backlog
  // pass must still succeed even when the mailbox credential is currently
  // broken — only 'move' rules need real IMAP access.
  let cred = null;
  try {
    cred = await (deps.resolveCredential || defaultResolve)(ctx.orgId, account.credentialId);
    if (!cred || !cred.imap_host || !cred.username || !cred.password) cred = null;
  } catch { cred = null; }

  const doMove = deps.moveMessages || moveMessages;
  const folderCache = new Map();
  const movesByTarget = new Map(); // targetPath -> matched messages
  let applied = 0;
  let screenedCount = 0;
  let blockedCount = 0;

  for (const m of messages) {
    const match = findMatchingRule(rules, m);
    if (!match) continue;
    applied += 1;
    if (match.action === 'block') {
      try { store.markBlocked({ orgId: ctx.orgId, accountId, target: m.fromAddr, type: 'sender' }); } catch { /* isolated — the zone update below is still attempted */ }
      if (store.updateMessageZone(ctx.orgId, m.id, 'screened')) blockedCount += 1;
    } else if (match.action === 'screen') {
      if (store.updateMessageZone(ctx.orgId, m.id, 'screened')) screenedCount += 1;
    } else if (match.action === 'move' && cred) {
      let targetFolder = folderCache.get(match.targetFolder);
      if (targetFolder === undefined) {
        targetFolder = resolveFolderRef(ctx.orgId, accountId, match.targetFolder);
        folderCache.set(match.targetFolder, targetFolder);
      }
      if (targetFolder) {
        if (!movesByTarget.has(targetFolder.imapPath)) movesByTarget.set(targetFolder.imapPath, []);
        movesByTarget.get(targetFolder.imapPath).push(m);
      }
    }
  }

  let movedCount = 0;
  for (const [targetPath, msgs] of movesByTarget) {
    const bySourceFolder = new Map();
    for (const m of msgs) {
      if (!bySourceFolder.has(m.folder)) bySourceFolder.set(m.folder, []);
      bySourceFolder.get(m.folder).push(m);
    }
    for (const [sourceFolder, msgs2] of bySourceFolder) {
      try {
        const uids = msgs2.map((m) => m.uid);
        const res = await doMove({
          host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password,
          folder: sourceFolder, uids, targetPath,
        });
        movedCount += (res && typeof res.moved === 'number') ? res.moved : uids.length;
        for (const m of msgs2) {
          store.updateMessageFolder(ctx.orgId, m.id, { folder: targetPath, uid: destUidFor(res, m.uid), uidvalidity: destUidValidityOf(res) });
        }
      } catch (e) {
        // This (target, source) group's move failed — isolated, the rest of
        // the batch (other groups, other actions) still applies.
      }
    }
  }

  deps.audit?.({ type: 'action', intent: 'quox.inbox.rule.apply', corr: accountId, payload: { orgId: ctx.orgId, ruleId: ruleId || null, applied, moved: movedCount, screened: screenedCount, blocked: blockedCount } });
  return ok({ applied, moved: movedCount, screened: screenedCount, blocked: blockedCount });
}

async function hGetSettings(ctx) {
  return ok({ settings: { ...store.getSettings(ctx.orgId), availableClassifierModels: store.AVAILABLE_CLASSIFIER_MODELS } });
}

async function hUpdateSettings(ctx, deps) {
  const { syncEnabled, syncIntervalMin, llmBudgetPerTick, classifierModel } = ctx.body || {};
  // Cost control: reject an out-of-list model rather than silently ignoring
  // or accepting an arbitrary (possibly expensive) model id. null/undefined
  // (disable) is always allowed.
  if (classifierModel !== undefined && classifierModel !== null) {
    const allowed = store.AVAILABLE_CLASSIFIER_MODELS.some((m) => m.id === classifierModel);
    if (!allowed) {
      return bad(`classifierModel must be one of: ${store.AVAILABLE_CLASSIFIER_MODELS.map((m) => m.id).join(', ')} (or null to disable)`);
    }
  }
  const settings = store.setSettings(ctx.orgId, { syncEnabled, syncIntervalMin, llmBudgetPerTick, classifierModel });
  deps.audit?.({ type: 'action', intent: 'quox.inbox.settings.update', corr: ctx.orgId, payload: { orgId: ctx.orgId, settings } });
  return ok({ settings: { ...settings, availableClassifierModels: store.AVAILABLE_CLASSIFIER_MODELS } });
}

// --- P3 physical filing engine ----------------------------------------------
//
// Off by default, per-org opt-in (inboxq_settings.physical_filing_enabled —
// same shape as syncEnabled/classifierModel). NEVER runs on connect. Folder
// mapping is store.zoneToFolder (focus always stays in INBOX; screened is
// always a REVIEW folder, never auto-Junk; fyi/auto are confidence-gated,
// low-confidence going to the Unsure review folder rather than being
// misfiled or left to rot — see store.js's doc comment for the exact bar).

/**
 * Idempotent: creates the 4 InboxQ/* mailboxes on the account's real IMAP
 * server (skipping any that already exist) and unions them into the
 * account's SYNCED folder set (store.updateAccountFolders) so they are both
 * browsable in the app and resolvable by store.resolveFolderRef's raw-synced-
 * path fallback — the exact mechanism the rules engine's custom-folder move
 * targets already rely on. Throws on a hard failure (bad credential, no IMAP
 * access at all); a single folder's CREATE failing (e.g. a races-with-itself
 * "already exists" from the server) is isolated and does not abort the rest.
 */
async function ensureFilingFolders(orgId, accountId, deps) {
  const account = store.getAccount(orgId, accountId);
  if (!account) throw new Error('account_not_found');
  const cred = await (deps.resolveCredential || defaultResolve)(orgId, account.credentialId);
  if (!cred.imap_host || !cred.username || !cred.password) throw new Error('credential_incomplete');

  let existingRemote = [];
  try {
    existingRemote = await (deps.listFolders || listFolders)({ host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password });
  } catch {
    // A listing failure is not fatal here — we simply attempt CREATE on all
    // 4 paths below and treat an "already exists"-shaped error as success.
    existingRemote = [];
  }
  const existingSet = new Set(existingRemote.map((f) => String(f).toLowerCase()));

  const created = [];
  for (const path of store.FILING_FOLDER_LIST) {
    if (existingSet.has(path.toLowerCase())) continue;
    try {
      await (deps.createImapFolder || createImapFolder)({ host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password, path });
      created.push(path);
    } catch (e) {
      // A folder that already exists (race, or the listing above missed it)
      // is not a failure; any other failure is isolated to this one folder
      // so the remaining 3 still get created.
      if (!/exist/i.test(e?.message || '')) {
        console.error(`[inboxq] filing: create folder "${path}" failed:`, e?.message);
      }
    }
  }

  const currentFolders = Array.isArray(account.folders) ? account.folders : ['INBOX'];
  const union = Array.from(new Set([...currentFolders, ...store.FILING_FOLDER_LIST]));
  if (union.length !== currentFolders.length) {
    store.updateAccountFolders(orgId, accountId, union);
  }

  return { created, folders: { ...store.FILING_FOLDERS } };
}

/**
 * The backlog counterpart of syncWorker.js's per-sync filing queue: scans the
 * account's already-STORED mail (store.listMessages' 500-row cap, same
 * window as hReclassify/hApplyRules), computes each message's filing target
 * via store.zoneToFolder(zone, confidence), and performs a real, safe IMAP
 * UID MOVE grouped by (target, source folder) so one group's failure never
 * aborts the rest — same failure-isolation shape as hApplyRules/
 * hMoveToFolder. A missing/broken credential fails every candidate message
 * in isolation (never throws) so the caller (hEnableFiling) can still report
 * enabled:true with an honest failed list.
 */
async function moveBacklogForFiling(orgId, accountId, deps) {
  const account = store.getAccount(orgId, accountId);
  if (!account) throw new Error('account_not_found');
  const messages = store.listMessages(orgId, { accountId, limit: 500 });
  const byTarget = new Map();
  for (const m of messages) {
    const target = store.zoneToFolder(m.zone, m.confidence);
    if (!target) continue;
    if (!byTarget.has(target)) byTarget.set(target, []);
    byTarget.get(target).push(m);
  }
  if (byTarget.size === 0) return { moved: 0, failed: [] };

  let cred = null;
  try {
    cred = await (deps.resolveCredential || defaultResolve)(orgId, account.credentialId);
    if (!cred || !cred.imap_host || !cred.username || !cred.password) cred = null;
  } catch { cred = null; }

  if (!cred) {
    const failed = [];
    for (const msgs of byTarget.values()) for (const m of msgs) failed.push(m.id);
    return { moved: 0, failed };
  }

  const doMove = deps.moveMessages || moveMessages;
  let moved = 0;
  const failed = [];
  for (const [targetPath, msgs] of byTarget) {
    const bySourceFolder = new Map();
    for (const m of msgs) {
      if (m.folder === targetPath) continue; // already filed there
      if (!bySourceFolder.has(m.folder)) bySourceFolder.set(m.folder, []);
      bySourceFolder.get(m.folder).push(m);
    }
    for (const [sourceFolder, msgs2] of bySourceFolder) {
      try {
        const uids = msgs2.map((m) => m.uid);
        const res = await doMove({
          host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password,
          folder: sourceFolder, uids, targetPath,
        });
        const movedCount = (res && typeof res.moved === 'number') ? res.moved : uids.length;
        moved += movedCount;
        for (const m of msgs2) {
          store.updateMessageFolder(orgId, m.id, { folder: targetPath, uid: destUidFor(res, m.uid), uidvalidity: destUidValidityOf(res) });
        }
      } catch (e) {
        for (const m of msgs2) failed.push(m.id);
      }
    }
  }
  return { moved, failed };
}

/** GET /filing/status?accountId= -> { enabled, folders: {fyi,auto,screened,unsure} }. */
async function hFilingStatus(ctx) {
  const accountId = ctx.query?.accountId || null;
  if (!accountId) return bad('accountId required');
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);
  const settings = store.getSettings(ctx.orgId);
  return ok({ enabled: Boolean(settings.physicalFilingEnabled), folders: { ...store.FILING_FOLDERS } });
}

/**
 * POST /filing/preview {accountId} -> { plan: [{target, count}], total }.
 * DRY-RUN over the account's already-STORED mail only — for every stored
 * message, computes where store.zoneToFolder would file it and tallies
 * counts per target. NEVER touches IMAP, NEVER mutates anything: the human
 * sees exactly what enabling (or applying to backlog) WOULD do before it
 * happens. Same scan window as hPreviewRule/hReclassify (store.listMessages'
 * 500-row cap) — an honest count within that window, not a claim about the
 * account's entire mail history.
 */
async function hPreviewFiling(ctx) {
  const { accountId } = ctx.body || {};
  if (!accountId) return bad('accountId required');
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);
  const messages = store.listMessages(ctx.orgId, { accountId, limit: 500 });
  const counts = new Map();
  for (const m of messages) {
    const target = store.zoneToFolder(m.zone, m.confidence);
    if (!target) continue;
    counts.set(target, (counts.get(target) || 0) + 1);
  }
  const plan = [...counts.entries()].map(([target, count]) => ({ target, count }));
  const total = plan.reduce((sum, p) => sum + p.count, 0);
  return ok({ plan, total });
}

/**
 * POST /filing/enable {accountId, applyToExisting} -> { enabled, created, moved, failed }.
 * Creates the 4 InboxQ/* folders (idempotent) and unions them into the
 * account's synced set, THEN flips inboxq_settings.physical_filing_enabled
 * ON for the org — an explicit opt-in, never implied by anything else. When
 * applyToExisting is truthy, ALSO runs a real, failure-isolated backlog move
 * of the account's already-stored mail right now (moveBacklogForFiling);
 * otherwise enabling only takes effect on FUTURE syncs (syncWorker.js).
 */
async function hEnableFiling(ctx, deps) {
  const { accountId, applyToExisting } = ctx.body || {};
  if (!accountId) return bad('accountId required');
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);

  let setup;
  try {
    setup = await ensureFilingFolders(ctx.orgId, accountId, deps);
  } catch (e) {
    return bad(`filing folder setup failed: ${e.message}`, 502);
  }

  store.setSettings(ctx.orgId, { physicalFilingEnabled: true });

  let moved = 0;
  let failed = [];
  if (applyToExisting) {
    const backlog = await moveBacklogForFiling(ctx.orgId, accountId, deps);
    moved = backlog.moved;
    failed = backlog.failed;
  }

  deps.audit?.({ type: 'action', intent: 'quox.inbox.filing.enable', corr: accountId, payload: { orgId: ctx.orgId, applyToExisting: Boolean(applyToExisting), created: setup.created, moved, failed: failed.length } });
  return ok({ enabled: true, created: setup.created, moved, failed });
}

/**
 * POST /filing/disable {accountId} -> { enabled: false, note }.
 * Turns future physical filing OFF (org-scoped). Deliberately does NOT
 * un-move mail already physically filed — reversing a real mail move is a
 * second, unannounced mail effect nobody asked for; the response says so
 * explicitly rather than leaving the human to assume it happened.
 */
async function hDisableFiling(ctx, deps) {
  const { accountId } = ctx.body || {};
  if (!accountId) return bad('accountId required');
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);
  store.setSettings(ctx.orgId, { physicalFilingEnabled: false });
  deps.audit?.({ type: 'action', intent: 'quox.inbox.filing.disable', corr: accountId, payload: { orgId: ctx.orgId } });
  return ok({ enabled: false, note: 'already-filed mail was not moved back; only future syncs stop physically filing' });
}

/**
 * POST /messages/confirm-junk {messageIds, accountId} -> { moved, blocked, failed }.
 * A human's escalation from InboxQ/Screened (a review folder, never
 * auto-Junk) to the mailbox's REAL Junk/Spam folder, for a message they have
 * looked at and confirmed IS junk. Two effects, both best-effort/isolated:
 * (1) markBlocked on each distinct sender — the SAME instant, human-
 * authoritative block hBlockSender uses, so future mail from that sender is
 * screened from the very next message; (2) a real IMAP move to the
 * account's Spam/Junk folder, resolved the SAME way a block does (prefer a
 * synced junk folder, else discover one on the server, else create 'Junk').
 * A message whose IMAP move fails is left in place — reported in `failed`,
 * never silently dropped; the sender block still applies.
 */
async function hConfirmJunk(ctx, deps) {
  const { messageIds, accountId } = ctx.body || {};
  if (!accountId) return bad('accountId required');
  if (!Array.isArray(messageIds) || messageIds.length === 0) return bad('messageIds required');
  const account = store.getAccount(ctx.orgId, accountId);
  if (!account) return bad('account not found', 404);

  const messages = [];
  const failed = [];
  for (const id of messageIds) {
    // Account-scoped as well as org-scoped: this blocks the sender and moves to
    // THIS account's Junk folder with THIS account's credentials, so a sibling
    // account's id must not be accepted (same reasoning as hMoveToFolder).
    const m = store.getMessage(ctx.orgId, id);
    if (!m || m.accountId !== accountId) { failed.push(id); continue; }
    messages.push(m);
  }

  const blockedSenders = new Set();
  for (const m of messages) {
    const normalized = (m.fromAddr || '').toString().trim().toLowerCase();
    if (!normalized || blockedSenders.has(normalized)) continue;
    try { store.markBlocked({ orgId: ctx.orgId, accountId: account.id, target: normalized, type: 'sender' }); } catch { /* isolated */ }
    blockedSenders.add(normalized);
  }

  // Resolve a real Junk folder the SAME way a block does: prefer a synced junk
  // folder, else discover one on the server (adding it to the synced set), else
  // create 'Junk'. Previously this only looked in account.folders, so an account
  // with no SYNCED junk folder failed the move for every message even when the
  // server had one (owner audit 2026-10-07, self-audit gap a).
  let junkFolder = null;
  try { junkFolder = await resolveJunkFolder(ctx.orgId, account, deps); } catch { junkFolder = null; }

  let moved = 0;
  if (!junkFolder) {
    for (const m of messages) failed.push(m.id);
  } else {
    let cred = null;
    try {
      cred = await (deps.resolveCredential || defaultResolve)(ctx.orgId, account.credentialId);
      if (!cred || !cred.imap_host || !cred.username || !cred.password) cred = null;
    } catch { cred = null; }

    if (!cred) {
      for (const m of messages) if (m.folder !== junkFolder) failed.push(m.id);
    } else {
      const doMove = deps.moveMessages || moveMessages;
      const bySourceFolder = new Map();
      for (const m of messages) {
        if (m.folder === junkFolder) continue; // already there
        if (!bySourceFolder.has(m.folder)) bySourceFolder.set(m.folder, []);
        bySourceFolder.get(m.folder).push(m);
      }
      for (const [sourceFolder, msgs] of bySourceFolder) {
        try {
          const uids = msgs.map((m) => m.uid);
          const res = await doMove({
            host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password,
            folder: sourceFolder, uids, targetPath: junkFolder,
          });
          const movedCount = (res && typeof res.moved === 'number') ? res.moved : uids.length;
          moved += movedCount;
          for (const m of msgs) {
            store.updateMessageFolder(ctx.orgId, m.id, { folder: junkFolder, uid: destUidFor(res, m.uid), uidvalidity: destUidValidityOf(res) });
          }
        } catch (e) {
          for (const m of msgs) failed.push(m.id);
        }
      }
    }
  }

  deps.audit?.({ type: 'action', intent: 'quox.inbox.confirm_junk', corr: accountId, payload: { orgId: ctx.orgId, moved, blocked: blockedSenders.size, failed: failed.length } });
  return ok({ moved, blocked: blockedSenders.size, failed });
}

// --- helpers ---------------------------------------------------------------

function redactAccount(a) {
  // Never expose credential material; the credentialId reference is fine (it is
  // a vault handle, not a secret) but we do not echo it to reduce surface.
  return {
    id: a.id, emailAddress: a.emailAddress, displayName: a.displayName,
    folders: a.folders, pollEnabled: a.pollEnabled, createdAt: a.createdAt,
  };
}

async function defaultResolve(orgId, credentialId) {
  return resolveEmailCredential(orgId, credentialId);
}

// --- express wiring --------------------------------------------------------

/**
 * @param {object} app express app
 * @param {object} deps { requireAuth, resolveOrgId, isPluginLicensed, audit, ...testOverrides }
 */
function registerInboxqRoutes(app, deps = {}) {
  const requireAuth = deps.requireAuth || ((req, res, next) => next());
  const resolveOrgId = deps.resolveOrgId || ((req) => req.headers['x-org-id'] || 'default');
  const isPluginLicensed = deps.isPluginLicensed || (() => true);
  // codex F04: resolving a proposal (approve/deny) is a human decision. This
  // middleware must reject agent tokens, agent-operated sessions and service
  // keys. server.js supplies requireHumanAdmin adapted to (req,res,next); the
  // default here is fail-CLOSED so a misconfiguration cannot silently let an
  // agent approve.
  const requireHuman = deps.requireHuman || ((req, res) => res.status(403).json({ error: 'human_actor_required' }));

  const wrap = (handler) => async (req, res) => {
    try {
      const orgId = resolveOrgId(req);
      if (!orgId) return res.status(401).json({ error: 'unauthenticated' });
      if (!isPluginLicensed(orgId, 'inboxq')) return res.status(402).json({ error: 'inboxq not licensed for this org' });
      const ctx = {
        orgId,
        userId: req.user?.id || req.auth?.userId || null,
        body: req.body || {},
        params: req.params || {},
        query: req.query || {},
      };
      const { status, json } = await handler(ctx, deps);
      res.status(status).json(json);
    } catch (e) {
      // Never leak internals; log server-side.
      console.error('[inboxq] route error:', e?.message);
      res.status(500).json({ error: 'internal_error' });
    }
  };

  app.get('/api/v1/inboxq/accounts', requireAuth, wrap(hListAccounts));
  app.post('/api/v1/inboxq/accounts', requireAuth, wrap(hCreateAccount));
  app.delete('/api/v1/inboxq/accounts/:accountId', requireAuth, wrap(hDeleteAccount));
  app.get('/api/v1/inboxq/accounts/:accountId/available-folders', requireAuth, wrap(hAvailableFolders));
  app.put('/api/v1/inboxq/accounts/:accountId/folders', requireAuth, wrap(hUpdateAccountFolders));
  app.get('/api/v1/inboxq/messages', requireAuth, wrap(hListMessages));
  // Registered BEFORE '/messages/:id' — Express matches route order, and
  // '/messages/:id' would otherwise swallow '/messages/search' as id='search'.
  app.get('/api/v1/inboxq/messages/search', requireAuth, wrap(hSearchMessages));
  app.get('/api/v1/inboxq/messages/:id', requireAuth, wrap(hGetMessage));
  app.post('/api/v1/inboxq/messages/:id/move', requireAuth, wrap(hMoveMessage));
  app.post('/api/v1/inboxq/messages/:id/fetch-body', requireAuth, wrap(hFetchMessageBody));
  app.post('/api/v1/inboxq/messages/backfill-bodies', requireAuth, wrap(hBackfillBodies));
  app.post('/api/v1/inboxq/messages/move-to-folder', requireAuth, wrap(hMoveToFolder));
  // AQ-9E U2: reversible moves
  app.get('/api/v1/inboxq/moves/recent', requireAuth, wrap(hListMoves));
  app.post('/api/v1/inboxq/moves/undo', requireAuth, wrap(hUndoMove));
  app.post('/api/v1/inboxq/messages/confirm-junk', requireAuth, wrap(hConfirmJunk));
  app.post('/api/v1/inboxq/senders/block', requireAuth, wrap(hBlockSender));
  app.post('/api/v1/inboxq/senders/trust', requireAuth, wrap(hTrustSender));
  app.get('/api/v1/inboxq/senders/blocked', requireAuth, wrap(hListBlocked));
  app.post('/api/v1/inboxq/senders/unblock', requireAuth, wrap(hUnblock));
  app.get('/api/v1/inboxq/rules', requireAuth, wrap(hListRules));
  app.post('/api/v1/inboxq/rules', requireAuth, wrap(hCreateRule));
  app.patch('/api/v1/inboxq/rules/:ruleId', requireAuth, wrap(hUpdateRule));
  app.delete('/api/v1/inboxq/rules/:ruleId', requireAuth, wrap(hDeleteRule));
  app.post('/api/v1/inboxq/rules/preview', requireAuth, wrap(hPreviewRule));
  app.post('/api/v1/inboxq/rules/apply', requireAuth, wrap(hApplyRules));
  app.post('/api/v1/inboxq/reclassify', requireAuth, wrap(hReclassify));
  app.get('/api/v1/inboxq/zones', requireAuth, wrap(hZones));
  app.post('/api/v1/inboxq/sync', requireAuth, wrap(hSync));
  app.get('/api/v1/inboxq/sync-status', requireAuth, wrap(hSyncStatus));
  app.post('/api/v1/inboxq/report/generate', requireAuth, wrap(hGenerateReport));
  app.get('/api/v1/inboxq/report/latest', requireAuth, wrap(hLatestReport));
  app.get('/api/v1/inboxq/watches', requireAuth, wrap(hListWatches));
  app.post('/api/v1/inboxq/watches', requireAuth, wrap(hCreateWatch));
  app.post('/api/v1/inboxq/watches/:watchId/active', requireAuth, wrap(hSetWatchActive));
  app.get('/api/v1/inboxq/settings', requireAuth, wrap(hGetSettings));
  app.put('/api/v1/inboxq/settings', requireAuth, wrap(hUpdateSettings));
  app.get('/api/v1/inboxq/filing/status', requireAuth, wrap(hFilingStatus));
  app.post('/api/v1/inboxq/filing/preview', requireAuth, wrap(hPreviewFiling));
  app.post('/api/v1/inboxq/filing/enable', requireAuth, wrap(hEnableFiling));
  app.post('/api/v1/inboxq/filing/disable', requireAuth, wrap(hDisableFiling));
  app.get('/api/v1/inboxq/proposals', requireAuth, wrap(hListProposals));
  app.post('/api/v1/inboxq/proposals', requireAuth, wrap(hCreateProposal));
  app.post('/api/v1/inboxq/proposals/:proposalId/resolve', requireAuth, requireHuman, wrap(hResolveProposal));
  app.get('/api/v1/inboxq/folders', requireAuth, wrap(hListFolders));
  app.get('/api/v1/inboxq/folders/tree', requireAuth, wrap(hFolderTree)); // AQ-9E U3
  app.post('/api/v1/inboxq/folders', requireAuth, wrap(hCreateFolder));
  app.delete('/api/v1/inboxq/folders/:folderId', requireAuth, wrap(hDeleteFolder));
}

module.exports = {
  registerInboxqRoutes,
  // handlers exported for unit tests
  _handlers: {
    hListAccounts, hCreateAccount, hDeleteAccount, hAvailableFolders, hUpdateAccountFolders, hListMessages, hSearchMessages, hGetMessage, hFetchMessageBody, hBackfillBodies, hMoveMessage, hMoveToFolder, hUndoMove, hListMoves, hFolderTree, hBlockSender, hTrustSender, hListBlocked, hUnblock, hReclassify, hZones, hSync, hSyncStatus,
    hGenerateReport, hLatestReport, hListWatches, hCreateWatch, hSetWatchActive,
    hListProposals, hCreateProposal, hResolveProposal,
    hGetSettings, hUpdateSettings,
    hListFolders, hCreateFolder, hDeleteFolder,
    hListRules, hCreateRule, hUpdateRule, hDeleteRule, hPreviewRule, hApplyRules,
    // P3 physical filing engine
    hFilingStatus, hPreviewFiling, hEnableFiling, hDisableFiling, hConfirmJunk,
  },
  // exported for the inboxqTools.js agent satellite module and unit tests —
  // the shared executors so a tool test can assert the SAME code path the
  // resolve route runs, and so an approved 'block'/'rezone'/'folder_create'
  // proposal never diverges from the instant human route's behaviour.
  _executors: {
    executeFileProposal, executeRezoneProposal, executeBlockProposal, executeFolderCreateProposal,
    runDomainBlock, runSenderBlock, createFolderInternal,
    // P3 physical filing engine — exported so tests can exercise folder
    // setup / backlog move in isolation from the full enable route.
    ensureFilingFolders, moveBacklogForFiling,
  },
};
