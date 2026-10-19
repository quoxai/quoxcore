/**
 * Tool catalog seed: shipped manifests -> tool_definitions.
 *
 * Shared by the boot step (migrations/seed-tool-catalog-on-boot.js) and the
 * operator script (scripts/seed-tools.js). quoxai/quox #1045.
 *
 * seedToolCatalog() is INSERT-IF-MISSING keyed on the UNIQUE tool_id:
 *   - a row that already exists is never updated, so an admin's edits
 *     (name, status, featured, risk) survive every boot;
 *   - nothing is ever deleted, so org-authored rows (from-script, from-repo,
 *     Toolsmith) and rows whose manifest was removed are left alone;
 *   - an entry the schema would reject (no id, an accessLevel outside the
 *     CHECK set) is skipped and counted, never guessed at;
 *   - a tool that is declared but not implemented (lib/unavailableTools.js,
 *     quox #1051) is not inserted and is counted as `unavailable`; it is seeded
 *     on the first boot after it leaves that set.
 * Catalog rows are global (tool_definitions has no org column); per-org
 * availability is tool_installations, untouched here.
 */

import crypto from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getUnavailableToolIds } from './unavailableTools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** services/auth/lib -> repo root. In the auth image this is /app/src/config/entities/tools. */
export const DEFAULT_TOOLS_DIR = join(__dirname, '../../../src/config/entities/tools');

const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const SANDBOX_PROFILES = new Set(['restricted', 'standard', 'privileged']);
const ACCESS_LEVELS = new Set(['orchestrator', 'managers+', 'specialists+', 'workers+', 'all']);

export function catalogUlid() {
    const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const time = Date.now().toString(32).toUpperCase().padStart(10, '0');
    const randomBytes = crypto.randomBytes(16);
    let rand = '';
    for (let i = 0; i < 16; i++) rand += chars[randomBytes[i] % 32];
    return time + rand;
}

/** Convert one manifest (v2 pack with tools[], or a v1 single tool) into tool_definitions rows. */
export function manifestToRows(manifest) {
    const base = (tool, spec) => ({
        id: catalogUlid(),
        tool_id: tool.id,
        name: tool.name,
        description: tool.description ?? null,
        category: manifest.category || 'uncategorized',
        subcategory: manifest.subcategory || null,
        provider: manifest.provider || null,
        version: manifest.version || '1.0.0',
        spec_json: JSON.stringify(spec),
        risk_level: manifest.risk_level || 'low',
        sandbox_profile: manifest.sandbox_profile || 'standard',
        capabilities_json: JSON.stringify(tool.capabilities || []),
        min_access_level: tool.accessLevel || 'specialists+',
        requires_license: manifest.requires_license || null,
        requires_config: manifest.endpoints ? 1 : 0,
        status: 'available',
        is_core: 1,
        is_featured: 0,
        icon: manifest.icon || null,
        documentation_url: manifest.help?.man_url || null,
    });

    if (Array.isArray(manifest.tools)) {
        return manifest.tools.map((tool) => base(tool, {
            ...tool,
            instructions: tool.instructions || manifest.instructions,
            help: manifest.help,
            agent_hints: manifest.agent_hints,
            endpoints: manifest.endpoints,
        }));
    }
    return [base(manifest, manifest)];
}

/** Why the schema would refuse this row, or null if it is insertable. */
export function rowRejection(row) {
    if (typeof row.tool_id !== 'string' || !row.tool_id.trim()) return 'missing id';
    if (typeof row.name !== 'string' || !row.name.trim()) return 'missing name';
    if (!RISK_LEVELS.has(row.risk_level)) return `invalid risk_level '${row.risk_level}'`;
    if (!SANDBOX_PROFILES.has(row.sandbox_profile)) return `invalid sandbox_profile '${row.sandbox_profile}'`;
    if (!ACCESS_LEVELS.has(row.min_access_level)) return `invalid accessLevel '${row.min_access_level}'`;
    return null;
}

/**
 * Insert every manifest tool that is not already in the catalog.
 * Returns { inserted, present, skipped, unavailable, files, skippedDetail }.
 * Throws only if the manifests directory (or the unavailable-tools file) cannot
 * be read.
 */
export function seedToolCatalog(db, {
    toolsDir = process.env.TOOLS_DIR || DEFAULT_TOOLS_DIR,
    unavailableToolIds = getUnavailableToolIds(),
} = {}) {
    const files = readdirSync(toolsDir).filter((f) => f.endsWith('.json')).sort();

    const insert = db.prepare(`
        INSERT OR IGNORE INTO tool_definitions (
            id, tool_id, name, description,
            category, subcategory, provider, version,
            spec_json,
            risk_level, sandbox_profile, capabilities_json,
            min_access_level, requires_license, requires_config,
            status, is_core, is_featured,
            icon, documentation_url
        ) VALUES (
            @id, @tool_id, @name, @description,
            @category, @subcategory, @provider, @version,
            @spec_json,
            @risk_level, @sandbox_profile, @capabilities_json,
            @min_access_level, @requires_license, @requires_config,
            @status, @is_core, @is_featured,
            @icon, @documentation_url
        )
    `);

    const result = { inserted: 0, present: 0, skipped: 0, unavailable: 0, files: files.length, skippedDetail: [] };
    const skip = (where, why) => { result.skipped++; result.skippedDetail.push(`${where}: ${why}`); };

    db.transaction(() => {
        for (const file of files) {
            let rows;
            try {
                rows = manifestToRows(JSON.parse(readFileSync(join(toolsDir, file), 'utf-8')));
            } catch (err) {
                skip(file, `unreadable manifest (${err.message})`);
                continue;
            }
            for (const row of rows) {
                const why = rowRejection(row);
                if (why) { skip(`${file} ${row.tool_id || row.name || '?'}`, why); continue; }
                // #1051: declared but returns not_implemented; never advertise it.
                if (unavailableToolIds.has(row.tool_id)) { result.unavailable++; continue; }
                // OR IGNORE: the only conflict left after rowRejection is the
                // UNIQUE tool_id, i.e. the row is already present.
                const info = insert.run(row);
                if (info.changes > 0) result.inserted++;
                else result.present++;
            }
        }
    })();

    return result;
}
