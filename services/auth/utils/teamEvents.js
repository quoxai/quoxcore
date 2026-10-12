/**
 * ET-3 Phase B — team_events append-only log.
 *
 * Matrix integration seam. Every team or membership lifecycle change
 * MUST call emitTeamEvent so Stream M (Matrix rooms) can sync state
 * by tailing this log. Events are append-only and ULID-ordered so
 * consumers can use listTeamEventsSince(cursor) as a reliable
 * at-least-once subscription primitive.
 *
 * The list of event types is frozen here and validated on emit — we
 * want drift detected loudly, not silently.
 */

import { ulid } from './helpers.js';

export const TEAM_EVENT_TYPES = Object.freeze([
    'team.created',
    'team.archived',
    'team.member.invited',
    'team.member.joined',
    'team.member.left',
    'team.member.role_changed',
]);

const EVENT_TYPES_SET = new Set(TEAM_EVENT_TYPES);

// ──────────────────────────────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────────────────────────────

export function ensureTeamEventsSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS team_events (
            id               TEXT PRIMARY KEY,
            org_id           TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
            team_id          TEXT,
            event_type       TEXT NOT NULL,
            actor_id         TEXT,
            subject_user_id  TEXT,
            metadata_json    TEXT NOT NULL DEFAULT '{}',
            created_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_team_events_org_id
            ON team_events(org_id, id);
        CREATE INDEX IF NOT EXISTS idx_team_events_created
            ON team_events(created_at);
    `);
}

// ──────────────────────────────────────────────────────────────────────
// Emit + read
// ──────────────────────────────────────────────────────────────────────

export function emitTeamEvent(db, {
    orgId,
    teamId       = null,
    eventType,
    actorId      = null,
    subjectUserId = null,
    metadata     = {},
}) {
    if (!orgId) throw new Error('orgId required');
    if (!EVENT_TYPES_SET.has(eventType)) {
        throw new Error(`unknown event_type "${eventType}" — expected one of ${TEAM_EVENT_TYPES.join(', ')}`);
    }
    const id = ulid();
    db.prepare(`
        INSERT INTO team_events
            (id, org_id, team_id, event_type, actor_id, subject_user_id, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, orgId, teamId, eventType, actorId, subjectUserId,
        JSON.stringify(metadata || {}),
    );
    return db.prepare(`SELECT * FROM team_events WHERE id = ?`).get(id);
}

export function listTeamEvents(db, orgId, { limit = 100 } = {}) {
    return db.prepare(`
        SELECT * FROM team_events
        WHERE org_id = ?
        ORDER BY id DESC
        LIMIT ?
    `).all(orgId, Math.min(Math.max(1, limit), 1000));
}

export function listTeamEventsSince(db, orgId, sinceId = '', { limit = 100 } = {}) {
    return db.prepare(`
        SELECT * FROM team_events
        WHERE org_id = ? AND id > ?
        ORDER BY id ASC
        LIMIT ?
    `).all(orgId, sinceId || '', Math.min(Math.max(1, limit), 1000));
}
