/**
 * Strict dry_run flag parsing for destructive routes.
 *
 * Accepts a boolean or its exact string form ('true' / 'false', for form and
 * query callers). Absent means `defaultValue`. Anything else (null, 1, "1",
 * "yes", "TRUE", objects) is refused: a malformed flag must never fall
 * through into the live, destructive branch.
 *
 * @returns {{ ok: true, value: boolean } | { ok: false }}
 */
export function parseDryRunFlag(raw, { defaultValue = true } = {}) {
    if (raw === undefined) return { ok: true, value: defaultValue };
    if (raw === true || raw === 'true') return { ok: true, value: true };
    if (raw === false || raw === 'false') return { ok: true, value: false };
    return { ok: false };
}

export const INVALID_DRY_RUN_BODY = Object.freeze({
    error: 'invalid_dry_run',
    message: 'dry_run must be true or false when supplied; any other value is refused rather than treated as a live run.',
});
