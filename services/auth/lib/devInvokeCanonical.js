/**
 * devInvokeCanonical — strict shape validation for the SECOND kind of bytes
 * the DCSK signing oracle is asked to sign: fleet dev-INVOKE job envelopes.
 *
 * quox#586: TRUST-PROOF audit cycle 1 hardened POST /api/internal/dev-profiles
 * /sign to sign ONLY well-formed dev CapabilityPROFILE bytes
 * (lib/devProfileCanonical.js). Correct in spirit — the oracle must never be a
 * general-purpose signer — but the same oracle also signs the job-envelope
 * bytes every fleet dev-invoke carries (collector's devLoopSpawner /
 * devBuildProxy / devSessionsProxy / devBackupProxy all sign
 *
 *     envelope.id + created_at(RFC3339) + goJsonStringify(Job)
 *
 * which quoxagent's internal/crypto/verifier.go buildSignedData verifies with
 * the same DCSK public key, agent commit 74f4096). Those bytes are NOT profile
 * JSON, so after cycle 1 every fleet loop/build/sessions/backup invocation was
 * rejected as not_a_profile / not_json — fleet dev-invoke was dead at signing.
 *
 * The fix keeps the oracle domain-separated, not widened: the sign route takes
 * a `kind` discriminator and, for kind:'invoke', validates the bytes here as a
 * well-formed invoke-envelope signed-data string and RE-SERIALISES it to prove
 * auth accounts for every byte it signs (same canonical-lock discipline the
 * profile validator uses). A signed profile can never be replayed as an invoke
 * envelope or vice versa: the two byte-shapes are structurally disjoint AND
 * each request must declare which shape it is.
 *
 * This module — like devProfileCanonical — deliberately does NOT import the
 * collector's job/tool catalog (cross-service coupling). It bounds the tool to
 * the dev.* namespace and the requester to the collector.* namespace; the
 * host-side executor enforces the exact tool/method it will run.
 */

// Envelope id: collector mints `dv[isb]_<hex>` (dvi_/dvb_/dvs_ + 24 hex). Keep
// the pattern structural, not an exact prefix list, so a new invoke caller
// does not have to touch auth — but no timestamp/JSON chars, so the split
// below is unambiguous.
const ENVELOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Go time.RFC3339 without fractional seconds, UTC 'Z' (rfc3339Utc() emits it).
const RFC3339 = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z';
const RFC3339_PATTERN = new RegExp(`^${RFC3339}$`);
// Split <id><createdAt><job>: id is non-greedy up to the FIRST RFC3339 stamp
// (the id carries none), then the job is the single brace-group to end. Both
// boundaries (T/:/Z vs id charset, Z vs {) are unambiguous.
const SIGNED_DATA_PATTERN = new RegExp(`^(.+?)(${RFC3339})(\\{[\\s\\S]*\\})$`);

const TOOL_PATTERN = /^dev\.[a-z][a-z0-9_.-]{0,63}$/;
const REQUESTER_PATTERN = /^collector[.a-z0-9_-]{0,63}$/;

const JOB_REQUIRED_KEYS = ['type', 'name', 'tool', 'inputs', 'requester', 'correlation_id'];
const JOB_ALLOWED_KEYS = new Set(JOB_REQUIRED_KEYS);
const INPUT_ALLOWED_KEYS = new Set(['name', 'content']);

const MAX_STRING = 8192;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

// U+2028 / U+2029 built from char codes so no literal line-separator ever sits
// in this source file (it would break the parser).
const U2028_RE = new RegExp(String.fromCharCode(0x2028), 'g');
const U2029_RE = new RegExp(String.fromCharCode(0x2029), 'g');

function fail(reason) {
    return { ok: false, reason };
}

/**
 * Reproduce collector devLoopSpawner.goJsonStringify byte-for-byte: JSON with
 * Go json.Marshal's default HTML-escaping (<, >, & and U+2028/U+2029). The
 * canonical lock below compares against the ORIGINAL bytes, so this must match
 * exactly what the collector produced.
 */
function goJsonStringify(value) {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(U2028_RE, '\\u2028')
        .replace(U2029_RE, '\\u2029');
}

/**
 * @param {Buffer} bytes - the exact bytes the caller wants signed
 * @param {Date} [now]
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function validateCanonicalInvokeBytes(bytes, now = new Date()) {
    const text = bytes.toString('utf8');

    const m = text.match(SIGNED_DATA_PATTERN);
    if (!m) {
        return fail('not_an_invoke: bytes must be <envelopeId><createdAt RFC3339><job JSON>');
    }
    const [, envelopeId, createdAt, jobText] = m;

    if (!ENVELOPE_ID_PATTERN.test(envelopeId)) return fail('bad_envelope_id');
    if (!RFC3339_PATTERN.test(createdAt)) return fail('bad_created_at');
    const createdMs = Date.parse(createdAt);
    if (Number.isNaN(createdMs)) return fail('bad_created_at');
    if (createdMs > now.getTime() + FUTURE_SKEW_MS) return fail('created_at_in_future');

    let job;
    try {
        job = JSON.parse(jobText);
    } catch {
        return fail('job_not_json');
    }
    if (!job || typeof job !== 'object' || Array.isArray(job)) return fail('job_not_object');

    for (const k of Object.keys(job)) {
        if (!JOB_ALLOWED_KEYS.has(k)) return fail(`job_unknown_field: ${k}`);
    }
    for (const k of JOB_REQUIRED_KEYS) {
        if (!(k in job)) return fail(`job_missing_field: ${k}`);
    }

    if (job.type !== 'tool') return fail('job_type_not_tool');
    if (typeof job.tool !== 'string' || !TOOL_PATTERN.test(job.tool)) return fail('tool_out_of_namespace');
    if (typeof job.name !== 'string' || job.name.length === 0 || job.name.length > MAX_STRING) return fail('bad_name');
    if (typeof job.requester !== 'string' || !REQUESTER_PATTERN.test(job.requester)) return fail('requester_out_of_namespace');
    if (typeof job.correlation_id !== 'string' || job.correlation_id.length === 0 || job.correlation_id.length > MAX_STRING) {
        return fail('bad_correlation_id');
    }

    if (!Array.isArray(job.inputs) || job.inputs.length === 0) return fail('inputs_empty');
    for (const inp of job.inputs) {
        if (!inp || typeof inp !== 'object' || Array.isArray(inp)) return fail('bad_input');
        for (const k of Object.keys(inp)) {
            if (!INPUT_ALLOWED_KEYS.has(k)) return fail(`input_unknown_field: ${k}`);
        }
        if (typeof inp.name !== 'string' || inp.name.length === 0 || inp.name.length > MAX_STRING) return fail('bad_input_name');
        if (typeof inp.content !== 'string') return fail('bad_input_content');
    }

    // Canonical lock: the bytes must be the pinned serialisation of their own
    // parsed values, in EXACTLY quoxagent's pkg/jobs.Job struct-field order
    // (the only order Go's json.Marshal emits, hence the only order the agent
    // ever verifies against). Rebuilding the object in fixed order and
    // re-serialising means auth signs ONLY bytes it fully reconstructs — a
    // reordered job, a reordered input, extra whitespace or an escaping drift
    // all fail here. Signing still covers the ORIGINAL bytes.
    const pinned = {
        type: job.type,
        name: job.name,
        tool: job.tool,
        inputs: job.inputs.map((i) => ({ name: i.name, content: i.content })),
        requester: job.requester,
        correlation_id: job.correlation_id,
    };
    if (envelopeId + createdAt + goJsonStringify(pinned) !== text) {
        return fail('not_canonical: bytes are not the pinned Go-struct-order serialisation of their own values (key order / whitespace / encoding drift)');
    }

    return { ok: true };
}

export { validateCanonicalInvokeBytes, goJsonStringify };
