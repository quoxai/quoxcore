/**
 * lib/entitlements.js — LICENSE-ENFORCE LE-2 / LE-3c
 *
 * The entitlement resolver. Fail closed: a plugin is licensed only if a
 * stored lease (a) cryptographically verifies against the embedded quox.ai
 * public key, (b) is bound to THIS instance, and (c) has not expired. Any
 * lease that fails any of those checks is silently excluded, not trusted.
 *
 * Backs `GET /api/setup/internal/has-plugin` — the endpoint
 * services/tasks/lib/licenseGate.js has been calling (and 404ing on) since
 * QMH-1.
 *
 * LE-3c adds the org-scoped entitlement grammar (docs/STREAM_LICENSE_ENFORCE.md
 * §11.1/§13.1): an entitlements[] entry is either `<pluginId>` (whole-install)
 * or `<pluginId>@orgs=<N>` (covers at most N organisations on this install).
 * Because entitlements[] sits inside the signed license/lease payload, the
 * org count is forgery-proof with no change to the signer/verifier format.
 */

import { getDb } from '../db/index.js';
import { verifyLease } from './licenseVerify.js';
import { getInstanceId } from './instanceIdentity.js';
import { listStoredLeases } from './licenseClient.js';
import { loadSignedCatalog, governedIdsFromCatalog, tiersFromCatalog, paidIdsFromCatalog, displayRowsFromCatalog } from './signedCatalog.js';
import { cacheGeneration, clearEntitlementsCache } from './entitlementsCache.js';

const CACHE_TTL_MS = 10_000;

// Keyed on the DATABASE HANDLE, not global: a single process can hold more than
// one database (the service db plus a test's own), and a global cache made the
// second one read the first one's answer for up to CACHE_TTL_MS. Invalidation
// is a generation counter rather than a clear(), because a WeakMap cannot be
// iterated.
/** @type {WeakMap<object, { expiresAt: number, generation: number, data: object }>} */
const _cache = new WeakMap();

// ── LE-3c: licence-governed plugin universe ─────────────────────────────
//
// LICENSE-LAUNCH LL-4b: this list is now the documented FALLBACK, not the
// authority. When a verified signed catalogue is installed (lib/signedCatalog.js),
// the governed set is DERIVED from it — quox.ai says what exists and this
// service gates it, instead of two repos hand-copying ids at each other and
// drifting. Absent a snapshot (the pre-cutover state), this list still runs,
// with one warn line at startup.
//
// Plugins in the governed set require an entitlement to use; plugins NOT in it
// (custom org uploads via services/auth/routes/plugins.js) are not
// licence-governed and always pass hasPlugin(). `core` (the shell itself) is
// handled separately below, not via this list.
//
// While the fallback is live it must KEEP IN SYNC WITH quox-website
// api/config/pluginCatalog.js — tests/license-catalog-drift.test.js guards the
// two lists, tests/signed-catalog.test.js guards this list against the signed
// catalogue's id set.
const GOVERNED_PLUGIN_IDS = [
    'quoxcore', 'advanced-memory', 'proxmox', 'uptime-kuma', 'prometheus',
    'grafana', 'visualizations', 'soc', 'noc', 'files', 'cognitive-topology',
    'aocl-compliance-suite', 'aocl-developer-kit', 'backup-restore',
    // advanced-voice REMOVED from the governed set (owner ruling 2026-08-31,
    // LICENSE-LAUNCH LL-6d): the premium voice settings + TTS behaviour are
    // statically imported by the FREE build (src/services/voiceSettings.js), so
    // charging for them was dishonest. It is now genuinely free core, no strip
    // owed. FOLLOW-UP (owner-side, NOT done here): this is only the FALLBACK
    // list. The AUTHORITATIVE governed set on a deployed box is derived from the
    // SIGNED CATALOGUE (LICENSE_GOVERNED_PLUGINS = _signedCatalog ? ... : this
    // list). quox.ai must REGENERATE the signed catalogue with advanced-voice
    // dropped (or moved to price 0), or advanced-voice STAYS GOVERNED in
    // production until then. Do not regenerate the signed catalogue from here.
    // The two catalog-drift guards record this deliberate fallback exclusion:
    // tests/license-catalog-drift.test.js DELIBERATELY_UNGOVERNED_CATALOG_IDS
    // and tests/signed-catalog.test.js KNOWN_IN_CATALOG_NOT_IN_LEGACY.
    'core-comms', 'mikrotik-routeros', 'web-terminal',
    'action-tracker', 'wazuh', 'quoxagent-fleet', 'prompts-library',
    'system-maintenance', 'workflow-library', 'codebase-mirror', 'opsdeck',
    'bastion-fleet', 'docker-fleet', 'quoxchat', 'browser-q', 'cogcore3d',
    'tailscale', 'quoxtrade', 'local-inference', 'developer-tools',
    'quoxbox-macmini', 'decision-evidence', 'linkedin', 'youtube', 'x', 'github',
    'quoxmind-pro', 'quoxmind-complete', 'quox-nucleus',
    // QuoxPlan (dev bundle #2).
    'quoxplan',
    // Brain2 cockpit: RULED 2026-10-06 (owner). The dashboard view + Settings
    // section are paid ($29 one-time); the engine (quoxbrain APIs, agent
    // tools, `quox brain` CLI) never consults this id and stays free.
    'quox-brain2',
    // Quox Telegram Pro (QTG-PRO): governed from day one as a new commercial
    // plugin. NOTE: a dev/owner install must hold an entitlement for it
    // before the auth service is rebuilt with this entry, or the plugin
    // hides from the dashboard (frontend gate mirrors hasPlugin()).
    'telegram-pro',
    // QLarity (dev bundle #3, DEVSUITE-CLARIFY). Governed from day one, per
    // BLUEPRINT defect 5.3: retro-governing a deployed plugin is an
    // owner-gated cutover with a lockout risk, so new plugins never start
    // ungoverned. Same telegram-pro caveat applies — a dev/owner install must
    // hold the entitlement BEFORE the auth service is rebuilt with this
    // entry, or the plugin hides from the dashboard.
    //
    // Not yet deployed: QLarity's service exists (~/qlarity) but the plugin
    // manifest, view and nav are DEVSUITE-CLARIFY P2. This entry landing
    // first is deliberate: the gate precedes the surface, never the reverse.
    'qlarity',
    // Dev Suite members + bundle (2026-08-16, owner-priced store rows).
    // Same gate-precedes-surface pattern as qlarity above: none of these id
    // strings match a deployed plugin yet (verified against
    // src/config/plugins/index.js before adding), so the entries are inert
    // until each substream registers its plugin — at which point a
    // generate-all master key already entitles it. Ids = store slugs =
    // /solutions paths, per LE-3.0.
    'dev-servers', 'qloop', 'quoxbuild', 'gripe', 'triage',
    'proofloop', 'fixloop', 'skill-packs', 'quoxslots', 'dev-suite-bundle',
    // LICENSE-ENFORCE LE-5 drift fix (2026-08-06): three priced, catalog-listed
    // plugins were shipping ungoverned — an entitlement query for any of them
    // returned licensed:true for every org, entitled or not. Each was already
    // live/proxied, so this is a retro-governing cutover: an install holding a
    // real lease for one of these must already carry (or immediately activate)
    // the matching entitlement, or the plugin locks out on the next auth
    // rebuild. See services/auth/tests/license-catalog-drift.test.js.
    //
    // quoxsignal (tier_b): gate lands in services/collector/server.js's
    // /api/v1/signal/* proxy (the only path the dashboard client uses — see
    // src/components/quoxsignal/lib/api.js). Was previously unchecked there
    // by explicit design comment ("no org/license gating either"); now
    // resolves the caller org and 403s an unlicensed one, mirroring the
    // QLarity/RepoBrain proxy pattern in the same file.
    'quoxsignal',
    // quoxseo (tier_b): governed from day one (the QLarity lesson — never
    // "add gating later"). Gate lands in services/collector/server.js's
    // /api/v1/quoxseo/* proxy, the only path the dashboard client uses; the
    // backend (:3110, repo quoxai/quox-seo) is loopback-bound and read-only.
    'quoxseo',
    // quoxchat-pro (tier_c): QuoxChat itself stays gated on the base
    // `quoxchat` entitlement (services/collector/routes/quoxchat.js
    // licenseGuard) — that is unchanged and covers ordinary chat. The
    // Pro-only capability is human handoff getting a live governed Matrix
    // room (QUOXCHAT-PRO P2): the gate lands in
    // services/collector/lib/quoxchatMatrixRelay.js's provisionHandoffRoom(),
    // the single choke point every handoff path (LLM tool call, action chip,
    // re-provision retry) routes through. Without the entitlement the room is
    // never provisioned — the visitor gets the existing fail-soft "queued"
    // UX (same as a Matrix outage today), not an error, so this cannot break
    // an org's ordinary chat traffic.
    'quoxchat-pro',
    // quoxlens (tier_b): two gates apply once this id is governed. (1)
    // src/components/quoxlens/QuoxLensView.jsx already calls
    // isPluginLicensed('quoxlens') and renders QuoxLensLocked when false
    // (docs/QUOXLENS_GATING.md) — that check was previously a no-op because
    // this id was absent from the governed set (fail-open). (2) the real
    // data-plane: server.js mounts services/collector/routes/quoxlens.js at
    // /api/v1/lens/* with NO licence check of its own — an authenticated
    // caller could reach findings/apply directly, bypassing the frontend
    // lock entirely. This change adds a licence-gate middleware at that
    // mount point (mirrors the QLarity mount pattern) so both the UI and the
    // API are actually gated, not just the UI.
    //
    // LOCKOUT WARNING: unlike quoxsignal/quoxchat-pro above, no lease on this
    // dev/owner install currently grants 'quoxlens' (checked directly against
    // the running auth service's stored leases) — rebuilding auth with this
    // entry WILL lock QuoxLens out for the owner too, exactly as
    // docs/QUOXLENS_GATING.md warns. Issue a quoxlens entitlement to this
    // instance BEFORE the next auth rebuild, or expect the lockout.
    'quoxlens',
    // discord-pro: install/settings surface for the Discord Pro daemon
    // (separate repo, /opt/quoxcore/quox-discord-pro). Governed from day
    // one, per the qlarity/telegram-pro precedent above: a new commercial
    // plugin never starts ungoverned. LOCKOUT WARNING applies exactly as it
    // does for quoxlens: a dev/owner install must hold a discord-pro
    // entitlement before the auth service is rebuilt with this entry, or
    // the plugin hides from the dashboard on the next rebuild.
    'discord-pro',
    // LICENSE-LAUNCH LL-5 Group E, owner ruling 2026-08-29 ("ALL PAID"): the
    // Chief Team packs and QUOX-SECURITY were listed in the quox-website
    // catalog (issuable) but absent here, so hasPlugin() returned true for
    // every org — fail-open, license-catalog-drift.test.js red. The owner
    // has now ruled all six ungoverned Group E SKUs paid; these four are
    // governed in this pass. See services/auth/lib/signedCatalog.js
    // DELIBERATELY_UNGOVERNED_IDS (chief-team-* removed from that carve-out
    // to match). The other two Group E ids (doneengine, enterprise-bundle)
    // are owned by a different session and deliberately NOT touched here —
    // they stay red in the drift test until that session governs them.
    'chief-team-small', 'chief-team-medium', 'chief-team-enterprise',
    'quox-security',
];

/**
 * LL-4b: the hardcoded universe, kept and exported under its honest name. It is
 * what runs when no signed catalogue is installed, and what the drift guard
 * compares the catalogue against.
 */
export const FALLBACK_GOVERNED_PLUGIN_IDS = GOVERNED_PLUGIN_IDS;

// LL-4b: resolved ONCE at import (i.e. at service startup). loadSignedCatalog()
// throws on a present-but-unverifiable snapshot, so a tampered catalogue takes
// the service down rather than silently degrading it to the fallback list.
const _signedCatalog = loadSignedCatalog();
const _catalogTiers = _signedCatalog ? tiersFromCatalog(_signedCatalog.products) : new Map();

/**
 * LICENSE-LAUNCH LL-2e (cutover): the PAID id set, from the signed catalogue
 * when one is installed, else null — meaning "use the fallback free list
 * below". Resolved once at import, like the governed set and the tiers.
 */
const _catalogPaidIds = _signedCatalog ? paidIdsFromCatalog(_signedCatalog.products) : null;

/**
 * The licence-governed plugin universe: derived from the signed catalogue when
 * one is installed, else the fallback list above.
 */
export const LICENSE_GOVERNED_PLUGINS = _signedCatalog
    ? governedIdsFromCatalog(_signedCatalog.products)
    : new Set(GOVERNED_PLUGIN_IDS);

/**
 * LL-4c: the catalogue as DISPLAY metadata for clients (the entitlements API
 * serves this to the dashboard and the CLI), or NULL when no snapshot is
 * installed. Null, not [], because the two mean different things to a client:
 * null is "this server has no authority to offer, use your own fallback list",
 * [] would be "the authority says no products exist" and would blank every
 * tier label on the pre-cutover box.
 */
export const CATALOG_DISPLAY = _signedCatalog
    ? displayRowsFromCatalog(_signedCatalog.products)
    : null;

// entitlements[] entry grammar: `<pluginId>` or `<pluginId>@orgs=<N>` (N >= 1
// integer). The part before `@` is the entitlement id; `orgs=N` is the
// org allowance for that entitlement. Anything else is treated as a plain
// whole-install entitlement id (defensive — malformed `@orgs=` suffixes fall
// back to whole-install rather than being silently dropped).
const ORG_SCOPE_RE = /^(.+)@orgs=(\d+)$/;

// LICENSE-LAUNCH LL-2e-ii: plan tiers ride v2 as PSEUDO-entitlements of the
// form `plan.<tier>` (e.g. `plan.enterprise`) inside the ordinary signed
// entitlements[] array. They are NOT plugins: they are split out here, at the
// single fold point every lease entry passes through, so a `plan.*` id can
// never reach the plugin entitlement set, the org-scope rules, hasPlugin(),
// or the entitlements API response as if it were a plugin id.
// utils/planTiers.js maps the collected tiers to a plan name.
export const PLAN_ENTITLEMENT_PREFIX = 'plan.';

// ── LICENSE-LAUNCH LL-2e (the cutover): bare PAID ids are refused ──────────
//
// A bare entitlement (`quoxchat`, no `@orgs=N`) means WHOLE INSTALL. That is
// correct for a product that costs nothing and wrong for one that does: one
// paid org silently licensed every org on the box. Post-cutover a PAID id
// arriving bare in a signed key/lease is REFUSED — not granted, and surfaced
// as a validation error naming the id (getEntitlementErrors()) so an admin
// sees WHY a plugin went dark instead of guessing.
//
// ORDERING (docs/CUTOVER_RUNBOOK_LL2E.md, the one ordering rule): the estate
// is inventoried and reissued with explicit bands (`GET
// /api/admin/licenses/band-audit`, `POST .../reissue-banded`) BEFORE this code
// ships. A holder still carrying a bare paid id after it ships is stuck until
// their key is reissued, which is exactly why step 2 must report zero findings
// first.
//
// The FREE fallback list below mirrors quox-website api/data/product-catalog.json
// rows priced at 0, and only runs while no signed catalogue is installed — the
// same fallback posture as FALLBACK_GOVERNED_PLUGIN_IDS above. `core` is here
// for completeness; it never reaches the check (hasPlugin() short-circuits it).
export const FALLBACK_FREE_ENTITLEMENT_IDS = new Set([
    'core',
    'prompts-library',
    'aocl-developer-kit',
    'cognitive-topology',
    'files',
    'noc',
    'soc',
    'system-maintenance',
    'workflow-library',
    'codebase-mirror',
    'visualizations',
    'local-inference',
]);

/**
 * Does this entitlement id cost money, and is it therefore refusable when it
 * arrives bare?
 *
 * Two deliberate narrowings, both so this consumer refuses EXACTLY what the
 * issuing authority's band audit flags and never a superset:
 *
 *  1. Only LICENCE-GOVERNED ids can be refused. An id outside the governed set
 *     is not gated at all (custom org uploads, and the declared carve-outs in
 *     signedCatalog.js DELIBERATELY_UNGOVERNED_IDS), so refusing it would be a
 *     lockout for something this service was never enforcing.
 *  2. With a signed catalogue installed, paid means the AUTHORITY says
 *     `price > 0`. An id the catalogue does not price is not refusable —
 *     mirroring findBarePaidEntitlements() in quox-website
 *     api/services/licenseDb.js, which likewise treats an unknown id as "not a
 *     finding". Absent a catalogue, every governed id is paid unless it is in
 *     the free list above.
 */
export function isPaidEntitlementId(pluginId) {
    if (!LICENSE_GOVERNED_PLUGINS.has(pluginId)) return false;
    return _catalogPaidIds
        ? _catalogPaidIds.has(pluginId)
        : !FALLBACK_FREE_ENTITLEMENT_IDS.has(pluginId);
}

/**
 * LICENSE-LAUNCH LL-8: exported so lib/freeClaimGuard.js parses the org-scope
 * suffix grammar (`<id>` / `<id>@orgs=<N>`) and the `plan.<tier>` prefix the
 * exact same way this resolver does, rather than a second regex that could
 * drift from this one.
 */
export function parseEntitlementEntry(raw) {
    const str = String(raw);
    const m = ORG_SCOPE_RE.exec(str);
    if (m) {
        const n = parseInt(m[2], 10);
        if (Number.isInteger(n) && n >= 1) {
            return { pluginId: m[1], orgScoped: true, maxOrgs: n };
        }
    }
    return { pluginId: str, orgScoped: false, maxOrgs: null };
}

/**
 * LICENSE-LAUNCH LL-3b: split one lease's raw entitlements[] into the plugin
 * entries a licence list should DISPLAY and the `plan.<tier>` grants it should
 * not. getLicenseSummaries() echoed the raw array, so a `plan.enterprise`
 * pseudo-id (LL-2e-ii) rendered verbatim as if it were a purchasable plugin.
 *
 * Display-only: this changes nothing about what the resolver TRUSTS —
 * applyEntitlementEntries() above is still the single fold point that decides
 * entitlements, org-scope rules and plan tiers.
 *
 * @returns {{ entitlements: string[], plans: string[] }}
 */
function splitLeaseEntitlements(rawEntries) {
    const entitlements = [];
    const plans = [];
    for (const raw of (rawEntries || [])) {
        const { pluginId } = parseEntitlementEntry(raw);
        if (pluginId.startsWith(PLAN_ENTITLEMENT_PREFIX)) {
            const tier = pluginId.slice(PLAN_ENTITLEMENT_PREFIX.length).toLowerCase();
            if (tier) plans.push(tier);
            continue;
        }
        entitlements.push(String(raw));
    }
    return { entitlements, plans };
}

function keyConfigKey(licenseId) {
    return `licensing.key.${licenseId}`;
}

/**
 * The signed license key's REAL expires_at, parsed from the stored key JSON
 * (`licensing.key.<license_id>` in instance_config, written by
 * licenseClient.js on activate). Distinct from the lease's expires_at (the
 * short-lived ~72h renewal token) — a license may run for a year while its
 * lease renews every few days. Returns null if no key row was stored (e.g.
 * a lease inserted directly, or a legacy activation) or the row isn't
 * parseable JSON with an expires_at field.
 */
function readStoredKeyExpiry(db, licenseId) {
    try {
        const row = db.prepare('SELECT value FROM instance_config WHERE key = ?').get(keyConfigKey(licenseId));
        if (!row) return null;
        const parsed = JSON.parse(row.value);
        return typeof parsed?.expires_at === 'string' ? parsed.expires_at : null;
    } catch {
        return null;
    }
}

/**
 * Fold one verified, unexpired entitlements[] list into the accumulating
 * entitlements set + org-scope rules, applying the entry grammar: a
 * whole-install grant wins over an org-scoped grant for the same plugin, and
 * multiple org-scoped grants accumulate their allowance.
 */
function applyEntitlementEntries(entitlements, entitlementRules, planTiers, rawEntries, errors, licenseId) {
    for (const raw of (rawEntries || [])) {
        const { pluginId, orgScoped, maxOrgs } = parseEntitlementEntry(raw);

        // LL-2e-ii: `plan.<tier>` is a plan grant, not a plugin. Collect the
        // tier and move on — deliberately BEFORE entitlements.add() so it is
        // impossible for a plan id to be resolved as a plugin. An `@orgs=N`
        // suffix on a plan entry is meaningless and simply ignored (the plan
        // is instance-wide, like the legacy tiers array it replaces).
        if (pluginId.startsWith(PLAN_ENTITLEMENT_PREFIX)) {
            const tier = pluginId.slice(PLAN_ENTITLEMENT_PREFIX.length).toLowerCase();
            if (tier) planTiers.add(tier);
            continue;
        }

        // LL-2e (cutover): a PAID id with no `@orgs=N` band would mean whole
        // install. Refuse it — deliberately BEFORE entitlements.add(), so a
        // bare paid id grants nothing at all rather than granting everything.
        // Free ids fall straight through and stay whole-install by design.
        if (!orgScoped && isPaidEntitlementId(pluginId)) {
            const message =
                `Entitlement '${pluginId}' is a paid product but carries no org band ` +
                `(expected '${pluginId}@orgs=<N>'). A bare paid entitlement would license every ` +
                `organisation on this install, so it is refused. Ask quox.ai to reissue this ` +
                `licence with an explicit band.`;
            errors?.push({
                license_id: licenseId ?? null,
                entitlement: pluginId,
                error: 'bare_paid_entitlement',
                message,
            });
            console.warn(`[Entitlements] REFUSED bare paid entitlement '${pluginId}' on licence ${licenseId ?? 'unknown'}: ${message}`);
            continue;
        }

        entitlements.add(pluginId);

        const existing = entitlementRules.get(pluginId);
        if (!orgScoped) {
            // A whole-install grant always wins over any org-scoped grant
            // for the same plugin (unlimited supersedes N-limited).
            entitlementRules.set(pluginId, { wholeInstall: true, maxOrgs: null });
        } else if (!existing) {
            entitlementRules.set(pluginId, { wholeInstall: false, maxOrgs });
        } else if (!existing.wholeInstall) {
            // Multiple org-scoped grants for the same plugin (e.g. an
            // additional-orgs top-up license) accumulate the allowance.
            entitlementRules.set(pluginId, { wholeInstall: false, maxOrgs: existing.maxOrgs + maxOrgs });
        }
        // existing.wholeInstall === true → leave as whole-install, ignore.
    }
}

function computeEntitlements(db) {
    const instanceId = getInstanceId(db);
    const leases = listStoredLeases(db);
    const now = Date.now();

    const entitlements = new Set();
    /** @type {Map<string, { wholeInstall: boolean, maxOrgs: number }>} */
    const entitlementRules = new Map();
    /** @type {Set<string>} LL-2e-ii: `plan.<tier>` grants, kept out of `entitlements`. */
    const planTiers = new Set();
    /** @type {Array<{license_id: string|null, entitlement: string, error: string, message: string}>}
     *  LL-2e: entries a verified lease carried that this install REFUSED. */
    const errors = [];
    const licenses = [];

    for (const lease of leases) {
        const verification = verifyLease(lease);
        if (!verification.valid) continue;
        if (!instanceId || lease.instance_id !== instanceId) continue;

        const expiresAtMs = Date.parse(lease.expires_at);
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) continue;

        applyEntitlementEntries(entitlements, entitlementRules, planTiers, lease.entitlements, errors, lease.license_id);

        const display = splitLeaseEntitlements(lease.entitlements);
        licenses.push({
            license_id: lease.license_id,
            entitlements: display.entitlements,
            plans: display.plans,
            expires_at: readStoredKeyExpiry(db, lease.license_id) || lease.expires_at,
            lease_expires_at: lease.expires_at,
        });
    }

    // RETIRED (LICENSE-LAUNCH LL-1a, owner ruling R7): offline-imported
    // licenses (`licensing.imported.<id>`) used to be consumed here as a
    // second entitlement source, verified against the license-key-v2 signed
    // payload with no instance binding — one paid key could therefore run
    // unlimited installs. A verified, instance-bound, unexpired lease is now
    // the ONLY entitlement source. Guard:
    // tests/license-offline-import-removed.test.js.

    return { entitlements, entitlementRules, planTiers, errors, licenses };
}

function getCached(db) {
    const hit = _cache.get(db);
    if (hit && hit.generation === cacheGeneration() && Date.now() < hit.expiresAt) return hit.data;
    const data = computeEntitlements(db);
    _cache.set(db, { data, expiresAt: Date.now() + CACHE_TTL_MS, generation: cacheGeneration() });
    return data;
}

/**
 * @returns {Set<string>} union of entitlement plugin ids across every
 * verified, instance-bound, unexpired lease (org-scoped suffixes stripped).
 */
export function getEntitlements(db) {
    return getCached(db).entitlements;
}

/**
 * LICENSE-LAUNCH LL-2e-ii — the `plan.<tier>` grants held by verified,
 * instance-bound, unexpired leases, with the `plan.` prefix stripped and
 * lower-cased (e.g. `enterprise`). Never overlaps getEntitlements(): a plan
 * id is excluded from the plugin set by construction.
 *
 * Consumed by utils/planTiers.js, which owns the tier -> plan-name mapping.
 * Same trust path as every other entitlement: no lease, no expiry, no
 * instance binding, no signature -> no plan.
 *
 * @returns {Set<string>}
 */
export function getPlanTiers(db) {
    return getCached(db).planTiers;
}

/**
 * LICENSE-LAUNCH LL-2e — entitlement entries this install REFUSED, with the
 * offending id named. Today that is exactly one class: a bare (unbanded) PAID
 * id, which would otherwise have meant whole install.
 *
 * These are validation errors, not licence failures: the lease itself verified,
 * is bound to this instance and has not expired — one of the entries inside it
 * is not honourable. A lease that fails verification is excluded wholesale and
 * says nothing here (silently untrusted, as it always was).
 *
 * @returns {Array<{license_id: string|null, entitlement: string, error: string, message: string}>}
 */
export function getEntitlementErrors(db) {
    return getCached(db).errors;
}

/**
 * @returns {Array<{license_id, entitlements, plans, expires_at, lease_expires_at}>}
 *
 * LL-3b: `entitlements` carries PLUGIN entries only (org-scope suffixes kept
 * verbatim, they are part of the plugin grammar); `plan.<tier>` grants are
 * split into `plans` so a licence list never renders a plan pseudo-id as a
 * plugin. See splitLeaseEntitlements().
 */
export function getLicenseSummaries(db) {
    return getCached(db).licenses;
}

// ── LE-3c: org slot assignment (instance_config `licensing.orgs.<pluginId>`) ──
//
// Read/written live (NOT through the 10s entitlements cache above) — slot
// claims must be immediate and consistent, and they are a separate
// instance_config key from the lease rows the cache is built from.

function orgSlotsKey(pluginId) {
    return `licensing.orgs.${pluginId}`;
}

function readOrgSlots(db, pluginId) {
    try {
        const row = db.prepare('SELECT value FROM instance_config WHERE key = ?').get(orgSlotsKey(pluginId));
        if (!row) return [];
        const arr = JSON.parse(row.value);
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

function writeOrgSlots(db, pluginId, orgIds) {
    db.prepare(`
        INSERT INTO instance_config (key, value, value_type, description, updated_at)
        VALUES (?, ?, 'json', 'Org-scoped entitlement slot assignment (LICENSE-ENFORCE LE-3c)', datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value, value_type = 'json', updated_at = datetime('now')
    `).run(orgSlotsKey(pluginId), JSON.stringify(orgIds));
}

/**
 * LICENSE-LAUNCH LL-2d1: reconcile a persisted slot list against the
 * allowance currently resolved from the live leases.
 *
 * Slot rows are append-only, so a license reissued with a SMALLER `@orgs=N`
 * (say 3 down to 1) used to leave every previously assigned org resolving as
 * licensed forever — claimOrgSlot()'s membership check ran before any cap
 * check. Trimming here, on the live read paths, makes eviction immediate:
 * the first `maxOrgs` entries keep their seats (array order is claim order,
 * so earliest claims win) and the rest are dropped and persisted.
 *
 * A rule that disappears entirely (lease gone/expired) is NOT handled here —
 * hasPlugin() already fails closed on a missing entitlement, and the stale
 * slot row is left alone deliberately so a renewed lease restores the same
 * assignments.
 *
 * @returns {string[]} the (possibly trimmed) slot list.
 */
function reconcileOrgSlots(db, pluginId, maxOrgs) {
    const slots = readOrgSlots(db, pluginId);
    if (!Number.isInteger(maxOrgs) || slots.length <= maxOrgs) return slots;

    const kept = slots.slice(0, maxOrgs);
    const evicted = slots.slice(maxOrgs);
    writeOrgSlots(db, pluginId, kept);
    console.warn(
        `[Entitlements] org allowance for '${pluginId}' fell ${slots.length} -> ${maxOrgs}; ` +
        `evicted org slots: ${evicted.join(', ')}`
    );
    return kept;
}

/**
 * LICENSE-LAUNCH LL-3a: the slot read-modify-write sequences below run as
 * better-sqlite3 transaction functions, so no concurrent claim can observe a
 * half-applied state or push the list past `maxOrgs`. Transaction functions
 * are cached per database handle (building one prepares BEGIN/COMMIT/ROLLBACK
 * statements, and claimOrgSlot is on the hot hasPlugin() path). Nested calls
 * are safe: better-sqlite3 falls back to SAVEPOINT inside an open transaction.
 */
const _slotTransactions = new WeakMap();

function slotTransaction(db, name, body) {
    let byName = _slotTransactions.get(db);
    if (!byName) {
        byName = new Map();
        _slotTransactions.set(db, byName);
    }
    let tx = byName.get(name);
    if (!tx) {
        tx = db.transaction(body);
        byName.set(name, tx);
    }
    return tx;
}

// GRIPE-714: org ids are ULIDs / slugs-safe tokens; a `user:<id>` personal
// bucket (or anything with a colon, whitespace, etc.) is never an org.
const ORG_ID_FORMAT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Is `orgId` eligible to hold a seat: well-formed AND a live (not
 * soft-deleted) row in the orgs table.
 * @returns {{ ok: true } | { ok: false, reason: 'not_an_org_id'|'org_deleted_or_missing' }}
 */
function checkBandEligibility(db, orgId) {
    if (typeof orgId !== 'string' || !ORG_ID_FORMAT.test(orgId)) {
        return { ok: false, reason: 'not_an_org_id' };
    }
    let row;
    try {
        row = db.prepare('SELECT 1 AS x FROM orgs WHERE id = ? AND deleted_at IS NULL').get(orgId);
    } catch {
        row = undefined;
    }
    return row ? { ok: true } : { ok: false, reason: 'org_deleted_or_missing' };
}

const _refusalsLogged = new Set();
function warnRefusedOnce(pluginId, orgId, reason) {
    const k = `${pluginId}|${orgId}`;
    if (_refusalsLogged.has(k)) return;
    if (_refusalsLogged.size > 1000) _refusalsLogged.clear();
    _refusalsLogged.add(k);
    console.warn(`[Entitlements] refused org-seat claim for '${pluginId}': '${orgId}' is not a live org (${reason})`);
}

/**
 * Read-only: every band entry (across all `licensing.orgs.*` keys) that is not
 * a live org id. For an owner cleanup script; never mutates.
 * @returns {{ pluginId: string, entry: string, reason: string }[]}
 */
export function listInvalidBandEntries(db) {
    const rows = db.prepare(
        "SELECT key FROM instance_config WHERE key LIKE 'licensing.orgs.%'"
    ).all();
    const out = [];
    for (const row of rows) {
        const pluginId = row.key.slice('licensing.orgs.'.length);
        for (const entry of readOrgSlots(db, pluginId)) {
            const check = checkBandEligibility(db, entry);
            if (!check.ok) out.push({ pluginId, entry, reason: check.reason });
        }
    }
    return out;
}

/**
 * Read-only: every holder of a plugin's band with its eligibility. Unlike
 * getOrgSlotsSummary() this reads the raw band row, so it also works for a
 * plugin whose entitlement has since lapsed (ghost seats are the point).
 * @returns {{ entry: string, live: boolean, reason?: string }[]}
 */
export function listBandHolders(db, pluginId) {
    return readOrgSlots(db, pluginId).map((entry) => {
        const check = checkBandEligibility(db, entry);
        return check.ok ? { entry, live: true } : { entry, live: false, reason: check.reason };
    });
}

/**
 * Claim (or confirm) an org slot for a org-scoped entitlement. First-come
 * auto-assign: if orgId already occupies a slot, true. Else if the slot list
 * has room (< maxOrgs), append and persist, true. Else false (exhausted).
 *
 * LL-2d1: reconciles against the current allowance FIRST, so an org evicted
 * by a shrunken license does not pass the membership check below. The
 * reconcile is inside the LL-3a transaction with the rest of the sequence.
 */
function claimOrgSlot(db, pluginId, orgId, maxOrgs) {
    // GRIPE-714: a band holds REAL orgs only. Refuse (never throw) anything
    // else, e.g. the personal `user:<id>` bucket of an org-less session.
    const check = checkBandEligibility(db, orgId);
    if (!check.ok) {
        warnRefusedOnce(pluginId, orgId, check.reason);
        return false;
    }
    return slotTransaction(db, 'claim', (pid, oid, max) => {
        const slots = reconcileOrgSlots(db, pid, max);
        if (slots.includes(oid)) return true;
        if (slots.length < max) {
            slots.push(oid);
            writeOrgSlots(db, pid, slots);
            return true;
        }
        return false;
    })(pluginId, orgId, maxOrgs);
}

/**
 * Free an org's slot for a plugin (admin action — e.g. an org left, or the
 * admin wants to reassign the seat to a different org).
 * @returns {{ released: boolean }}
 */
export function releaseOrgSlot(db, pluginId, orgId) {
    // LL-3a: read-modify-write in one transaction, same as claimOrgSlot().
    return slotTransaction(db, 'release', (pid, oid) => {
        const slots = readOrgSlots(db, pid);
        const idx = slots.indexOf(oid);
        if (idx === -1) return { released: false };
        slots.splice(idx, 1);
        writeOrgSlots(db, pid, slots);
        return { released: true };
    })(pluginId, orgId);
}

/**
 * Free EVERY licence slot an org holds, across every plugin band. Called on
 * org deletion (routes/orgs.js): slot rows are otherwise append-only, so a
 * soft-deleted org keeps its seats forever and eventually fills the band —
 * on 2026-09-18 every @orgs=10 band on the dev instance was 10/10 full with
 * 9 soft-deleted test orgs each, locking real orgs out of licensed plugins.
 * @returns {{ released: number }} how many bands the org was removed from
 */
export function releaseAllOrgSlots(db, orgId) {
    return slotTransaction(db, 'releaseAll', (oid) => {
        const rows = db.prepare(
            "SELECT key FROM instance_config WHERE key LIKE 'licensing.orgs.%'"
        ).all();
        let released = 0;
        for (const row of rows) {
            const pluginId = row.key.slice('licensing.orgs.'.length);
            const slots = readOrgSlots(db, pluginId);
            const idx = slots.indexOf(oid);
            if (idx === -1) continue;
            slots.splice(idx, 1);
            writeOrgSlots(db, pluginId, slots);
            released += 1;
        }
        return { released };
    })(orgId);
}

/**
 * Full slot map for every org-scoped entitlement currently held, for the
 * Settings UI / `GET /setup/licensing/org-slots`.
 * @returns {Record<string, { allowance: number, orgs: string[] }>}
 */
export function getOrgSlotsSummary(db) {
    const { entitlementRules } = getCached(db);
    const summary = {};
    for (const [pluginId, rule] of entitlementRules) {
        if (rule.wholeInstall) continue; // whole-install plugins have no slot concept
        // LL-2d1: reconcile here too, so the Settings UI shows the truth even
        // if no org has resolved a licence check since the allowance fell.
        summary[pluginId] = { allowance: rule.maxOrgs, orgs: reconcileOrgSlots(db, pluginId, rule.maxOrgs) };
    }
    return summary;
}

/**
 * LICENSE-LAUNCH LL-3b — per-plugin org-band state for the entitlements
 * response, so the dashboard can show an over-allowance org that it is
 * UNLICENSED instead of letting it discover that as a 402 at its public embed.
 *
 * The flat entitlement set says only "this install holds a grant for X". This
 * says, for each org-scoped grant: how many orgs it covers, which orgs hold a
 * seat, and whether the CALLING org is licensed under it.
 *
 * `org_licensed` mirrors hasPlugin()'s org-slot semantics exactly — assigned,
 * or a free seat it would claim on first resolution — WITHOUT claiming here: a
 * GET must not consume a seat on behalf of an org that merely looked at the
 * settings page. It is null (unknown, and the frontend fails closed on it)
 * when the caller carries no org context, matching hasPlugin(db, id,
 * undefined) returning false for an org-scoped grant.
 *
 * Whole-install grants have NO band: they have no slot concept, so the key is
 * absent rather than a fabricated allowance.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} [orgId] — the calling context's org, if any.
 * @returns {Record<string, { allowance: number, assigned_orgs: string[], assigned_count: number, org_licensed: boolean|null }>}
 */
export function getOrgBands(db, orgId) {
    const bands = {};
    for (const [pluginId, { allowance, orgs }] of Object.entries(getOrgSlotsSummary(db))) {
        bands[pluginId] = {
            allowance,
            assigned_orgs: orgs,
            assigned_count: orgs.length,
            org_licensed: (orgId && checkBandEligibility(db, orgId).ok) ? (orgs.includes(orgId) || orgs.length < allowance) : null,
        };
    }
    return bands;
}

/**
 * `core` (the shell itself) is always entitled — the app must boot to
 * accept a key. Plugins outside LICENSE_GOVERNED_PLUGINS (custom org
 * uploads) are not licence-governed and always pass. Every other plugin
 * requires an entitlement:
 *   - whole-install entitlement present → true, regardless of orgId.
 *   - org-scoped entitlement (`<pluginId>@orgs=N`) → true only if orgId
 *     occupies (or can first-come claim) one of the N slots. No orgId given
 *     for an org-scoped entitlement → false (cannot allocate anonymously).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} pluginId
 * @param {string} [orgId] — required for org-scoped entitlements; ignored
 *   for whole-install entitlements.
 */
export function hasPlugin(db, pluginId, orgId) {
    return resolvePluginAccess(db, pluginId, orgId).licensed;
}

/**
 * hasPlugin() with a reason. `reason: 'no_org_context'` means an org-scoped
 * grant was asked about by a caller with no real org (none given, or a
 * personal `user:<id>` / deleted / unknown id): unlicensed, and no seat was
 * claimed (GRIPE-714).
 * @returns {{ licensed: boolean, reason?: string }}
 */
export function resolvePluginAccess(db, pluginId, orgId) {
    if (pluginId === 'core') return { licensed: true };
    if (!LICENSE_GOVERNED_PLUGINS.has(pluginId)) return { licensed: true };

    const { entitlements, entitlementRules } = getCached(db);
    if (!entitlements.has(pluginId)) return { licensed: false };

    const rule = entitlementRules.get(pluginId);
    if (!rule || rule.wholeInstall) return { licensed: true };

    if (!orgId) return { licensed: false };
    if (!checkBandEligibility(db, orgId).ok) {
        claimOrgSlot(db, pluginId, orgId, rule.maxOrgs); // logs the refusal once
        return { licensed: false, reason: 'no_org_context' };
    }
    return { licensed: claimOrgSlot(db, pluginId, orgId, rule.maxOrgs) };
}

/**
 * LL-4b: the tier a plugin belongs to, as stated by the SIGNED catalogue. Null
 * when no snapshot is installed (the pre-cutover state — the has-plugin wire
 * contract allows null) or when the id carries no tier. This service never
 * invents a tier: the authority that sells the product names it.
 */
export function tierForPlugin(_db, pluginId) {
    return _catalogTiers.get(pluginId) ?? null;
}

/**
 * Test/admin: clear the in-process cache so a just-activated/deactivated
 * lease is reflected immediately rather than up to CACHE_TTL_MS later.
 *
 * Re-exported from lib/entitlementsCache.js (which imports nothing) so a caller
 * that only needs to invalidate does not have to import this module and, with
 * it, the database. Every existing importer keeps importing it from here.
 */
export { clearEntitlementsCache };

export default {
    getEntitlements,
    getPlanTiers,
    getEntitlementErrors,
    getLicenseSummaries,
    hasPlugin,
    isPaidEntitlementId,
    tierForPlugin,
    clearEntitlementsCache,
    releaseOrgSlot,
    getOrgSlotsSummary,
    getOrgBands,
    LICENSE_GOVERNED_PLUGINS,
    CATALOG_DISPLAY,
};
