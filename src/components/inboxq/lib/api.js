/**
 * InboxQ API client — tiny fetch wrapper against the collector's native
 * InboxQ routes.
 *
 * InboxQ is collector-native (no separate backend service, no :port to
 * proxy): the collector itself registers these routes at
 * /api/v1/inboxq/* (see services/collector/server.js + lib/inboxq/api.js).
 * The dashboard always reaches the collector through the same-origin
 * `/collector` prefix (nginx strips it before it hits the collector app),
 * exactly the pattern QuoxLens's client uses for its own collector-native
 * routes — see src/components/quoxlens/lib/api.js.
 *
 * House rule: server-side is the source of truth. This module holds an
 * in-memory (per browser-session, cleared on reload) cache only — never
 * localStorage — for read data.
 *
 * v1 is proposal-only: creating/resolving a proposal records intent, it
 * never performs the underlying mail action (no send, no move, no block).
 * See services/collector/lib/inboxq/api.js's header comment.
 */

const API_BASE = '/collector/api/v1/inboxq';

/** In-memory cache, keyed by request URL. Cleared on full page reload. */
const cache = new Map();

/** In-flight promises, keyed by the same cacheKey as `cache` above — dedupes
 * two callers racing the same request before either has resolved yet
 * (mirrors quoxsignal/lib/api.js's request()). */
const inFlight = new Map();

async function request(path, { cacheKey, force = false } = {}) {
  const key = cacheKey ?? path;
  if (!force && cache.has(key)) return cache.get(key);
  if (!force && inFlight.has(key)) return inFlight.get(key);

  const promise = (async () => {
    const res = await fetch(path, { credentials: 'include' });
    if (!res.ok) {
      let bodyExcerpt = '';
      try {
        bodyExcerpt = (await res.text()).slice(0, 200);
      } catch {
        // ignore body read failures, the status is still informative
      }
      throw new Error(`API ${res.status} ${res.statusText} for ${path}: ${bodyExcerpt}`);
    }
    const data = await res.json();
    cache.set(key, data);
    return data;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

export function clearApiCache() {
  cache.clear();
  inFlight.clear();
}

function invalidateCache(prefix) {
  for (const key of cache.keys()) {
    if (key === prefix || key.startsWith(prefix)) cache.delete(key);
  }
}

/** Thrown by write-path helpers below. Carries the parsed error body so callers can surface `body.error`. */
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `API error ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function mutate(path, { method = 'POST', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let payload = null;
  try {
    payload = res.status === 204 ? null : await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    throw new ApiError(res.status, payload);
  }
  return payload;
}

export const api = {
  /** GET /accounts -> { accounts: [{ id, emailAddress, displayName, folders, pollEnabled, createdAt }] }. */
  listAccounts(opts) {
    return request(`${API_BASE}/accounts`, { cacheKey: 'accounts', ...opts });
  },

  /** POST /accounts -> { account }. Connects a mailbox already resolvable as a vault credential. */
  async createAccount({ credentialId, emailAddress, displayName, folders }) {
    const data = await mutate(`${API_BASE}/accounts`, {
      body: { credentialId, emailAddress, displayName, folders }
    });
    invalidateCache('accounts');
    return data;
  },

  /** DELETE /accounts/:id -> { removed }. */
  async deleteAccount(accountId) {
    const data = await mutate(`${API_BASE}/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
    invalidateCache('accounts');
    return data;
  },

  /** GET /accounts/:id/available-folders -> { folders: [imapPath, ...] }.
   * Live IMAP mailbox list for the picker; a new account only syncs INBOX
   * until the human opts into more via updateAccountFolders. */
  getAvailableFolders(accountId) {
    return request(`${API_BASE}/accounts/${encodeURIComponent(accountId)}/available-folders`, { force: true });
  },

  /** PUT /accounts/:id/folders {folders} -> { account }. Replaces the whole
   * set of folders the account syncs. */
  async updateAccountFolders(accountId, folders) {
    const data = await mutate(`${API_BASE}/accounts/${encodeURIComponent(accountId)}/folders`, {
      method: 'PUT', body: { folders }
    });
    invalidateCache('accounts');
    return data;
  },

  /**
   * GET /messages?accountId=&zone=&limit= -> { messages, zones }.
   * zone is one of focus|fyi|auto|screened; omit for all zones.
   */
  listMessages({ accountId, zone, limit = 50, offset = 0 } = {}, opts) {
    const qs = new URLSearchParams();
    if (accountId) qs.set('accountId', accountId);
    if (zone) qs.set('zone', zone);
    if (limit) qs.set('limit', limit);
    if (offset) qs.set('offset', offset);
    const qsStr = qs.toString();
    return request(`${API_BASE}/messages${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: `messages:${qsStr}`,
      ...opts
    });
  },

  /** GET /messages/:id -> { message }. Includes the full (bounded) body
   * captured at sync time — the list route deliberately omits it. */
  getMessage(id, opts) {
    return request(`${API_BASE}/messages/${encodeURIComponent(id)}`, { cacheKey: `message:${id}`, ...opts });
  },

  /** POST /messages/:id/fetch-body -> { message }. On-demand backfill for a
   * message stored before body capture (or before P1b shipped it): re-opens
   * IMAP for just this one message. A message that already has a body is a
   * no-op on the server (no IMAP call). */
  async fetchMessageBody(id) {
    const data = await mutate(`${API_BASE}/messages/${encodeURIComponent(id)}/fetch-body`);
    invalidateCache(`message:${id}`);
    invalidateCache('messages:');
    return data;
  },

  /** POST /messages/backfill-bodies {accountId, limit} -> { backfilled, remaining }.
   * Bulk backfill for an account's already-stored, still-bodyless messages;
   * call again (until remaining is 0) to work through a large backlog. */
  async backfillBodies({ accountId, limit = 50 } = {}) {
    const data = await mutate(`${API_BASE}/messages/backfill-bodies`, { body: { accountId, limit } });
    invalidateCache('messages:');
    invalidateCache('message:');
    return data;
  },

  /** GET /zones?accountId= -> { zones: { focus, fyi, auto, screened } }. */
  listZones({ accountId } = {}, opts) {
    const qs = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    return request(`${API_BASE}/zones${qs}`, { cacheKey: `zones:${accountId || 'all'}`, ...opts });
  },

  /**
   * GET /messages/search?accountId=&folder=&limit= -> { total, messages, matchSpec }.
   * Folder-scoped browse for the nav's real IMAP folder rows: the same
   * bounded search route the `inbox_search` agent tool uses
   * (INBOXQ_AGENT_DESIGN.md §A), scoped down to just the folder field.
   * `total` is the full match count; `messages` is capped server-side at
   * 200 (searchMessages' hard cap) and this route has no offset param, so a
   * folder past that size is shown honestly as "first N of total" by the
   * caller rather than paginated.
   */
  listByFolder({ accountId, folder, limit = 200 } = {}, opts) {
    const qs = new URLSearchParams();
    if (accountId) qs.set('accountId', accountId);
    if (folder) qs.set('folder', folder);
    if (limit) qs.set('limit', limit);
    const qsStr = qs.toString();
    return request(`${API_BASE}/messages/search${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: `folder:${accountId || ''}:${folder || ''}`,
      ...opts
    });
  },

  /** POST /sync {accountId} -> { summary }. Pulls new mail and re-classifies since the last sync. */
  async syncAccount(accountId) {
    const data = await mutate(`${API_BASE}/sync`, { body: { accountId } });
    invalidateCache('messages:');
    invalidateCache('zones:');
    invalidateCache('folder:');
    return data;
  },

  /** GET /sync-status?accountId -> { syncing, stored, folders:{total,backfilled} }.
   *  Live progress for the detached full sync (gap d). Never cached — each poll
   *  forces a fresh read so the UI reflects real server state. */
  async syncStatus(accountId) {
    return request(`${API_BASE}/sync-status?accountId=${encodeURIComponent(accountId)}`, { force: true });
  },

  /** POST /reclassify {accountId} -> { counts }. Re-runs classification and
   * learned reputation over stored messages, re-sorting them into zones. */
  async reclassify(accountId) {
    const data = await mutate(`${API_BASE}/reclassify`, { body: { accountId } });
    invalidateCache('messages:');
    invalidateCache('zones:');
    invalidateCache('folder:');
    return data;
  },

  /** POST /messages/:id/move {toZone} -> updates the message's zone and feeds
   * the sender-reputation learning loop. toZone is one of focus|fyi|auto|screened. */
  async moveMessage(messageId, toZone) {
    const data = await mutate(`${API_BASE}/messages/${encodeURIComponent(messageId)}/move`, {
      body: { toZone }
    });
    invalidateCache('messages:');
    invalidateCache('zones:');
    invalidateCache('folder:');
    return data;
  },

  /** POST /messages/move-to-folder {messageIds, folder, accountId} -> { moved[], failed[], moves[] }.
   * Human-authoritative instant manual sort: real IMAP UID MOVE of the given
   * messages into `folder` (an inboxq_folders id, name, or imap_path), not
   * an agent proposal. Per-message failure isolation server-side. `moved` is the
   * array of moved message ids; `moves` carries the undo-log entries (AQ-9E U2). */
  /**
   * GET /messages/search by sender (or domain/text) -> { total, messages, matchSpec }.
   * Backs the row "File > all from this sender" flow: find every stored message
   * from a sender so they can be filed in one direct move. Server-capped at 200;
   * callers report "N of total" honestly when total exceeds that.
   */
  searchMessages({ accountId, from, fromDomain, text, limit = 200 } = {}, opts) {
    const qs = new URLSearchParams();
    if (accountId) qs.set('accountId', accountId);
    if (from) qs.set('from', from);
    if (fromDomain) qs.set('fromDomain', fromDomain);
    if (text) qs.set('text', text);
    if (limit) qs.set('limit', limit);
    const s = qs.toString();
    return request(`${API_BASE}/messages/search${s ? `?${s}` : ''}`, { cacheKey: `search:${s}`, ...opts });
  },

  async moveToFolder({ messageIds, folder, accountId }) {
    const data = await mutate(`${API_BASE}/messages/move-to-folder`, { body: { messageIds, folder, accountId } });
    invalidateCache('messages:');
    invalidateCache('zones:');
    invalidateCache('folder:');
    return data;
  },

  /** POST /moves/undo {moveId} -> { ok, moveId, messageId, restoredTo, uid }.
   * AQ-9E U2: reverse a recorded move (real reverse IMAP move back to the source
   * folder). Idempotent-safe server-side (a move already undone 409s). */
  async undoMove({ moveId }) {
    const data = await mutate(`${API_BASE}/moves/undo`, { body: { moveId } });
    invalidateCache('messages:');
    invalidateCache('zones:');
    invalidateCache('folder:');
    return data;
  },

  /** GET /folders/tree?accountId= -> { live, folders[] }. AQ-9E U3/U4: the real
   * IMAP folder tree with per-folder stored counts, coverage (watched), and
   * reconcile state. `live` is false when the tree is the last-known fallback
   * (IMAP unreachable) rather than a verified live read. */
  folderTree({ accountId } = {}, opts) {
    if (!accountId) return Promise.resolve({ live: false, folders: [] });
    return request(`${API_BASE}/folders/tree?accountId=${encodeURIComponent(accountId)}`, {
      cacheKey: `foldertree:${accountId}`, ...opts,
    });
  },

  /** GET /moves/recent?accountId=&limit= -> { moves }. AQ-9E U2: recent undoable moves. */
  listMoves({ accountId, limit } = {}, opts) {
    const qs = new URLSearchParams();
    if (accountId) qs.set('accountId', accountId);
    if (limit) qs.set('limit', String(limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request(`${API_BASE}/moves/recent${suffix}`, { cacheKey: `moves:${accountId || 'all'}`, ...opts });
  },

  /** POST /senders/trust {fromAddr, accountId} -> { ok, restored }.
   * Human-authoritative instant "Trust sender": the ALLOW mirror of
   * blockSender. Marks the sender trusted (future mail never auto-screened)
   * and re-zones their currently-stored Screened/FYI/Auto mail back to Focus. */
  async trustSender({ fromAddr, accountId }) {
    const data = await mutate(`${API_BASE}/senders/trust`, { body: { fromAddr, accountId } });
    invalidateCache('messages:');
    invalidateCache('zones:');
    invalidateCache('folder:');
    invalidateCache('blocked:');
    return data;
  },

  /** POST /folders {accountId, name} -> { folder }. Creates a durable custom
   * filing folder, backed by a real IMAP CREATE. */
  async createFolder({ accountId, name }) {
    const data = await mutate(`${API_BASE}/folders`, { body: { accountId, name } });
    // A new folder changes the account's folder list (now appended server-side)
    // and the folder reads; drop their caches so every destination dropdown
    // (File, Rules, bulk) shows it on the next read, not after a full sync.
    invalidateCache('accounts');
    invalidateCache('folder:');
    return data;
  },

  /** POST /senders/block {fromAddr, accountId, scope, domain?} -> { ok, screened, scope, target, sender? }.
   * Human-authoritative instant block: screens the sender (future mail auto-screened)
   * and re-zones their stored mail to screened. scope is 'sender' (default) or 'domain'
   * (blocks every address at fromAddr's domain, or an explicit `domain`). Not the agent
   * proposal path. */
  async blockSender({ fromAddr, accountId, scope = 'sender', domain }) {
    const data = await mutate(`${API_BASE}/senders/block`, { body: { fromAddr, accountId, scope, domain } });
    invalidateCache('messages:');
    invalidateCache('zones:');
    invalidateCache('folder:');
    return data;
  },

  /** GET /senders/blocked?accountId= -> { blocked: [{ target, type, blockedAt }] }. */
  listBlocked({ accountId } = {}, opts) {
    const qs = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    return request(`${API_BASE}/senders/blocked${qs}`, { cacheKey: `blocked:${accountId || 'all'}`, ...opts });
  },

  /** POST /senders/unblock {target, type, accountId} -> { ok, target, type }. */
  async unblock({ target, type = 'sender', accountId }) {
    const data = await mutate(`${API_BASE}/senders/unblock`, { body: { target, type, accountId } });
    invalidateCache('blocked:');
    invalidateCache('messages:');
    invalidateCache('zones:');
    invalidateCache('folder:');
    return data;
  },

  /** POST /report/generate {accountId} -> { report: { bodyMd, counts } }. */
  async generateReport(accountId) {
    const data = await mutate(`${API_BASE}/report/generate`, { body: { accountId } });
    invalidateCache(`report:${accountId}`);
    return data;
  },

  /** GET /report/latest?accountId= -> { report: {...} | null }. */
  getLatestReport(accountId, opts) {
    if (!accountId) return Promise.resolve({ report: null });
    return request(`${API_BASE}/report/latest?accountId=${encodeURIComponent(accountId)}`, {
      cacheKey: `report:${accountId}`,
      ...opts
    });
  },

  /** GET /proposals?status= -> { proposals }. */
  listProposals({ status } = {}, opts) {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return request(`${API_BASE}/proposals${qs}`, { cacheKey: `proposals:${status || 'all'}`, ...opts });
  },

  /** POST /proposals {accountId, kind, payload} -> { proposal }. kind is file|block|draft. */
  async createProposal({ accountId, kind, payload }) {
    const data = await mutate(`${API_BASE}/proposals`, { body: { accountId, kind, payload } });
    invalidateCache('proposals:');
    return data;
  },

  /** POST /proposals/:id/resolve {decision: 'approve'|'deny'} -> { proposal, executed: false }. */
  async resolveProposal(proposalId, decision) {
    const data = await mutate(`${API_BASE}/proposals/${encodeURIComponent(proposalId)}/resolve`, {
      body: { decision }
    });
    invalidateCache('proposals:');
    return data;
  },

  /** GET /settings -> { settings: { syncEnabled, syncIntervalMin, llmBudgetPerTick,
   * classifierModel, availableClassifierModels: [{id,provider,label}] } }.
   * classifierModel is null when the (opt-in) LLM tie-break classifier is disabled —
   * the default, deterministic-only, zero extra cost. */
  getSettings(opts) {
    return request(`${API_BASE}/settings`, { cacheKey: 'settings', ...opts });
  },

  /** PUT /settings {syncEnabled?, syncIntervalMin?, llmBudgetPerTick?, classifierModel?} -> { settings }.
   * classifierModel must be an id from availableClassifierModels, or null to disable;
   * an out-of-list id is rejected (400). */
  async updateSettings(patch) {
    const data = await mutate(`${API_BASE}/settings`, { method: 'PUT', body: patch });
    invalidateCache('settings');
    return data;
  },

  /** GET /rules?accountId= -> { rules: [{id,accountId,matchType,matchValue,action,targetFolder,enabled,priority,createdAt}] }. */
  listRules({ accountId } = {}, opts) {
    const qs = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    return request(`${API_BASE}/rules${qs}`, { cacheKey: `rules:${accountId || 'all'}`, ...opts });
  },

  /** POST /rules {accountId, matchType, matchValue, action, targetFolder?, priority?, enabled?} -> { rule }.
   * matchType is one of from|domain|tld|name|subject; action is one of move|screen|block
   * (targetFolder required for move). Applied on every future sync AND left
   * dormant against already-stored mail until applyRules is called. */
  async createRule({ accountId, matchType, matchValue, action, targetFolder, priority, enabled }) {
    const data = await mutate(`${API_BASE}/rules`, {
      body: { accountId, matchType, matchValue, action, targetFolder, priority, enabled }
    });
    invalidateCache('rules:');
    return data;
  },

  /** PATCH /rules/:id {matchType?, matchValue?, action?, targetFolder?, priority?, enabled?} -> { rule }. */
  async updateRule(ruleId, fields) {
    const data = await mutate(`${API_BASE}/rules/${encodeURIComponent(ruleId)}`, { method: 'PATCH', body: fields });
    invalidateCache('rules:');
    return data;
  },

  /** PATCH /rules/:id {enabled} -> { rule }. Toggle a rule on/off without
   * touching its match/action shape. */
  async setRuleEnabled(ruleId, enabled) {
    const data = await mutate(`${API_BASE}/rules/${encodeURIComponent(ruleId)}`, { method: 'PATCH', body: { enabled } });
    invalidateCache('rules:');
    return data;
  },

  /** DELETE /rules/:id -> { removed }. */
  async deleteRule(ruleId) {
    const data = await mutate(`${API_BASE}/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
    invalidateCache('rules:');
    return data;
  },

  /** POST /rules/preview {accountId, matchType, matchValue} -> { matchCount, sample }.
   * Dry-run over already-stored mail only (never IMAP, never mutates) so the
   * UI can show "this would match N" before the human saves the rule. */
  previewRule({ accountId, matchType, matchValue }) {
    return mutate(`${API_BASE}/rules/preview`, { body: { accountId, matchType, matchValue } });
  },

  /** POST /rules/apply {accountId, ruleId?} -> { applied, moved, screened, blocked }.
   * User-triggered backlog pass: applies enabled rules (or just `ruleId`, if
   * given) to the account's already-stored mail, including real IMAP moves. */
  async applyRules({ accountId, ruleId } = {}) {
    const data = await mutate(`${API_BASE}/rules/apply`, { body: { accountId, ruleId } });
    invalidateCache('messages:');
    invalidateCache('zones:');
    invalidateCache('folder:');
    return data;
  },

  /** GET /watches?activeOnly= -> { watches: [{id,label,match,active,hitCount,accountId}] }. */
  listWatches({ activeOnly } = {}, opts) {
    const qs = activeOnly ? '?activeOnly=1' : '';
    return request(`${API_BASE}/watches${qs}`, { cacheKey: `watches:${activeOnly ? 'active' : 'all'}`, ...opts });
  },

  /** POST /watches {accountId?, label, match} -> { watch }. */
  async createWatch({ accountId, label, match }) {
    const data = await mutate(`${API_BASE}/watches`, { body: { accountId, label, match } });
    invalidateCache('watches:');
    return data;
  },

  /** POST /watches/:watchId/active {active} -> { updated: true }. */
  async setWatchActive(watchId, active) {
    const data = await mutate(`${API_BASE}/watches/${encodeURIComponent(watchId)}/active`, { body: { active } });
    invalidateCache('watches:');
    return data;
  },

  /** GET /filing/status?accountId= -> { enabled, folders: {fyi,auto,screened,unsure} }.
   * Physical filing (P3) is off by default, per-org opt-in. */
  getFilingStatus(accountId, opts) {
    return request(`${API_BASE}/filing/status?accountId=${encodeURIComponent(accountId)}`, {
      cacheKey: `filing:status:${accountId}`,
      ...opts
    });
  },

  /** POST /filing/preview {accountId} -> { plan: [{target, count}], total }.
   * DRY-RUN over already-stored mail only — never touches IMAP, never
   * mutates. Shows what enabling (or applying to backlog) WOULD do. */
  previewFiling({ accountId }) {
    return mutate(`${API_BASE}/filing/preview`, { body: { accountId } });
  },

  /** POST /filing/enable {accountId, applyToExisting} -> { enabled, created, moved, failed }.
   * Creates the 4 InboxQ/* folders and turns on future physical filing for
   * this org. When applyToExisting is true, also runs a real backlog move
   * of already-stored mail right now (failure-isolated). */
  async enableFiling({ accountId, applyToExisting = false }) {
    const data = await mutate(`${API_BASE}/filing/enable`, { body: { accountId, applyToExisting } });
    invalidateCache('filing:');
    invalidateCache('messages:');
    invalidateCache('zones:');
    invalidateCache('folder:');
    return data;
  },

  /** POST /filing/disable {accountId} -> { enabled: false, note }.
   * Stops future physical filing; does NOT un-move mail already filed. */
  async disableFiling({ accountId }) {
    const data = await mutate(`${API_BASE}/filing/disable`, { body: { accountId } });
    invalidateCache('filing:');
    return data;
  },

  /** POST /messages/confirm-junk {messageIds, accountId} -> { moved, blocked, failed }.
   * Escalates a reviewed InboxQ/Screened message to the mailbox's real
   * Junk/Spam folder and blocks its sender (future mail auto-screened). */
  async confirmJunk({ messageIds, accountId }) {
    const data = await mutate(`${API_BASE}/messages/confirm-junk`, { body: { messageIds, accountId } });
    invalidateCache('messages:');
    invalidateCache('zones:');
    invalidateCache('folder:');
    invalidateCache('blocked:');
    return data;
  }
};

export default api;
