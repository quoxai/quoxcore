/**
 * feedGdriveSource.js — The Feed's Google Drive OAuth-connected ingester
 * (BRAIN2-OAUTH-GDRIVE, mirrors feedNotionSource.js's shape exactly — same
 * per-provider design entry, this time "gdrive").
 *
 * CONNECT, DON'T CONFIGURE — this is an 'oauth' connector
 * (feedSourceCatalog.js's `gdrive` entry), not a 'host' connector: there is
 * no path to type in. A user connects a Google account through the auth
 * service's OAuth handshake (services/auth/routes/oauth-connect.js), which
 * writes the resulting integration credential into the existing
 * Vault-backed integrations model and then registers this org's
 * feed_sources row with `config.credentialId` pointing at it. This
 * ingester does exactly one thing with that config: hand credentialId to
 * feedOauthTokenClient.getAccessToken() to get a short-lived access token.
 * It never sees a refresh token or an OAuth client secret — those live
 * entirely on the auth-service side of the broker, same contract as Notion.
 *
 * INERT BY DEFAULT — four independent gates, any one of which alone keeps
 * this source silent and non-throwing (identical to feedNotionSource.js):
 *   (a) feedScheduler.js only registers this ingester under
 *       SOURCE_INGESTERS when QUOXFEED_OAUTH_SOURCES_ENABLED === 'true'
 *       (the SAME flag Notion uses) — unset by default on every
 *       deployment, so the cockpit's derived status (feedApiHandlers.js
 *       LIVE_SOURCE_TYPES) stays 'available', never 'live', until an
 *       operator has actually witnessed a first successful sync.
 *   (b) No feed_sources row, or a row with no `config.credentialId`: this
 *       ingester returns `{skipped: 'not connected'}` immediately.
 *   (c) feedOauthTokenClient.getAccessToken() returns null (auth service
 *       down, credential revoked/deleted, INTERNAL_SERVICE_KEY unset, or
 *       no Google OAuth app configured at all): `result.error` is set to
 *       'no access token, reconnect required', nothing is pushed, no
 *       watermark advances.
 *   (d) Any Drive API error (401/403 on a revoked grant, network failure,
 *       malformed response) is caught — a single failing file never
 *       aborts the whole batch, and a failing files.list call fails this
 *       tick only, never throws to the scheduler.
 *
 * NOTE ON TOKEN LIFETIME — Google access tokens are short-lived (~1 hour)
 * and this scaffold, like Notion's, does not implement the refresh-token
 * rotation path (oauth-connect.js's token broker returns the stored token
 * as-is; see that module's supportsRefresh comment). Until that refresh
 * path is built, a connected Drive account will need reconnecting once its
 * access token expires — a known, named gap, not a silent failure: the
 * broker returning null degrades to gate (c) above.
 *
 * WATERMARK — keyed per connection, `gdrive:<sha1(credentialId)-first12>`
 * (feedNotionSource.js's watermarkKeyForCredential idiom): reconnecting a
 * different Google account must never inherit a stale cursor from a
 * previous connection. Client-side strictly-after filter on `modifiedTime`
 * against the stored watermark — same ORDERING CAVEAT as every other
 * ingester in this family: a single bounded files.list page can in
 * principle miss a very large backlog's older-but-newly-edited items past
 * the page cutoff. Accepted, same tradeoff.
 *
 * READ API — bounded, two calls per tick shape:
 *   1. GET /drive/v3/files (files.list), ordered by modifiedTime desc,
 *      pageSize capped at maxItems, `trashed = false` filter. One call
 *      covers the whole listing.
 *   2. Per eligible, text-readable file: GET /drive/v3/files/{id}/export
 *      (files.export, mimeType text/plain) for native Google Docs, or
 *      GET /drive/v3/files/{id}?alt=media (files.get) for plain-text
 *      files. Any other mimeType (sheets, slides, PDFs, images, folders,
 *      binaries) is not eligible for content read in this scaffold — it
 *      is skipped, never fetched, never thrown on.
 *   Per-item try/catch throughout — one bad file is skipped, the rest of
 *   the batch still ingests. A MAX_FILES_PER_TICK cap additionally bounds
 *   the number of content fetches per tick.
 *
 * NOTE MAPPING — one doc per file (`gdrive/<file_id>.md`, kind
 * 'gdrive_file'). Every rendered body passes through
 * feedAiHistorySource.redactSecrets — Drive content is external,
 * user-supplied text under the same threat model as a chat export.
 */

'use strict';

const crypto = require('crypto');
const feedWatermark = require('./feedWatermark.js');
const brainFeedClient = require('./brainFeedClient.js');
const feedBatchSupport = require('./feedBatchSupport.js');
const feedOauthTokenClient = require('./feedOauthTokenClient.js');
const { redactSecrets } = require('./feedAiHistorySource.js');

const SOURCE_TYPE = 'gdrive';
const VAULT_NAME = 'Google Drive';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

const DEFAULT_MAX_ITEMS = 25;
// Per-tick content-fetch cap, independent of maxItems (files.list can
// return more matches than we're willing to fully fetch content for in
// one 30-minute tick) — mirrors feedNotionSource.js's MAX_PAGES_PER_TICK.
const MAX_FILES_PER_TICK = 25;
const MAX_DOC_BYTES = 150 * 1024;
const LIST_PAGE_SIZE_CAP = 100; // Drive's practical page size
// BRAIN2-W5 030: files.list is paged via nextPageToken until exhausted (bounded);
// maxItems / MAX_FILES_PER_TICK bound the content fetches per tick instead.
const MAX_LIST_PAGES = 50;
const REQUEST_TIMEOUT_MS = 30000;

const GOOGLE_DOC_MIME_TYPE = 'application/vnd.google-apps.document';
// Plain-text mime types readable via files.get?alt=media without any
// export conversion.
const PLAIN_TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

/**
 * Derives a short, stable, per-connection watermark key so reconnecting a
 * different Google account under the same feed_sources row never inherits
 * a stale cursor from the previous connection — mirrors
 * feedNotionSource.js's watermarkKeyForCredential().
 */
function watermarkKeyForCredential(credentialId) {
  const hash = crypto.createHash('sha1').update(String(credentialId)).digest('hex').slice(0, 12);
  return `${SOURCE_TYPE}:${hash}`;
}

function driveHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * True (with a read strategy tag) if this file's mimeType is one this
 * ingester knows how to read text out of. Returns null (never throws) for
 * anything else — folders, spreadsheets, slides, PDFs, images, binaries —
 * so callers can skip content fetch for those without a special case.
 */
function readStrategyForMimeType(mimeType) {
  if (mimeType === GOOGLE_DOC_MIME_TYPE) return 'export';
  if (PLAIN_TEXT_MIME_TYPES.has(mimeType)) return 'get';
  return null;
}

/** Per-request signal: the scheduler's (if any) combined with a hard timeout. */
function requestSignal(signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Default GET /drive/v3/files (files.list) client, paged via nextPageToken.
 * The returned array carries `.complete` (false when the page cap cut the
 * listing short) so only a full listing is used for deletion reconciliation.
 * Overridable via deps.listFilesFn (tests).
 */
async function defaultListFiles(token, { fetchImpl = fetch, signal } = {}) {
  const files = [];
  let pageToken = null;
  let complete = false;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const url = new URL(`${DRIVE_API_BASE}/files`);
    // BRAIN2-W7 A 043: list only mime types the reader can ingest, so PDFs,
    // sheets, slides and binaries never occupy listing pages (or the page cap).
    const mimeClause = [GOOGLE_DOC_MIME_TYPE, ...PLAIN_TEXT_MIME_TYPES].map((m) => `mimeType = '${m}'`).join(' or ');
    url.searchParams.set('q', `trashed = false and (${mimeClause})`);
    url.searchParams.set('orderBy', 'modifiedTime desc');
    url.searchParams.set('pageSize', String(LIST_PAGE_SIZE_CAP));
    url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetchImpl(url.toString(), { headers: driveHeaders(token), signal: requestSignal(signal) });
    if (!res.ok) throw new Error(`GET /files failed HTTP ${res.status}`);
    const body = await res.json();
    if (Array.isArray(body?.files)) files.push(...body.files);
    pageToken = body?.nextPageToken || null;
    if (!pageToken) { complete = true; break; }
  }
  files.complete = complete;
  return files;
}

/** Default GET /drive/v3/files/{id}/export client (Google Docs → text/plain) — overridable via deps.exportFileFn (tests). Body read is byte-capped (BRAIN2-W5 041). */
async function defaultExportFile(token, fileId, { fetchImpl = fetch, signal } = {}) {
  const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/export`);
  url.searchParams.set('mimeType', 'text/plain');
  const res = await fetchImpl(url.toString(), { headers: driveHeaders(token), signal: requestSignal(signal) });
  if (!res.ok) throw new Error(`GET /files/${fileId}/export failed HTTP ${res.status}`);
  return feedBatchSupport.readCapped(res, MAX_DOC_BYTES + 1);
}

/** Default GET /drive/v3/files/{id}?alt=media client (plain-text files.get) — overridable via deps.getFileFn (tests). Body read is byte-capped (BRAIN2-W5 041). */
async function defaultGetFile(token, fileId, { fetchImpl = fetch, signal } = {}) {
  const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set('alt', 'media');
  const res = await fetchImpl(url.toString(), { headers: driveHeaders(token), signal: requestSignal(signal) });
  if (!res.ok) throw new Error(`GET /files/${fileId} failed HTTP ${res.status}`);
  return feedBatchSupport.readCapped(res, MAX_DOC_BYTES + 1);
}

/** Caps a rendered doc body at MAX_DOC_BYTES — truncated, never dropped, never thrown. */
function capContent(content, maxBytes = MAX_DOC_BYTES) {
  const str = String(content == null ? '' : content);
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
  return `${str.slice(0, maxBytes)}\n\n<!-- truncated: exceeds ${maxBytes} byte cap -->`;
}

/**
 * Renders one Drive file (plus its already-fetched text content) into a
 * push-ingest document.
 */
function renderFileDoc(file, contentText, accountLabel) {
  const title = file?.name || 'Untitled file';
  const link = file?.webViewLink || null;
  const provenance = link ? `[View in Google Drive](${link})` : '';
  const body = [`# ${title}`, '', provenance, '', contentText || ''].filter((l) => l !== '').join('\n');

  return {
    relPath: `gdrive/${file.id}.md`,
    content: capContent(redactSecrets(body)),
    title,
    kind: 'gdrive_file',
    sourceType: SOURCE_TYPE,
    occurredAt: file.modifiedTime,
    tags: ['gdrive', accountLabel].filter(Boolean),
  };
}

/**
 * Ingests an org's connected Google Drive account (text-readable files
 * only) into the "Google Drive" push vault. See module header for the full
 * gating contract — this function NEVER throws.
 *
 * @param {string} orgId
 * @param {{maxItems?: number, config?: {credentialId: string, accountLabel?: string}, dryRun?: boolean}} [opts]
 * @param {{
 *   getAccessTokenFn?: Function,  // (orgId, credentialId, {fetchImpl}) => Promise<string|null>
 *   listFilesFn?: Function,       // (token, {pageSize, fetchImpl}) => Promise<Array>
 *   exportFileFn?: Function,      // (token, fileId, {fetchImpl}) => Promise<string>
 *   getFileFn?: Function,         // (token, fileId, {fetchImpl}) => Promise<string>
 *   getWatermarkFn?: Function,    // (orgId) => string|null
 *   setWatermarkFn?: Function,    // (orgId, ts) => void
 *   ensurePushVaultFn?: Function, // defaults to brainFeedClient.ensurePushVault
 *   pushDocumentsFn?: Function,   // defaults to brainFeedClient.pushDocuments
 *   fetchImpl?: Function,         // forwarded everywhere (test injection)
 *   userId?: string,
 *   dbPath?: string,              // forwarded to feedWatermark (tests)
 * }} [deps]
 * @returns {Promise<{rowsRead: number, docsPushed: number, skipped: string|null, error: string|null}>}
 */
async function ingestGdrive(orgId, opts = {}, deps = {}) {
  const result = { rowsRead: 0, docsPushed: 0, skipped: null, error: null };

  const config = opts.config || null;
  const credentialId = config?.credentialId;
  if (!credentialId) {
    result.skipped = 'not connected';
    return result;
  }

  const {
    getAccessTokenFn = (org, credId, { fetchImpl } = {}) => feedOauthTokenClient.getAccessToken(org, SOURCE_TYPE, credId, { fetchImpl }),
    listFilesFn = defaultListFiles,
    exportFileFn = defaultExportFile,
    getFileFn = defaultGetFile,
    getWatermarkFn,
    setWatermarkFn,
    ensurePushVaultFn = brainFeedClient.ensurePushVault,
    pushDocumentsFn = brainFeedClient.pushDocuments,
    fetchImpl,
    userId,
    dbPath,
  } = deps;

  const watermarkKey = watermarkKeyForCredential(credentialId);
  const getWM = getWatermarkFn || ((org) => feedWatermark.getWatermark(org, watermarkKey, { dbPath }));
  const setWM = setWatermarkFn || ((org, ts) => feedWatermark.setWatermark(org, watermarkKey, ts, { dbPath }));

  const maxItems = opts.maxItems || DEFAULT_MAX_ITEMS;
  const dryRun = !!opts.dryRun;
  const accountLabel = config?.accountLabel || null;

  let token = null;
  try {
    token = await getAccessTokenFn(orgId, credentialId, { fetchImpl });
  } catch (err) {
    result.error = `token broker failed: ${err.message}`;
    console.error(`[FeedGdriveSource] org=${orgId}: ${result.error}`);
    return result;
  }
  if (!token) {
    result.error = 'no access token, reconnect required';
    console.error(`[FeedGdriveSource] org=${orgId}: ${result.error}`);
    return result;
  }

  let storedWatermark = null;
  try {
    storedWatermark = await getWM(orgId);
  } catch (err) {
    console.error(`[FeedGdriveSource] org=${orgId}: watermark read failed, treating as no watermark — ${err.message}`);
  }

  let files = [];
  try {
    files = (await listFilesFn(token, { pageSize: LIST_PAGE_SIZE_CAP, fetchImpl, signal: opts.signal })) || [];
  } catch (err) {
    result.error = `files.list failed: ${err.message}`;
    console.error(`[FeedGdriveSource] org=${orgId}: ${result.error}`);
    return result;
  }
  const listComplete = files.complete !== false;
  const stateStore = feedBatchSupport.resolveStateStore(deps, !!getWatermarkFn);
  const guard = await feedBatchSupport.createFailureGuard(stateStore, orgId, watermarkKey);

  // Compound (modifiedTime, id) cursor (BRAIN2-W5 033); unreadable mime types
  // never consume the per-tick budget.
  const allEligible = files
    .filter((file) => readStrategyForMimeType(file?.mimeType))
    .map((file) => ({ file, ts: file?.modifiedTime, id: file?.id }))
    .filter(({ ts, id }) => ts && feedWatermark.isAfterCursor(storedWatermark, ts, id))
    .sort(feedWatermark.compareByTsId);
  const eligible = allEligible.slice(0, maxItems);

  const docs = [];
  const processed = [];
  let newWatermark = storedWatermark || null;
  let filesProcessed = 0;
  let held = false; // first failed file: later files still push, the cursor does not move past it

  for (const { file, ts, id } of eligible) {
    if (filesProcessed >= MAX_FILES_PER_TICK) break;

    const strategy = readStrategyForMimeType(file?.mimeType);
    try {
      const contentText = strategy === 'export'
        ? await exportFileFn(token, file.id, { fetchImpl, signal: opts.signal })
        : await getFileFn(token, file.id, { fetchImpl, signal: opts.signal });

      docs.push(renderFileDoc(file, contentText, accountLabel));
      result.rowsRead += 1;
      filesProcessed += 1;
      guard.clear(id);
      if (!held) processed.push({ ts, id });
    } catch (err) {
      // BRAIN2-W5 026: hold the cursor at the first failure so it is retried;
      // after repeated failures it is passed over (loudly).
      const n = guard.record(id);
      console.error(`[FeedGdriveSource] org=${orgId}: file ${file.id} failed (${n}/${feedBatchSupport.MAX_ITEM_ATTEMPTS}) — ${err.message}`);
      if (guard.shouldSkip(id)) { if (!held) processed.push({ ts, id }); continue; }
      held = true;
      result.error = result.error || `read file ${file.id} failed — ${err.message}`;
    }
  }
  await guard.flush();

  const doneIds = new Set(processed.map((p) => p.id));
  const remaining = allEligible.filter((e) => !doneIds.has(e.id)).map(({ ts, id }) => ({ ts, id }));
  newWatermark = feedWatermark.nextCursor(processed, remaining) || newWatermark;

  if (dryRun) return result; // tallies rowsRead, pushes/advances nothing

  const ensureVault = async () => ensurePushVaultFn(orgId, VAULT_NAME, { scope: 'org', userId, fetchImpl });

  try {
    if (docs.length > 0) {
      const vaultId = await ensureVault();
      if (!vaultId) {
        result.error = 'ensurePushVault returned no vaultId';
        console.error(`[FeedGdriveSource] org=${orgId}: ${result.error} — not advancing watermark`);
        return result;
      }

      const pushResult = await pushDocumentsFn(orgId, vaultId, docs, { userId, fetchImpl });
      if (pushResult?.error) {
        result.error = pushResult.error;
        console.error(`[FeedGdriveSource] org=${orgId}: push failed — ${pushResult.error} — not advancing watermark`);
        return result;
      }

      result.docsPushed = docs.length;
    }

    if (newWatermark && newWatermark !== storedWatermark && (docs.length > 0 || processed.length > 0)) {
      try {
        await setWM(orgId, newWatermark);
      } catch (err) {
        console.error(`[FeedGdriveSource] org=${orgId}: watermark write failed — ${err.message}`);
      }
    }

    // BRAIN2-W5 024: a complete listing is a full snapshot, so files that
    // vanished (deleted, trashed, access revoked) get explicit tombstones.
    if (listComplete && stateStore) {
      const seen = files.filter((f) => f?.id && readStrategyForMimeType(f.mimeType)).map((f) => `gdrive/${f.id}.md`);
      const r = await feedBatchSupport.reconcileDeletions({
        store: stateStore, orgId, key: watermarkKey, seen, complete: true, ensureVault,
        pushDeletionsFn: deps.pushDeletionsFn || brainFeedClient.pushDeletions, pushOpts: { userId, fetchImpl },
      });
      if (r.deleted > 0) result.deleted = r.deleted;
      if (r.error) { result.error = r.error; console.error(`[FeedGdriveSource] org=${orgId}: ${r.error}`); }
    }
  } catch (err) {
    result.error = `push failed — ${err.message}`;
    console.error(`[FeedGdriveSource] org=${orgId}: ${result.error} — not advancing watermark`);
  }

  return result;
}

module.exports = {
  ingestGdrive,
  defaultGetFile,
  defaultListFiles,
  readStrategyForMimeType,
  renderFileDoc,
  capContent,
  watermarkKeyForCredential,
  SOURCE_TYPE,
  VAULT_NAME,
  DEFAULT_MAX_ITEMS,
  MAX_FILES_PER_TICK,
  MAX_DOC_BYTES,
  GOOGLE_DOC_MIME_TYPE,
  PLAIN_TEXT_MIME_TYPES,
};
