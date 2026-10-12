/**
 * QC-LINKS: seed or update a widget's curated site map
 * (embed_config_json.site_links). The collector injects the list into the
 * assistant's context so it can hand out REAL documentation links; the
 * model may only link from this list.
 *
 * Usage (inside the auth container):
 *   node scripts/seed-widget-site-links.js <widget_public_key_or_id> <links.json> [--dry-run]
 *
 * links.json: [{ "title": "Styling guide", "url": "https://..." }, ...]
 * Merges by replacing site_links only; every other embed_config key is
 * preserved. Idempotent: identical input produces no write.
 */

import { readFileSync } from 'node:fs';
import { prepare } from '../db/index.js';

const [widgetKey, linksPath, flag] = process.argv.slice(2);
if (!widgetKey || !linksPath) {
    console.error('usage: seed-widget-site-links.js <widget_public_key_or_id> <links.json> [--dry-run]');
    process.exit(1);
}
const dryRun = flag === '--dry-run';

const raw = JSON.parse(readFileSync(linksPath, 'utf-8'));
if (!Array.isArray(raw)) { console.error('links.json must be an array'); process.exit(1); }
const links = raw
    .filter((l) => l && typeof l.title === 'string' && l.title.trim()
        && typeof l.url === 'string' && /^https:\/\//i.test(l.url.trim()))
    .map((l) => ({ title: l.title.trim().slice(0, 80), url: l.url.trim().slice(0, 200) }));
if (links.length === 0) { console.error('no valid links in input'); process.exit(1); }

const widget = prepare(`
    SELECT id, name, embed_config_json FROM website_widgets
    WHERE id = ? OR public_key = ?
`).get(widgetKey, widgetKey);
if (!widget) { console.error(`widget not found: ${widgetKey}`); process.exit(1); }

let cfg = {};
try { cfg = widget.embed_config_json ? JSON.parse(widget.embed_config_json) : {}; } catch { cfg = {}; }
const before = JSON.stringify(cfg.site_links || null);
cfg.site_links = links;
const after = JSON.stringify(cfg.site_links);

if (before === after) {
    console.log(`widget ${widget.id} (${widget.name}): site_links already current (${links.length} links)`);
    process.exit(0);
}
if (dryRun) {
    console.log(`DRY RUN widget ${widget.id} (${widget.name}): would set ${links.length} site_links`);
    process.exit(0);
}
prepare('UPDATE website_widgets SET embed_config_json = ? WHERE id = ?')
    .run(JSON.stringify(cfg), widget.id);
console.log(`widget ${widget.id} (${widget.name}): site_links set (${links.length} links)`);
