/**
 * CookieConsent Component
 *
 * GDPR-compliant cookie consent banner that:
 * - Shows on first visit when no consent decision has been made
 * - Allows users to accept all, accept necessary only, or customize preferences
 * - Provides clear information about cookie categories
 * - Links to privacy policy
 * - Persists consent decision in localStorage
 *
 * Security Issue #74: High - No cookie consent implementation
 */

import { useState, useEffect, useCallback } from 'react';
import {
    hasConsentDecision,
    acceptAllCookies,
    acceptNecessaryOnly,
    saveConsent,
    getStoredConsent,
    COOKIE_CATEGORIES
} from '../../services/cookieConsentService';
import './cookie-consent.css';

/**
 * Cookie Consent Banner Component
 * Shows a banner at the bottom of the screen for new visitors
 */
export function CookieConsentBanner() {
    // Initialize directly from localStorage — if consent exists, never show
    const [isVisible, setIsVisible] = useState(() => !hasConsentDecision());
    const [showPreferences, setShowPreferences] = useState(false);
    const [preferences, setPreferences] = useState({
        necessary: true,
        functional: true,
        analytics: false
    });

    // Defensive: re-check localStorage on mount and listen for consent events.
    // Handles re-mounts (e.g., AuthProvider conditional rendering) and multi-tab sync.
    useEffect(() => {
        if (hasConsentDecision()) {
            setIsVisible(false);
        }
        const hide = () => setIsVisible(false);
        window.addEventListener('cookieConsentChanged', hide);
        const onStorage = (e) => {
            if (e.key === 'quox-cookie-consent' && e.newValue) setIsVisible(false);
        };
        window.addEventListener('storage', onStorage);
        return () => {
            window.removeEventListener('cookieConsentChanged', hide);
            window.removeEventListener('storage', onStorage);
        };
    }, []);

    // Handle accept all
    const handleAcceptAll = useCallback(() => {
        acceptAllCookies();
        setIsVisible(false);
    }, []);

    // Handle accept necessary only
    const handleAcceptNecessary = useCallback(() => {
        acceptNecessaryOnly();
        setIsVisible(false);
    }, []);

    // Handle save custom preferences
    const handleSavePreferences = useCallback(() => {
        saveConsent(preferences);
        setIsVisible(false);
        setShowPreferences(false);
    }, [preferences]);

    // Toggle a preference category
    const togglePreference = useCallback((category) => {
        if (category === 'necessary') return; // Can't toggle necessary
        setPreferences(prev => ({
            ...prev,
            [category]: !prev[category]
        }));
    }, []);

    // Don't render if not visible
    if (!isVisible) return null;

    return (
        <div className="cookie-consent-overlay">
            <div className={`cookie-consent-banner glass ${showPreferences ? 'cookie-consent-banner--expanded' : ''}`}>
                {/* Main Banner Content */}
                <div className="cookie-consent-main">
                    <div className="cookie-consent-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <circle cx="12" cy="12" r="10"/>
                            <path d="M12 8v4M12 16h.01"/>
                        </svg>
                    </div>

                    <div className="cookie-consent-content">
                        <h3 className="cookie-consent-title">Cookie Preferences</h3>
                        <p className="cookie-consent-text">
                            We use cookies to enhance your experience, improve site performance, and analyze usage.
                            You can customize your preferences or accept all cookies.
                            <a
                                href="https://quox.ai/privacy"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="cookie-consent-link"
                            >
                                Learn more in our Privacy Policy
                            </a>
                        </p>
                    </div>

                    <div className="cookie-consent-actions">
                        <button
                            className="cookie-consent-btn cookie-consent-btn--secondary"
                            onClick={() => setShowPreferences(!showPreferences)}
                        >
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="3"/>
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                            </svg>
                            Customize
                        </button>
                        <button
                            className="cookie-consent-btn cookie-consent-btn--outline"
                            onClick={handleAcceptNecessary}
                        >
                            Necessary Only
                        </button>
                        <button
                            className="cookie-consent-btn cookie-consent-btn--primary"
                            onClick={handleAcceptAll}
                        >
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="20 6 9 17 4 12"/>
                            </svg>
                            Accept All
                        </button>
                    </div>
                </div>

                {/* Expanded Preferences Panel */}
                {showPreferences && (
                    <div className="cookie-consent-preferences">
                        <div className="cookie-consent-preferences-header">
                            <h4>Cookie Preferences</h4>
                            <p>Choose which types of cookies you want to allow.</p>
                        </div>

                        <div className="cookie-consent-categories">
                            {Object.values(COOKIE_CATEGORIES).map(category => (
                                <div key={category.id} className="cookie-consent-category">
                                    <div className="cookie-consent-category-header">
                                        <div className="cookie-consent-category-info">
                                            <span className="cookie-consent-category-name">{category.name}</span>
                                            {category.required && (
                                                <span className="cookie-consent-badge cookie-consent-badge--required">Required</span>
                                            )}
                                        </div>
                                        <label className="cookie-consent-toggle">
                                            <input
                                                type="checkbox"
                                                checked={preferences[category.id]}
                                                onChange={() => togglePreference(category.id)}
                                                disabled={category.required}
                                            />
                                            <span className="cookie-consent-toggle-slider" />
                                        </label>
                                    </div>
                                    <p className="cookie-consent-category-description">{category.description}</p>

                                    {/* Cookie Details (collapsed by default) */}
                                    <details className="cookie-consent-details">
                                        <summary>View cookies ({category.cookies.length})</summary>
                                        <table className="cookie-consent-table">
                                            <thead>
                                                <tr>
                                                    <th>Cookie</th>
                                                    <th>Purpose</th>
                                                    <th>Duration</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {category.cookies.map(cookie => (
                                                    <tr key={cookie.name}>
                                                        <td><code>{cookie.name}</code></td>
                                                        <td>{cookie.purpose}</td>
                                                        <td>{cookie.duration}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </details>
                                </div>
                            ))}
                        </div>

                        <div className="cookie-consent-preferences-actions">
                            <button
                                className="cookie-consent-btn cookie-consent-btn--outline"
                                onClick={() => setShowPreferences(false)}
                            >
                                Cancel
                            </button>
                            <button
                                className="cookie-consent-btn cookie-consent-btn--primary"
                                onClick={handleSavePreferences}
                            >
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                                    <polyline points="17 21 17 13 7 13 7 21"/>
                                    <polyline points="7 3 7 8 15 8"/>
                                </svg>
                                Save Preferences
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * Cookie Settings Panel Component
 * For use in Settings page to manage cookie preferences after initial consent
 */
export function CookieSettingsPanel() {
    const [consent, setConsent] = useState(null);
    const [preferences, setPreferences] = useState({
        necessary: true,
        functional: false,
        analytics: false
    });
    const [saved, setSaved] = useState(false);

    // Load current consent on mount
    useEffect(() => {
        const stored = getStoredConsent();
        if (stored) {
            setConsent(stored);
            setPreferences(stored.categories);
        }
    }, []);

    // Toggle a preference
    const togglePreference = useCallback((category) => {
        if (category === 'necessary') return;
        setPreferences(prev => ({
            ...prev,
            [category]: !prev[category]
        }));
        setSaved(false);
    }, []);

    // Save preferences
    const handleSave = useCallback(() => {
        const newConsent = saveConsent(preferences);
        setConsent(newConsent);
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
    }, [preferences]);

    return (
        <div className="cookie-settings-panel">
            <div className="cookie-settings-header">
                <h3>Cookie Preferences</h3>
                <p>Manage how we use cookies and similar technologies.</p>
                {consent && (
                    <p className="cookie-settings-last-updated">
                        Last updated: {new Date(consent.timestamp).toLocaleDateString()}
                    </p>
                )}
            </div>

            <div className="cookie-settings-categories">
                {Object.values(COOKIE_CATEGORIES).map(category => (
                    <div key={category.id} className="cookie-settings-category">
                        <div className="cookie-settings-category-row">
                            <div className="cookie-settings-category-info">
                                <span className="cookie-settings-category-name">{category.name}</span>
                                {category.required && (
                                    <span className="cookie-consent-badge cookie-consent-badge--required">Always On</span>
                                )}
                            </div>
                            <label className="cookie-consent-toggle">
                                <input
                                    type="checkbox"
                                    checked={preferences[category.id]}
                                    onChange={() => togglePreference(category.id)}
                                    disabled={category.required}
                                />
                                <span className="cookie-consent-toggle-slider" />
                            </label>
                        </div>
                        <p className="cookie-settings-category-description">{category.description}</p>
                    </div>
                ))}
            </div>

            <div className="cookie-settings-actions">
                <button
                    className="cookie-consent-btn cookie-consent-btn--primary"
                    onClick={handleSave}
                >
                    {saved ? (
                        <>
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="20 6 9 17 4 12"/>
                            </svg>
                            Saved
                        </>
                    ) : (
                        <>
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                                <polyline points="17 21 17 13 7 13 7 21"/>
                                <polyline points="7 3 7 8 15 8"/>
                            </svg>
                            Save Changes
                        </>
                    )}
                </button>
            </div>

            <div className="cookie-settings-footer">
                <a
                    href="https://quox.ai/privacy"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="cookie-consent-link"
                >
                    View Privacy Policy
                </a>
            </div>
        </div>
    );
}

export default CookieConsentBanner;
