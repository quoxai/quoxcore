/**
 * ET-3 Phase D — bulk invite frontend client.
 *
 * Pure CSV preview parser (so the UI can show a row count + headers
 * before submitting) plus the submit wrapper.
 */

export const BULK_INVITE_ROLES = ['owner', 'admin', 'builder', 'runner', 'viewer', 'auditor'];
export const MAX_BULK_INVITE_ROWS = 500;

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

export function parseCsvPreview(text) {
    if (typeof text !== 'string') return { rows: [], error: 'csv body required' };
    const clean = text.replace(/^\ufeff/, '').replace(/\r\n/g, '\n');
    const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return { rows: [], error: 'csv is empty' };
    const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase());
    if (!headers.includes('email')) {
        return { rows: [], error: 'csv must include an "email" column' };
    }
    const body = lines.slice(1);
    if (body.length > MAX_BULK_INVITE_ROWS) {
        return { rows: [], error: `too many rows — max ${MAX_BULK_INVITE_ROWS}` };
    }
    const rows = body.map(line => {
        const cells = parseCsvLine(line);
        const obj = {};
        headers.forEach((h, i) => {
            obj[h] = (cells[i] ?? '').trim();
        });
        if (obj.email) obj.email = obj.email.toLowerCase();
        return obj;
    });
    return { rows, error: null };
}

async function parseOrEmpty(res) { try { return await res.json(); } catch { return null; } }

export async function submitBulkInvite(orgId, { csv, rows, dryRun = true }, authFetch) {
    if (typeof csv !== 'string' && !Array.isArray(rows)) {
        throw new Error('provide either csv (string) or rows (array)');
    }
    const body = { dry_run: !!dryRun };
    if (typeof csv === 'string') body.csv = csv;
    if (Array.isArray(rows))     body.rows = rows;

    const res = await authFetch(`/api/orgs/${orgId}/invites/bulk`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
    });
    const out = await parseOrEmpty(res);
    if (!res.ok) {
        throw new Error(out?.message || `submitBulkInvite: ${res.status}`);
    }
    return out;
}
