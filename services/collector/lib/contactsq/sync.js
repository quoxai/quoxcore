'use strict';

/**
 * ContactsQ P7: ONE-WAY PULL SYNC from a CardDAV address book (iCloud, Fastmail, Nextcloud, ...).
 *
 * Rules (owner decisions, not up for re-litigation):
 *  - One way. ContactsQ is the governed copy. Nothing here ever writes back to the address book.
 *  - An upstream deletion FLAGS the linked contact ('source_removed', visible in the UI). It never erases it:
 *    erasure stays a deliberate GDPR act.
 *  - Additive to local data: an identifier is never removed, and a field the user edited locally since the last
 *    sync (the contact's updated_at moved past the value recorded at the last sync) is never overwritten.
 *  - New cards go through the SAME planImport/commitImport machinery as a file import (source_type 'sync_carddav'),
 *    so dedupe by identifier, suppression marking and erasure tombstones behave exactly like import: an erased
 *    person's identifier never comes back.
 *  - Sync tables hold a HASH of each upstream href, the etag and the contact id. No name, email or phone.
 *
 * Loop hygiene (the triad), see tick(): failures are counted distinctly from empty runs, a failing source backs
 * off exponentially (capped), and after MAX_FAILURES consecutive failures it is RETIRED until a human re-enables it.
 */

const nodeCrypto = require('node:crypto');
const store = require('./store.js');
const imp = require('./import.js');
const carddav = require('./carddav.js');
const { resolveCarddavCredential } = require('./credential.js');

const MAX_FAILURES = 10;
const BACKOFF_BASE_MIN = 15;
const BACKOFF_CAP_MIN = 360;
const MIN_INTERVAL_MIN = 15;
const MAX_INTERVAL_MIN = 10080;
const MAX_PER_TICK = 5;
const SOURCE_REMOVED = 'source_removed';
const yieldLoop = () => new Promise((r) => setImmediate(r));

class SyncError extends Error {
  constructor(code, status = 400, extra = null) { super(code); this.code = code; this.status = status; this.extra = extra; }
}

/** Failure code for the source's last_status: a stable, PII-free token. */
function failureCode(e) {
  if (e instanceof carddav.CardDavError) return e.code;
  if (e instanceof SyncError) return e.code;
  if (e instanceof store.ContactsqError) return e.code;
  const m = e && e.message;
  if (['credential_resolve_failed', 'lease_required', 'credential_incomplete', 'credential_wrong_kind'].includes(m)) return m;
  return 'sync_failed';
}

const backoffMin = (n) => Math.min(BACKOFF_BASE_MIN * 2 ** Math.max(n - 1, 0), BACKOFF_CAP_MIN);

function viewSource(r) {
  return {
    id: r.id, provider: r.provider, label: r.label, credential_id: r.credential_id, enabled: Boolean(r.enabled),
    interval_min: r.interval_min === null || r.interval_min === undefined ? null : r.interval_min,
    last_run_at: r.last_run_at || null, last_status: r.last_status || null, last_counts: store.parseJson(r.last_counts, null),
    consecutive_failures: r.consecutive_failures, backoff_until: r.backoff_until || null, retired_at: r.retired_at || null,
    has_token: Boolean(r.sync_token), created_at: r.created_at,
  };
}

const getSource = (orgId, id) => store.getDb().prepare('SELECT * FROM sync_sources WHERE id = ? AND org_id = ?').get(String(id), orgId) || null;
const listSources = (orgId) => store.getDb().prepare('SELECT * FROM sync_sources WHERE org_id = ? ORDER BY created_at ASC, rowid ASC').all(orgId).map(viewSource);

function invalidateIdentity() {
  try { require('./identity.js').invalidate(); } catch (e) { console.warn('[contactsq] identity cache invalidate failed:', e && e.message); }
}

/**
 * @param {{ emit: Function, deps?: { fetchImpl?: Function, resolver?: object, allowInsecureHttp?: boolean, resolveCredential?: Function } }} o
 */
function createSync({ emit, deps = {} }) {
  const running = new Set();
  let ticking = false;
  const resolveCredential = deps.resolveCredential || ((orgId, credId) => resolveCarddavCredential(orgId, credId, { fetchImpl: deps.credentialFetch || fetch }));
  const clientFor = (cred, serverUrl) => carddav.createClient({
    serverUrl, username: cred.username, password: cred.password,
    fetchImpl: deps.fetchImpl || fetch, resolver: deps.resolver || require('node:dns').promises, allowInsecureHttp: Boolean(deps.allowInsecureHttp),
    ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
  });

  const normPath = (href, bookUrl) => {
    let p = new URL(href, bookUrl).pathname;
    try { p = decodeURIComponent(p); } catch { /* keep raw */ }
    return p;
  };
  const hashOf = (sourceId, href, bookUrl) => nodeCrypto.createHash('sha256').update(`${sourceId}\n${normPath(href, bookUrl)}`).digest('hex').slice(0, 40);

  // ---- link table ---------------------------------------------------------
  const linkOf = (orgId, sourceId, hash) => store.getDb().prepare('SELECT * FROM sync_links WHERE org_id = ? AND source_id = ? AND href_hash = ?').get(orgId, sourceId, hash) || null;
  function putLink(orgId, sourceId, hash, { etag, contactId, removedAt = null, snapshot = null }) {
    store.getDb().prepare(`
      INSERT INTO sync_links (org_id, source_id, href_hash, etag, contact_id, removed_at, local_edit_at_last_sync) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id, source_id, href_hash) DO UPDATE SET etag = excluded.etag, contact_id = excluded.contact_id, removed_at = excluded.removed_at, local_edit_at_last_sync = excluded.local_edit_at_last_sync
    `).run(orgId, sourceId, hash, etag || null, contactId || null, removedAt, snapshot);
  }
  const snapshotOf = (orgId, contactId) => { const r = contactId ? store.getContactRow(orgId, contactId) : null; return r ? r.updated_at : null; };
  const liveRow = (orgId, id) => {
    let r = id ? store.getContactRow(orgId, id) : null;
    if (r && r.status === 'merged' && r.merged_into) r = store.getContactRow(orgId, r.merged_into);
    return r && r.status !== 'erased' && r.status !== 'merged' ? r : null;
  };

  // ---- the run ------------------------------------------------------------

  /** Flag or unflag 'source_removed' (additive over the contact's other flags). */
  function setRemovedFlag(orgId, contactId, on) {
    const row = liveRow(orgId, contactId);
    if (!row) return false;
    const cur = store.parseJson(row.flags_json, []);
    const has = cur.includes(SOURCE_REMOVED);
    if (on === has) return false;
    store.updateContact(orgId, row.id, { flags: on ? [...cur, SOURCE_REMOVED] : cur.filter((f) => f !== SOURCE_REMOVED) });
    return true;
  }

  async function execute(src, { dryRun, by }) {
    const orgId = src.org_id;
    const cred = await resolveCredential(orgId, src.credential_id);
    const client = clientFor(cred, src.server_url);
    const book = src.addressbook_url;
    const c = {
      fetched: 0, created: 0, linked_existing: 0, updated: 0, unchanged: 0, flagged_removed: 0, restored: 0, skipped_tombstoned: 0,
      skipped_invalid: 0, duplicates_in_file: 0, identifiers_added: 0, photos: 0, row_errors: 0, full_resync: 0, pages: 0, requests: 0,
    };
    const db = store.getDb();

    // 1. What changed upstream?
    let changed = [];
    let removedHashes = [];
    let newToken = src.sync_token || null;
    let full = !src.sync_token;
    if (src.sync_token) {
      let tok = src.sync_token;
      for (let page = 0; page < 50; page += 1) {
        let r;
        try { r = await client.syncCollection(book, tok); } catch (e) {
          if (e instanceof carddav.CardDavError && e.code === 'invalid_sync_token') { full = true; changed = []; removedHashes = []; break; }
          throw e;
        }
        c.pages += 1;
        changed.push(...r.changed);
        removedHashes.push(...r.removed.map((h) => hashOf(src.id, h, book)));
        newToken = r.token || tok;
        tok = r.token || tok;
        if (!r.truncated) break;
      }
    }
    if (full) {
      c.full_resync = 1;
      const listing = await client.listEtags(book);
      c.pages += 1;
      changed = listing.items;
      newToken = listing.token || null;
      const seen = new Set(listing.items.map((i) => hashOf(src.id, i.href, book)));
      removedHashes = db.prepare('SELECT href_hash FROM sync_links WHERE org_id = ? AND source_id = ? AND removed_at IS NULL').all(orgId, src.id)
        .map((r) => r.href_hash).filter((h) => !seen.has(h));
    }

    // Only cards whose etag differs from the stored link (or whose link was marked removed) need fetching.
    const todo = [];
    for (const ch of changed) {
      const hash = hashOf(src.id, ch.href, book);
      const link = linkOf(orgId, src.id, hash);
      if (link && link.etag === ch.etag && !link.removed_at) { c.unchanged += 1; continue; }
      todo.push({ ...ch, hash, link });
    }
    c.fetched = todo.length;

    // 2. Fetch, plan and commit in batches of 50; each batch is durable before the next starts.
    for (let i = 0; i < todo.length; i += carddav.MULTIGET_BATCH) {
      const batch = todo.slice(i, i + carddav.MULTIGET_BATCH);
      const byHref = new Map(batch.map((b) => [normPath(b.href, book), b]));
      const cards = await client.multiget(book, batch.map((b) => b.href));
      const records = [];
      const meta = new Map(); // record row -> { hash, etag, link, edited }
      for (const card of cards) {
        const b = byHref.get(normPath(card.href, book));
        if (!b) continue;
        let rec = null;
        try { [rec] = imp.parseVcardRecords(card.vcard); } catch { rec = null; }
        if (!rec) {
          c.skipped_invalid += 1;
          if (!dryRun) putLink(orgId, src.id, b.hash, { etag: card.etag || b.etag, contactId: b.link ? b.link.contact_id : null, removedAt: b.link ? b.link.removed_at : null, snapshot: b.link ? b.link.local_edit_at_last_sync : null });
          continue;
        }
        rec.row = records.length + 1;
        records.push(rec);
        meta.set(rec.row, { hash: b.hash, etag: card.etag || b.etag, link: b.link });
      }
      if (records.length) {
        const parsed = { format: 'carddav', source_type: 'sync_carddav', records };
        const planned = imp.planImport(orgId, parsed);
        c.skipped_tombstoned += planned.report.skipped_tombstoned;
        c.skipped_invalid += planned.report.invalid.length;
        c.duplicates_in_file += planned.report.duplicates_in_file;
        const planRows = new Map();
        for (const e of planned.plan) {
          const m = meta.get(e.row);
          const linked = m.link && m.link.contact_id ? liveRow(orgId, m.link.contact_id) : null;
          m.linked = linked;
          m.hadExisting = Boolean(e.existing_id);
          if (linked && !e.folded_into) {
            e.existing_id = linked.id;
            // Edited locally since the last sync: company and title are left alone too (name is handled after the commit).
            m.edited = Boolean(m.link.local_edit_at_last_sync) && linked.updated_at > m.link.local_edit_at_last_sync;
            if (m.edited) { e.company = ''; e.title = ''; }
          }
          m.entry = e;
          planRows.set(e.row, e);
        }
        if (dryRun) {
          for (const e of planned.plan) {
            const m = meta.get(e.row);
            if (e.folded_into) continue;
            if (m.linked) c.updated += 1; else if (m.hadExisting) c.linked_existing += 1; else c.created += 1;
          }
        } else {
          let out;
          try { out = imp.commitImport(orgId, parsed, planned, { by }); } finally { invalidateIdentity(); }
          c.identifiers_added += out.report.identifiers_added;
          c.photos += out.report.photos;
          c.row_errors += out.report.row_errors.length;
          const failedRows = new Set(out.report.row_errors.map((x) => x.row));
          for (const [row, m] of meta) {
            const contactId = out.row_contacts.get(row) || null;
            if (failedRows.has(row)) continue; // not linked, so the next sync retries it
            if (!contactId) {
              // Tombstoned or invalid: remember the etag so a full resync does not refetch it forever.
              putLink(orgId, src.id, m.hash, { etag: m.etag, contactId: m.link ? m.link.contact_id : null, removedAt: m.link ? m.link.removed_at : null, snapshot: m.link ? m.link.local_edit_at_last_sync : null });
              continue;
            }
            const e = m.entry;
            const row2 = liveRow(orgId, contactId);
            if (m.linked) {
              c.updated += 1;
              if (row2 && !m.edited && e && !e.folded_into) {
                try {
                  if (row2.kind === 'person' && e.name) store.updateContact(orgId, row2.id, { name: e.name, display_name_override: e.display_name_override || null });
                  else if (row2.kind === 'organisation' && e.display_name) store.updateContact(orgId, row2.id, { display_name: e.display_name });
                } catch (err) {
                  if (!(err instanceof store.ContactsqError)) throw err;
                  c.row_errors += 1;
                }
              }
            } else if (m.hadExisting) c.linked_existing += 1;
            else if (!e || !e.folded_into) c.created += 1;
            if (m.link && m.link.removed_at && setRemovedFlag(orgId, contactId, false)) c.restored += 1;
            putLink(orgId, src.id, m.hash, { etag: m.etag, contactId, removedAt: null, snapshot: snapshotOf(orgId, contactId) });
          }
          invalidateIdentity();
        }
      }
      await yieldLoop();
    }

    // 3. Upstream deletions FLAG the linked contact. Nothing is erased.
    let n = 0;
    for (const hash of removedHashes) {
      const link = linkOf(orgId, src.id, hash);
      if (!link || link.removed_at) continue;
      if (dryRun) { if (link.contact_id && liveRow(orgId, link.contact_id)) c.flagged_removed += 1; continue; }
      if (link.contact_id && setRemovedFlag(orgId, link.contact_id, true)) c.flagged_removed += 1;
      putLink(orgId, src.id, hash, { etag: link.etag, contactId: link.contact_id, removedAt: store.nowIso(), snapshot: snapshotOf(orgId, link.contact_id) });
      n += 1;
      if (n % 200 === 0) await yieldLoop();
    }
    if (!dryRun) invalidateIdentity();
    c.requests = client.stats.requests;
    return { counts: c, token: newToken };
  }

  /** Run one source now (manual or scheduled). Failure accounting happens here for real (non-dry) runs. */
  async function run(ctx, id, { dryRun = false } = {}) {
    const orgId = ctx.orgId;
    const src = getSource(orgId, id);
    if (!src) throw new SyncError('not_found', 404);
    if (src.retired_at) throw new SyncError('source_retired', 409);
    if (running.has(src.id)) throw new SyncError('sync_in_progress', 409);
    running.add(src.id);
    const db = store.getDb();
    try {
      const by = ctx.userId ? `user:${ctx.userId}` : `sync:${src.id}`;
      let res;
      try {
        res = await execute(src, { dryRun, by });
      } catch (e) {
        const code = failureCode(e);
        if (!dryRun) {
          const n = src.consecutive_failures + 1;
          const retire = n >= MAX_FAILURES;
          db.prepare('UPDATE sync_sources SET last_run_at = ?, last_status = ?, consecutive_failures = ?, backoff_until = ?, retired_at = ? WHERE id = ? AND org_id = ?')
            .run(store.nowIso(), retire ? `retired:${code}` : `failed:${code}`, n,
              retire ? null : new Date(Date.now() + backoffMin(n) * 60000).toISOString(), retire ? store.nowIso() : null, src.id, orgId);
        }
        emit(dryRun ? 'quox.contacts.sync_dry_run' : 'quox.contacts.sync_run', ctx, { source_id: src.id, outcome: 'failed', reason: code, ...(e && e.status ? { counts: { http_status: e.status } } : {}) });
        if (e instanceof SyncError) throw e;
        throw new SyncError(code, e instanceof carddav.CardDavError && e.code === 'auth_failed' ? 422 : 502);
      }
      if (!dryRun) {
        db.prepare('UPDATE sync_sources SET sync_token = ?, last_run_at = ?, last_status = ?, last_counts = ?, consecutive_failures = 0, backoff_until = NULL WHERE id = ? AND org_id = ?')
          .run(res.token, store.nowIso(), 'ok', JSON.stringify(res.counts), src.id, orgId);
      }
      emit(dryRun ? 'quox.contacts.sync_dry_run' : 'quox.contacts.sync_run', ctx, { source_id: src.id, counts: res.counts, outcome: dryRun ? 'dry_run' : 'synced' });
      return { dry_run: dryRun, counts: res.counts };
    } finally {
      running.delete(src.id);
    }
  }

  // ---- source management ----------------------------------------------------

  async function addSource(ctx, b) {
    const orgId = ctx.orgId;
    const cred = await resolveCredential(orgId, b.credential_id).catch((e) => {
      const code = failureCode(e);
      throw new SyncError(code, code === 'lease_required' ? 403 : code === 'credential_wrong_kind' || code === 'credential_incomplete' ? 422 : 502);
    });
    if (!cred.server_url) throw new SyncError('server_url_required', 422);
    const client = clientFor(cred, cred.server_url);
    let found;
    try { found = await client.discover(); } catch (e) {
      const code = failureCode(e);
      throw new SyncError(code === 'auth_failed' ? 'credential_rejected' : code, code === 'auth_failed' || code === 'blocked_egress' || code === 'https_required' ? 422 : 502);
    }
    const books = found.addressbooks;
    if (!books.length) throw new SyncError('no_addressbook', 422);
    let book;
    if (b.addressbook_url) {
      book = books.find((x) => x.url === b.addressbook_url);
      if (!book) throw new SyncError('addressbook_not_found', 422);
    } else if (books.length === 1) [book] = books;
    else throw new SyncError('addressbook_choice_required', 409, { addressbooks: books.map((x) => ({ url: x.url, name: x.name })) });
    const dup = store.getDb().prepare('SELECT 1 FROM sync_sources WHERE org_id = ? AND credential_id = ? AND addressbook_url = ?').get(orgId, b.credential_id, book.url);
    if (dup) throw new SyncError('source_exists', 409);
    const provider = cred.integration_type === 'icloud_contacts' ? 'icloud' : 'carddav';
    const id = store.gid('ss');
    store.getDb().prepare(`
      INSERT INTO sync_sources (id, org_id, provider, label, credential_id, server_url, addressbook_url, enabled, interval_min, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(id, orgId, provider, b.label || (provider === 'icloud' ? 'iCloud Contacts' : 'CardDAV address book'), b.credential_id, cred.server_url, book.url, b.interval_min ?? null, ctx.userId || null, store.nowIso());
    emit('quox.contacts.sync_source_add', ctx, { source_id: id, outcome: 'added' });
    return viewSource(getSource(orgId, id));
  }

  function updateSource(ctx, id, patch) {
    const src = getSource(ctx.orgId, id);
    if (!src) throw new SyncError('not_found', 404);
    const sets = [];
    const args = [];
    const set = (k, v) => { sets.push(`${k} = ?`); args.push(v); };
    if (patch.label !== undefined) set('label', patch.label);
    if (patch.interval_min !== undefined) set('interval_min', patch.interval_min);
    if (patch.enabled !== undefined) {
      set('enabled', patch.enabled ? 1 : 0);
      // A human re-enabling is the ONLY way out of retirement and backoff.
      if (patch.enabled) { set('retired_at', null); set('consecutive_failures', 0); set('backoff_until', null); if (src.retired_at) set('last_status', 'reenabled'); }
    }
    if (!sets.length) throw new SyncError('nothing_to_update', 400);
    store.getDb().prepare(`UPDATE sync_sources SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`).run(...args, src.id, ctx.orgId);
    emit('quox.contacts.sync_source_update', ctx, { source_id: src.id, outcome: 'updated' });
    return viewSource(getSource(ctx.orgId, id));
  }

  /** Stops syncing, keeps every contact, drops the links (so nothing is flagged or updated again). */
  function removeSource(ctx, id) {
    const src = getSource(ctx.orgId, id);
    if (!src) throw new SyncError('not_found', 404);
    if (running.has(src.id)) throw new SyncError('sync_in_progress', 409);
    const db = store.getDb();
    const links = db.transaction(() => {
      const n = db.prepare('DELETE FROM sync_links WHERE org_id = ? AND source_id = ?').run(ctx.orgId, src.id).changes;
      db.prepare('DELETE FROM sync_sources WHERE id = ? AND org_id = ?').run(src.id, ctx.orgId);
      return n;
    })();
    emit('quox.contacts.sync_source_remove', ctx, { source_id: src.id, counts: { links_removed: links }, outcome: 'removed' });
    return { removed: true, links_removed: links };
  }

  // ---- scheduler entry --------------------------------------------------------

  /**
   * Wall-clock tick (scheduler.js). NOT boot-triggered: due-ness comes from the persisted last_run_at, so a restart
   * does not make anything due that was not already due. One source at a time, yielding between sources.
   */
  async function tick({ nowMs = Date.now(), log = (m) => console.log(m) } = {}) {
    if (ticking) return { skipped: true };
    ticking = true;
    const sum = { due: 0, ran: 0, ok: 0, failed: 0, retired: 0, backing_off: 0 };
    try {
      const rows = store.getDb().prepare(
        'SELECT * FROM sync_sources WHERE enabled = 1 AND retired_at IS NULL AND interval_min IS NOT NULL ORDER BY COALESCE(last_run_at, \'\') ASC LIMIT 200'
      ).all();
      const due = [];
      for (const r of rows) {
        if (r.backoff_until && Date.parse(r.backoff_until) > nowMs) { sum.backing_off += 1; continue; }
        if (r.last_run_at && Date.parse(r.last_run_at) + r.interval_min * 60000 > nowMs) continue;
        due.push(r);
      }
      sum.due = due.length;
      for (const r of due.slice(0, MAX_PER_TICK)) {
        const ctx = { orgId: r.org_id, actor: 'service', agentId: 'contactsq-sync' };
        sum.ran += 1;
        try { await run(ctx, r.id, { dryRun: false }); sum.ok += 1; } catch (e) {
          sum.failed += 1;
          const after = getSource(r.org_id, r.id);
          if (after && after.retired_at) sum.retired += 1;
          log(`[contactsq] sync source ${r.id} failed code=${failureCode(e)} consecutive=${after ? after.consecutive_failures : '?'}${after && after.retired_at ? ' RETIRED' : ''}`);
        }
        await yieldLoop();
      }
      if (sum.ran > 0) log(`[contactsq] sync tick due=${sum.due} ran=${sum.ran} ok=${sum.ok} failed=${sum.failed} retired=${sum.retired} backing_off=${sum.backing_off}`);
      return sum;
    } finally {
      ticking = false;
    }
  }

  return { run, addSource, updateSource, removeSource, tick, listSources, getSource, hashOf };
}

/**
 * Service functions (same shape as p5.js): composed into the ONE contactsq service by api.js.
 * Authority: human org admin only, exactly like import. An agent (or an agent-operated session) is 403.
 */
function createSyncService({ emit, wrap, err, deps }) {
  const core = createSync({ emit, deps });
  const needAdmin = (ctx) => (ctx.actor !== 'human' || !ctx.isAdmin ? err(403, 'admin_required') : null);
  const guarded = (fn) => wrap(async (ctx, i) => {
    const denied = needAdmin(ctx);
    if (denied) return denied;
    try { return await fn(ctx, i); } catch (e) {
      if (e instanceof SyncError) return { status: e.status, json: { error: e.code, ...(e.extra || {}) } };
      throw e;
    }
  });
  const intOrNull = (v) => v === null || (Number.isInteger(v) && v >= MIN_INTERVAL_MIN && v <= MAX_INTERVAL_MIN);

  const listSyncSources = guarded((ctx) => ({ status: 200, json: { sources: core.listSources(ctx.orgId) } }));

  const addSyncSource = guarded(async (ctx, b) => {
    if (typeof b.credential_id !== 'string' || !b.credential_id || b.credential_id.length > 100) return err(400, 'invalid_credential_id');
    if (b.label !== undefined && (typeof b.label !== 'string' || !b.label.trim() || b.label.length > 80)) return err(400, 'invalid_label');
    if (b.interval_min !== undefined && !intOrNull(b.interval_min)) return err(400, 'invalid_interval_min');
    if (b.addressbook_url !== undefined && (typeof b.addressbook_url !== 'string' || b.addressbook_url.length > 500)) return err(400, 'invalid_addressbook_url');
    const source = await core.addSource(ctx, { ...b, label: b.label ? b.label.trim() : undefined });
    return { status: 201, json: { source } };
  });

  const updateSyncSource = guarded((ctx, { id, body: b }) => {
    const known = ['enabled', 'interval_min', 'label'];
    if (Object.keys(b || {}).some((k) => !known.includes(k))) return err(400, 'unknown_field');
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return err(400, 'invalid_enabled');
    if (b.interval_min !== undefined && !intOrNull(b.interval_min)) return err(400, 'invalid_interval_min');
    if (b.label !== undefined && (typeof b.label !== 'string' || !b.label.trim() || b.label.length > 80)) return err(400, 'invalid_label');
    return { status: 200, json: { source: core.updateSource(ctx, String(id), { ...b, label: b.label ? b.label.trim() : undefined }) } };
  });

  const runSyncSource = guarded(async (ctx, { id, body: b }) => {
    if (b && b.dry_run !== undefined && typeof b.dry_run !== 'boolean') return err(400, 'invalid_dry_run');
    const out = await core.run(ctx, String(id), { dryRun: Boolean(b && b.dry_run) });
    return { status: 200, json: { ...out, source: core.listSources(ctx.orgId).find((s) => s.id === String(id)) || null } };
  });

  const removeSyncSource = guarded((ctx, { id }) => ({ status: 200, json: core.removeSource(ctx, String(id)) }));

  return { listSyncSources, addSyncSource, updateSyncSource, runSyncSource, removeSyncSource, syncTick: core.tick, _sync: core };
}

module.exports = { createSync, createSyncService, SyncError, MAX_FAILURES, backoffMin, SOURCE_REMOVED };
