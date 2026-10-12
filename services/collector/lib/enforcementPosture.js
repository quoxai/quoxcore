/**
 * lib/enforcementPosture.js — LICENSE-LAUNCH LL-6b piece 4 (collector side).
 *
 * CommonJS MIRROR of services/auth/lib/breakGlass.js. The collector cannot
 * import that ESM module and has no access to auth.db, so it carries the same
 * registry and the same pure resolver here and POLLS auth for the active
 * break-glass records. Same deliberate-mirror pattern as
 * lib/licenseGate.js ↔ services/tasks/lib/licenseGate.js.
 * services/auth/tests/enforcement-break-glass.test.js asserts the two flag
 * registries have not drifted apart.
 *
 * WHAT THIS CHANGES. Three enforcement postures used to be decided by
 * `process.env.X === '...'` at the call site, two of them OFF by default. On a
 * production box that meant a missing or empty env var silently disabled a
 * security gate. Now:
 *
 *   env asks for enforcement            → enforced
 *   env off, NODE_ENV != production     → NOT enforced (dev stays switchable)
 *   env off, production, break-glass    → NOT enforced, attributed + expiring
 *   env off, production, no break-glass → ENFORCED anyway, logged loudly
 *
 * FAIL CLOSED ON EVERY UNCERTAINTY. isEnforced() is synchronous, so it reads a
 * cache that a background poller fills. Before the first successful poll, and
 * whenever auth is unreachable, the cache holds no record for the flag and the
 * answer in production is "enforce". An outage can therefore only ever make
 * the box stricter, never looser. Records are self-expiring (72h ceiling), so
 * a stale cache cannot hold a window open past its own expiry either.
 */

/** Hard ceiling on a break-glass window. Mirrors lib/breakGlass.js. */
const MAX_BREAK_GLASS_MS = 72 * 60 * 60 * 1000;

const ENFORCEMENT_FLAGS = [
    {
        key: 'COLLECTOR_AUTH_ENFORCE',
        name: 'Collector default-deny auth gate',
        enforcedWhen: (env) => env.COLLECTOR_AUTH_ENFORCE === 'enforce',
    },
    {
        key: 'AEE_ENDPOINT_AUTH_ENFORCE',
        name: 'AEE endpoint authentication',
        enforcedWhen: (env) => env.AEE_ENDPOINT_AUTH_ENFORCE === 'true',
    },
    {
        key: 'QUOXCHAT_LICENSE_ENFORCE',
        name: 'QuoxChat widget licence gate',
        enforcedWhen: (env) => String(env.QUOXCHAT_LICENSE_ENFORCE || 'on').toLowerCase() !== 'off',
    },
];

const FLAGS_BY_KEY = new Map(ENFORCEMENT_FLAGS.map(f => [f.key, f]));

/** flag key -> break-glass record. Filled by the poller, empty until then. */
let breakGlassCache = new Map();
let lastFetchAt = null;
let lastFetchError = null;
let pollTimer = null;

// Loud-log throttle: one line per flag per 5 minutes, so a forced-on flag is
// visible in the log without drowning it on a busy box.
const FORCED_LOG_INTERVAL_MS = 5 * 60_000;
const lastForcedLogAt = new Map();

function isActive(record, now = Date.now()) {
    if (!record || !record.expires_at) return false;
    const t = Date.parse(record.expires_at);
    return Number.isFinite(t) && t > now;
}

/**
 * The pure resolver. Identical semantics to lib/breakGlass.js
 * resolveEnforcement(); kept side-effect free so it is testable without a
 * clock, an env or a network.
 */
function resolveEnforcement({ flag, env = {}, breakGlass = null, nodeEnv = undefined }) {
    if (!flag || typeof flag.enforcedWhen !== 'function') {
        throw new Error('resolveEnforcement: a flag registry entry is required');
    }
    const effectiveNodeEnv = nodeEnv === undefined ? env.NODE_ENV : nodeEnv;
    const envEnforced = !!flag.enforcedWhen(env);
    const breakGlassActive = isActive(breakGlass);

    if (envEnforced) {
        return { enforced: true, envEnforced, breakGlassActive, forced: false, reason: 'env_enforced' };
    }
    if (effectiveNodeEnv !== 'production') {
        return { enforced: false, envEnforced, breakGlassActive, forced: false, reason: 'env_off_non_production' };
    }
    if (breakGlassActive) {
        return { enforced: false, envEnforced, breakGlassActive, forced: false, reason: 'break_glass' };
    }
    return { enforced: true, envEnforced, breakGlassActive, forced: true, reason: 'production_no_break_glass' };
}

/**
 * Should `flagKey` be enforced right now? Synchronous, safe to call per
 * request (a Map lookup and a string compare).
 */
function isEnforced(flagKey, env = process.env) {
    const flag = FLAGS_BY_KEY.get(flagKey);
    if (!flag) throw new Error(`unknown enforcement flag: ${flagKey}`);

    const verdict = resolveEnforcement({
        flag,
        env,
        breakGlass: breakGlassCache.get(flagKey) || null,
    });

    if (verdict.forced) {
        const now = Date.now();
        const last = lastForcedLogAt.get(flagKey) || 0;
        if (now - last > FORCED_LOG_INTERVAL_MS) {
            lastForcedLogAt.set(flagKey, now);
            console.error(
                `[enforcement] ${flagKey} is switched OFF in the environment but NODE_ENV=production ` +
                `and no unexpired break-glass record exists — ENFORCING ANYWAY (fail closed). ` +
                `Open a break-glass window in Settings → Security → Enforcement, or set the flag to enforce.`,
            );
        }
    }
    return verdict.enforced;
}

/** Full posture of every flag — for the collector's own status surface. */
function enforcementStatus(env = process.env) {
    return ENFORCEMENT_FLAGS.map((flag) => {
        const breakGlass = breakGlassCache.get(flag.key) || null;
        const verdict = resolveEnforcement({ flag, env, breakGlass });
        return {
            key: flag.key,
            name: flag.name,
            env_enforced: verdict.envEnforced,
            enforced: verdict.enforced,
            forced_on: verdict.forced,
            reason: verdict.reason,
            break_glass: isActive(breakGlass) ? breakGlass : null,
        };
    });
}

// ──────────────────────────────────────────────────────────────────────
// Poller
// ──────────────────────────────────────────────────────────────────────

function getAuthUrl() {
    // Same var precedence as lib/licenseGate.js — one canonical var so a
    // compose that sets only one of them cannot silently point this elsewhere.
    return process.env.AUTH_SERVICE_URL || process.env.AUTH_INTERNAL_URL || 'http://auth:3101';
}

/**
 * Pull the active break-glass records from auth. On ANY failure the previous
 * cache is retained (records self-expire, so this cannot hold a window open
 * past its own expiry) and the error is recorded for the status surface.
 */
async function refreshBreakGlass() {
    const serviceKey = process.env.INTERNAL_SERVICE_KEY;
    try {
        const res = await fetch(`${getAuthUrl()}/api/setup/internal/break-glass`, {
            headers: {
                ...(serviceKey ? { 'x-service-key': serviceKey } : {}),
                'x-internal-call': '1',
            },
            signal: AbortSignal.timeout(2000),
        });
        if (!res.ok) throw new Error(`auth ${res.status}`);
        const body = await res.json();
        const next = new Map();
        for (const [key, record] of Object.entries(body.break_glass || {})) {
            if (FLAGS_BY_KEY.has(key) && isActive(record)) next.set(key, record);
        }
        breakGlassCache = next;
        lastFetchAt = new Date().toISOString();
        lastFetchError = null;
        return { ok: true, count: next.size };
    } catch (err) {
        lastFetchError = err.message;
        console.warn(`[enforcement] could not refresh break-glass records from auth: ${err.message} (keeping last known set; enforcement stays ON where none is known)`);
        return { ok: false, error: err.message };
    }
}

function startEnforcementPosture({ intervalMs = 60_000 } = {}) {
    if (pollTimer) return;
    refreshBreakGlass().catch(() => {});
    pollTimer = setInterval(() => { refreshBreakGlass().catch(() => {}); }, intervalMs);
    if (pollTimer.unref) pollTimer.unref();
    console.log(`[enforcement] break-glass poller started (every ${intervalMs / 1000}s)`);
}

function stopEnforcementPosture() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

/** Test seam: set the cache directly instead of polling. */
function _setBreakGlassForTests(map) {
    breakGlassCache = new Map(Object.entries(map || {}));
    lastForcedLogAt.clear();
}

module.exports = {
    MAX_BREAK_GLASS_MS,
    ENFORCEMENT_FLAGS,
    resolveEnforcement,
    isActive,
    isEnforced,
    enforcementStatus,
    refreshBreakGlass,
    startEnforcementPosture,
    stopEnforcementPosture,
    breakGlassMeta: () => ({ lastFetchAt, lastFetchError, cached: breakGlassCache.size }),
    _setBreakGlassForTests,
};
