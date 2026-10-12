/**
 * ET-3 Phase D — bulk CSV invite.
 *
 * Three layers:
 *   parseInviteCsv(text)         — pure CSV → row objects
 *   validateBulkInviteRows       — pure validation against the org
 *   runBulkInvite(dryRun?:true)  — orchestrator that optionally writes
 *                                   invites + fires team.member.invited
 *                                   events for Matrix/webhooks.
 */

import { ulid } from './helpers.js';
import { randomBytes } from 'crypto';
import { emitAndDispatch } from './teamEventEmitter.js';

export const ALLOWED_ROLES = ['owner', 'admin', 'builder', 'runner', 'viewer', 'auditor'];
export const MAX_ROWS      = 500;
const INVITE_TTL_HOURS     = 7 * 24;

const ROLE_SET  = new Set(ALLOWED_ROLES);
const EMAIL_RE  = /^[a-z0-9._%+\-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

// ──────────────────────────────────────────────────────────────────────
// CSV parser — small, single-line-record, tolerant of quoted fields
// ──────────────────────────────────────────────────────────────────────

function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
            if (ch === '"') { inQuotes = false; continue; }
            cur += ch;
        } else {
            if (ch === ',') { out.push(cur); cur = ''; continue; }
            if (ch === '"') { inQuotes = true; continue; }
            cur += ch;
        }
    }
    out.push(cur);
    return out.map(s => s.trim());
}

export function parseInviteCsv(text) {
    if (typeof text !== 'string') throw new Error('csv body required');
    // Strip BOM + normalise newlines.
    const clean = text.replace(/^\ufeff/, '').replace(/\r\n/g, '\n');
    const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) throw new Error('csv is empty');
    const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase());
    if (!headers.includes('email')) {
        throw new Error('csv must include an "email" column');
    }
    const body = lines.slice(1);
    if (body.length > MAX_ROWS) {
        throw new Error(`too many rows — max ${MAX_ROWS}`);
    }
    return body.map(line => {
        const cells = parseCsvLine(line);
        const obj = {};
        headers.forEach((h, i) => {
            obj[h] = (cells[i] ?? '').trim();
        });
        if (obj.email) obj.email = obj.email.toLowerCase();
        return obj;
    });
}

// ──────────────────────────────────────────────────────────────────────
// Validator
// ──────────────────────────────────────────────────────────────────────

function loadTeamIndex(db, orgId) {
    const rows = db.prepare(
        `SELECT id, LOWER(slug) AS slug, LOWER(name) AS name FROM teams WHERE org_id = ?`,
    ).all(orgId);
    const idx = new Map();
    for (const r of rows) {
        idx.set(r.slug, r.id);
        idx.set(r.name, r.id);
        idx.set(r.id.toLowerCase(), r.id);
    }
    return idx;
}

function activeMembershipEmails(db, orgId) {
    const rows = db.prepare(`
        SELECT LOWER(u.primary_email) AS email
        FROM org_memberships m
        INNER JOIN users u ON u.id = m.user_id
        WHERE m.org_id = ? AND m.status = 'active'
    `).all(orgId);
    return new Set(rows.map(r => r.email));
}

export function validateBulkInviteRows(db, orgId, rows) {
    if (!Array.isArray(rows)) throw new Error('rows must be an array');

    const teamIndex   = loadTeamIndex(db, orgId);
    const activeEmail = activeMembershipEmails(db, orgId);
    const valid = [];
    const errors = [];
    const seenInBatch = new Set();

    rows.forEach((row, index) => {
        const lineNumber = index + 2;   // account for header line
        const email = (row.email || '').trim().toLowerCase();
        const rawRole = (row.role || '').trim().toLowerCase();
        const role = rawRole === '' ? 'viewer' : rawRole;
        const teamKey = (row.team || '').trim().toLowerCase();

        if (!EMAIL_RE.test(email)) {
            errors.push({ line: lineNumber, email: row.email || '', reason: 'invalid email' });
            return;
        }
        if (!ROLE_SET.has(role)) {
            errors.push({ line: lineNumber, email, reason: `invalid role "${rawRole}"` });
            return;
        }
        let team_id = null;
        if (teamKey) {
            team_id = teamIndex.get(teamKey) || null;
            if (!team_id) {
                errors.push({ line: lineNumber, email, reason: `team "${row.team}" not found in this org` });
                return;
            }
        }
        if (seenInBatch.has(email)) {
            errors.push({ line: lineNumber, email, reason: 'duplicate email in this batch' });
            return;
        }
        if (activeEmail.has(email)) {
            errors.push({ line: lineNumber, email, reason: 'already a member of this org' });
            return;
        }
        seenInBatch.add(email);
        valid.push({ line: lineNumber, email, role, team_id });
    });

    return { valid, errors };
}

// ──────────────────────────────────────────────────────────────────────
// Executor
// ──────────────────────────────────────────────────────────────────────

function generateInviteToken() {
    return `inv_${randomBytes(24).toString('base64url')}`;
}

function expiresAtIso() {
    return new Date(Date.now() + INVITE_TTL_HOURS * 3600 * 1000).toISOString();
}

export function runBulkInvite(db, orgId, actorId, rows, { dryRun = false } = {}) {
    const report = validateBulkInviteRows(db, orgId, rows);
    if (dryRun) {
        return { dry_run: true, valid: report.valid, errors: report.errors };
    }

    const insert = db.prepare(`
        INSERT INTO invites (id, org_id, team_id, email, role, invited_by, token, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let created = 0;
    const tx = db.transaction(() => {
        for (const row of report.valid) {
            insert.run(
                ulid(), orgId, row.team_id, row.email, row.role,
                actorId, generateInviteToken(), expiresAtIso(),
            );
            created++;
        }
    });
    tx();

    // Fire lifecycle events for Matrix + webhooks. Done outside the
    // transaction so a dispatch failure can't undo the DB insert.
    for (const row of report.valid) {
        emitAndDispatch(db, {
            orgId,
            teamId:    row.team_id,
            eventType: 'team.member.invited',
            actorId,
            metadata:  { email: row.email, role: row.role, via: 'bulk_invite' },
        });
    }

    return {
        dry_run: false,
        created,
        valid:   report.valid,
        errors:  report.errors,
    };
}
