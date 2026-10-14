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
 * LATE ARRIVALS: inboxq_messages has no updated_at, so the date cursor cannot
 * see (b) a body captured after the cursor passed, or (c) a message backfilled
 * with a date older than the cursor. The manifest therefore stores a per-id
 * body fingerprint (text/html lengths); each tick, live ids at or behind the
 * cursor that are missing from the manifest or whose fingerprint changed are
 * re-pushed, at most MAX_REPUSH_PER_TICK (idempotent by content hash).
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
const MAX_REPUSH_PER_TICK = 50;
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

const READ_COLS = `m.id, m.folder, m.zone, m.from_addr, m.from_name, m.subject, m.date_ts,
           m.snippet, m.body_text, m.body_html, a.email_address AS account_email,
           length(m.body_text) AS bt_len, length(m.body_html) AS bh_len`;

/** Cheap content fingerprint: changes when a body is captured or extended after the first push. */
function fingerprint(row) {
  const bt = row.bt_len ?? (row.body_text == null ? 0 : String(row.body_text).length);
  const bh = row.bh_len ?? (row.body_html == null ? 0 : String(row.body_html).length);
  return `t${bt}h${bh}`;
}

/**
 * Default reader: the oldest MAX_READ_WINDOW eligible messages strictly after
 * the compound (date_ts, id) cursor, for accounts created by userId in orgId.
 * The cursor is applied IN SQL so pagination is exact for tied timestamps;
 * excluded folders are filtered in JS, so pages are walked until the window
 * is full or the table is exhausted. Org and user bound in SQL.
 */
function readMessages(orgId, userId, { afterMs = null, afterId = null } = {}) {
  const db = inboxqStore.getDb();
  const stmt = db.prepare(`
    SELECT ${READ_COLS}
    FROM inboxq_messages m
    JOIN inboxq_accounts a ON a.id = m.account_id AND a.org_id = m.org_id
    WHERE m.org_id = ? AND a.created_by = ? AND m.date_ts IS NOT NULL
      AND (m.date_ts > ? OR (m.date_ts = ? AND m.id > ?))
      AND COALESCE(m.zone, '') != 'screened'
    ORDER BY m.date_ts ASC, m.id ASC
    LIMIT ?
  `);
  const out = [];
  let ts = afterMs == null ? -1 : afterMs;
  let id = afterId == null ? '' : String(afterId);
  const PAGE = MAX_READ_WINDOW * 2;
  for (;;) {
    const page = stmt.all(orgId, String(userId), ts, ts, id, PAGE);
    for (const r of page) if (!EXCLUDED_FOLDER_RE.test(r.folder || '')) out.push(r);
    if (out.length >= MAX_READ_WINDOW || page.length < PAGE) break;
    const last = page[page.length - 1];
    ts = last.date_ts; id = last.id;
  }
  return out.slice(0, MAX_READ_WINDOW);
}

/** Eligible messages by id (same org/user/exclusion filters), for re-push of late changes. */
function readMessagesByIds(orgId, userId, ids) {
  if (!ids.length) return [];
  const rows = inboxqStore.getDb().prepare(`
    SELECT ${READ_COLS}
    FROM inboxq_messages m
    JOIN inboxq_accounts a ON a.id = m.account_id AND a.org_id = m.org_id
    WHERE m.org_id = ? AND a.created_by = ? AND m.date_ts IS NOT NULL
      AND COALESCE(m.zone, '') != 'screened'
      AND m.id IN (${ids.map(() => '?').join(',')})
  `).all(orgId, String(userId), ...ids);
  return rows.filter((r) => !EXCLUDED_FOLDER_RE.test(r.folder || ''));
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
async function ingestPush(orgId, opts, deps, pushedIds, ctx = {}) {
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
  ctx.watermark = storedWatermark;

  let rows = [];
  try {
    const cur = feedWatermark.parseCursor(storedWatermark);
    const afterMs = cur?.ts ? new Date(cur.ts).getTime() : null;
    rows = (await readMessagesFn(orgId, userId, {
      afterMs: Number.isFinite(afterMs) ? afterMs : null,
      afterId: cur?.id ?? null,
    })) || [];
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
    for (const x of eligible) pushedIds.push({ id: x.id, fp: fingerprint(x.r) });
    if (newWatermark && newWatermark !== storedWatermark) {
      ctx.watermark = newWatermark;
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

/** Every message currently eligible for the user (same filters as the reader): id, ts, fingerprint. Throws on read error. */
function listLiveIds(orgId, userId) {
  const rows = inboxqStore.getDb().prepare(`
    SELECT m.id, m.folder, m.date_ts, length(m.body_text) AS bt_len, length(m.body_html) AS bh_len
    FROM inboxq_messages m
    JOIN inboxq_accounts a ON a.id = m.account_id AND a.org_id = m.org_id
    WHERE m.org_id = ? AND a.created_by = ? AND m.date_ts IS NOT NULL AND COALESCE(m.zone, '') != 'screened'
  `).all(orgId, String(userId));
  return rows.filter((r) => !EXCLUDED_FOLDER_RE.test(r.folder || ''))
    .map((r) => ({ id: r.id, ts: new Date(r.date_ts).toISOString(), fp: fingerprint(r) }));
}

async function reconcile(orgId, opts, deps, pushedIds, result, ctx = {}) {
  const tag = `[FeedEmailSource] org=${orgId}`;
  const { userId, dbPath, fetchImpl, listLiveIdsFn = listLiveIds, readMessagesByIdsFn = readMessagesByIds,
    pushDocumentsFn = brainFeedClient.pushDocuments,
    ensurePushVaultFn = brainFeedClient.ensurePushVault,
    pushDeletionsFn = brainFeedClient.pushDeletions } = deps;
  const store = deps.stateStore || ((dbPath || !deps.getWatermarkFn) ? feedSweep.defaultStore(dbPath) : null);
  if (!store) return;
  const key = `${watermarkKeyForUser(userId)}:manifest`;
  // Manifest: Map id -> content fingerprint (legacy array form = ids with unknown fingerprint).
  let manifest;
  try {
    const raw = await store.get(orgId, key);
    const parsed = raw ? JSON.parse(raw) : {};
    manifest = new Map(Array.isArray(parsed)
      ? parsed.map((id) => [id, null])
      : Object.entries(parsed && typeof parsed === 'object' ? parsed : {}));
  } catch (err) {
    console.error(`${tag}: manifest read failed, NOT reconciling deletions, ${err.message}`);
    return;
  }
  for (const p of pushedIds) manifest.set(p.id, p.fp);
  const persist = async () => {
    try { await store.set(orgId, key, JSON.stringify(Object.fromEntries(manifest))); } catch (err) {
      console.error(`${tag}: manifest write failed, ${err.message}`);
    }
  };
  let dirty = false;
  // Late arrivals the date cursor cannot see: a live message at or behind the
  // cursor that the manifest lacks (older-dated backfill) or whose body
  // fingerprint changed since the push (body captured late). Bounded per tick;
  // pushDocuments is content-hash idempotent, so a spurious re-push is harmless.
  const repush = async (rowsLive) => {
    const behind = rowsLive.filter((x) => x.ts && manifest.get(x.id) !== x.fp
      && !(!manifest.has(x.id) && feedWatermark.isAfterCursor(ctx.watermark, x.ts, x.id)))
      .sort(feedWatermark.compareByTsId).slice(0, MAX_REPUSH_PER_TICK);
    if (behind.length === 0) return;
    try {
      const rows = await readMessagesByIdsFn(orgId, userId, behind.map((x) => x.id));
      if (rows.length === 0) return;
      const vaultId = await ensurePushVaultFn(orgId, opts.config?.name || 'InboxQ Email', { scope: 'user', userId, fetchImpl });
      if (!vaultId) { console.error(`${tag}: late re-push skipped, no vaultId`); return; }
      const res = await pushDocumentsFn(orgId, vaultId, rows.map((r) => renderMessageNote(r)), { userId, fetchImpl });
      if (res?.error) { console.error(`${tag}: late re-push failed, ${res.error} (will retry)`); return; }
      for (const r of rows) manifest.set(r.id, fingerprint(r));
      result.docsRepushed = (result.docsRepushed || 0) + rows.length;
      dirty = true;
    } catch (err) {
      console.error(`${tag}: late re-push failed, ${err.message} (will retry)`);
    }
  };
  let live;
  let liveRows;
  try {
    liveRows = (await listLiveIdsFn(orgId, userId)).map((x) => (typeof x === 'string' ? { id: x, ts: null, fp: null } : x));
    live = new Set(liveRows.map((x) => x.id));
  } catch (err) {
    // A read ERROR is not "mail is gone": retract nothing, keep the manifest.
    console.error(`${tag}: live id read failed, NOT deleting (${err.message})`);
    if (pushedIds.length) await persist();
    return;
  }
    await repush(liveRows);
  const gone = [...manifest.keys()].filter((id) => !live.has(id)).slice(0, MAX_DELETIONS_PER_TICK);
  if (gone.length === 0) { if (dirty || pushedIds.length) await persist(); return; }
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
  const ctx = {};
  const result = await ingestPush(orgId, opts, deps, pushedIds, ctx);
  result.docsDeleted = 0;
  result.docsRepushed = 0;
  if (result.skipped || opts.dryRun || result.error) return result;
  await reconcile(orgId, opts, deps, pushedIds, result, ctx);
  return result;
}

module.exports = {
  ingestEmail, htmlToText, stripQuotedTail, renderMessageNote, watermarkKeyForUser,
  SOURCE_TYPE, DEFAULT_MAX_MESSAGES, MAX_BODY_BYTES, MAX_REPUSH_PER_TICK,
};
