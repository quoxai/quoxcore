/**
 * devProfileCanonical — strict shape validation for the bytes the DCSK
 * signing oracle is asked to sign.
 *
 * TRUST-PROOF audit cycle 1 (medium, self-flagged TODO(SEC-FLEET-CRED)):
 * POST /api/internal/dev-profiles/sign signed OPAQUE caller-supplied bytes
 * under any org's DCSK, gated only by the shared INTERNAL_SERVICE_KEY. That
 * made the route a general-purpose signing oracle: any key holder could
 * obtain a valid org signature over ARBITRARY bytes. This module collapses
 * that to "well-formed dev CapabilityProfile bytes only":
 *
 *   - the bytes must parse as JSON with EXACTLY the profile field set
 *   - every field is validated against the same rules the collector issuer
 *     enforces (devCapabilityProfileIssuer.js) and quoxagent's
 *     internal/plugins/dev/profile.go expects
 *   - the bytes must equal the canonical serialization of their own parsed
 *     values (pinned lexicographic key order, RFC3339 no fractional
 *     seconds) — auth signs ONLY bytes it fully accounts for, and signs the
 *     ORIGINAL bytes, so there is no re-serialization drift risk
 *
 * What this does NOT fix (still open in the finding): org_id continues to
 * come from the request body under the shared key. The per-caller-bound
 * token migration (the fleetHostCredentialsStore pattern) remains the
 * follow-up for the day a remote fleet host gets a call path here; until
 * then this bounds the oracle to short-shape dev profiles instead of
 * arbitrary blobs.
 */

const VERSION_PATTERN = /^[0-9A-Za-z.]{1,16}$/;
const KEY_ID_PATTERN = /^[0-9A-Za-z_-]{1,64}$/;
const HOST_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
// dev.* namespace only — auth deliberately does not import the collector's
// capability catalog (cross-service coupling); the namespace bound plus the
// issuer-side exact-catalog check together hold the line.
const CAPABILITY_PATTERN = /^dev\.[a-z][a-z0-9_.]{0,47}$/;
// Go time.RFC3339 without fractional seconds, UTC 'Z' form (what
// toRFC3339()/profile.go emit).
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const REQUIRED_KEYS = ['capabilities', 'issued_at', 'key_id', 'max_concurrent_sessions', 'version'];
const OPTIONAL_KEYS = ['expires_at', 'host_id'];
const ALLOWED_KEYS = new Set([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);

const FUTURE_SKEW_MS = 5 * 60 * 1000;

function fail(reason) {
    return { ok: false, reason };
}

/**
 * Rebuild the canonical serialization for a parsed profile — the exact
 * byte layout devCapabilityProfileIssuer.buildCanonicalBytes() and Go's
 * buildProfileSignedData() produce (lexicographic key order; capability
 * strings contain no JSON-escapable characters by validation above).
 */
function canonicalSerialize(p) {
    const parts = [`"capabilities":[${p.capabilities.map((c) => `"${c}"`).join(',')}]`];
    if (p.expires_at !== undefined) parts.push(`"expires_at":"${p.expires_at}"`);
    if (p.host_id !== undefined) parts.push(`"host_id":"${p.host_id}"`);
    parts.push(`"issued_at":"${p.issued_at}"`);
    parts.push(`"key_id":"${p.key_id}"`);
    parts.push(`"max_concurrent_sessions":${p.max_concurrent_sessions}`);
    parts.push(`"version":"${p.version}"`);
    return `{${parts.join(',')}}`;
}

/**
 * @param {Buffer} bytes - the exact bytes the caller wants signed
 * @param {Date} [now]
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function validateCanonicalProfileBytes(bytes, now = new Date()) {
    let text;
    let parsed;
    try {
        text = bytes.toString('utf8');
        parsed = JSON.parse(text);
    } catch {
        return fail('not_json: canonical bytes must be the profile JSON buildProfileSignedData() produces');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return fail('not_object');
    }

    const keys = Object.keys(parsed);
    for (const k of keys) {
        if (!ALLOWED_KEYS.has(k)) return fail(`unknown_field: ${k}`);
    }
    for (const k of REQUIRED_KEYS) {
        if (!(k in parsed)) return fail(`missing_field: ${k}`);
    }

    if (!Array.isArray(parsed.capabilities) || parsed.capabilities.length === 0) {
        return fail('capabilities_empty');
    }
    for (const c of parsed.capabilities) {
        if (typeof c !== 'string' || !CAPABILITY_PATTERN.test(c)) {
            return fail(`capability_out_of_namespace: ${String(c).slice(0, 64)}`);
        }
    }
    if (typeof parsed.version !== 'string' || !VERSION_PATTERN.test(parsed.version)) return fail('bad_version');
    if (typeof parsed.key_id !== 'string' || !KEY_ID_PATTERN.test(parsed.key_id)) return fail('bad_key_id');
    if (parsed.host_id !== undefined && (typeof parsed.host_id !== 'string' || !HOST_ID_PATTERN.test(parsed.host_id))) {
        return fail('bad_host_id');
    }
    if (!Number.isInteger(parsed.max_concurrent_sessions) || parsed.max_concurrent_sessions < 0 || parsed.max_concurrent_sessions > 10000) {
        return fail('bad_max_concurrent_sessions');
    }

    if (typeof parsed.issued_at !== 'string' || !RFC3339_PATTERN.test(parsed.issued_at)) return fail('bad_issued_at');
    const issuedAt = Date.parse(parsed.issued_at);
    if (Number.isNaN(issuedAt)) return fail('bad_issued_at');
    if (issuedAt > now.getTime() + FUTURE_SKEW_MS) return fail('issued_at_in_future');

    if (parsed.expires_at !== undefined) {
        if (typeof parsed.expires_at !== 'string' || !RFC3339_PATTERN.test(parsed.expires_at)) return fail('bad_expires_at');
        const expiresAt = Date.parse(parsed.expires_at);
        if (Number.isNaN(expiresAt)) return fail('bad_expires_at');
        if (expiresAt <= issuedAt) return fail('expires_before_issued');
    }

    if (canonicalSerialize(parsed) !== text) {
        return fail('not_canonical: bytes are not the pinned canonical serialization of their own values (key order / whitespace / encoding drift)');
    }

    return { ok: true };
}

export { validateCanonicalProfileBytes, canonicalSerialize };
