/**
 * Audit Export helpers for ET-5.
 *
 * - buildAuditQuery: compose WHERE clause + params from filters
 * - renderAuditCsv:  backwards-compatible CSV serialisation
 * - renderAuditJson: evidence-wrapped JSON output
 * - renderAuditBundle: zip containing csv + json + receipt + manifest
 */

import AdmZip from 'adm-zip';

const ALLOWED_COLUMNS = {
    actor_id:    'actor_id',
    action:      'action',
    target_type: 'target_type',
    scope_id:    'scope_id',
};

function isNonEmpty(v) {
    return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Build a safe WHERE clause + params for the audit-export query.
 * Unknown filter keys are ignored. Empty strings are dropped.
 */
// #1106: `alias` qualifies every column (e.g. 'ae.') for a query that joins users, where created_at and status
// would otherwise be ambiguous. Default unqualified, as before.
export function buildAuditQuery(orgId, filters = {}, { alias = '' } = {}) {
    const conditions = [`${alias}org_id = ?`];
    const params = [orgId];

    // Date filters — accept new + legacy names.
    const fromVal = filters.from ?? filters.from_date;
    const toVal   = filters.to   ?? filters.to_date;
    if (isNonEmpty(fromVal)) {
        conditions.push(`${alias}created_at >= ?`);
        params.push(fromVal);
    }
    if (isNonEmpty(toVal)) {
        conditions.push(`${alias}created_at <= ?`);
        params.push(toVal);
    }

    // Column filters
    for (const [key, column] of Object.entries(ALLOWED_COLUMNS)) {
        const val = filters[key];
        if (isNonEmpty(val)) {
            conditions.push(`${alias}${column} = ?`);
            params.push(val);
        }
    }

    return {
        whereClause: conditions.join(' AND '),
        params,
    };
}

// ──────────────────────────────────────────────────────────────────────
// CSV
// ──────────────────────────────────────────────────────────────────────

const CSV_HEADERS = [
    'timestamp',
    'action',
    'actor_type',
    'actor_id',
    'actor_name',
    'target_type',
    'target_id',
    'status',
    'ip_address',
    'metadata',
];

function escapeCsvField(v) {
    if (v === null || v === undefined) return '';
    const s = String(v)
        .replace(/,/g, ';')      // keep existing behaviour (replace commas)
        .replace(/"/g, '""');    // escape embedded quotes
    return s;
}

export function renderAuditCsv(events = []) {
    const rows = [CSV_HEADERS.join(',')];
    for (const ev of events) {
        const row = [
            ev.created_at,
            ev.action,
            ev.actor_type,
            ev.actor_id,
            escapeCsvField(ev.actor_name),
            ev.target_type,
            ev.target_id,
            ev.status,
            ev.ip_address,
            escapeCsvField(ev.metadata_json),
        ];
        rows.push(row.map(f => `"${f ?? ''}"`).join(','));
    }
    return rows.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// JSON
// ──────────────────────────────────────────────────────────────────────

export function renderAuditJson(events = [], receipt = null) {
    return {
        events: events || [],
        receipt: receipt || null,
    };
}

// ──────────────────────────────────────────────────────────────────────
// Bundle (zip)
// ──────────────────────────────────────────────────────────────────────

/**
 * Render an audit-evidence zip bundle.
 *
 * Files:
 *   audit.csv              — backward-compatible CSV (human + spreadsheet)
 *   audit.json             — { events, receipt } (machine-readable)
 *   evidence.receipt.json  — the detached-signature receipt alone
 *   manifest.json          — export metadata + file references
 *
 * @param {Array<object>} events
 * @param {object} receipt    evidence receipt (from auditSigning.signAuditExport)
 * @param {object} meta       same shape as META in the signing helper
 * @returns {Buffer}          zip bytes
 */
export function renderAuditBundle(events, receipt, meta) {
    const csv        = renderAuditCsv(events);
    const json       = renderAuditJson(events, receipt);
    const manifest = {
        org_id:       meta.org_id,
        filters:      meta.filters || {},
        exported_by:  meta.exported_by,
        exported_at:  meta.exported_at,
        tool_version: meta.tool_version,
        event_count:  (events || []).length,
        csv_ref:      'audit.csv',
        json_ref:     'audit.json',
        receipt_ref:  'evidence.receipt.json',
    };

    const zip = new AdmZip();
    zip.addFile('audit.csv',             Buffer.from(csv, 'utf-8'));
    zip.addFile('audit.json',            Buffer.from(JSON.stringify(json, null, 2),     'utf-8'));
    zip.addFile('evidence.receipt.json', Buffer.from(JSON.stringify(receipt, null, 2),  'utf-8'));
    zip.addFile('manifest.json',         Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'));
    return zip.toBuffer();
}
