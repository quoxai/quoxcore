'use strict';

/**
 * ContactsQ P7 schema: one-way CardDAV pull sync (additive, idempotent, safe on a live database).
 *
 *   sync_sources  one row per linked address book. Holds the vault credential ID (never the secret), the
 *                 collection URL, the sync-token and the run bookkeeping. Counts only: no names, no values.
 *   sync_links    one row per upstream card: a HASH of its href (never the href), the etag, the contact it
 *                 landed on, when upstream removed it, and the contact's updated_at as of the last sync
 *                 (so a later local edit is detectable). No name, email or phone lives here.
 */

function initSync(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_sources (
      id                   TEXT PRIMARY KEY,
      org_id               TEXT NOT NULL,
      provider             TEXT NOT NULL,
      label                TEXT NOT NULL,
      credential_id        TEXT NOT NULL,
      server_url           TEXT NOT NULL,
      addressbook_url      TEXT NOT NULL,
      sync_token           TEXT,
      enabled              INTEGER NOT NULL DEFAULT 1,
      interval_min         INTEGER,
      last_run_at          TEXT,
      last_status          TEXT,
      last_counts          TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      backoff_until        TEXT,
      retired_at           TEXT,
      created_by           TEXT,
      created_at           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_sources_org ON sync_sources(org_id, created_at);

    CREATE TABLE IF NOT EXISTS sync_links (
      org_id                  TEXT NOT NULL,
      source_id               TEXT NOT NULL,
      href_hash               TEXT NOT NULL,
      etag                    TEXT,
      contact_id              TEXT,
      removed_at              TEXT,
      local_edit_at_last_sync TEXT,
      PRIMARY KEY (org_id, source_id, href_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_links_contact ON sync_links(org_id, contact_id);
  `);
}

module.exports = { initSync };
