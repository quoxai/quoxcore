/**
 * ET-4 Phase C — MFA policy evaluator.
 *
 * Pure function. Does not read DB / session — the caller assembles the
 * inputs and decides what to do with the verdict.
 */

export const MFA_MODES = Object.freeze({
    DISABLED: 'disabled',
    OPTIONAL: 'optional',
    REQUIRED: 'required',
});

export function evaluateMfaPolicy({
    mode        = MFA_MODES.OPTIONAL,
    userHasMfa  = false,
    mfaVerified = false,
    userRole    = null,
    breakGlass  = false,
} = {}) {
    // Break-glass escape hatch for root_admin — always audit when invoked.
    if (mode === MFA_MODES.REQUIRED && breakGlass && userRole === 'root_admin') {
        return { allowed: true, required: false, reason: 'break_glass_bypass' };
    }

    if (mode === MFA_MODES.DISABLED) {
        return { allowed: true, required: false, reason: null };
    }

    if (mode === MFA_MODES.REQUIRED) {
        if (!userHasMfa) {
            return { allowed: false, required: true, reason: 'mfa_enrollment_required' };
        }
        if (!mfaVerified) {
            return { allowed: false, required: true, reason: 'mfa_challenge_required' };
        }
        return { allowed: true, required: true, reason: null };
    }

    // OPTIONAL (default / fallback): never blocks
    return { allowed: true, required: false, reason: null };
}
