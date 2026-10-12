/**
 * feedEmailSource.js, The Feed's InboxQ email ingester (catalog sourceType
 * 'email', connector 'internal', requiresConfig true, defaultOn false).
 *
 * Same control flow as feedGitSource.js (guard, compound (ts,id) watermark via
 * feedWatermark, bounded slice per tick, dryRun early return, ensurePushVault,
 * pushDocuments, watermark advanced only on a clean push, per-item try/catch).
 *
 * WHERE THE MAIL LIVES: InboxQ's own sqlite store (lib/inboxq/store.js,
 * INBOXQ_DB_PATH, table inboxq_messages joined to inboxq_accounts). The
 * collector reads it in-process, so no extra service or HTTP hop.
 *
 * PRIVACY MODEL (owner rule: user content to a third-party AI is never on by
 * default, cloud is per-org opt-in and disclosed). Four independent locks, all
 * must hold or the tick is skipped without reading a single message:
 *   1. The scheduler already fails closed: no feed_sources row, or enabled=0,
 *      means the ingester is never called (feedScheduler.isSourceEnabled).
 *   2. config.consent === true: an explicit disclosure acknowledgement stored
 *      with the source row, so a bare "enabled" toggle is not enough.
 *   3. opts.scope === 'user': mail is never org-shared. The PUT handler sets
 *      owner_user_id to the enabling admin and the scheduler passes it as
 *      deps.userId.
 *   4. deps.userId is required: ONLY mail from InboxQ accounts that user
 *      created (inboxq_accounts.created_by = userId) in THIS org is read. Other
 *      users' mailboxes in the same org are never touched, and org B config
 *      can never read org A rows (every query is org_id-bound).
 *
 * MESSAGE vs THREAD: InboxQ stores no thread table (only RFC message_id), so one
 * document per message. relPath 'email/<inboxq message id>.md' is stable.
 *
 * EXCLUSIONS: spam/junk/trash/deleted/bin/draft folders (by name, so Gmail
 * '[Gmail]/Spam' and 'INBOX.Junk' match), and the 'screened' zone (InboxQ's
 * own junk/phishing verdict). Body: body_text, else HTML stripped to text,
 * else snippet; quoted reply tails dropped; capped at MAX_BODY_BYTES.
 *
 * WATERMARK keyed 'email:<sha1(userId)-first12>' so switching the owner never
 * inherits another user's cursor. Cursor ts is the message date.
 *
 * DELETIONS: a manifest of pushed message ids lives in the feed watermark store
 * ('<watermarkKey>:manifest', same mechanism as feedTranscriptSource). Each
 * tick, ids in the manifest that are no longer live (deleted, moved to an
 * excluded folder, screened, or the account was disconnected) are retracted
 * via brainFeedClient.pushDeletions, at most MAX_DELETIONS_PER_TICK, and
 * dropped from the manifest only on a clean delete. An EMPTY live set is a real
 * answer (account disconnected = erasure), but a live-set READ ERROR retracts
 * nothing. Not run on dryRun. If the source is disabled the scheduler stops
 * calling us, so disabling does not retract by itself.
 *
 * KNOWN GAPS: (b) A message whose body arrives after its date cursor passed
 * (body_text captured later by the backfill) is ingested with the snippet only.
 * (c) Messages dated older than the cursor (late backfill) are never picked up.
 */

'use strict';

const crypto = require('crypto');
const feedWatermark = require('./feedWatermark.js');
const brainFeedClient = require('./brainFeedClient.js');
const inboxqStore = require('./inboxq/store.js');
const feedSweep = require('./feedSweep.js');

const SOURCE_TYPE = 'email';
const DEFAULT_MAX_MESSAGES = 50;
const MAX_READ_WINDOW = 200;
const MAX_BODY_BYTES = 8192;
const MAX_DELETIONS_PER_TICK = 200;
const EXCLUDED_FOLDER_RE = /(spam|junk|trash|deleted|\bbin\b|draft)/i;

function watermarkKeyForUser(userId) {
  return `${SOURCE_TYPE}:${crypto.createHash('sha1').update(String(userId)).digest('hex').slice(0, 12)}`;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] || m)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Drops a trailing quoted reply: from an "On ... wrote:" line or the first '>' line. */
function stripQuotedTail(text) {
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*>/.test(l) || /^\s*On .{3,200} wrote:\s*$/i.test(l) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l)) {
      return lines.slice(0, i).join('\n').trim();
    }
  }
  return String(text || '').trim();
}

function capBytes(s, max) {
  return Buffer.byteLength(s, 'utf8') > max ? Buffer.from(s, 'utf8').slice(0, max).toString('utf8') : s;
}

/**
 * Default reader: the oldest MAX_READ_WINDOW eligible messages at or after
 * afterMs, for accounts created by userId in orgId. Org and user bound in SQL.
 */
function readMessages(orgId, userId, { afterMs = null } = {}) {
  const db = inboxqStore.getDb();
  return db.prepare(`
    SELECT m.id, m.folder, m.zone, m.from_addr, m.from_name, m.subject, m.date_ts,
           m.snippet, m.body_text, m.body_html, a.email_address AS account_email
    FROM inboxq_messages m
    JOIN inboxq_accounts a ON a.id = m.account_id AND a.org_id = m.org_id
    WHERE m.org_id = ? AND a.created_by = ? AND m.date_ts IS NOT NULL AND m.date_ts >= ?
      AND COALESCE(m.zone, '') != 'screened'
    ORDER BY m.date_ts ASC, m.id ASC
    LIMIT ?
  `).all(orgId, String(userId), afterMs == null ? 0 : afterMs, MAX_READ_WINDOW * 2)
    .filter((r) => !EXCLUDED_FOLDER_RE.test(r.folder || ''))
    .slice(0, MAX_READ_WINDOW);
}

function renderMessageNote(row) {
  const occurredAt = new Date(row.date_ts).toISOString();
  const subject = row.subject || '(no subject)';
  const raw = row.body_text || htmlToText(row.body_html) || row.snippet || '';
  const body = capBytes(stripQuotedTail(raw), MAX_BODY_BYTES);
  const from = row.from_name ? `${row.from_name} <${row.from_addr || ''}>` : (row.from_addr || 'unknown');
  const content = [
    `# ${subject}`,
    '',
    `From: ${from}`,
    `To: ${row.account_email || 'unknown'}`,
    `Date: ${occurredAt}`,
    `Subject: ${subject}`,
    '',
    body,
  ].join('\n');
  return {
    relPath: `email/${row.id}.md`,
    content,
    title: subject.slice(0, 120),
    kind: 'email',
    sourceType: SOURCE_TYPE,
    occurredAt,
  };
}

/**
 * @param {string} orgId
 * @param {{maxItems?:number, config?:{consent?:boolean,name?:string}, scope?:string, dryRun?:boolean}} [opts]
 * @param {{readMessagesFn?:Function, getWatermarkFn?:Function, setWatermarkFn?:Function,
 *          ensurePushVaultFn?:Function, pushDocumentsFn?:Function, fetchImpl?:Function,
 *          userId?:string, dbPath?:string}} [deps]
 * @returns {Promise<{messagesRead:number, docsPushed:number, skipped:string|null, error:string|null}>}
 */
async function ingestPush(orgId, opts, deps, pushedIds) {
  const result = { messagesRead: 0, docsPushed: 0, skipped: null, error: null };
  const config = opts.config || null;

  if (!config || config.consent !== true) { result.skipped = 'email feed not opted in (config.consent required)'; return result; }
  if (opts.scope !== 'user') { result.skipped = 'email feed must be user scope (never org-shared)'; return result; }
  const {
    readMessagesFn = readMessages,
    getWatermarkFn, setWatermarkFn,
    ensurePushVaultFn = brainFeedClient.ensurePushVault,
    pushDocumentsFn = brainFeedClient.pushDocuments,
    fetchImpl, userId, dbPath,
  } = deps;
  if (!userId) { result.skipped = 'no owner user for private email source'; return result; }

  const key = watermarkKeyForUser(userId);
  const getWM = getWatermarkFn || ((org) => feedWatermark.getWatermark(org, key, { dbPath }));
  const setWM = setWatermarkFn || ((org, ts) => feedWatermark.setWatermark(org, key, ts, { dbPath }));
  const maxItems = opts.maxItems ?? DEFAULT_MAX_MESSAGES;

  let storedWatermark = null;
  try { storedWatermark = await getWM(orgId); } catch (err) {
    console.error(`[FeedEmailSource] org=${orgId}: watermark read failed, treating as none, ${err.message}`);
  }

  let rows = [];
  try {
    const afterTs = feedWatermark.parseCursor(storedWatermark)?.ts || null;
    const afterMs = afterTs ? new Date(afterTs).getTime() - 1000 : null;
    rows = (await readMessagesFn(orgId, userId, { afterMs: Number.isFinite(afterMs) ? afterMs : null })) || [];
  } catch (err) {
    result.error = `inboxq read failed, ${err.message}`;
    console.error(`[FeedEmailSource] org=${orgId}: ${result.error}`);
    return result;
  }

  const items = rows
    .map((r) => ({ r, ts: new Date(r.date_ts).toISOString(), id: r.id }))
    .filter((x) => feedWatermark.isAfterCursor(storedWatermark, x.ts, x.id))
    .sort(feedWatermark.compareByTsId);
  const eligible = items.slice(0, maxItems);
  const remaining = items.slice(maxItems).map((x) => ({ ts: x.ts, id: x.id }));
  if (eligible.length === 0) return result;

  const docs = [];
  const processed = [];
  for (const x of eligible) {
    try {
      docs.push(renderMessageNote(x.r));
      result.messagesRead++;
      processed.push({ ts: x.ts, id: x.id });
    } catch (err) {
      console.error(`[FeedEmailSource] org=${orgId}: skipping message ${x.id}, ${err.message}`);
    }
  }
  const newWatermark = feedWatermark.nextCursor(processed, remaining) || storedWatermark;
  if (docs.length === 0 || opts.dryRun) return result;

  try {
    const vaultId = await ensurePushVaultFn(orgId, config.name || 'InboxQ Email', { scope: 'user', userId, fetchImpl });
    if (!vaultId) {
      result.error = 'ensurePushVault returned no vaultId';
      return result;
    }
    const pushResult = await pushDocumentsFn(orgId, vaultId, docs, { userId, fetchImpl });
    if (pushResult?.error) {
      result.error = pushResult.error;
      console.error(`[FeedEmailSource] org=${orgId}: push failed, ${pushResult.error}, not advancing watermark`);
      return result;
    }
    result.docsPushed = docs.length;
    for (const x of eligible) pushedIds.push(x.id);
    if (newWatermark && newWatermark !== storedWatermark) {
      try { await setWM(orgId, newWatermark); } catch (err) {
        console.error(`[FeedEmailSource] org=${orgId}: watermark write failed, ${err.message}`);
      }
    }
  } catch (err) {
    result.error = `push failed, ${err.message}`;
    console.error(`[FeedEmailSource] org=${orgId}: ${result.error}, not advancing watermark`);
  }
  return result;
}

/** Ids of every message currently eligible for the user (same filters as the reader). Throws on read error. */
function listLiveIds(orgId, userId) {
  const rows = inboxqStore.getDb().prepare(`
    SELECT m.id, m.folder
    FROM inboxq_messages m
    JOIN inboxq_accounts a ON a.id = m.account_id AND a.org_id = m.org_id
    WHERE m.org_id = ? AND a.created_by = ? AND m.date_ts IS NOT NULL AND COALESCE(m.zone, '') != 'screened'
  `).all(orgId, String(userId));
  return rows.filter((r) => !EXCLUDED_FOLDER_RE.test(r.folder || '')).map((r) => r.id);
}

async function reconcile(orgId, opts, deps, pushedIds, result) {
  const tag = `[FeedEmailSource] org=${orgId}`;
  const { userId, dbPath, fetchImpl, listLiveIdsFn = listLiveIds,
    ensurePushVaultFn = brainFeedClient.ensurePushVault,
    pushDeletionsFn = brainFeedClient.pushDeletions } = deps;
  const store = deps.stateStore || ((dbPath || !deps.getWatermarkFn) ? feedSweep.defaultStore(dbPath) : null);
  if (!store) return;
  const key = `${watermarkKeyForUser(userId)}:manifest`;
  let manifest;
  try {
    const raw = await store.get(orgId, key);
    const parsed = raw ? JSON.parse(raw) : [];
    manifest = new Set(Array.isArray(parsed) ? parsed : []);
  } catch (err) {
    console.error(`${tag}: manifest read failed, NOT reconciling deletions, ${err.message}`);
    return;
  }
  for (const id of pushedIds) manifest.add(id);
  const persist = async () => {
    try { await store.set(orgId, key, JSON.stringify([...manifest])); } catch (err) {
      console.error(`${tag}: manifest write failed, ${err.message}`);
    }
  };
  let live;
  try {
    live = new Set(await listLiveIdsFn(orgId, userId));
  } catch (err) {
    // A read ERROR is not "mail is gone": retract nothing, keep the manifest.
    console.error(`${tag}: live id read failed, NOT deleting (${err.message})`);
    if (pushedIds.length) await persist();
    return;
  }
  const gone = [...manifest].filter((id) => !live.has(id)).slice(0, MAX_DELETIONS_PER_TICK);
  if (gone.length === 0) { if (pushedIds.length) await persist(); return; }
  try {
    const vaultId = await ensurePushVaultFn(orgId, opts.config?.name || 'InboxQ Email', { scope: 'user', userId, fetchImpl });
    const del = vaultId ? await pushDeletionsFn(orgId, vaultId, gone.map((id) => `email/${id}.md`), { userId, fetchImpl }) : { error: 'no vaultId' };
    if (del?.error) {
      console.error(`${tag}: tombstones failed, ${del.error} (manifest kept, will retry)`);
      await persist();
      return;
    }
    for (const id of gone) manifest.delete(id);
    result.docsDeleted = gone.length;
    await persist();
  } catch (err) {
    console.error(`${tag}: tombstones failed, ${err.message} (manifest kept)`);
    await persist();
  }
}

async function ingestEmail(orgId, opts = {}, deps = {}) {
  const pushedIds = [];
  const result = await ingestPush(orgId, opts, deps, pushedIds);
  result.docsDeleted = 0;
  if (result.skipped || opts.dryRun || result.error) return result;
  await reconcile(orgId, opts, deps, pushedIds, result);
  return result;
}

module.exports = {
  ingestEmail, htmlToText, stripQuotedTail, renderMessageNote, watermarkKeyForUser,
  SOURCE_TYPE, DEFAULT_MAX_MESSAGES, MAX_BODY_BYTES,
};
