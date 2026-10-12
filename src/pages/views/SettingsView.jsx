/**
 * SettingsView - Unified Settings with Professional Sidebar Layout
 *
 * Features:
 * - Sidebar navigation for sections
 * - Glass-morphism card styling
 * - Integrations Vault for secure credential storage
 * - Responsive design (mobile-first)
 */

import { useState, useEffect, useCallback } from 'react';
import { useOutletContext, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { csrfFetch } from '../../utils/csrfFetch';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { ServiceStatus, CustomServicesPanel, AlertRulesPanel, CoreCommsSettings } from '../../components/settings';
import SettingsLayout from '../../components/settings/SettingsLayout';
import SettingsSection from '../../components/settings/SettingsSection';
import SettingsCard, { SettingsGroup, SettingsCardGroup } from '../../components/settings/SettingsCard';
import CoreIntegrations from '../../components/settings/CoreIntegrations';
import PluginsSettingsLink from '../../components/settings/PluginsSettingsLink';
import VoiceSettings from '../../components/settings/VoiceSettings';
import { IntegrationsVault } from '../../components/integrations';
import { RouterSettings } from '../../components/router';
import { CookieSettingsPanel } from '../../components/privacy';
import DataRetentionSettings from '../../components/settings/DataRetentionSettings';
import PrivacySettings from '../../components/settings/PrivacySettings';
import PlatformFlagsPanel from '../../components/settings/PlatformFlagsPanel';
import EnforcementPanel from '../../components/settings/EnforcementPanel';
import { isTelemetryEnabled, setTelemetryEnabled, buildPayload } from '../../services/heartbeatService';
import AssistantSettings from '../../components/settings/AssistantSettings';
import DashboardSettings from '../../components/settings/DashboardSettings';
import ExecutionPolicySettings from '../../components/settings/ExecutionPolicySettings';
import BackupSettings from '../../components/settings/BackupSettings';
// LICENSE-LAUNCH LL-7 local-inference strip: Local Inference is a PREMIUM
// settings section now. This V1 view keeps the section (the sidebar row, the
// #local-inference hash, the VALID_SECTIONS entry) and resolves its content
// LATE through the capability-panel registry — the real panel when the signed
// local-inference bundle is active, the locked upsell slot otherwise. Restoring
// the static import here un-strips a paid plugin back into dist/assets.
import { CapabilityPanelSlot } from '../../config/capabilityPanelRegistry';
import QuoxMindSettings from '../../components/settings/QuoxMindSettings';
import AppearanceSettings from '../../components/settings/AppearanceSettings';
import SettingsChatSidebar from '../../components/settings/SettingsChatSidebar';
import { SettingItem, Input, FormField } from '../../components/ui/Input';
import Button from '../../components/ui/Button';
import { getFileStorageSettings, setFileStorageSettings } from '../../services/fileStorage';
import { forceRepopulateDummyData } from '../../services/dummyData';
import { useUISettings } from '../../services/uiSettings';
import { getLicenseStatus, getTierDisplayName } from '../../services/pluginClient';
import { getLicenseStatus as getLocalLicenseStatus } from '../../services/licenseValidator';
import { getAllPluginManifests } from '../../config/plugins';
import { queueSync } from '../../services/serverSyncQueue';
import { useLlmRoutingPolicy } from '../../hooks/useLlmRoutingPolicy';
import { useLlmCapabilityPreferences } from '../../hooks/useLlmCapabilityPreferences';
import voltBridge from '../../lib/volt/volt-bridge';
import '../../components/settings/settings.css';
import '../../components/ui/ui.css';
import './views.css';

// Validation helpers
const validateIP = (ip) => {
    if (!ip) return { valid: false, message: 'IP address is required' };
    const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    if (!ipRegex.test(ip)) return { valid: false, message: 'Invalid IP address format' };
    return { valid: true };
};

const validateHostname = (hostname) => {
    if (!hostname) return { valid: false, message: 'Hostname is required' };
    if (hostname.length < 1 || hostname.length > 63) return { valid: false, message: 'Hostname must be 1-63 characters' };
    const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
    if (!hostnameRegex.test(hostname)) return { valid: false, message: 'Invalid hostname format' };
    return { valid: true };
};

const validateUsername = (username) => {
    if (!username) return { valid: false, message: 'Username is required' };
    if (username.length < 1 || username.length > 32) return { valid: false, message: 'Username must be 1-32 characters' };
    const usernameRegex = /^[a-z_][a-z0-9_-]*$/;
    if (!usernameRegex.test(username)) return { valid: false, message: 'Invalid username format (lowercase, no spaces)' };
    return { valid: true };
};

/**
 * Collapsible viewer showing the exact telemetry payload
 */
function TelemetryPayloadViewer() {
    const [expanded, setExpanded] = useState(false);
    const [payload, setPayload] = useState(null);

    const handleToggle = () => {
        if (!expanded) {
            try {
                setPayload(buildPayload());
            } catch {
                setPayload({ error: 'Could not build payload' });
            }
        }
        setExpanded(!expanded);
    };

    return (
        <div>
            <Button variant="outline" onClick={handleToggle}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '8px' }}>
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                </svg>
                {expanded ? 'Hide payload' : 'View exact payload'}
            </Button>
            {expanded && payload && (
                <pre style={{
                    marginTop: '12px', padding: '14px', borderRadius: '8px',
                    background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)',
                    fontSize: '12px', color: 'var(--ui-text-secondary)', overflow: 'auto',
                    maxHeight: '300px', lineHeight: '1.5'
                }}>
                    {JSON.stringify(payload, null, 2)}
                </pre>
            )}
        </div>
    );
}

function SettingsView() {
    const { halState } = useOutletContext() || {};
    const navigate = useNavigate();
    const location = useLocation();
    const { user, logout, authFetch } = useAuth();
    const { currentOrg } = useWorkspace();
    const [uiSettings, updateUISetting] = useUISettings();
    const llmRoutingPolicy = useLlmRoutingPolicy(authFetch, currentOrg?.id);
    const llmCapabilityPreferences = useLlmCapabilityPreferences(authFetch, currentOrg?.id);

    // All valid section IDs (must match SettingsSidebar DEFAULT_SECTIONS)
    const VALID_SECTIONS = ['core', 'general', 'appearance', 'dashboard', 'voice', 'files', 'assistants', 'execution-policy', 'quoxmind', 'router', 'local-inference', 'infrastructure', 'vault', 'backup', 'plugins', 'notifications', 'services', 'account', 'privacy', 'telemetry', 'docs'];

    // Get initial section from: location.state > hash > default
    const getInitialSection = () => {
        // Support navigate('/settings', { state: { section: 'plugins' } })
        if (location.state?.section && VALID_SECTIONS.includes(location.state.section)) {
            return location.state.section;
        }
        const hash = location.hash.replace('#', '');
        return VALID_SECTIONS.includes(hash) ? hash : 'core';
    };

    const [activeSection, setActiveSection] = useState(getInitialSection);
    const [highlightPlugin, setHighlightPlugin] = useState(location.state?.highlight || null);
    const [saveStatus, setSaveStatus] = useState(null);
    const [validationErrors, setValidationErrors] = useState({});
    const [notification, setNotification] = useState(null);

    const [settings, setSettings] = useState({
        theme: 'dark',
        notifications: true,
        sounds: true,
        autoSave: true,
        showThinking: false,
        useStreaming: true,
        jumpHost: {
            enabled: false,
            hostname: 'bastion01',
            ip: '',
            user: 'control'
        },
        monitoring: {
            prometheus: { url: 'http://localhost:9090', enabled: false },
            grafana: { url: 'http://localhost:3000', enabled: false },
            uptimeKuma: { url: 'http://localhost:3001', enabled: false }
        }
    });

    const [fileSettings, setFileSettings] = useState(() => getFileStorageSettings());

    // Account deletion state (Security Issue #57 - GDPR Art. 17)
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [deletePassword, setDeletePassword] = useState('');
    const [deleteImmediate, setDeleteImmediate] = useState(false);
    const [deleteLoading, setDeleteLoading] = useState(false);
    const [deleteError, setDeleteError] = useState(null);
    const [deletionStatus, setDeletionStatus] = useState(null);

    // QuoxCORE platform hero bar state
    const [platformStatus, setPlatformStatus] = useState({ licensed: false, days_remaining: 0, tiers: ['free'] });
    const [activePluginCount, setActivePluginCount] = useState(0);
    const [platformVersion, setPlatformVersion] = useState('');
    const [chatSidebarOpen, setChatSidebarOpen] = useState(true);

    useEffect(() => {
        let cancelled = false;
        async function loadPlatformInfo() {
            try {
                const license = await getLicenseStatus();
                if (!cancelled) {
                    setPlatformStatus(license);
                }
            } catch {
                // Fall back to local license
                const local = getLocalLicenseStatus();
                if (!cancelled) setPlatformStatus(local);
            }
            try {
                const manifests = getAllPluginManifests();
                const coreManifest = manifests.find(m => m.name === 'QuoxCORE');
                if (!cancelled) {
                    setActivePluginCount(manifests.length);
                    if (coreManifest?.version) setPlatformVersion(coreManifest.version);
                }
            } catch { /* ignore */ }
        }
        loadPlatformInfo();
        return () => { cancelled = true; };
    }, []);

    // Update URL hash when section changes
    const handleSectionChange = useCallback((section) => {
        setActiveSection(section);
        setHighlightPlugin(null);
        navigate({ pathname: location.pathname, hash: `#${section}` }, { replace: true });
    }, [navigate, location.pathname]);

    // Sync section from location hash changes (e.g. /settings#execution-policy)
    useEffect(() => {
        const hashSection = location.hash.replace('#', '');
        if (VALID_SECTIONS.includes(hashSection)) {
            setActiveSection(hashSection);
        }
    }, [location.hash]);

    // Sync section from state on navigation (e.g. navigate('/settings', { state: { section: 'plugins' } }))
    useEffect(() => {
        if (location.state?.section && VALID_SECTIONS.includes(location.state.section)) {
            setActiveSection(location.state.section);
            if (location.state.highlight) setHighlightPlugin(location.state.highlight);
            navigate(
                { pathname: location.pathname, hash: `#${location.state.section}` },
                { replace: true, state: null }
            );
        }
    }, [location.state, location.pathname, navigate]);

    // Load settings from localStorage
    useEffect(() => {
        const saved = localStorage.getItem('quox-settings');
        if (saved) {
            setSettings(prev => ({ ...prev, ...JSON.parse(saved) }));
        }
    }, []);

    // Show notification helper
    const showNotification = useCallback((message, type = 'info') => {
        setNotification({ message, type });
        setTimeout(() => setNotification(null), 4000);
    }, []);

    // Update file storage settings
    const updateFileSettings = (key, value) => {
        const newSettings = { ...fileSettings, [key]: value };
        setFileSettings(newSettings);
        setFileStorageSettings(newSettings);
        showNotification('File settings saved', 'success');
    };

    // Clear save status after delay
    useEffect(() => {
        if (saveStatus === 'saved') {
            const timer = setTimeout(() => setSaveStatus(null), 2000);
            return () => clearTimeout(timer);
        }
    }, [saveStatus]);

    const updateSetting = (key, value) => {
        const newSettings = { ...settings, [key]: value };
        setSettings(newSettings);
        setSaveStatus('saving');
        try {
            localStorage.setItem('quox-settings', JSON.stringify(newSettings));
            queueSync('settings', newSettings);
            setSaveStatus('saved');
        } catch (err) {
            console.error('Failed to save settings:', err);
            setSaveStatus('error');
        }
    };

    // Validate jump host settings
    const validateJumpHost = useCallback((jumpHost) => {
        const errors = {};
        if (jumpHost.enabled) {
            const hostnameCheck = validateHostname(jumpHost.hostname);
            if (!hostnameCheck.valid) errors.hostname = hostnameCheck.message;

            const ipCheck = validateIP(jumpHost.ip);
            if (!ipCheck.valid) errors.ip = ipCheck.message;

            const userCheck = validateUsername(jumpHost.user);
            if (!userCheck.valid) errors.user = userCheck.message;
        }
        return errors;
    }, []);

    const updateJumpHostSetting = (field, value) => {
        const newJumpHost = { ...settings.jumpHost, [field]: value };
        const errors = validateJumpHost(newJumpHost);
        setValidationErrors(prev => ({ ...prev, jumpHost: errors }));

        if (Object.keys(errors).length === 0 || field === 'enabled') {
            updateSetting('jumpHost', newJumpHost);
        } else {
            setSettings(prev => ({ ...prev, jumpHost: newJumpHost }));
        }
    };

    const handleLogout = useCallback(async () => {
        await logout();
        navigate('/login', { replace: true });
    }, [logout, navigate]);

    // Account deletion handlers (Security Issue #57 - GDPR Art. 17)
    const checkDeletionStatus = useCallback(async () => {
        try {
            const response = await fetch('/api/auth/me/deletion-status', {
                credentials: 'include'
            });
            if (response.ok) {
                const data = await response.json();
                setDeletionStatus(data);
            }
        } catch (err) {
            console.error('Failed to check deletion status:', err);
        }
    }, []);

    // Check deletion status on mount
    useEffect(() => {
        if (user) {
            checkDeletionStatus();
        }
    }, [user, checkDeletionStatus]);

    const handleDeleteAccount = useCallback(async () => {
        if (!deletePassword) {
            setDeleteError('Please enter your password to confirm');
            return;
        }

        setDeleteLoading(true);
        setDeleteError(null);

        try {
            const response = await csrfFetch('/api/auth/me', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    password: deletePassword,
                    immediate: deleteImmediate
                })
            });

            const data = await response.json();

            if (!response.ok) {
                if (response.status === 400 && data.error === 'org_owner') {
                    setDeleteError(`You must transfer ownership of these organizations first: ${data.owned_orgs.map(o => o.name).join(', ')}`);
                } else {
                    setDeleteError(data.message || 'Failed to delete account');
                }
                return;
            }

            if (deleteImmediate) {
                // Account deleted immediately - redirect to login
                showNotification('Your account has been deleted.', 'success');
                navigate('/login', { replace: true });
            } else {
                // Account scheduled for deletion
                setShowDeleteModal(false);
                setDeletePassword('');
                showNotification(`Account scheduled for deletion on ${new Date(data.deletion_date).toLocaleDateString()}. You can cancel this within 14 days.`, 'warning');
                checkDeletionStatus();
            }
        } catch (err) {
            console.error('Delete account error:', err);
            setDeleteError('Network error - please try again');
        } finally {
            setDeleteLoading(false);
        }
    }, [deletePassword, deleteImmediate, navigate, showNotification, checkDeletionStatus]);

    const handleCancelDeletion = useCallback(async () => {
        try {
            const response = await csrfFetch('/api/auth/me/cancel-deletion', {
                method: 'POST'
            });

            if (response.ok) {
                showNotification('Account deletion cancelled.', 'success');
                setDeletionStatus(null);
            } else {
                const data = await response.json();
                showNotification(data.message || 'Failed to cancel deletion', 'error');
            }
        } catch (err) {
            console.error('Cancel deletion error:', err);
            showNotification('Network error - please try again', 'error');
        }
    }, [showNotification]);

    const jumpHostErrors = validationErrors.jumpHost || {};

    // Render-time redirect to canonical /assistants page so the legacy panel never mounts.
    // Catches both #assistants (v1) and #account/assistants (v2) hashes plus
    // navigate('/settings', { state: { section: 'assistants' } }) calls.
    {
        const hashSection = location.hash.replace('#', '');
        const stateSection = location.state?.section;
        if (hashSection === 'assistants' || hashSection === 'account/assistants' || stateSection === 'assistants') {
            const forwardState = location.state ? { ...location.state, section: undefined } : null;
            return <Navigate to="/assistants" replace state={forwardState} />;
        }
    }

    return (
        <div className="settings-page settings-page--row" role="main" aria-label="Settings">
            <style>{`
                .app-shell__content:has(.settings-page) {
                    padding: 0;
                    overflow: hidden;
                }
                .app-shell__content:has(.settings-page) .breadcrumbs {
                    display: none;
                }
                .settings-page {
                    display: flex;
                    flex-direction: column;
                    gap: 16px;
                    height: 100%;
                    min-height: 0;
                    overflow: hidden;
                }
                .settings-page--row {
                    flex-direction: row;
                    gap: 16px;
                }
                .settings-page__main-col {
                    flex: 1;
                    min-width: 0;
                    min-height: 0;
                    display: flex;
                    flex-direction: column;
                    gap: 16px;
                    overflow: hidden;
                }
                .settings-page__chat-col {
                    width: 360px;
                    flex-shrink: 0;
                    display: flex;
                    flex-direction: column;
                    position: relative;
                    isolation: isolate;
                    min-height: 0;
                    background: var(--m-bg-base, rgba(255,255,255,0.08));
                    border: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
                    border-radius: var(--qx-radius, 20px);
                    box-shadow:
                        inset 0 1px 0 rgba(255,255,255,0.18),
                        inset 0 -1px 0 rgba(0,0,0,0.45);
                    overflow: hidden;
                }
                .settings-page__chat-col::before {
                    content: '';
                    position: absolute;
                    inset: 0;
                    z-index: -1;
                    border-radius: inherit;
                    pointer-events: none;
                    background: var(--qx-edges);
                    backdrop-filter: var(--qx-blur);
                    -webkit-backdrop-filter: var(--qx-blur);
                }
                .settings-page__chat-close {
                    position: absolute;
                    top: 12px;
                    right: 12px;
                    z-index: 20;
                    width: 26px;
                    height: 26px;
                    border-radius: 8px;
                    background: rgba(255, 255, 255, 0.07);
                    border: 1px solid rgba(255,255,255,0.22);
                    color: #fff;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 11px;
                    box-shadow:
                        inset 0 1px 0 rgba(255,255,255,0.22),
                        0 2px 8px rgba(0,0,0,0.35);
                    transition: background 0.15s, border-color 0.15s;
                }
                .settings-page__chat-close:hover {
                    background: rgba(32, 36, 52, 0.94);
                    border-color: rgba(255,255,255,0.35);
                }
                .settings-page__chat-reopen {
                    position: fixed;
                    right: 20px;
                    bottom: 20px;
                    z-index: 50;
                    padding: 10px 14px;
                    border-radius: 12px;
                    background: rgba(56, 189, 248, 0.18);
                    border: 1px solid rgba(56, 189, 248, 0.48);
                    color: #fff;
                    font-size: 12px;
                    font-weight: 600;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    box-shadow: 0 6px 24px rgba(0,0,0,0.4);
                }

                /* ───── Platform Status Bar ───── */
                .settings-platform-bar {
                    display: flex;
                    align-items: center;
                    gap: 14px;
                    padding: 12px 18px;
                    flex-shrink: 0;
                    flex-wrap: wrap;
                    position: relative;
                    isolation: isolate;
                    background: var(--m-bg-base, rgba(255,255,255,0.08));
                    border: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
                    border-radius: var(--qx-radius, 20px);
                    box-shadow:
                        inset 0 1px 0 rgba(255,255,255,0.18),
                        inset 0 -1px 0 rgba(0,0,0,0.45);
                }
                .settings-platform-bar::before {
                    content: '';
                    position: absolute;
                    inset: 0;
                    z-index: -1;
                    border-radius: inherit;
                    pointer-events: none;
                    background: var(--qx-edges);
                    backdrop-filter: var(--qx-blur);
                    -webkit-backdrop-filter: var(--qx-blur);
                }
                .settings-platform-bar__icon {
                    width: 36px;
                    height: 36px;
                    border-radius: 10px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                    background: linear-gradient(145deg, rgba(168,85,247,0.18), rgba(56,189,248,0.08));
                    border: 1px solid rgba(168,85,247,0.4);
                    color: #fff;
                    box-shadow: inset 0 1px 0 rgba(255,255,255,0.18);
                }
                .settings-platform-bar__icon svg { width: 20px; height: 20px; }
                .settings-platform-bar__title-block {
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                    min-width: 140px;
                }
                .settings-platform-bar__title {
                    font-size: 12px;
                    font-weight: 700;
                    color: #fff;
                    letter-spacing: 0.1em;
                    text-transform: uppercase;
                    font-family: 'JetBrains Mono', 'SF Mono', monospace;
                }
                .settings-platform-bar__version {
                    font-size: 10px;
                    color: rgba(255, 255, 255, 0.55);
                    font-family: 'JetBrains Mono', 'SF Mono', monospace;
                    letter-spacing: 0.05em;
                }
                .settings-platform-bar__divider {
                    width: 1px;
                    height: 28px;
                    background: rgba(255, 255, 255, 0.12);
                    flex-shrink: 0;
                }
                .settings-platform-bar__pill {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    padding: 5px 12px;
                    border-radius: 999px;
                    font-size: 11px;
                    font-weight: 600;
                    font-family: 'JetBrains Mono', 'SF Mono', monospace;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    flex-shrink: 0;
                }
                .settings-platform-bar__pill--licensed {
                    background: rgba(48, 255, 144, 0.14);
                    border: 1px solid rgba(48, 255, 144, 0.4);
                    color: #30ff90;
                }
                .settings-platform-bar__pill--unlicensed {
                    background: rgba(245, 158, 11, 0.14);
                    border: 1px solid rgba(245, 158, 11, 0.4);
                    color: #f59e0b;
                }
                .settings-platform-bar__pill-dot {
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    background: currentColor;
                    box-shadow: 0 0 6px currentColor;
                    flex-shrink: 0;
                }
                .settings-platform-bar__count {
                    font-size: 11px;
                    color: rgba(255, 255, 255, 0.65);
                    font-family: 'JetBrains Mono', 'SF Mono', monospace;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                }
                .settings-platform-bar__spacer { flex: 1; }
                .settings-platform-bar__actions {
                    display: flex;
                    gap: 8px;
                    flex-shrink: 0;
                }
                .settings-platform-bar__btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    padding: 7px 14px;
                    border-radius: 8px;
                    border: 1px solid rgba(255, 255, 255, 0.18);
                    background: rgba(255, 255, 255, 0.05);
                    color: #fff;
                    font-size: 11px;
                    font-weight: 600;
                    font-family: 'JetBrains Mono', 'SF Mono', monospace;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    cursor: pointer;
                    transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
                    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14);
                }
                .settings-platform-bar__btn:hover {
                    background: rgba(32, 36, 52, 0.78);
                    border-color: rgba(255, 255, 255, 0.32);
                    transform: translateY(-1px);
                }
                .settings-platform-bar__btn svg { width: 14px; height: 14px; }
                .settings-platform-bar__btn--license {
                    border-color: rgba(56, 189, 248, 0.4);
                    color: #38bdf8;
                }
                .settings-platform-bar__btn--license:hover {
                    border-color: rgba(56, 189, 248, 0.6);
                    background: rgba(56, 189, 248, 0.12);
                }
                .settings-platform-bar__btn--trial {
                    border-color: rgba(48, 255, 144, 0.4);
                    color: #30ff90;
                }
                .settings-platform-bar__btn--trial:hover {
                    border-color: rgba(48, 255, 144, 0.6);
                    background: rgba(48, 255, 144, 0.12);
                }

                /* ───── Reusable info boxes inside cards ───── */
                .settings-info-box {
                    padding: 12px 14px;
                    background: rgba(56, 189, 248, 0.06);
                    border: 1px solid rgba(56, 189, 248, 0.22);
                    border-radius: 10px;
                    margin-top: 10px;
                    font-size: 12px;
                    color: rgba(255, 255, 255, 0.85);
                    line-height: 1.5;
                }
                .settings-info-box--purple {
                    background: rgba(168, 85, 247, 0.06);
                    border-color: rgba(168, 85, 247, 0.22);
                }
                .settings-info-box--green {
                    background: rgba(48, 255, 144, 0.06);
                    border-color: rgba(48, 255, 144, 0.22);
                }
                .settings-info-box--neutral {
                    background: rgba(255, 255, 255, 0.04);
                    border-color: rgba(255, 255, 255, 0.14);
                }
                .settings-info-box strong {
                    display: block;
                    font-weight: 700;
                    color: #fff;
                    font-size: 11px;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    margin-bottom: 6px;
                    font-family: 'JetBrains Mono', 'SF Mono', monospace;
                }
                .settings-info-box ul {
                    margin: 6px 0 0;
                    padding-left: 18px;
                    color: rgba(255, 255, 255, 0.78);
                }
                .settings-info-box ul li { margin: 2px 0; }
                .settings-info-box p {
                    margin: 6px 0 0;
                    color: rgba(255, 255, 255, 0.78);
                }
            `}</style>
            {/* Save Status Indicator */}
            {saveStatus && (
                <div
                    className={`settings-save-status settings-save-status--${saveStatus}`}
                    role="status"
                    aria-live="polite"
                    style={{
                        position: 'fixed',
                        top: '80px',
                        right: '24px',
                        zIndex: 1000
                    }}
                >
                    {saveStatus === 'saving' && (
                        <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
                                <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20" />
                            </svg>
                            Saving...
                        </>
                    )}
                    {saveStatus === 'saved' && (
                        <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="20 6 9 17 4 12" />
                            </svg>
                            Settings saved
                        </>
                    )}
                    {saveStatus === 'error' && (
                        <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                            </svg>
                            Failed to save settings
                        </>
                    )}
                </div>
            )}

            {/* Notification Toast */}
            {notification && (
                <div
                    className={`ui-alert ui-alert-${notification.type}`}
                    role="status"
                    aria-live="polite"
                    style={{
                        position: 'fixed',
                        bottom: '24px',
                        right: '24px',
                        zIndex: 1000,
                        maxWidth: '400px',
                        animation: 'fadeInUp 0.3s ease-out'
                    }}
                >
                    {notification.message}
                </div>
            )}

            <div className="settings-page__main-col">
            {/* QuoxCORE Platform Status Bar */}
            <div className="settings-platform-bar">
                <div className="settings-platform-bar__icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2L2 7l10 5 10-5-10-5z" />
                        <path d="M2 17l10 5 10-5" />
                        <path d="M2 12l10 5 10-5" />
                    </svg>
                </div>

                <div className="settings-platform-bar__title-block">
                    <span className="settings-platform-bar__title">QuoxCORE Platform</span>
                    {platformVersion && (
                        <span className="settings-platform-bar__version">v{platformVersion}</span>
                    )}
                </div>

                <div className="settings-platform-bar__divider" />

                {platformStatus.licensed ? (
                    <span className="settings-platform-bar__pill settings-platform-bar__pill--licensed">
                        <span className="settings-platform-bar__pill-dot" />
                        Licensed{platformStatus.days_remaining > 0 ? ` \u00B7 ${platformStatus.days_remaining}d remaining` : ''}
                    </span>
                ) : (
                    <span className="settings-platform-bar__pill settings-platform-bar__pill--unlicensed">
                        <span className="settings-platform-bar__pill-dot" />
                        Unlicensed
                    </span>
                )}

                <div className="settings-platform-bar__divider" />

                <span className="settings-platform-bar__count">
                    {activePluginCount} plugin{activePluginCount !== 1 ? 's' : ''} registered
                </span>

                <div className="settings-platform-bar__spacer" />

                {!platformStatus.licensed && (
                    <div className="settings-platform-bar__actions">
                        <button
                            type="button"
                            className="settings-platform-bar__btn settings-platform-bar__btn--license"
                            onClick={() => handleSectionChange('plugins')}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
                            </svg>
                            Enter License Key
                        </button>
                        <button
                            type="button"
                            className="settings-platform-bar__btn settings-platform-bar__btn--trial"
                            onClick={() => handleSectionChange('plugins')}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                            </svg>
                            Free 30-Day Trial
                        </button>
                    </div>
                )}

                {platformStatus.licensed && (
                    <button
                        type="button"
                        className="settings-platform-bar__btn"
                        onClick={() => handleSectionChange('plugins')}
                    >
                        Manage Plugins
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="9 18 15 12 9 6" />
                        </svg>
                    </button>
                )}
            </div>

            <SettingsLayout
                activeSection={activeSection}
                onSectionChange={handleSectionChange}
            >
                {/* Core Integrations */}
                {activeSection === 'core' && (
                    <CoreIntegrations />
                )}

                {/* General Settings */}
                {activeSection === 'general' && (
                    <div>
                        <SettingsSection
                            title="Preferences"
                            description="Configure your general application preferences"
                        >
                            <SettingsCard glass>
                                <SettingsGroup>
                                    <SettingItem
                                        label="Enable Notifications"
                                        description="Receive alerts and updates"
                                        checked={settings.notifications}
                                        onChange={(e) => updateSetting('notifications', e.target.checked)}
                                    />
                                    <SettingItem
                                        label="Sound Effects"
                                        description="Play sounds for actions"
                                        checked={settings.sounds}
                                        onChange={(e) => updateSetting('sounds', e.target.checked)}
                                    />
                                    <SettingItem
                                        label="Show Thinking Process"
                                        description="Display AI reasoning steps"
                                        checked={settings.showThinking}
                                        onChange={(e) => updateSetting('showThinking', e.target.checked)}
                                    />
                                    <SettingItem
                                        label="Use Streaming Responses"
                                        description="Stream AI responses in real-time"
                                        checked={settings.useStreaming}
                                        onChange={(e) => updateSetting('useStreaming', e.target.checked)}
                                    />
                                </SettingsGroup>
                            </SettingsCard>
                        </SettingsSection>

                        <SettingsSection
                            title="Advanced Features"
                            description="Enable power-user features and technical details"
                        >
                            <SettingsCard glass>
                                <SettingsGroup>
                                    <SettingItem
                                        label="Advanced Mode"
                                        description="Show layer analytics, processing traces, and technical metrics. Recommended for developers and power users."
                                        checked={uiSettings.advancedMode}
                                        onChange={(e) => updateUISetting('advancedMode', e.target.checked)}
                                    />
                                    {uiSettings.advancedMode && (
                                        <div className="settings-info-box">
                                            <strong>Enabled features</strong>
                                            <ul>
                                                <li>Layer Insights tab in Activity view</li>
                                                <li>Processing layer visualization during chat</li>
                                                <li>Detailed timing and performance metrics</li>
                                                <li>AOCL trace export and analysis</li>
                                            </ul>
                                        </div>
                                    )}
                                    <SettingItem
                                        label="VOLT Audit Trail"
                                        description="Record hash-chained audit events for agent actions via the AEE bridge. View traces at /volt. Requires page reload to take effect."
                                        checked={settings.voltEnabled}
                                        onChange={(e) => updateSetting('voltEnabled', e.target.checked)}
                                    />
                                    {settings.voltEnabled && (
                                        <SettingItem
                                            label="VOLT Content Capture"
                                            description="Record full prompts, responses, and tool I/O alongside VOLT audit events. Increases storage usage. Requires VOLT Audit Trail to be enabled."
                                            checked={settings.voltContentCapture}
                                            onChange={(e) => {
                                                const enabled = e.target.checked;
                                                updateSetting('voltContentCapture', enabled);
                                                if (enabled) {
                                                    voltBridge.enableContentCapture();
                                                } else {
                                                    voltBridge.disableContentCapture();
                                                }
                                            }}
                                        />
                                    )}
                                </SettingsGroup>
                            </SettingsCard>
                        </SettingsSection>

                        <SettingsSection
                            title="Demo Memory Data"
                            description="Populate memory system with sample data for testing and demos"
                        >
                            <SettingsCard glass>
                                <SettingsGroup>
                                    <SettingItem
                                        label="Enable Demo Data"
                                        description="Add sample memories (preferences, facts, decisions, constraints, errors, reflections) for testing. All demo items are clearly marked and will be removed when disabled."
                                        checked={uiSettings.dummyDataEnabled}
                                        onChange={(e) => {
                                            updateUISetting('dummyDataEnabled', e.target.checked)
                                            if (e.target.checked) {
                                                showNotification('Demo data added to memory system', 'success')
                                            } else {
                                                showNotification('Demo data removed from memory system', 'success')
                                            }
                                        }}
                                    />
                                    {uiSettings.dummyDataEnabled && (
                                        <div className="settings-info-box settings-info-box--green">
                                            <strong>Demo data active</strong>
                                            <p>Sample memories are loaded into the system. These are marked and will be automatically removed when you disable this setting.</p>
                                            <Button
                                                variant="secondary"
                                                style={{ marginTop: '12px' }}
                                                onClick={() => {
                                                    forceRepopulateDummyData()
                                                    showNotification('Demo data repopulated', 'success')
                                                }}
                                            >
                                                Repopulate Demo Data
                                            </Button>
                                        </div>
                                    )}
                                    {!uiSettings.dummyDataEnabled && (
                                        <div className="settings-info-box settings-info-box--neutral">
                                            <strong>Demo data disabled</strong>
                                            <p>Enable to populate the memory system with useful sample data. Great for testing, demos, or exploring memory features.</p>
                                        </div>
                                    )}
                                </SettingsGroup>
                            </SettingsCard>
                        </SettingsSection>

                    </div>
                )}

                {/* Appearance Settings */}
                {activeSection === 'appearance' && (
                    <AppearanceSettings />
                )}

                {/* Dashboard Settings */}
                {activeSection === 'dashboard' && (
                    <DashboardSettings />
                )}

                {/* Voice Settings */}
                {activeSection === 'voice' && (
                    <VoiceSettings />
                )}

                {/* Files Settings */}
                {activeSection === 'files' && (
                    <div>
                        <SettingsSection
                            title="File Storage Limits"
                            description="Configure storage limits for uploaded files"
                        >
                            <SettingsCard glass>
                                <p style={{ color: 'var(--ui-text-muted)', fontSize: '13px', marginBottom: '16px' }}>
                                    Files are stored in your browser's localStorage. Since this is your server,
                                    you can adjust these limits as needed.
                                </p>
                                <SettingsGroup>
                                    <FormField label="Max File Size" htmlFor="max-file-size">
                                        <select
                                            id="max-file-size"
                                            className="ui-input ui-select"
                                            value={fileSettings.maxFileSize}
                                            onChange={(e) => updateFileSettings('maxFileSize', parseInt(e.target.value))}
                                        >
                                            <option value={5 * 1024 * 1024}>5 MB</option>
                                            <option value={10 * 1024 * 1024}>10 MB</option>
                                            <option value={25 * 1024 * 1024}>25 MB</option>
                                            <option value={50 * 1024 * 1024}>50 MB</option>
                                            <option value={100 * 1024 * 1024}>100 MB</option>
                                            <option value={250 * 1024 * 1024}>250 MB</option>
                                            <option value={500 * 1024 * 1024}>500 MB</option>
                                            <option value={1024 * 1024 * 1024}>1 GB</option>
                                            <option value={Number.MAX_SAFE_INTEGER}>Unlimited</option>
                                        </select>
                                    </FormField>

                                    <FormField label="Max Total Storage" htmlFor="max-total-size">
                                        <select
                                            id="max-total-size"
                                            className="ui-input ui-select"
                                            value={fileSettings.maxTotalSize}
                                            onChange={(e) => updateFileSettings('maxTotalSize', parseInt(e.target.value))}
                                        >
                                            <option value={100 * 1024 * 1024}>100 MB</option>
                                            <option value={250 * 1024 * 1024}>250 MB</option>
                                            <option value={500 * 1024 * 1024}>500 MB</option>
                                            <option value={1024 * 1024 * 1024}>1 GB</option>
                                            <option value={2 * 1024 * 1024 * 1024}>2 GB</option>
                                            <option value={5 * 1024 * 1024 * 1024}>5 GB</option>
                                            <option value={10 * 1024 * 1024 * 1024}>10 GB</option>
                                            <option value={Number.MAX_SAFE_INTEGER}>Unlimited</option>
                                        </select>
                                    </FormField>

                                    <SettingItem
                                        label="Enforce File Size Limit"
                                        description="Reject files larger than the max file size"
                                        checked={fileSettings.enforceFileSizeLimit}
                                        onChange={(e) => updateFileSettings('enforceFileSizeLimit', e.target.checked)}
                                    />

                                    <SettingItem
                                        label="Enforce Total Storage Limit"
                                        description="Reject uploads when storage is full"
                                        checked={fileSettings.enforceTotalSizeLimit}
                                        onChange={(e) => updateFileSettings('enforceTotalSizeLimit', e.target.checked)}
                                    />
                                </SettingsGroup>
                            </SettingsCard>
                        </SettingsSection>

                        {/* VAULT-INTEG P17: server-side generated-content
                            storage quotas (registry group 'storage') — a
                            different store than the browser localStorage
                            limits above, but the same "how much do we keep"
                            territory, so it lives on this tab too. */}
                        <SettingsSection
                            title="Generated Content Storage"
                            description="Server-side storage quotas for generated images and other produced content"
                        >
                            <PlatformFlagsPanel
                                group="storage"
                                title="Storage Flags"
                                onNotification={showNotification}
                                authFetch={authFetch}
                            />
                        </SettingsSection>
                    </div>
                )}

                {/* Assistants Configuration */}
                {activeSection === 'assistants' && (
                    <AssistantSettings
                        initialEditAgent={location.state?.editAgent || null}
                        initialEditTab={location.state?.editTab || null}
                    />
                )}

                {activeSection === 'execution-policy' && (
                    <ExecutionPolicySettings
                        authFetch={authFetch}
                        currentOrg={currentOrg}
                        policyPayload={llmRoutingPolicy}
                        refreshPolicy={llmRoutingPolicy.refresh}
                        preferencePayload={llmCapabilityPreferences}
                        refreshPreferences={llmCapabilityPreferences.refresh}
                        onNotification={showNotification}
                    />
                )}

                {/* QuoxMind Settings */}
                {activeSection === 'quoxmind' && (
                    <QuoxMindSettings />
                )}

                {/* Smart Router Settings */}
                {activeSection === 'router' && (
                    <RouterSettings onNotification={showNotification} />
                )}

                {/* Local Inference — premium section, resolved late (LL-7) */}
                {activeSection === 'local-inference' && (
                    <CapabilityPanelSlot
                        capability="settings.local-inference"
                        onNotification={showNotification}
                    />
                )}

                {/* Plugins — de-duplicated (owner 2026-09-03): the full plugin
                    manager lives only on the /plugins dashboard now; this tab is
                    a signpost to it. */}
                {activeSection === 'plugins' && (
                    <PluginsSettingsLink />
                )}

                {/* Backup & Restore */}
                {activeSection === 'backup' && (
                    <BackupSettings />
                )}

                {/* Notifications - CoreComms */}
                {activeSection === 'notifications' && (
                    <div>
                        <SettingsSection
                            title="Notification Channels"
                            description="Configure external notification channels for HITL alerts"
                        >
                            <CoreCommsSettings />
                        </SettingsSection>

                        {/* VAULT-INTEG P17: TELEGRAM_DEFAULT_AGENT was settable
                            (registry group 'integrations') but had no page
                            showing it — Telegram is a comms channel, so it
                            belongs here rather than the platform-flags fallback. */}
                        <SettingsSection
                            title="Telegram Routing"
                            description="Which agent answers an inbound Telegram DM when no other routing rule matches"
                        >
                            <PlatformFlagsPanel
                                keys={['TELEGRAM_DEFAULT_AGENT']}
                                title="Telegram Flags"
                                onNotification={showNotification}
                                authFetch={authFetch}
                            />
                        </SettingsSection>
                    </div>
                )}

                {/* Services Monitoring */}
                {activeSection === 'services' && (
                    <div>
                        <SettingsSection
                            title="Service Status"
                            description="Monitor the status of connected services"
                        >
                            <ServiceStatus />
                        </SettingsSection>

                        <SettingsSection
                            title="Custom Services"
                            description="Add your own services to monitor on the dashboard"
                        >
                            <CustomServicesPanel />
                        </SettingsSection>

                        <SettingsSection
                            title="Alert Rules"
                            description="Configure when alerts are sent to the HITL inbox"
                        >
                            <AlertRulesPanel />
                        </SettingsSection>
                    </div>
                )}

                {/* Infrastructure Settings */}
                {activeSection === 'infrastructure' && (
                    <div>
                        <SettingsSection
                            title="Jump Host Configuration"
                            description="Configure SSH bastion host for secure connections"
                        >
                            <SettingsCard glass>
                                <SettingsGroup>
                                    <SettingItem
                                        label="Enable Jump Host"
                                        description="Use bastion for SSH connections"
                                        checked={settings.jumpHost.enabled}
                                        onChange={(e) => updateJumpHostSetting('enabled', e.target.checked)}
                                    />

                                    <FormField
                                        label="Hostname"
                                        htmlFor="jumphost-hostname"
                                        error={jumpHostErrors.hostname}
                                    >
                                        <Input
                                            id="jumphost-hostname"
                                            type="text"
                                            value={settings.jumpHost.hostname}
                                            onChange={(e) => updateJumpHostSetting('hostname', e.target.value)}
                                            disabled={!settings.jumpHost.enabled}
                                            error={!!jumpHostErrors.hostname}
                                            placeholder="e.g., gw-01"
                                        />
                                    </FormField>

                                    <FormField
                                        label="IP Address"
                                        htmlFor="jumphost-ip"
                                        error={jumpHostErrors.ip}
                                    >
                                        <Input
                                            id="jumphost-ip"
                                            type="text"
                                            value={settings.jumpHost.ip}
                                            onChange={(e) => updateJumpHostSetting('ip', e.target.value)}
                                            disabled={!settings.jumpHost.enabled}
                                            error={!!jumpHostErrors.ip}
                                            placeholder="e.g., 198.51.100.247"
                                        />
                                    </FormField>

                                    <FormField
                                        label="SSH User"
                                        htmlFor="jumphost-user"
                                        error={jumpHostErrors.user}
                                    >
                                        <Input
                                            id="jumphost-user"
                                            type="text"
                                            value={settings.jumpHost.user}
                                            onChange={(e) => updateJumpHostSetting('user', e.target.value)}
                                            disabled={!settings.jumpHost.enabled}
                                            error={!!jumpHostErrors.user}
                                            placeholder="e.g., control"
                                        />
                                    </FormField>
                                </SettingsGroup>
                            </SettingsCard>
                        </SettingsSection>

                        <SettingsSection
                            title="Monitoring Integrations"
                            description="Configure connections to monitoring services"
                        >
                            <SettingsCardGroup>
                                <div className="settings-grid settings-grid--2">
                                    <SettingsCard
                                        title="Prometheus"
                                        status={settings.monitoring.prometheus.enabled ? 'success' : 'neutral'}
                                        statusText={settings.monitoring.prometheus.enabled ? 'Connected' : 'Disabled'}
                                        glass
                                        compact
                                    >
                                        <FormField label="URL" htmlFor="prometheus-url">
                                            <Input id="prometheus-url" value={settings.monitoring.prometheus.url} readOnly />
                                        </FormField>
                                    </SettingsCard>

                                    <SettingsCard
                                        title="Grafana"
                                        status={settings.monitoring.grafana.enabled ? 'success' : 'neutral'}
                                        statusText={settings.monitoring.grafana.enabled ? 'Connected' : 'Disabled'}
                                        glass
                                        compact
                                    >
                                        <FormField label="URL" htmlFor="grafana-url">
                                            <Input id="grafana-url" value={settings.monitoring.grafana.url} readOnly />
                                        </FormField>
                                    </SettingsCard>
                                </div>
                            </SettingsCardGroup>
                        </SettingsSection>
                    </div>
                )}

                {/* Integrations Vault */}
                {activeSection === 'vault' && (
                    <IntegrationsVault orgId={currentOrg?.id} />
                )}

                {/* Account Settings */}
                {activeSection === 'account' && (
                    <div>
                        <SettingsSection
                            title="Account Information"
                            description="Your profile and account details"
                        >
                            <SettingsCard glass>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                                    <div style={{
                                        width: '64px',
                                        height: '64px',
                                        borderRadius: '50%',
                                        background: 'linear-gradient(135deg, var(--ui-blue), var(--ui-purple))',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        fontSize: '24px',
                                        fontWeight: '600',
                                        color: 'white',
                                        flexShrink: 0
                                    }}>
                                        {user?.display_name?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || 'U'}
                                    </div>
                                    <div>
                                        <h3 style={{ fontSize: '18px', fontWeight: '600', marginBottom: '4px' }}>
                                            {user?.display_name || 'User'}
                                        </h3>
                                        <p style={{ color: 'var(--ui-text-secondary)', fontSize: '14px' }}>
                                            {user?.email}
                                        </p>
                                        <p style={{ color: 'var(--ui-text-muted)', fontSize: '13px', marginTop: '4px' }}>
                                            Organization: {currentOrg?.name || 'None'}
                                        </p>
                                    </div>
                                </div>
                            </SettingsCard>
                        </SettingsSection>

                        <SettingsSection
                            title="Security"
                            description="Manage your account security settings"
                        >
                            <SettingsCard glass>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                    <Button
                                        variant="secondary"
                                        onClick={() => showNotification('Password change coming soon.', 'info')}
                                    >
                                        Change Password
                                    </Button>
                                    <Button
                                        variant="secondary"
                                        onClick={() => showNotification('Two-factor authentication coming soon.', 'info')}
                                    >
                                        Enable 2FA
                                    </Button>
                                    <Button
                                        variant="secondary"
                                        onClick={() => showNotification('Session management coming soon.', 'info')}
                                    >
                                        View Sessions
                                    </Button>
                                </div>
                            </SettingsCard>

                            {/*
                              * LICENSE-LAUNCH LL-6b: enforcement posture + break-glass.
                              * The collector's default-deny gate and AEE endpoint auth both
                              * default to OFF, so without this panel a production box could
                              * run with them decorative and no screen would say so.
                              */}
                            <EnforcementPanel onNotification={showNotification} />
                        </SettingsSection>

                        <SettingsSection
                            title="Danger Zone"
                        >
                            {/* Scheduled Deletion Warning */}
                            {deletionStatus?.scheduled && (
                                <SettingsCard variant="danger" glass style={{ marginBottom: '16px' }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ui-red)" strokeWidth="2">
                                                <circle cx="12" cy="12" r="10" />
                                                <line x1="12" y1="8" x2="12" y2="12" />
                                                <line x1="12" y1="16" x2="12.01" y2="16" />
                                            </svg>
                                            <span style={{ fontWeight: '600', color: 'var(--ui-red-light)' }}>
                                                Account Scheduled for Deletion
                                            </span>
                                        </div>
                                        <p style={{ color: 'var(--ui-text-secondary)', fontSize: '14px', margin: 0 }}>
                                            Your account is scheduled to be deleted on{' '}
                                            <strong>{new Date(deletionStatus.deletion_date).toLocaleDateString()}</strong>
                                            {' '}({deletionStatus.days_remaining} days remaining).
                                            All your data will be permanently removed.
                                        </p>
                                        <Button
                                            variant="secondary"
                                            onClick={handleCancelDeletion}
                                            style={{ alignSelf: 'flex-start' }}
                                        >
                                            Cancel Deletion
                                        </Button>
                                    </div>
                                </SettingsCard>
                            )}

                            <SettingsCard variant="danger" glass>
                                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                                    <Button variant="danger" onClick={handleLogout}>
                                        Sign Out
                                    </Button>
                                    {!deletionStatus?.scheduled && (
                                        <Button
                                            variant="ghost"
                                            style={{ color: 'var(--ui-red-light)', borderColor: 'var(--ui-red)' }}
                                            onClick={() => setShowDeleteModal(true)}
                                        >
                                            Delete Account
                                        </Button>
                                    )}
                                </div>
                            </SettingsCard>
                        </SettingsSection>

                        {/* Account Deletion Modal */}
                        {showDeleteModal && (
                            <div
                                style={{
                                    position: 'fixed',
                                    top: 0,
                                    left: 0,
                                    right: 0,
                                    bottom: 0,
                                    background: 'rgba(0, 0, 0, 0.7)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    zIndex: 2000,
                                    padding: '20px'
                                }}
                                onClick={(e) => {
                                    if (e.target === e.currentTarget) {
                                        setShowDeleteModal(false);
                                        setDeletePassword('');
                                        setDeleteError(null);
                                    }
                                }}
                            >
                                <div
                                    style={{
                                        background: 'var(--ui-bg-secondary)',
                                        borderRadius: '12px',
                                        padding: '24px',
                                        maxWidth: '480px',
                                        width: '100%',
                                        border: '1px solid var(--ui-red)',
                                        boxShadow: '0 20px 50px rgba(0, 0, 0, 0.5)'
                                    }}
                                >
                                    <h2 style={{
                                        fontSize: '20px',
                                        fontWeight: '600',
                                        color: 'var(--ui-red-light)',
                                        marginBottom: '16px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '10px'
                                    }}>
                                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                                            <line x1="10" y1="11" x2="10" y2="17" />
                                            <line x1="14" y1="11" x2="14" y2="17" />
                                        </svg>
                                        Delete Your Account
                                    </h2>

                                    <div style={{ marginBottom: '20px' }}>
                                        <p style={{ color: 'var(--ui-text-secondary)', fontSize: '14px', lineHeight: '1.6', marginBottom: '12px' }}>
                                            This action will permanently delete your account and all associated data, including:
                                        </p>
                                        <ul style={{ color: 'var(--ui-text-muted)', fontSize: '13px', margin: '0 0 16px 20px', lineHeight: '1.8' }}>
                                            <li>Your profile and personal information</li>
                                            <li>All active sessions</li>
                                            <li>Organization and team memberships</li>
                                            <li>Conversations and memories</li>
                                            <li>Credentials and integrations you created</li>
                                        </ul>
                                        <p style={{ color: 'var(--ui-text-secondary)', fontSize: '14px' }}>
                                            <strong>This action cannot be undone.</strong>
                                        </p>
                                    </div>

                                    {deleteError && (
                                        <div style={{
                                            background: 'rgba(239, 68, 68, 0.1)',
                                            border: '1px solid var(--ui-red)',
                                            borderRadius: '8px',
                                            padding: '12px',
                                            marginBottom: '16px',
                                            color: 'var(--ui-red-light)',
                                            fontSize: '14px'
                                        }}>
                                            {deleteError}
                                        </div>
                                    )}

                                    <div style={{ marginBottom: '16px' }}>
                                        <label style={{
                                            display: 'block',
                                            color: 'var(--ui-text-secondary)',
                                            fontSize: '14px',
                                            marginBottom: '8px'
                                        }}>
                                            Enter your password to confirm
                                        </label>
                                        <input
                                            type="password"
                                            value={deletePassword}
                                            onChange={(e) => setDeletePassword(e.target.value)}
                                            placeholder="Your current password"
                                            style={{
                                                width: '100%',
                                                padding: '10px 12px',
                                                background: 'var(--ui-bg-tertiary)',
                                                border: '1px solid var(--ui-border)',
                                                borderRadius: '6px',
                                                color: 'var(--ui-text-primary)',
                                                fontSize: '14px'
                                            }}
                                            autoComplete="current-password"
                                        />
                                    </div>

                                    <div style={{ marginBottom: '20px' }}>
                                        <label style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '10px',
                                            cursor: 'pointer',
                                            color: 'var(--ui-text-secondary)',
                                            fontSize: '14px'
                                        }}>
                                            <input
                                                type="checkbox"
                                                checked={deleteImmediate}
                                                onChange={(e) => setDeleteImmediate(e.target.checked)}
                                                style={{ width: '18px', height: '18px', accentColor: 'var(--ui-red)' }}
                                            />
                                            <span>
                                                Delete immediately
                                                <span style={{ color: 'var(--ui-text-muted)', marginLeft: '8px' }}>
                                                    (otherwise 14-day grace period)
                                                </span>
                                            </span>
                                        </label>
                                    </div>

                                    <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                                        <Button
                                            variant="secondary"
                                            onClick={() => {
                                                setShowDeleteModal(false);
                                                setDeletePassword('');
                                                setDeleteError(null);
                                            }}
                                            disabled={deleteLoading}
                                        >
                                            Cancel
                                        </Button>
                                        <Button
                                            variant="danger"
                                            onClick={handleDeleteAccount}
                                            disabled={deleteLoading || !deletePassword}
                                        >
                                            {deleteLoading ? 'Deleting...' : (deleteImmediate ? 'Delete Now' : 'Schedule Deletion')}
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* Privacy Settings (Security Issues #72, #74) */}
                {activeSection === 'privacy' && (
                    <div>
                        {/* AI Data Sharing Consent (Security Issue #72) */}
                        <PrivacySettings onNotification={showNotification} />

                        <SettingsSection
                            title="Cookie Preferences"
                            description="Manage how we use cookies and similar technologies"
                        >
                            <CookieSettingsPanel />
                        </SettingsSection>

                        <SettingsSection
                            title="Data Privacy"
                            description="Your data rights and privacy controls"
                        >
                            <SettingsCard glass>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                                    <p style={{ color: 'var(--ui-text-secondary)', fontSize: '14px', lineHeight: '1.6', margin: 0 }}>
                                        Under GDPR and other privacy regulations, you have rights over your personal data:
                                    </p>
                                    <ul style={{ margin: 0, paddingLeft: '20px', color: 'var(--ui-text-secondary)', fontSize: '14px', lineHeight: '1.8' }}>
                                        <li><strong style={{ color: 'var(--ui-text-primary)' }}>Right to Access</strong> - View and export all your data</li>
                                        <li><strong style={{ color: 'var(--ui-text-primary)' }}>Right to Rectification</strong> - Correct inaccurate data</li>
                                        <li><strong style={{ color: 'var(--ui-text-primary)' }}>Right to Erasure</strong> - Request deletion of your data</li>
                                        <li><strong style={{ color: 'var(--ui-text-primary)' }}>Right to Restrict Processing</strong> - Limit how we use your data</li>
                                        <li><strong style={{ color: 'var(--ui-text-primary)' }}>Right to Data Portability</strong> - Receive your data in a portable format</li>
                                    </ul>
                                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '8px' }}>
                                        <Button
                                            variant="secondary"
                                            onClick={async () => {
                                                try {
                                                    const response = await fetch('/api/auth/me/export', {
                                                        credentials: 'include'
                                                    });
                                                    if (response.ok) {
                                                        const blob = await response.blob();
                                                        const url = window.URL.createObjectURL(blob);
                                                        const a = document.createElement('a');
                                                        a.href = url;
                                                        a.download = `quox-data-export-${new Date().toISOString().split('T')[0]}.json`;
                                                        document.body.appendChild(a);
                                                        a.click();
                                                        window.URL.revokeObjectURL(url);
                                                        a.remove();
                                                        showNotification('Data export downloaded', 'success');
                                                    } else {
                                                        showNotification('Failed to export data', 'error');
                                                    }
                                                } catch (err) {
                                                    showNotification('Export failed: ' + err.message, 'error');
                                                }
                                            }}
                                        >
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '8px' }}>
                                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                                <polyline points="7 10 12 15 17 10" />
                                                <line x1="12" y1="15" x2="12" y2="3" />
                                            </svg>
                                            Export My Data
                                        </Button>
                                        <a
                                            href="https://quox.ai/privacy"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            style={{ textDecoration: 'none' }}
                                        >
                                            <Button variant="outline">
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '8px' }}>
                                                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                                    <polyline points="15 3 21 3 21 9" />
                                                    <line x1="10" y1="14" x2="21" y2="3" />
                                                </svg>
                                                Privacy Policy
                                            </Button>
                                        </a>
                                    </div>
                                </div>
                            </SettingsCard>
                        </SettingsSection>

                        <SettingsSection
                            title="Data Retention"
                            description="Control how long your personal data is stored"
                        >
                            <SettingsCard glass>
                                <DataRetentionSettings />
                            </SettingsCard>
                        </SettingsSection>
                    </div>
                )}

                {/* Telemetry Section */}
                {activeSection === 'telemetry' && (
                    <div className="telemetry-section">
                        <SettingsSection
                            title="QuoxCores Online"
                            description="Help improve QuoxCORE by sharing anonymous usage data"
                        >
                            <SettingsCard glass>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                                    {/* Toggle */}
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <div>
                                            <div style={{ fontWeight: 600, color: 'var(--ui-text-primary)', marginBottom: '4px' }}>
                                                Send anonymous heartbeat
                                            </div>
                                            <div style={{ fontSize: '13px', color: 'var(--ui-text-secondary)' }}>
                                                A small ping every 5 minutes lets us know your instance is running
                                            </div>
                                        </div>
                                        <label style={{ position: 'relative', display: 'inline-block', width: '48px', height: '26px', cursor: 'pointer' }}>
                                            <input
                                                type="checkbox"
                                                checked={isTelemetryEnabled()}
                                                onChange={(e) => {
                                                    setTelemetryEnabled(e.target.checked);
                                                    setNotification({ type: 'success', message: e.target.checked ? 'Telemetry enabled, thank you!' : 'Telemetry disabled' });
                                                }}
                                                style={{ opacity: 0, width: 0, height: 0 }}
                                            />
                                            <span style={{
                                                position: 'absolute', inset: 0, borderRadius: '13px', transition: 'background 0.2s',
                                                background: isTelemetryEnabled() ? 'var(--hal-green, #22c55e)' : 'rgba(255,255,255,0.15)',
                                            }}>
                                                <span style={{
                                                    position: 'absolute', top: '3px', left: isTelemetryEnabled() ? '25px' : '3px',
                                                    width: '20px', height: '20px', borderRadius: '50%', background: '#fff',
                                                    transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
                                                }} />
                                            </span>
                                        </label>
                                    </div>

                                    {/* Policy */}
                                    <div style={{
                                        padding: '16px', borderRadius: '8px',
                                        background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.15)'
                                    }}>
                                        <div style={{ fontWeight: 600, marginBottom: '8px', color: 'var(--ui-text-primary)', fontSize: '14px' }}>
                                            What we send
                                        </div>
                                        <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', color: 'var(--ui-text-secondary)', lineHeight: '1.8' }}>
                                            <li>A random instance ID (tied to your license for auth, not shared publicly)</li>
                                            <li>QuoxCORE version number</li>
                                            <li>Uptime and session duration</li>
                                            <li>OS platform and browser type</li>
                                            <li>Aggregate counts: enabled plugins, memory entries</li>
                                        </ul>
                                    </div>

                                    <div style={{
                                        padding: '16px', borderRadius: '8px',
                                        background: 'rgba(34, 197, 94, 0.08)', border: '1px solid rgba(34, 197, 94, 0.15)'
                                    }}>
                                        <div style={{ fontWeight: 600, marginBottom: '8px', color: 'var(--ui-text-primary)', fontSize: '14px' }}>
                                            What we NEVER send
                                        </div>
                                        <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', color: 'var(--ui-text-secondary)', lineHeight: '1.8' }}>
                                            <li>Conversation content or chat history</li>
                                            <li>Hostnames, IP addresses, or network details</li>
                                            <li>API keys, passwords, or credentials</li>
                                            <li>File contents or personal data</li>
                                        </ul>
                                    </div>

                                    <p style={{ fontSize: '13px', color: 'var(--ui-text-muted)', margin: 0, lineHeight: '1.6' }}>
                                        This data helps us understand how QuoxCORE is used, improve reliability,
                                        and prioritize features. You can turn this off at any time, no questions asked.
                                        Your instance will simply go quiet on our end.
                                    </p>

                                    {/* View Payload Button */}
                                    <TelemetryPayloadViewer />
                                </div>
                            </SettingsCard>
                        </SettingsSection>
                    </div>
                )}

                {/* Documentation Section */}
                {activeSection === 'docs' && (
                    <div className="docs-section">
                        <SettingsSection
                            title="Testing & Compliance"
                            description="Enterprise-grade testing and compliance documentation"
                        >
                            <SettingsCard glass>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                                    {/* Overview */}
                                    <div>
                                        <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '8px', color: 'var(--ui-text-primary)' }}>
                                            Overview
                                        </h3>
                                        <p style={{ color: 'var(--ui-text-secondary)', fontSize: '14px', lineHeight: '1.6' }}>
                                            QuoxCORE includes a comprehensive Test Lab for validating system components and ensuring
                                            regulatory compliance. The test suite covers 126+ enterprise compliance tests across
                                            audit logging, AOCL layers, working set memory, and capability indexing.
                                        </p>
                                    </div>

                                    {/* Compliance Standards */}
                                    <div>
                                        <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '12px', color: 'var(--ui-text-primary)' }}>
                                            Supported Compliance Standards
                                        </h3>
                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
                                            {[
                                                { name: 'SOC 2', desc: 'Trust Services Criteria for service organizations', icon: '🔒' },
                                                { name: 'HIPAA', desc: 'Healthcare data protection requirements', icon: '🏥' },
                                                { name: 'GDPR', desc: 'EU data protection and privacy regulation', icon: '🇪🇺' },
                                                { name: 'FedRAMP', desc: 'Federal security authorization program', icon: '🏛️' },
                                            ].map(std => (
                                                <div key={std.name} style={{
                                                    padding: '14px 16px',
                                                    background: 'rgba(59, 130, 246, 0.08)',
                                                    borderRadius: '8px',
                                                    border: '1px solid rgba(59, 130, 246, 0.15)'
                                                }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                                                        <span>{std.icon}</span>
                                                        <span style={{ fontWeight: '600', color: 'var(--ui-text-primary)' }}>{std.name}</span>
                                                    </div>
                                                    <p style={{ fontSize: '12px', color: 'var(--ui-text-muted)', margin: 0 }}>{std.desc}</p>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Test Categories */}
                                    <div>
                                        <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '12px', color: 'var(--ui-text-primary)' }}>
                                            Test Categories
                                        </h3>
                                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                                            <thead>
                                                <tr style={{ borderBottom: '1px solid var(--ui-border)' }}>
                                                    <th style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--ui-text-secondary)' }}>Category</th>
                                                    <th style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--ui-text-secondary)' }}>Tests</th>
                                                    <th style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--ui-text-secondary)' }}>Description</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {[
                                                    { name: 'Compliance', tests: 38, desc: 'Audit logging, SOC2, HIPAA, GDPR, FedRAMP requirements' },
                                                    { name: 'AOCL', tests: 34, desc: '11-layer orchestration system validation' },
                                                    { name: 'Working Set Memory', tests: 30, desc: 'Context tracking, entity management, open loops' },
                                                    { name: 'Capabilities', tests: 24, desc: 'Capability discovery, routing, indexing' },
                                                    { name: 'Agents', tests: '100+', desc: 'Agent delegation, personalities, manifests' },
                                                    { name: 'Memory', tests: '50+', desc: 'Memory lattice, persistence, behavior' },
                                                ].map(cat => (
                                                    <tr key={cat.name} style={{ borderBottom: '1px solid var(--ui-border-subtle)' }}>
                                                        <td style={{ padding: '10px 12px', color: 'var(--ui-text-primary)', fontWeight: '500' }}>{cat.name}</td>
                                                        <td style={{ padding: '10px 12px', color: 'var(--ui-green)' }}>{cat.tests}</td>
                                                        <td style={{ padding: '10px 12px', color: 'var(--ui-text-secondary)' }}>{cat.desc}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>

                                    {/* Quick Links */}
                                    <div>
                                        <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '12px', color: 'var(--ui-text-primary)' }}>
                                            Quick Links
                                        </h3>
                                        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                                            <Button variant="secondary" onClick={() => navigate('/test-lab')}>
                                                Open Test Lab
                                            </Button>
                                            <Button variant="secondary" onClick={() => navigate('/compliance')}>
                                                Compliance Reports
                                            </Button>
                                            <Button variant="secondary" onClick={() => navigate('/activity')}>
                                                View Activity Log
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            </SettingsCard>
                        </SettingsSection>

                        <SettingsSection
                            title="Audit Trail"
                            description="Understanding the audit logging system"
                        >
                            <SettingsCard glass>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                                    <p style={{ color: 'var(--ui-text-secondary)', fontSize: '14px', lineHeight: '1.6', margin: 0 }}>
                                        Every operation in QuoxCORE is logged through the Agent Envelope Exchange (AEE) protocol,
                                        creating an immutable audit trail. Key audit features include:
                                    </p>
                                    <ul style={{ margin: 0, paddingLeft: '20px', color: 'var(--ui-text-secondary)', fontSize: '14px', lineHeight: '1.8' }}>
                                        <li><strong style={{ color: 'var(--ui-text-primary)' }}>Timestamped Operations</strong> - ISO timestamps for all actions</li>
                                        <li><strong style={{ color: 'var(--ui-text-primary)' }}>Actor Identification</strong> - User/system identification for each operation</li>
                                        <li><strong style={{ color: 'var(--ui-text-primary)' }}>Outcome Tracking</strong> - Success, failure, and blocked operations recorded</li>
                                        <li><strong style={{ color: 'var(--ui-text-primary)' }}>Correlation IDs</strong> - Link related operations for traceability</li>
                                        <li><strong style={{ color: 'var(--ui-text-primary)' }}>DEFCON Levels</strong> - Risk classification for sensitive operations</li>
                                        <li><strong style={{ color: 'var(--ui-text-primary)' }}>Immutable Records</strong> - Original timestamps preserved, no silent modifications</li>
                                    </ul>
                                </div>
                            </SettingsCard>
                        </SettingsSection>

                        <SettingsSection
                            title="AOCL - Agent Orchestration Control Layers"
                            description="The 11-layer request processing architecture"
                        >
                            <SettingsCard glass>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                                    <p style={{ color: 'var(--ui-text-secondary)', fontSize: '14px', lineHeight: '1.6', margin: 0 }}>
                                        AOCL provides structured request processing with full observability at each layer:
                                    </p>
                                    <div style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                                        gap: '8px'
                                    }}>
                                        {[
                                            { layer: 'L0', name: 'Ingress', desc: 'Input normalization' },
                                            { layer: 'L1', name: 'Auth', desc: 'Authentication' },
                                            { layer: 'L2', name: 'Route', desc: 'Smart routing' },
                                            { layer: 'L3', name: 'Policy', desc: 'Policy enforcement' },
                                            { layer: 'L4', name: 'Context', desc: 'Memory loading' },
                                            { layer: 'L5', name: 'Enrich', desc: 'Data enrichment' },
                                            { layer: 'L6', name: 'Plan', desc: 'Action planning' },
                                            { layer: 'L7', name: 'Execute', desc: 'Delegation/execution' },
                                            { layer: 'L8', name: 'Validate', desc: 'Output validation' },
                                            { layer: 'L9', name: 'Format', desc: 'Response formatting' },
                                            { layer: 'L10', name: 'Audit', desc: 'Writeback/logging' },
                                        ].map(l => (
                                            <div key={l.layer} style={{
                                                padding: '10px 12px',
                                                background: 'rgba(139, 92, 246, 0.08)',
                                                borderRadius: '6px',
                                                border: '1px solid rgba(139, 92, 246, 0.15)',
                                                fontSize: '12px'
                                            }}>
                                                <div style={{ fontWeight: '600', color: '#a78bfa' }}>{l.layer}</div>
                                                <div style={{ color: 'var(--ui-text-primary)', fontWeight: '500' }}>{l.name}</div>
                                                <div style={{ color: 'var(--ui-text-muted)', fontSize: '11px' }}>{l.desc}</div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </SettingsCard>
                        </SettingsSection>

                        <SettingsSection
                            title="Running Compliance Tests"
                            description="How to validate your deployment"
                        >
                            <SettingsCard glass>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                                    <ol style={{ margin: 0, paddingLeft: '20px', color: 'var(--ui-text-secondary)', fontSize: '14px', lineHeight: '2' }}>
                                        <li>Navigate to <strong style={{ color: 'var(--ui-text-primary)' }}>Test Lab</strong> from the sidebar</li>
                                        <li>Click the <strong style={{ color: 'var(--ui-text-primary)' }}>Compliance</strong> category card</li>
                                        <li>Click <strong style={{ color: 'var(--ui-text-primary)' }}>Run Category</strong> to execute all compliance tests</li>
                                        <li>Review results in the console and activity log</li>
                                        <li>Export compliance reports from the <strong style={{ color: 'var(--ui-text-primary)' }}>Compliance Reports</strong> page</li>
                                    </ol>
                                    <p style={{ color: 'var(--ui-text-muted)', fontSize: '13px', margin: 0, fontStyle: 'italic' }}>
                                        For automated compliance verification, schedule regular test runs and export reports
                                        in SOC 2, HIPAA, GDPR, or ISO 27001 formats.
                                    </p>
                                </div>
                            </SettingsCard>
                        </SettingsSection>
                    </div>
                )}
            </SettingsLayout>
            </div>
            {chatSidebarOpen && (
                <aside className="settings-page__chat-col">
                    <button
                        className="settings-page__chat-close"
                        onClick={() => setChatSidebarOpen(false)}
                        title="Close chat"
                    >
                        &#x25B6;
                    </button>
                    <SettingsChatSidebar
                        currentSection={activeSection}
                        pluginCount={activePluginCount}
                        activePluginCount={activePluginCount}
                        licenseStatus={{
                            tier: platformStatus?.tiers?.[0],
                            daysRemaining: platformStatus?.days_remaining,
                        }}
                    />
                </aside>
            )}
            {!chatSidebarOpen && (
                <button
                    className="settings-page__chat-reopen"
                    onClick={() => setChatSidebarOpen(true)}
                    title="Open REGULA"
                >
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#38bdf8' }} />
                    Ask REGULA
                </button>
            )}
        </div>
    );
}

export default SettingsView;
