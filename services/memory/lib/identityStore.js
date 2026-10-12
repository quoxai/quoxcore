// Identity Blob Store — TRUST-GATE-1.15 / 1.16
//
// Generic namespaced key-value document store for user "identity" data
// (profile, projects, narratives, syntheses, trends, personalization,
// reflection_state, importance_evolution, alerts) that previously lived
// ONLY in browser localStorage (see src/services/memoryManager.js and
// src/services/alertService.js). One row per (org_id, user_id, namespace);
// document-shaped and versioned by updated_at — deliberately NOT 8+ bespoke
// per-namespace schemas.

import { ulid } from 'ulid'
import { getDatabase } from './db.js'

/**
 * Get an identity blob for (org, user, namespace).
 * Returns { data, updated_at } or null if none exists yet.
 */
export function getIdentity(orgId, userId, namespace) {
  const db = getDatabase()
  const row = db.prepare(
    'SELECT content_json, updated_at FROM identity_blobs WHERE org_id = ? AND user_id = ? AND namespace = ?'
  ).get(orgId, userId, namespace)

  if (!row) return null

  return {
    data: JSON.parse(row.content_json),
    updated_at: row.updated_at
  }
}

/**
 * Upsert an identity blob for (org, user, namespace).
 * Returns { namespace, data, updated_at }.
 */
export function setIdentity(orgId, userId, namespace, data) {
  const db = getDatabase()
  const contentJson = JSON.stringify(data ?? null)
  const now = new Date().toISOString()

  db.prepare(`
    INSERT INTO identity_blobs (id, org_id, user_id, namespace, content_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id, user_id, namespace)
    DO UPDATE SET content_json = excluded.content_json, updated_at = excluded.updated_at
  `).run(ulid(), orgId, userId, namespace, contentJson, now)

  return { namespace, data, updated_at: now }
}
