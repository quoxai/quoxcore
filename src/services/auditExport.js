/**
 * ET-5 — Audit export helpers (frontend).
 *
 * Pure functions for building the audit export request URL + download
 * metadata. Used by AuditLogView for CSV / JSON / bundle exports.
 */

const ALLOWED_FILTER_KEYS = [
    'actor_id',
    'action',
    'target_type',
    'scope_id',
    'status',
    'from_date',
    'to_date',
];

const FORMAT_META = {
    csv:    { ext: 'csv', accept: 'text/csv' },
    json:   { ext: 'json', accept: 'application/json' },
    bundle: { ext: 'zip',  accept: 'application/zip' },
};

function isNonEmpty(v) {
    return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Build the audit export HTTP request shape.
 *
 * @param {string} orgId
 * @param {object} filters  Partial filter map; empty values + unknown
 *                          keys are dropped
 * @param {string} format   'csv' | 'json' | 'bundle' (default 'csv')
 * @returns {{ url: string, filename: string, accept: string }}
 * @throws {Error} if format is not one of the allowed values
 */
export function buildAuditExportRequest(orgId, filters = {}, format = 'csv') {
    const fmt = (format || 'csv').toLowerCase();
    const meta = FORMAT_META[fmt];
    if (!meta) {
        throw new Error(`Unknown export format: ${format}. Use csv, json, or bundle.`);
    }

    const params = new URLSearchParams();
    params.set('format', fmt);

    for (const key of ALLOWED_FILTER_KEYS) {
        const val = filters?.[key];
        if (isNonEmpty(val)) {
            params.set(key, val);
        }
    }

    return {
        url:      `/api/orgs/${orgId}/audit/export?${params.toString()}`,
        filename: `audit-log-${orgId}.${meta.ext}`,
        accept:   meta.accept,
    };
}
