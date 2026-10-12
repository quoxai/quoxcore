/**
 * Password Validation Module
 *
 * Centralized password policy enforcement for consistent security across the application.
 *
 * Requirements:
 * - Minimum 12 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one number
 * - At least one special character
 */

const MIN_PASSWORD_LENGTH = 12;
// Hard ceiling — beyond this an attacker can melt CPU on argon2id.
// Real users never need passwords longer than this; passphrase users
// pick well under 200 chars typically. 256 is generous + safe.
const MAX_PASSWORD_LENGTH = 256;

const PASSWORD_REQUIREMENTS = {
    minLength: MIN_PASSWORD_LENGTH,
    maxLength: MAX_PASSWORD_LENGTH,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSpecialChar: true
};

/**
 * Validates a password against the security policy
 * @param {string} password - The password to validate
 * @returns {{ valid: boolean, message?: string, errors?: string[] }}
 */
function validatePassword(password) {
    const errors = [];

    if (!password || typeof password !== 'string') {
        return {
            valid: false,
            message: 'Password is required',
            errors: ['Password is required']
        };
    }

    // Check minimum length
    if (password.length < MIN_PASSWORD_LENGTH) {
        errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    // Hard ceiling — bounce ridiculous lengths before argon2 is invoked.
    if (password.length > MAX_PASSWORD_LENGTH) {
        errors.push(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
    }

    // Check for uppercase letter
    if (!/[A-Z]/.test(password)) {
        errors.push('Password must contain at least one uppercase letter');
    }

    // Check for lowercase letter
    if (!/[a-z]/.test(password)) {
        errors.push('Password must contain at least one lowercase letter');
    }

    // Check for number
    if (!/[0-9]/.test(password)) {
        errors.push('Password must contain at least one number');
    }

    // Check for special character
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)) {
        errors.push('Password must contain at least one special character (!@#$%^&*()_+-=[]{};\':"|,.<>/?`~)');
    }

    if (errors.length > 0) {
        return {
            valid: false,
            message: errors[0], // Primary error message for simple error handling
            errors: errors      // All errors for detailed feedback
        };
    }

    return { valid: true };
}

/**
 * Returns the password requirements as a human-readable string
 * @returns {string}
 */
function getPasswordRequirementsText() {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters and contain: uppercase letter, lowercase letter, number, and special character`;
}

/**
 * Returns the password requirements object
 * @returns {object}
 */
function getPasswordRequirements() {
    return { ...PASSWORD_REQUIREMENTS };
}

export {
    validatePassword,
    getPasswordRequirementsText,
    getPasswordRequirements,
    MIN_PASSWORD_LENGTH
};
