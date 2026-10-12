/**
 * Data Retention Settings Component
 * Security Issue #73: No data retention policy or automatic cleanup
 *
 * Allows users to view and configure their personal data retention preferences.
 */

import React, { useState, useEffect, useCallback } from 'react';
import Button from '../ui/Button';
import { csrfFetch } from '../../utils/csrfFetch';
import { buildAuthApiUrl } from '../../services/authApiUrl';

export default function DataRetentionSettings({ showNotification: showNotificationProp }) {
    const [preferences, setPreferences] = useState(null);
    const [minRetentionDays, setMinRetentionDays] = useState(7);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [notification, setNotification] = useState(null);

    // Use prop if provided, otherwise use local notification state
    const showNotification = useCallback((message, type = 'info') => {
        if (showNotificationProp) {
            showNotificationProp(message, type);
        } else {
            setNotification({ message, type });
            setTimeout(() => setNotification(null), 3000);
        }
    }, [showNotificationProp]);

    // Form state
    const [personalDataDays, setPersonalDataDays] = useState('');
    const [sessionHistoryDays, setSessionHistoryDays] = useState('');
    const [auditEventsDays, setAuditEventsDays] = useState('');

    // Fetch user retention preferences
    useEffect(() => {
        fetchPreferences();
    }, []);

    async function fetchPreferences() {
        try {
            setLoading(true);
            const response = await fetch(buildAuthApiUrl('/users/me/retention'), {
                credentials: 'include'
            });

            if (!response.ok) {
                throw new Error('Failed to load retention preferences');
            }

            const data = await response.json();
            setPreferences(data.preferences);
            setMinRetentionDays(data.minRetentionDays || 7);

            // Initialize form state
            setPersonalDataDays(data.preferences.personal_data_days || '');
            setSessionHistoryDays(data.preferences.session_history_days || '');
            setAuditEventsDays(data.preferences.audit_events_days || '');
        } catch (err) {
            console.error('Error fetching retention preferences:', err);
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }

    async function handleSave() {
        try {
            setSaving(true);
            const response = await csrfFetch(buildAuthApiUrl('/users/me/retention'), {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    personal_data_days: personalDataDays ? parseInt(personalDataDays, 10) : null,
                    session_history_days: sessionHistoryDays ? parseInt(sessionHistoryDays, 10) : null,
                    audit_events_days: auditEventsDays ? parseInt(auditEventsDays, 10) : null
                })
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Failed to save preferences');
            }

            const data = await response.json();
            setPreferences(data.preferences);
            showNotification('Retention preferences saved', 'success');
        } catch (err) {
            console.error('Error saving retention preferences:', err);
            showNotification(err.message, 'error');
        } finally {
            setSaving(false);
        }
    }

    async function requestDeletion(dataTypes) {
        try {
            const response = await csrfFetch(buildAuthApiUrl('/users/me/retention/request-deletion'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ dataTypes })
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Failed to request deletion');
            }

            const data = await response.json();
            showNotification(data.message, 'success');
            fetchPreferences(); // Refresh to show pending deletions
        } catch (err) {
            console.error('Error requesting deletion:', err);
            showNotification(err.message, 'error');
        }
    }

    if (loading) {
        return (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--ui-text-muted)' }}>
                Loading retention settings...
            </div>
        );
    }

    if (error) {
        return (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--ui-red)' }}>
                {error}
                <br />
                <Button variant="ghost" onClick={fetchPreferences} style={{ marginTop: '12px' }}>
                    Retry
                </Button>
            </div>
        );
    }

    const hasPendingDeletions = preferences?.pending_deletions_json &&
        JSON.parse(preferences.pending_deletions_json || '[]').length > 0;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {/* Introduction */}
            <div>
                <p style={{ color: 'var(--ui-text-secondary)', fontSize: '14px', lineHeight: '1.6', margin: 0 }}>
                    Control how long your personal data is retained. You can request shorter retention periods
                    than the system default. Data older than your specified retention period will be automatically
                    deleted during scheduled cleanup cycles.
                </p>
            </div>

            {/* Pending Deletions Warning */}
            {hasPendingDeletions && (
                <div style={{
                    background: 'var(--ui-warning-bg, rgba(251, 191, 36, 0.1))',
                    border: '1px solid var(--ui-warning-border, rgba(251, 191, 36, 0.3))',
                    borderRadius: '8px',
                    padding: '16px'
                }}>
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        marginBottom: '8px',
                        color: 'var(--ui-warning, #fbbf24)',
                        fontWeight: 600
                    }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        Pending Data Deletion
                    </div>
                    <p style={{ margin: 0, color: 'var(--ui-text-secondary)', fontSize: '13px' }}>
                        You have requested deletion of some data types. This will be processed during the next
                        scheduled cleanup cycle.
                    </p>
                </div>
            )}

            {/* Retention Period Settings */}
            <div style={{
                background: 'var(--glass-bg)',
                borderRadius: '12px',
                padding: '20px',
                border: '1px solid var(--glass-border)'
            }}>
                <h4 style={{
                    margin: '0 0 16px 0',
                    color: 'var(--ui-text-primary)',
                    fontSize: '15px',
                    fontWeight: 600
                }}>
                    Retention Periods
                </h4>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    {/* Personal Data */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                        <label style={{
                            flex: '1 1 200px',
                            color: 'var(--ui-text-primary)',
                            fontSize: '14px'
                        }}>
                            Personal Data
                            <span style={{ display: 'block', color: 'var(--ui-text-muted)', fontSize: '12px' }}>
                                Profile information, preferences
                            </span>
                        </label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <input
                                type="number"
                                value={personalDataDays}
                                onChange={(e) => setPersonalDataDays(e.target.value)}
                                min={minRetentionDays}
                                placeholder="Default"
                                style={{
                                    width: '100px',
                                    padding: '8px 12px',
                                    borderRadius: '6px',
                                    border: '1px solid var(--glass-border)',
                                    background: 'var(--ui-bg-secondary)',
                                    color: 'var(--ui-text-primary)',
                                    fontSize: '14px'
                                }}
                            />
                            <span style={{ color: 'var(--ui-text-muted)', fontSize: '13px' }}>days</span>
                        </div>
                    </div>

                    {/* Session History */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                        <label style={{
                            flex: '1 1 200px',
                            color: 'var(--ui-text-primary)',
                            fontSize: '14px'
                        }}>
                            Session History
                            <span style={{ display: 'block', color: 'var(--ui-text-muted)', fontSize: '12px' }}>
                                Login sessions, device history
                            </span>
                        </label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <input
                                type="number"
                                value={sessionHistoryDays}
                                onChange={(e) => setSessionHistoryDays(e.target.value)}
                                min={minRetentionDays}
                                placeholder="Default"
                                style={{
                                    width: '100px',
                                    padding: '8px 12px',
                                    borderRadius: '6px',
                                    border: '1px solid var(--glass-border)',
                                    background: 'var(--ui-bg-secondary)',
                                    color: 'var(--ui-text-primary)',
                                    fontSize: '14px'
                                }}
                            />
                            <span style={{ color: 'var(--ui-text-muted)', fontSize: '13px' }}>days</span>
                        </div>
                    </div>

                    {/* Audit Events */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                        <label style={{
                            flex: '1 1 200px',
                            color: 'var(--ui-text-primary)',
                            fontSize: '14px'
                        }}>
                            Activity Log
                            <span style={{ display: 'block', color: 'var(--ui-text-muted)', fontSize: '12px' }}>
                                Actions and audit events
                            </span>
                        </label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <input
                                type="number"
                                value={auditEventsDays}
                                onChange={(e) => setAuditEventsDays(e.target.value)}
                                min={minRetentionDays}
                                placeholder="Default"
                                style={{
                                    width: '100px',
                                    padding: '8px 12px',
                                    borderRadius: '6px',
                                    border: '1px solid var(--glass-border)',
                                    background: 'var(--ui-bg-secondary)',
                                    color: 'var(--ui-text-primary)',
                                    fontSize: '14px'
                                }}
                            />
                            <span style={{ color: 'var(--ui-text-muted)', fontSize: '13px' }}>days</span>
                        </div>
                    </div>
                </div>

                <div style={{
                    marginTop: '16px',
                    paddingTop: '16px',
                    borderTop: '1px solid var(--glass-border)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '12px'
                }}>
                    <span style={{ color: 'var(--ui-text-muted)', fontSize: '12px' }}>
                        Minimum: {minRetentionDays} days. Leave blank to use system defaults.
                    </span>
                    <Button
                        variant="primary"
                        onClick={handleSave}
                        disabled={saving}
                    >
                        {saving ? 'Saving...' : 'Save Preferences'}
                    </Button>
                </div>
            </div>

            {/* Immediate Deletion Requests */}
            <div style={{
                background: 'var(--glass-bg)',
                borderRadius: '12px',
                padding: '20px',
                border: '1px solid var(--glass-border)'
            }}>
                <h4 style={{
                    margin: '0 0 16px 0',
                    color: 'var(--ui-text-primary)',
                    fontSize: '15px',
                    fontWeight: 600
                }}>
                    Request Data Deletion
                </h4>

                <p style={{
                    color: 'var(--ui-text-secondary)',
                    fontSize: '13px',
                    margin: '0 0 16px 0'
                }}>
                    Request immediate deletion of specific data types. Deletions are processed during
                    the next scheduled cleanup cycle (typically daily).
                </p>

                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                    <Button
                        variant="outline"
                        onClick={() => requestDeletion(['session_history'])}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '6px' }}>
                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                            <polyline points="16,17 21,12 16,7" />
                            <line x1="21" y1="12" x2="9" y2="12" />
                        </svg>
                        Delete Session History
                    </Button>
                    <Button
                        variant="outline"
                        onClick={() => requestDeletion(['audit_events'])}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '6px' }}>
                            <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        Delete Activity Log
                    </Button>
                </div>
            </div>

            {/* Info Box */}
            <div style={{
                background: 'rgba(59, 130, 246, 0.1)',
                border: '1px solid rgba(59, 130, 246, 0.2)',
                borderRadius: '8px',
                padding: '16px'
            }}>
                <div style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '12px'
                }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ui-blue)" strokeWidth="2" style={{ flexShrink: 0, marginTop: '2px' }}>
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                    </svg>
                    <div>
                        <h5 style={{ margin: '0 0 4px 0', color: 'var(--ui-blue)', fontSize: '14px' }}>
                            About Data Retention
                        </h5>
                        <p style={{ margin: 0, color: 'var(--ui-text-secondary)', fontSize: '13px', lineHeight: '1.5' }}>
                            Data retention helps protect your privacy by automatically removing old data.
                            Your organization may have minimum retention requirements for compliance.
                            You can set shorter retention periods, but not longer than your organization allows.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
