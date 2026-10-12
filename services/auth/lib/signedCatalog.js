/**
 * lib/signedCatalog.js — LICENSE-LAUNCH LL-4b
 *
 * The dashboard side of the signed product catalogue. quox.ai (LL-4a) is the
 * AUTHORITY for what products exist, what tier each is, and where each is
 * enforced; this module is the CONSUMER. Before it, this service carried its
 * own hand-typed copy of that universe (lib/entitlements.js
 * GOVERNED_PLUGIN_IDS, 60 ids, "KEEP IN SYNC WITH quox-website"), and a comment
 * asking two repos to stay in sync is not a mechanism — the lists drifted.
 *
 * WIRE CONTRACT. The artifact is `{ catalog: { version, generated_at, sources,
 * products[] }, sig }`. Each product carries its ENTITLEMENT id (the thing a
 * key is signed with and a gate matches), its store `slug`, `tier`,
 * `tier_source`, `price`, `category`, `enforcement_point`, `sellable`,
 * `grants[]`, `artefacts[]`, `backend_image` and a `stripe` reference block.
 *
 * CANONICALIZATION mirrors quox-website api/services/licenseSign.js
 * signCatalog() byte for byte, because a signature over "the same object,
 * serialised differently" verifies against nothing:
 *   - object keys sorted RECURSIVELY (arrays keep their order), so however the
 *     generator built the object, the bytes are the same.
 *   - the JSON is LENGTH-PREFIXED: `catalog1|<byteLength>|<json>`. This is the
 *     same delimiter-safety discipline the `v2|...` licence payloads get from
 *     their fixed arity (lib/licenseVerify.js) — a `|` inside a product name
 *     cannot fake a field boundary when the field length is signed too.
 *
 * POSTURE — fail closed on tamper, loud on absence:
 *   - snapshot present and VERIFIES -> it is the source of truth.
 *   - snapshot present and FAILS    -> THROW at startup. A catalogue edited
 *     underneath its signature is not a catalogue, and quietly falling back to
 *     the legacy list would make tampering a way to DOWNGRADE enforcement.
 *   - snapshot ABSENT               -> null, plus one warn line, and the caller
 *     uses its documented legacy fallback. This is the pre-cutover state: the
 *     production artifact is generated on quox.ai by the owner (the private
 *     signing key never leaves that box), so NO production snapshot is
 *     committed here and none may be fabricated.
 */

import { existsSync, readFileSync } from 'fs';
import { verify as cryptoVerify } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { loadLicensePublicKey } from './licenseVerify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Where the owner drops the artifact produced on quox.ai at cutover. */
export const SIGNED_CATALOG_PATH = join(__dirname, '..', 'data', 'signed-catalog.json');

/** The only catalogue schema version this build knows how to read. */
export const SUPPORTED_CATALOG_VERSION = 1;

const SIG_PREFIX = 'ED25519:';

/**
 * Catalogue ids that are DELIBERATELY not gated, by name, with the reason —
 * so the carve-out is a recorded decision rather than an unexplained hole. The
 * governed set is the catalogue MINUS this set; nothing else is exempt.
 *
 *   noc-suite-bundle, quoxgpu — the LL-5 sweep found these listed by the
 *     authority but ungoverned here (fail-open). Whether they SHOULD be
 *     gated is a commercial ruling the owner makes (LL-5 Group E), not one
 *     this consumer takes by quietly adding them to a gate: doing so is a
 *     lockout event for anyone running them today.
 *
 *   quox-brain2 — RULED 2026-10-06 (owner): the COCKPIT (dashboard view +
 *     Settings section) is paid, the ENGINE stays free. Governed here; the
 *     licence scopes the cockpit surface only (no engine route, agent tool or
 *     CLI path consults hasPlugin('quox-brain2')). The lockout concern that
 *     justified the carve-out is handled by the existing quox-brain2@orgs=N
 *     lease entitlement on deployed instances.
 *
 *   chief-team-small / -medium / -enterprise — RULED 2026-08-29 (owner,
 *     "ALL PAID"): governed. Removed from this carve-out; see
 *     entitlements.js GOVERNED_PLUGIN_IDS for the matching fallback-list
 *     entry.
 */
export const DELIBERATELY_UNGOVERNED_IDS = new Set([
    'noc-suite-bundle',
    'quoxgpu',
]);

/** Recursively sort object keys. Arrays keep their order; scalars pass through. */
function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
        return out;
    }
    return value;
}

function catalogPayload(catalog) {
    const json = JSON.stringify(canonicalize(catalog));
    return `catalog1|${Buffer.byteLength(json, 'utf8')}|${json}`;
}

/**
 * Verify a `{ catalog, sig }` artifact against the embedded licensing public
 * key (or the injected LICENSE_PUBLIC_KEY, same seam the licence verifier and
 * its tests use). Returns a boolean and never throws: every unexpected shape,
 * malformed signature or key failure is a false, and the CALLER decides how
 * loudly to fail.
 */
export function verifySignedCatalog(artifact) {
    try {
        const { catalog, sig } = artifact || {};
        if (!catalog || typeof catalog !== 'object') return false;
        if (typeof sig !== 'string' || !sig.startsWith(SIG_PREFIX)) return false;

        const pubKey = loadLicensePublicKey();
        const sigBytes = Buffer.from(sig.slice(SIG_PREFIX.length), 'base64');
        // Ed25519: no digest algorithm.
        return cryptoVerify(null, Buffer.from(catalogPayload(catalog), 'utf-8'), pubKey, sigBytes);
    } catch {
        return false;
    }
}

let _resolved; // { catalog: object|null } once resolved — null means "absent".
let _warned = false;

function resolvePath(explicit) {
    return explicit || process.env.SIGNED_CATALOG_PATH || SIGNED_CATALOG_PATH;
}

/**
 * The verified catalogue, or null when no snapshot is installed.
 *
 * @param {{ path?: string }} [opts] — path override (tests, tooling).
 * @returns {{ version: number, generated_at?: string, products: object[] }|null}
 * @throws when a snapshot IS present but unreadable, unverifiable, or of a
 *   schema version this build cannot read. All three are fail-closed: a
 *   catalogue this service cannot fully trust must stop the service, not
 *   quietly become the legacy list.
 */
export function loadSignedCatalog(opts = {}) {
    if (_resolved) return _resolved.catalog;

    const path = resolvePath(opts.path);

    if (!existsSync(path)) {
        if (!_warned) {
            _warned = true;
            console.warn(
                `[SignedCatalog] No signed-catalog.json at ${path} — falling back to the LEGACY hardcoded ` +
                `governed-plugin list in lib/entitlements.js. Enforcement still runs; what is missing is the ` +
                `tamper-evident authority for WHICH products are governed. Install the artifact generated on ` +
                `quox.ai (node api/scripts/generate-signed-catalog.mjs) to switch over.`,
            );
        }
        _resolved = { catalog: null };
        return null;
    }

    let artifact;
    try {
        artifact = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (err) {
        throw new Error(`[SignedCatalog] ${path} is present but unreadable — refusing to start: ${err.message}`);
    }

    if (!verifySignedCatalog(artifact)) {
        throw new Error(
            `[SignedCatalog] ${path} failed Ed25519 verification — refusing to start. A catalogue edited ` +
            `underneath its signature is not a catalogue, and falling back to the legacy list here would make ` +
            `tampering a way to downgrade enforcement. Reinstall the artifact from quox.ai.`,
        );
    }

    const { catalog } = artifact;
    if (catalog.version !== SUPPORTED_CATALOG_VERSION) {
        throw new Error(
            `[SignedCatalog] ${path} is schema version ${catalog.version}, this build reads ` +
            `${SUPPORTED_CATALOG_VERSION} — refusing to start rather than misread a governance artifact. ` +
            `Upgrade this service, or remove the snapshot to fall back to the legacy list.`,
        );
    }
    if (!Array.isArray(catalog.products) || catalog.products.length === 0) {
        throw new Error(`[SignedCatalog] ${path} verified but carries no products — refusing to start on an empty governed universe.`);
    }

    _resolved = { catalog };
    return catalog;
}

/**
 * The governed id set implied by a catalogue: every product id except the
 * declared carve-outs above. Pure — takes the rows, so callers and tests can
 * derive without touching disk.
 *
 * @param {object[]} products
 * @returns {Set<string>}
 */
export function governedIdsFromCatalog(products = []) {
    const governed = new Set();
    for (const p of products) {
        if (!p || typeof p.id !== 'string') continue;
        if (DELIBERATELY_UNGOVERNED_IDS.has(p.id)) continue;
        governed.add(p.id);
    }
    return governed;
}

/**
 * id -> tier, from the catalogue. The tier is what the AUTHORITY says it is;
 * this service does not have an opinion (before LL-4b it had no tiers at all —
 * tierForPlugin() returned a flat null).
 *
 * @param {object[]} products
 * @returns {Map<string, string>}
 */
export function tiersFromCatalog(products = []) {
    const tiers = new Map();
    for (const p of products) {
        if (!p || typeof p.id !== 'string' || !p.tier) continue;
        tiers.set(p.id, p.tier);
    }
    return tiers;
}

/**
 * LICENSE-LAUNCH LL-2e (cutover) — the ids that COST money, as stated by the
 * signed catalogue (`price` > 0). This is the SAME predicate the issuing
 * authority uses to decide what must carry an org band: quox-website
 * api/services/licenseDb.js builds PAID_PRODUCT_IDS from
 * `products.filter(p => Number(p.price) > 0)` off the same catalogue rows.
 * Keeping the two definitions byte-identical is what makes "the band audit
 * reports zero findings" a real guarantee that no holder is refused here: an
 * id the authority never flagged for reissue must never be refused by this
 * consumer.
 *
 * A free product is whole-install BY DESIGN and stays bare forever, so it is
 * deliberately absent from this set.
 *
 * @param {object[]} products
 * @returns {Set<string>}
 */
export function paidIdsFromCatalog(products = []) {
    const paid = new Set();
    for (const p of products) {
        if (!p || typeof p.id !== 'string') continue;
        if (Number(p.price) > 0) paid.add(p.id);
    }
    return paid;
}

/**
 * LICENSE-LAUNCH LL-8 — the ids that cost NOTHING, as stated by the signed
 * catalogue (`price` === 0). The mirror of paidIdsFromCatalog above, and the
 * predicate the self-serve free-claim device flow gates against: an id not in
 * this set is either paid or does not exist in the catalogue at all, and
 * either way the free-claim path must refuse it rather than guess.
 *
 * @param {object[]} products
 * @returns {Set<string>}
 */
export function freeIdsFromCatalog(products = []) {
    const free = new Set();
    for (const p of products) {
        if (!p || typeof p.id !== 'string') continue;
        if (Number(p.price) === 0) free.add(p.id);
    }
    return free;
}

/**
 * LL-4c: the catalogue reduced to what a UI needs to LABEL a product — id, the
 * authority's tier, its category and whether it is sellable. Deliberately NOT a
 * passthrough of the row: artefact paths, backend images and the stripe block
 * describe how a product is built and billed, and no browser needs them, so
 * they never leave this service.
 *
 * @param {object[]} products
 * @returns {Array<{id: string, tier: string|null, category: string|null, sellable: boolean}>}
 */
export function displayRowsFromCatalog(products = []) {
    const rows = [];
    for (const p of products) {
        if (!p || typeof p.id !== 'string') continue;
        rows.push({
            id: p.id,
            tier: p.tier ?? null,
            category: p.category ?? null,
            sellable: p.sellable === true,
        });
    }
    return rows;
}

/** Test/tooling hook: drop the memoised resolution (and the one-shot warn). */
export function resetSignedCatalogCache() {
    _resolved = undefined;
    _warned = false;
}

export default {
    loadSignedCatalog,
    verifySignedCatalog,
    governedIdsFromCatalog,
    tiersFromCatalog,
    paidIdsFromCatalog,
    freeIdsFromCatalog,
    displayRowsFromCatalog,
    resetSignedCatalogCache,
    DELIBERATELY_UNGOVERNED_IDS,
    SIGNED_CATALOG_PATH,
};
