/**
 * Seed the global tool catalog from the shipped manifests on every boot.
 *
 * WHY (quoxai/quox #1045)
 * ---
 * tool_definitions was only ever filled by scripts/seed-tools.js, which no
 * install path runs. On a fresh install `quox tool catalog` listed nothing,
 * `quox tool install <slug>` 404'd, and `quox agent tool assign` could never
 * succeed because an assignment needs an installation and an installation
 * needs a catalog row. Same shape as the empty agent roster that
 * seed-core-agents-on-boot.js fixed: a bootstrap step that only worked on a box
 * that grew organically.
 *
 * WHY AT BOOT, NOT setup.sh
 * ---
 * Boot runs on every install path (setup.sh, the public compose file, image
 * upgrades, a restored backup) and on every upgrade, so a manifest added in a
 * release reaches existing instances too. setup.sh runs once on one path.
 *
 * BEHAVIOUR
 * ---
 * Insert-if-missing by tool_id (see lib/toolCatalogSeed.js): never updates or
 * deletes a row, so admin edits and org-authored rows survive. About 20 local
 * JSON files, no network. One log line, only on a boot that inserted something
 * (a fresh install or a new manifest). Non-fatal: a missing catalog is a
 * degraded instance, a service that refuses to boot is a dead one.
 */

import { getDb } from '../db/index.js';
import { seedToolCatalog } from '../lib/toolCatalogSeed.js';

export function seedToolCatalogOnBoot(opts = {}) {
    try {
        const result = seedToolCatalog(opts.db || getDb(), opts);
        if (result.inserted > 0) {
            console.log(`[ToolCatalog] Seeded ${result.inserted} new catalog tool(s) from ${result.files} manifest(s); `
                + `${result.present} already present, ${result.skipped} skipped`
                + (result.skipped ? ` (${result.skippedDetail.join('; ')})` : ''));
        }
        return result;
    } catch (err) {
        console.error('[ToolCatalog] Catalog seed failed (non-fatal):', err.message);
        return { inserted: 0, present: 0, skipped: 0, files: 0, error: err.message };
    }
}
