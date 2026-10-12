/**
 * ET-3 Phase B — org webhook subscriptions.
 *
 * Each webhook row has:
 *   - url              : https:// endpoint to POST to
 *   - events           : JSON array of team_event types to fan out
 *   - secret_cipher    : AES-256-GCM encrypted shared secret used for
 *                        HMAC-SHA256 payload signing
 *
 * The plaintext secret is returned exactly once — on create or rotate —
 * so the subscriber can record it. After that it can only be verified
 * server-side or rotated.
 */

import { ulid } from './helpers.js';
import { randomBytes } from 'crypto';
import { encrypt, decrypt } from './encryption.js';
import { TEAM_EVENT_TYPES } from './teamEvents.js';

const EVENT_TYPES_SET = new Set(TEAM_EVENT_TYPES);

// ──────────────────────────────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────────────────────────────

export function ensureWebhooksSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS webhooks (
            id             TEXT PRIMARY KEY,
            org_id         TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
            url            TEXT NOT NULL,
            events_json    TEXT NOT NULL DEFAULT '[]',
            secret_cipher  TEXT NOT NULL,
            enabled        INTEGER NOT NULL DEFAULT 1,
            created_at     TEXT NOT NULL DEFAULT (datetime('now')),
            created_by     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhooks(org_id, enabled);

        CREATE TABLE IF NOT EXISTS webhook_deliveries (
            id              TEXT PRIMARY KEY,
            webhook_id      TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
            event_id        TEXT NOT NULL,
            status          TEXT NOT NULL,          -- success | failed | retrying
            response_status INTEGER,
            error_message   TEXT,
            attempt         INTEGER NOT NULL DEFAULT 1,
            next_retry_at   TEXT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook
            ON webhook_deliveries(webhook_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry
            ON webhook_deliveries(status, next_retry_at);
    `);
}

// ──────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────

function validateEvents(events) {
    if (!Array.isArray(events) || events.length === 0) {
        throw new Error('events must be a non-empty array');
    }
    for (const e of events) {
        if (!EVENT_TYPES_SET.has(e)) {
            throw new Error(`unknown event_type "${e}"`);
        }
    }
}

function validateUrl(url) {
    if (typeof url !== 'string' || !url) throw new Error('url required');
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error(`invalid url "${url}"`); }
    if (parsed.protocol !== 'https:') throw new Error('webhook url must be https://');
}

function generateSecret() {
    // 32 bytes of entropy → 43 chars base64url → comfortably HMAC-friendly.
    return `whsec_${randomBytes(32).toString('base64url')}`;
}

function rowToWebhook(row) {
    if (!row) return null;
    const { secret_cipher: _c, events_json, ...rest } = row;
    return {
        ...rest,
        enabled: !!row.enabled,
        events:  events_json ? JSON.parse(events_json) : [],
    };
}

// ──────────────────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────────────────

export function createWebhook(db, orgId, { url, events, createdBy = null }) {
    validateUrl(url);
    validateEvents(events);
    const id = ulid();
    const secret = generateSecret();
    const cipher = encrypt(secret);
    db.prepare(`
        INSERT INTO webhooks (id, org_id, url, events_json, secret_cipher, enabled, created_by)
        VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(id, orgId, url, JSON.stringify(events), cipher, createdBy);
    const row = db.prepare(`SELECT * FROM webhooks WHERE id = ?`).get(id);
    return { ...rowToWebhook(row), secret };
}

export function listWebhooks(db, orgId) {
    return db.prepare(`
        SELECT id, org_id, url, events_json, enabled, created_at, created_by
        FROM webhooks WHERE org_id = ?
        ORDER BY created_at ASC
    `).all(orgId).map(r => rowToWebhook(r));
}

export function getWebhook(db, orgId, id) {
    const row = db.prepare(
        `SELECT * FROM webhooks WHERE id = ? AND org_id = ?`,
    ).get(id, orgId);
    return rowToWebhook(row);
}

export function deleteWebhook(db, orgId, id) {
    db.prepare(`DELETE FROM webhooks WHERE id = ? AND org_id = ?`).run(id, orgId);
}

export function rotateWebhookSecret(db, orgId, id) {
    const row = db.prepare(`SELECT id FROM webhooks WHERE id = ? AND org_id = ?`).get(id, orgId);
    if (!row) return null;
    const secret = generateSecret();
    db.prepare(`UPDATE webhooks SET secret_cipher = ? WHERE id = ?`)
        .run(encrypt(secret), id);
    return { id, secret };
}

// ──────────────────────────────────────────────────────────────────────
// Dispatcher consumer API
// ──────────────────────────────────────────────────────────────────────

export function getDecryptedWebhookSecret(db, id) {
    const row = db.prepare(`SELECT secret_cipher FROM webhooks WHERE id = ?`).get(id);
    if (!row) return null;
    return decrypt(row.secret_cipher);
}

export function listEnabledWebhooksForEvent(db, orgId, eventType) {
    const rows = db.prepare(`
        SELECT id, url, events_json, secret_cipher
        FROM webhooks WHERE org_id = ? AND enabled = 1
    `).all(orgId);
    return rows
        .filter(r => {
            try {
                const events = JSON.parse(r.events_json);
                return Array.isArray(events) && events.includes(eventType);
            } catch { return false; }
        })
        .map(r => ({
            id:     r.id,
            url:    r.url,
            secret: decrypt(r.secret_cipher),
        }));
}
