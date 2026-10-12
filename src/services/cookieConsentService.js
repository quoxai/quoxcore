/**
 * Cookie Consent Service
 *
 * Manages user consent for cookies and tracking.
 * Implements GDPR-compliant consent management with:
 * - Necessary cookies (always allowed, required for site function)
 * - Functional cookies (user preferences, session state)
 * - Analytics cookies (usage tracking, performance monitoring)
 *
 * Security Issue #74: High - No cookie consent implementation
 *
 * Storage: localStorage (exception to cookie consent as it's needed to track consent itself)
 */

const CONSENT_KEY = 'quox-cookie-consent';
const CONSENT_VERSION = '1.0';

/**
 * Cookie categories with descriptions for user information
 */
export const COOKIE_CATEGORIES = {
    necessary: {
        id: 'necessary',
        name: 'Necessary',
        description: 'Essential cookies required for the website to function. These cannot be disabled.',
        required: true,
        cookies: [
            { name: 'access_token', purpose: 'Authentication session', duration: '15 minutes' },
            { name: 'refresh_token', purpose: 'Session refresh', duration: '7 days' },
            { name: 'csrf_token', purpose: 'Security protection', duration: 'Session' }
        ]
    },
    functional: {
        id: 'functional',
        name: 'Functional',
        description: 'Cookies that remember your preferences and settings to improve your experience.',
        required: false,
        cookies: [
            { name: 'quox-sidebar-collapsed', purpose: 'Remember sidebar state', duration: 'Persistent' },
            { name: 'quox-theme', purpose: 'Theme preference', duration: 'Persistent' },
            { name: 'quox-collapsed-sections', purpose: 'UI state preferences', duration: 'Persistent' }
        ]
    },
    analytics: {
        id: 'analytics',
        name: 'Analytics',
        description: 'Cookies that help us understand how you use the site so we can improve it.',
        required: false,
        cookies: [
            { name: 'usage_metrics', purpose: 'Anonymous usage statistics', duration: '1 year' },
            { name: 'performance_data', purpose: 'Page load performance', duration: '30 days' }
        ]
    }
};

/**
 * Get stored consent preferences
 * @returns {Object|null} Consent object or null if not set
 */
export function getStoredConsent() {
    try {
        const stored = localStorage.getItem(CONSENT_KEY);
        if (!stored) return null;

        const consent = JSON.parse(stored);

        // Check if consent version matches (re-prompt if version changed)
        if (consent.version !== CONSENT_VERSION) {
            return null;
        }

        return consent;
    } catch (err) {
        console.error('[CookieConsent] Error reading stored consent:', err);
        return null;
    }
}

/**
 * Check if consent has been given (any decision made)
 * @returns {boolean}
 */
export function hasConsentDecision() {
    return getStoredConsent() !== null;
}

/**
 * Check if a specific cookie category is allowed
 * @param {string} category - Category ID (necessary, functional, analytics)
 * @returns {boolean}
 */
export function isCategoryAllowed(category) {
    // Necessary cookies are always allowed
    if (category === 'necessary') return true;

    const consent = getStoredConsent();
    if (!consent) return false;

    return consent.categories[category] === true;
}

/**
 * Save consent preferences
 * @param {Object} categories - Object with category IDs as keys and boolean values
 * @returns {Object} The saved consent object
 */
export function saveConsent(categories) {
    const consent = {
        version: CONSENT_VERSION,
        timestamp: new Date().toISOString(),
        categories: {
            necessary: true, // Always true
            functional: categories.functional === true,
            analytics: categories.analytics === true
        }
    };

    try {
        localStorage.setItem(CONSENT_KEY, JSON.stringify(consent));

        // Log consent event for audit
        logConsentChange(consent);

        // Apply consent decisions
        applyConsentDecisions(consent);

        return consent;
    } catch (err) {
        console.error('[CookieConsent] Error saving consent:', err);
        throw err;
    }
}

/**
 * Accept all cookies
 * @returns {Object} The saved consent object
 */
export function acceptAllCookies() {
    return saveConsent({
        necessary: true,
        functional: true,
        analytics: true
    });
}

/**
 * Accept only necessary cookies
 * @returns {Object} The saved consent object
 */
export function acceptNecessaryOnly() {
    return saveConsent({
        necessary: true,
        functional: false,
        analytics: false
    });
}

/**
 * Revoke consent (removes stored preferences)
 * User will be prompted again on next visit
 */
export function revokeConsent() {
    try {
        localStorage.removeItem(CONSENT_KEY);
        logConsentChange({ action: 'revoked' });

        // Clear non-essential cookies
        clearNonEssentialCookies();
    } catch (err) {
        console.error('[CookieConsent] Error revoking consent:', err);
    }
}

/**
 * Apply consent decisions - clear/allow cookies based on consent
 * @param {Object} consent - Consent object with categories
 */
function applyConsentDecisions(consent) {
    // If functional cookies not allowed, clear them
    if (!consent.categories.functional) {
        clearFunctionalData();
    }

    // If analytics not allowed, clear analytics data
    if (!consent.categories.analytics) {
        clearAnalyticsData();
    }

    // Dispatch event so other parts of the app can react
    window.dispatchEvent(new CustomEvent('cookieConsentChanged', {
        detail: consent
    }));
}

/**
 * Clear functional/preference data from localStorage
 */
function clearFunctionalData() {
    const functionalKeys = [
        'quox-sidebar-collapsed',
        'quox-theme',
        'quox-collapsed-sections',
        'quox-extensions-expanded'
    ];

    functionalKeys.forEach(key => {
        try {
            localStorage.removeItem(key);
        } catch (err) {
            console.warn(`[CookieConsent] Could not remove ${key}:`, err);
        }
    });
}

/**
 * Clear analytics/tracking data
 */
function clearAnalyticsData() {
    const analyticsKeys = [
        'quox-usage-metrics',
        'quox-performance-data'
    ];

    analyticsKeys.forEach(key => {
        try {
            localStorage.removeItem(key);
        } catch (err) {
            console.warn(`[CookieConsent] Could not remove ${key}:`, err);
        }
    });
}

/**
 * Clear all non-essential cookies and storage
 */
function clearNonEssentialCookies() {
    clearFunctionalData();
    clearAnalyticsData();
}

/**
 * Log consent change for audit purposes
 * @param {Object} consent - Consent object or action
 */
function logConsentChange(consent) {
    const logEntry = {
        type: 'COOKIE_CONSENT_CHANGE',
        timestamp: new Date().toISOString(),
        consent: consent,
        userAgent: navigator.userAgent,
        url: window.location.href
    };

    console.log('[CookieConsent] Consent changed:', logEntry);

    // In a production environment, this would be sent to an audit logging service
    // For now, we store in sessionStorage for debugging
    try {
        const auditLog = JSON.parse(sessionStorage.getItem('quox-consent-audit') || '[]');
        auditLog.push(logEntry);
        // Keep only last 10 entries
        if (auditLog.length > 10) auditLog.shift();
        sessionStorage.setItem('quox-consent-audit', JSON.stringify(auditLog));
    } catch (err) {
        // Silent fail for audit logging
    }
}

/**
 * Check if functional storage is allowed before using localStorage for preferences
 * @param {string} key - Storage key
 * @param {any} value - Value to store
 * @returns {boolean} Whether the value was stored
 */
export function setFunctionalStorage(key, value) {
    if (!isCategoryAllowed('functional')) {
        console.debug(`[CookieConsent] Blocked functional storage for ${key} - consent not given`);
        return false;
    }

    try {
        localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
        return true;
    } catch (err) {
        console.error(`[CookieConsent] Error storing ${key}:`, err);
        return false;
    }
}

/**
 * Get functional storage (only if consent given, otherwise return default)
 * @param {string} key - Storage key
 * @param {any} defaultValue - Default value if not found or not allowed
 * @returns {any} Stored value or default
 */
export function getFunctionalStorage(key, defaultValue = null) {
    if (!isCategoryAllowed('functional')) {
        return defaultValue;
    }

    try {
        const value = localStorage.getItem(key);
        if (value === null) return defaultValue;

        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    } catch (err) {
        return defaultValue;
    }
}

/**
 * Initialize consent service - checks for existing consent
 * @returns {Object|null} Existing consent or null
 */
export function initCookieConsent() {
    const consent = getStoredConsent();

    if (consent) {
        // Re-apply consent decisions (in case browser was closed)
        applyConsentDecisions(consent);
    }

    return consent;
}

export default {
    COOKIE_CATEGORIES,
    getStoredConsent,
    hasConsentDecision,
    isCategoryAllowed,
    saveConsent,
    acceptAllCookies,
    acceptNecessaryOnly,
    revokeConsent,
    setFunctionalStorage,
    getFunctionalStorage,
    initCookieConsent
};
