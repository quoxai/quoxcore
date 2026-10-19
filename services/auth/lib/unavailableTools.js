/**
 * Catalog tool ids that are declared in a shipped manifest but cannot run yet.
 *
 * quoxai/quox #1051: the collector's mikrotikExecutor answers these with
 * not_implemented/501, so listing or seeding them in the tool catalog is a
 * claim we cannot back. The set is NOT maintained here: it is read from
 * shared/tool-availability/unsupported-tools.json, the same file
 * services/collector/lib/mikrotikExecutor.js exports as UNSUPPORTED_TOOLS (the
 * auth image does not carry collector code; both images copy shared/). An id
 * removed from that file is seeded and listed again on the next boot.
 *
 * Rows already in tool_definitions are hidden from catalog reads, never
 * deleted (an admin may have edited them).
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** services/auth/lib -> repo root shared/ (in the auth image: /app/shared). */
export const DEFAULT_UNSUPPORTED_TOOLS_FILE = join(__dirname, '../../../shared/tool-availability/unsupported-tools.json');

/** The groups read, ALLOWLISTED (#1062 review): a new group (e.g. "planned") never hides a live tool. */
export const UNAVAILABLE_GROUPS = Object.freeze(['mikrotik', 'stubs', 'duplicates']);

/** Every tool id listed under an allowlisted group of the shared file. */
export function loadUnavailableToolIds(file = DEFAULT_UNSUPPORTED_TOOLS_FILE) {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    const ids = new Set();
    for (const key of UNAVAILABLE_GROUPS) {
        const map = data[key];
        if (map && typeof map === 'object') for (const id of Object.keys(map)) ids.add(id);
    }
    return ids;
}

let _cache = null;
let _override = null;

/** The current unavailable set. A missing/unreadable file throws: hiding nothing would re-advertise 501 tools. */
export function getUnavailableToolIds() {
    if (_override) return _override;
    if (!_cache) _cache = loadUnavailableToolIds();
    return _cache;
}

/** Test seam: replace the set (null restores the shared file). */
export function __setUnavailableToolIdsForTesting(ids) {
    _override = ids ? new Set(ids) : null;
}

/** SQL fragment + params excluding the unavailable ids from a tool_definitions alias. */
export function unavailableToolFilter(alias = 'td') {
    const ids = [...getUnavailableToolIds()];
    if (ids.length === 0) return { sql: '', params: [] };
    return { sql: ` AND ${alias}.tool_id NOT IN (${ids.map(() => '?').join(', ')})`, params: ids };
}
