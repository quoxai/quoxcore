/**
 * scripts/sync-integration-types.mjs — VAULT-INTEG P2 frontend-copy generator.
 *
 * WHY THIS EXISTS: services/auth/config/integrationTypeRegistry.js is the
 * backend's single source of truth for integration types (400+ entries and
 * growing). src/config/integrationTypes.js was a HAND-MAINTAINED parallel
 * copy consumed by src/hooks/useIntegrationTypes.js as the offline/fetch-
 * failed fallback — it drifted to 369 keys against the backend's 400+ and
 * nobody noticed, because the fallback fails silently. This script
 * regenerates the frontend copy FROM the backend registry so the two
 * cannot diverge again; src/test/integrationTypesSync.test.js fails the
 * build the moment they do (it calls the same builder functions below and
 * diffs their output against what's on disk).
 *
 * The generated frontend file carries NO function values — no
 * validateCredentials, no testEndpoint-as-function, no testHeaders/
 * testBody/testParams. Those only make sense server-side (they run a real
 * network probe against a provider using a decrypted secret) and must
 * never ship to the browser. In their place: `hasLiveTest`, a boolean
 * summarising whether the backend registry can run a real network probe
 * for that type at all. No credential VALUES ever exist in either
 * registry — these are field *definitions* (labels/types/placeholders),
 * never secrets.
 *
 * Also emits services/auth/config/integration-types.export.json — an even
 * smaller canonical export (id, name, category, hasLiveTest, field NAMES
 * only, no other field metadata) for the quox-website repo to consume
 * without importing backend server code.
 *
 * Usage:
 *   node scripts/sync-integration-types.mjs            # (re)generate + write both outputs
 *   node scripts/sync-integration-types.mjs --check     # exit 1 if either output is stale; writes nothing
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = path.join(REPO, 'services', 'auth', 'config', 'integrationTypeRegistry.js');
const FRONTEND_OUT_PATH = path.join(REPO, 'src', 'config', 'integrationTypes.js');
const EXPORT_OUT_PATH = path.join(REPO, 'services', 'auth', 'config', 'integration-types.export.json');

// Only these per-field properties are plain, JSON-safe form metadata.
// Anything else on a field object (there is nothing else today, but this
// is a whitelist, not a denylist) never reaches the generated output.
const FIELD_METADATA_KEYS = ['key', 'label', 'type', 'required', 'placeholder', 'prefix', 'default', 'options'];

/**
 * Import the backend registry fresh (cache-busted via a query string) so a
 * repeated call within one process — e.g. the drift test re-running the
 * builder after editing the registry in the same test run — never serves a
 * stale cached module.
 *
 * @returns {Promise<{ INTEGRATION_TYPES: object, INTEGRATION_CATEGORIES: object }>}
 */
export async function loadRegistry() {
    const url = `${pathToFileURL(REGISTRY_PATH).href}?t=${Date.now()}-${Math.random()}`;
    const mod = await import(url);
    return { INTEGRATION_TYPES: mod.INTEGRATION_TYPES, INTEGRATION_CATEGORIES: mod.INTEGRATION_CATEGORIES, getTestDepth: mod.getTestDepth };
}

/** Strip a field object down to plain, JSON-safe form metadata. */
function sanitizeField(field) {
    const out = {};
    for (const key of FIELD_METADATA_KEYS) {
        if (field[key] !== undefined) out[key] = field[key];
    }
    return out;
}

/**
 * Build the plain-data shape shared by both outputs: no functions, no
 * secrets (there are none to begin with — these are field definitions),
 * one entry per backend type keyed by id.
 *
 * @param {object} INTEGRATION_TYPES - backend registry's INTEGRATION_TYPES
 * @param {(type: object) => ('live'|'format-only'|'none')} getTestDepth - backend registry's getTestDepth
 * @returns {Record<string, object>}
 */
export function buildPlainTypes(INTEGRATION_TYPES, getTestDepth) {
    const out = {};
    for (const [id, type] of Object.entries(INTEGRATION_TYPES)) {
        const fields = (type.fields || []).map(sanitizeField);
        const entry = {
            id: type.id,
            name: type.name,
            description: type.description,
            color: type.color,
            fields,
            hasLiveTest: Boolean(type.testEndpoint),
            // VAULT-INTEG P8: the same fact as hasLiveTest, expressed as a
            // 3-way enum ('live'|'format-only'|'none') — see
            // getTestDepth() in integrationTypeRegistry.js for the rules.
            // hasLiveTest stays for callers already depending on the bool.
            testDepth: getTestDepth(type),
        };
        if (type.category !== undefined) entry.category = type.category;
        if (type.docs !== undefined) entry.docs = type.docs;
        out[id] = entry;
    }
    return out;
}

/**
 * Render src/config/integrationTypes.js source from the plain-data shape +
 * the backend's category dictionary. The three helper functions
 * (getIntegrationsByCategory / getIntegrationType / validateCredentials)
 * are generic operations over the data — they never depended on any one
 * type's specifics, so they're emitted verbatim rather than generated.
 *
 * @param {Record<string, object>} plainTypes
 * @param {object} categories - backend registry's INTEGRATION_CATEGORIES
 * @returns {string}
 */
export function renderFrontendModule(plainTypes, categories) {
    const typesJson = JSON.stringify(plainTypes, null, 4);
    const categoriesJson = JSON.stringify(categories, null, 4);

    return `/**
 * Integration Types Configuration — GENERATED FILE, do not hand-edit.
 *
 * Regenerate with: node scripts/sync-integration-types.mjs
 * Source of truth: services/auth/config/integrationTypeRegistry.js
 *
 * This is the offline/pre-fetch fallback src/hooks/useIntegrationTypes.js
 * serves when the live /api/orgs/:orgId/vault/types call hasn't landed yet
 * (or fails). It intentionally excludes validateCredentials/testEndpoint
 * function bodies and any live-test wiring — those are backend-only and run
 * against decrypted secrets server-side. \`hasLiveTest\` records whether the
 * backend registry can run a real network probe for that type at all;
 * \`testDepth\` (VAULT-INTEG P8) is the same fact as a 3-way enum
 * ('live'|'format-only'|'none') so the UI can render a distinct badge for a
 * format-only pass instead of a bare true/false.
 *
 * src/test/integrationTypesSync.test.js fails the build if this file (or
 * services/auth/config/integration-types.export.json) drifts from the
 * backend registry — see that test before hand-editing this file back out
 * of sync; regenerate instead.
 */

export const INTEGRATION_TYPES = ${typesJson};

// Categories for grouping — mirrors the backend registry's
// INTEGRATION_CATEGORIES so the two never diverge either.
export const INTEGRATION_CATEGORIES = ${categoriesJson};

/**
 * Get integration types grouped by category
 */
export function getIntegrationsByCategory() {
    const grouped = {};

    for (const [id, type] of Object.entries(INTEGRATION_TYPES)) {
        const category = type.category || 'custom';
        if (!grouped[category]) {
            grouped[category] = {
                ...INTEGRATION_CATEGORIES[category],
                integrations: []
            };
        }
        grouped[category].integrations.push(type);
    }

    return grouped;
}

/**
 * Get a specific integration type
 */
export function getIntegrationType(typeId) {
    return INTEGRATION_TYPES[typeId] || null;
}

/**
 * Validate credentials for a type (client-side)
 */
export function validateCredentials(typeId, credentials) {
    const type = INTEGRATION_TYPES[typeId];
    if (!type) {
        return { valid: false, errors: { _form: 'Unknown integration type' } };
    }

    const errors = {};

    for (const field of type.fields) {
        const value = credentials[field.key];

        if (field.required && (!value || !value.trim())) {
            errors[field.key] = \`\${field.label} is required\`;
            continue;
        }

        if (value && field.prefix && !value.startsWith(field.prefix)) {
            errors[field.key] = \`\${field.label} should start with \${field.prefix}\`;
        }

        if (value && field.type === 'url') {
            try {
                new URL(value);
            } catch {
                errors[field.key] = 'Invalid URL format';
            }
        }
    }

    return {
        valid: Object.keys(errors).length === 0,
        errors
    };
}

export default INTEGRATION_TYPES;
`;
}

/**
 * Build the minimal canonical export consumed by the quox-website repo:
 * id, name, category, hasLiveTest, and field NAMES only (no labels, types,
 * placeholders, defaults — just which keys a credential for this type
 * needs, for a repo that has no reason to import backend server code).
 *
 * @param {Record<string, object>} plainTypes
 * @returns {object}
 */
export function buildCanonicalExport(plainTypes) {
    const types = {};
    for (const [id, type] of Object.entries(plainTypes)) {
        types[id] = {
            id: type.id,
            name: type.name,
            category: type.category || 'custom',
            hasLiveTest: type.hasLiveTest,
            testDepth: type.testDepth,
            fields: (type.fields || []).map((f) => f.key),
        };
    }
    return {
        generatedBy: 'quox-dashboard scripts/sync-integration-types.mjs — do not hand-edit, regenerate from services/auth/config/integrationTypeRegistry.js',
        types,
    };
}

export function renderCanonicalExportJson(plainTypes) {
    return `${JSON.stringify(buildCanonicalExport(plainTypes), null, 4)}\n`;
}

/**
 * Compute both generated outputs from the live backend registry.
 * @returns {Promise<{ frontendModule: string, exportJson: string }>}
 */
// Labels for category ids the backend registry uses on types but never gave
// metadata (a nameless grouped bucket crashed the add-credential search on
// 2026-09-10: IntegrationModal calls category.name.toLowerCase()). The
// backend map is copied verbatim; anything it misses gets synthesized here
// so the generated frontend can NEVER emit a bucket without a string name.
const FALLBACK_CATEGORY_LABELS = {
    integrations: 'Integrations',
    productivity: 'Productivity',
    analytics: 'Analytics',
    utilities: 'Utilities',
    ticketing: 'Ticketing',
    cloudsecurity: 'Cloud Security',
    zerotrust: 'Zero Trust',
    kubernetes: 'Kubernetes',
    datamovement: 'Data Movement',
    datacatalog: 'Data Catalog',
    documentai: 'Document AI',
    finance: 'Finance',
    compliance: 'Compliance',
    vectordb: 'Vector Databases',
};

export function completeCategories(plainTypes, categories) {
    const completed = { ...categories };
    for (const type of Object.values(plainTypes)) {
        const cat = type.category || 'custom';
        if (!completed[cat]) {
            const label = FALLBACK_CATEGORY_LABELS[cat]
                || (cat.charAt(0).toUpperCase() + cat.slice(1));
            completed[cat] = { name: label, description: `${label} integrations` };
        } else if (typeof completed[cat].name !== 'string') {
            completed[cat] = { ...completed[cat], name: FALLBACK_CATEGORY_LABELS[cat] || cat };
        }
    }
    return completed;
}

export async function buildOutputs() {
    const { INTEGRATION_TYPES, INTEGRATION_CATEGORIES, getTestDepth } = await loadRegistry();
    const plainTypes = buildPlainTypes(INTEGRATION_TYPES, getTestDepth);
    return {
        frontendModule: renderFrontendModule(plainTypes, completeCategories(plainTypes, INTEGRATION_CATEGORIES)),
        exportJson: renderCanonicalExportJson(plainTypes),
    };
}

// ── CLI ──────────────────────────────────────────────────────────────────

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
    const { frontendModule, exportJson } = await buildOutputs();

    if (process.argv.includes('--check')) {
        const currentFrontend = (() => { try { return readFileSync(FRONTEND_OUT_PATH, 'utf8'); } catch { return null; } })();
        const currentExport = (() => { try { return readFileSync(EXPORT_OUT_PATH, 'utf8'); } catch { return null; } })();
        const staleFrontend = currentFrontend !== frontendModule;
        const staleExport = currentExport !== exportJson;
        if (staleFrontend || staleExport) {
            console.error(`Ⓠ QUOX │ sync-integration-types --check │ STALE: ${[
                staleFrontend ? 'src/config/integrationTypes.js' : null,
                staleExport ? 'services/auth/config/integration-types.export.json' : null,
            ].filter(Boolean).join(', ')} — run \`node scripts/sync-integration-types.mjs\` to regenerate ✖`);
            process.exit(1);
        }
        console.log('Ⓠ QUOX │ sync-integration-types --check │ both outputs match the backend registry ✔');
    } else {
        writeFileSync(FRONTEND_OUT_PATH, frontendModule);
        writeFileSync(EXPORT_OUT_PATH, exportJson);
        const count = Object.keys(JSON.parse(exportJson).types).length;
        console.log(`Ⓠ QUOX │ sync-integration-types │ wrote ${count} types to src/config/integrationTypes.js + integration-types.export.json ✔`);
    }
}
