/**
 * ET-6C — org + scope-bound secrets CRUD.
 *
 * Values are encrypted at rest with the master key. List/get returns
 * only metadata; revealSecret is the single path that decrypts and
 * SHOULD be paired with an audit event at the route layer.
 *
 * Scope semantics:
 *   - scope_id IS NULL → org-wide
 *   - scope_id = '...'  → bounded to that scope (team/dept/etc)
 * UNIQUE(org, scope, name) — the same name can exist org-wide AND
 * inside a team without clashing.
 */

import { ulid } from './helpers.js';
import { encrypt, decrypt } from './encryption.js';

// ──────────────────────────────────────────────────────────────────────
// Schema (idempotent — the table may already exist from schema.sql)
// ──────────────────────────────────────────────────────────────────────

export function ensureSecretsSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS secrets (
            id            TEXT PRIMARY KEY,
            org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
            scope_id      TEXT,
            name          TEXT NOT NULL,
            description   TEXT,
            ciphertext    TEXT NOT NULL,
            metadata_json TEXT DEFAULT '{}',
            created_by    TEXT NOT NULL REFERENCES users(id),
            created_at    TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
            rotated_at    TEXT,
            UNIQUE(org_id, scope_id, name)
        );
    `);
}

function stripCipher(row) {
    if (!row) return null;
    const { ciphertext: _c, ...rest } = row;
    return rest;
}

// ──────────────────────────────────────────────────────────────────────
// Create
// ──────────────────────────────────────────────────────────────────────

export function createSecret(db, orgId, { name, value, description = null, scopeId = null, createdBy, metadata = {} }) {
    if (!orgId)     throw new Error('orgId required');
    if (!name)      throw new Error('name required');
    if (typeof value !== 'string' || !value) throw new Error('value required');
    if (!createdBy) throw new Error('createdBy required');

    // SQLite treats NULL as distinct from NULL under UNIQUE, so the
    // table-level constraint alone won't catch org-wide (scope_id=NULL)
    // duplicates. Check by hand when scopeId is null.
    if (scopeId == null) {
        const dup = db.prepare(
            `SELECT id FROM secrets WHERE org_id = ? AND scope_id IS NULL AND name = ?`,
        ).get(orgId, name);
        if (dup) throw new Error(`secret "${name}" already exists (UNIQUE org, scope, name)`);
    }

    const id = ulid();
    const cipher = encrypt(value);
    db.prepare(`
        INSERT INTO secrets
            (id, org_id, scope_id, name, description, ciphertext, metadata_json, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, scopeId, name, description, cipher, JSON.stringify(metadata || {}), createdBy);
    return stripCipher(db.prepare(`SELECT * FROM secrets WHERE id = ?`).get(id));
}

// ──────────────────────────────────────────────────────────────────────
// List / get metadata
// ──────────────────────────────────────────────────────────────────────

export function listSecrets(db, orgId, filters = {}) {
    const where = ['org_id = ?'];
    const params = [orgId];
    if ('scopeId' in filters) {
        if (filters.scopeId === null) {
            where.push('scope_id IS NULL');
        } else {
            where.push('scope_id = ?');
            params.push(filters.scopeId);
        }
    }
    return db.prepare(`
        SELECT id, org_id, scope_id, name, description, metadata_json,
               created_by, created_at, updated_at, rotated_at
        FROM secrets
        WHERE ${where.join(' AND ')}
        ORDER BY name ASC
    `).all(...params);
}

export function getSecretMeta(db, orgId, id) {
    const row = db.prepare(`
        SELECT id, org_id, scope_id, name, description, metadata_json,
               created_by, created_at, updated_at, rotated_at
        FROM secrets WHERE id = ? AND org_id = ?
    `).get(id, orgId);
    return row || null;
}

// ──────────────────────────────────────────────────────────────────────
// Reveal — only place that decrypts
// ──────────────────────────────────────────────────────────────────────

export function revealSecret(db, orgId, id) {
    const row = db.prepare(
        `SELECT id, name, ciphertext FROM secrets WHERE id = ? AND org_id = ?`,
    ).get(id, orgId);
    if (!row) return null;
    return { id: row.id, name: row.name, value: decrypt(row.ciphertext) };
}

// ──────────────────────────────────────────────────────────────────────
// Update (supports rotation via { value })
// ──────────────────────────────────────────────────────────────────────

export function updateSecret(db, orgId, id, patch = {}) {
    const existing = db.prepare(
        `SELECT id FROM secrets WHERE id = ? AND org_id = ?`,
    ).get(id, orgId);
    if (!existing) return null;

    const sets = [];
    const values = [];
    if ('description' in patch) {
        sets.push('description = ?');
        values.push(patch.description ?? null);
    }
    if ('metadata' in patch) {
        sets.push('metadata_json = ?');
        values.push(JSON.stringify(patch.metadata || {}));
    }
    if ('name' in patch && typeof patch.name === 'string' && patch.name) {
        sets.push('name = ?');
        values.push(patch.name);
    }
    if ('value' in patch) {
        if (typeof patch.value !== 'string' || !patch.value) {
            throw new Error('value cannot be empty on rotate');
        }
        sets.push('ciphertext = ?');
        values.push(encrypt(patch.value));
        sets.push(`rotated_at = datetime('now')`);
    }
    sets.push(`updated_at = datetime('now')`);
    if (values.length === 0) return getSecretMeta(db, orgId, id);

    db.prepare(`UPDATE secrets SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return getSecretMeta(db, orgId, id);
}

// ──────────────────────────────────────────────────────────────────────
// Delete
// ──────────────────────────────────────────────────────────────────────

export function deleteSecret(db, orgId, id) {
    db.prepare(`DELETE FROM secrets WHERE id = ? AND org_id = ?`).run(id, orgId);
}
