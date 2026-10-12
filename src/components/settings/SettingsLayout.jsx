/**
 * SettingsLayout Component
 *
 * Main layout wrapper for the settings area with sidebar navigation.
 * Uses the SettingsSidebar component for navigation.
 *
 * @example
 * <SettingsLayout
 *   activeSection="general"
 *   onSectionChange={setActiveSection}
 * >
 *   {activeSection === 'general' && <GeneralSettings />}
 * </SettingsLayout>
 */

import { useMemo, useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import SettingsSidebar, { DEFAULT_SECTIONS } from './SettingsSidebar';
import SettingsSidebarV2 from './SettingsSidebarV2';
import SectionRenderer from './SectionRenderer.jsx';
import { getSectionById } from '../../config/settingsSections.js';
import { resolveLegacyAnchor } from '../../config/legacyAnchorAliases.js';
import { buildSetupChecklist } from '../../config/settingsSetupChecklist.js';
import { getAllPluginManifests } from '../../config/plugins';
import './settings.css';

// External-redirect anchors: hashes that should bounce out of /settings to a
// sibling route. Lives here (not in legacyAnchorAliases) because aliases
// resolve to a section id within /settings; these jump out of /settings.
const EXTERNAL_HASH_REDIRECTS = Object.freeze({
    vault: '/vault',
});

/**
 * SET-IA Phase 7 — V2 is now the default IA. The flag stays as a
 * one-release escape hatch: ?ia=v1 falls back to the legacy sidebar
 * + inline section rendering for users hitting V2-only regressions.
 * The escape hatch retires in Phase 8 once telemetry confirms parity.
 */
function useIaV2Flag() {
    if (typeof window === 'undefined') return true;
    return new URLSearchParams(window.location.search).get('ia') !== 'v1';
}

/**
 * V2 hash sync — reads /settings#<scope>/<id> on mount and writes
 * back to history when the user picks a section. Used only when
 * ?ia=v2 is on; the v1 sidebar uses its own hash format.
 *
 * Phase 6: applies the legacyAnchorAliases manifest so old short
 * hashes (#vault, #plugins, #voice, …) keep resolving to the new
 * canonical ids (account/integrations, account/plugins, …). Old
 * bookmarks survive Phase 7's default-flip.
 */
function resolveHashToSectionId(raw) {
    if (!raw) return null;
    if (getSectionById(raw)) return raw;             // canonical id
    return resolveLegacyAnchor(raw) || null;          // legacy alias or null
}

function useV2HashSection() {
    const initial = useMemo(() => {
        if (typeof window === 'undefined') return null;
        return resolveHashToSectionId(window.location.hash.replace(/^#/, ''));
    }, []);

    const [active, setActiveState] = useState(initial);

    useEffect(() => {
        const onHash = () => {
            setActiveState(resolveHashToSectionId(window.location.hash.replace(/^#/, '')));
        };
        window.addEventListener('hashchange', onHash);
        return () => window.removeEventListener('hashchange', onHash);
    }, []);

    const setActive = useCallback((id) => {
        setActiveState(id);
        if (typeof window !== 'undefined') {
            const next = id ? `#${id}` : '';
            // replaceState avoids polluting history when clicking sidebar items.
            window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${next}`);
        }
    }, []);

    return [active, setActive];
}

/**
 * SettingsLayout Component
 *
 * @param {string} activeSection - Currently active section ID
 * @param {function} onSectionChange - Callback when section changes
 * @param {Array} sections - Custom sections configuration (optional)
 * @param {string} title - Sidebar title
 * @param {string} subtitle - Sidebar subtitle
 * @param {React.ReactNode} children - Content to render
 */
export default function SettingsLayout({
    activeSection = 'general',
    onSectionChange,
    sections = DEFAULT_SECTIONS,
    title = 'Settings',
    subtitle = 'Manage your preferences',
    children
}) {
    // Generate a unique key for content transitions
    const contentKey = useMemo(() => activeSection, [activeSection]);

    const useV2 = useIaV2Flag();
    const [v2Section, setV2Section] = useV2HashSection();
    const navigate = useNavigate();
    const location = useLocation();

    // LLM-FAILOVER P2 (UX audit A3a): /settings?section=<id> deep-link.
    // Sections are normally selected via the URL hash (useV2HashSection);
    // the ?section= query param resolves through the same canonical-id +
    // legacy-alias table and, when present, selects that section on mount
    // and on in-app navigations that change the search string (the layout
    // does not remount when already on /settings). setV2Section also
    // writes the canonical hash, so the sidebar highlight stays in sync.
    useEffect(() => {
        if (!useV2) return;
        const param = new URLSearchParams(location.search).get('section');
        const resolved = resolveHashToSectionId(param || '');
        if (resolved) setV2Section(resolved);
    }, [useV2, location.search, setV2Section]);

    // External-redirect: /settings#vault → /vault (preserves old bookmarks
    // after the legacyHash 'vault' alias was removed). Runs on mount and on
    // every hashchange.
    useEffect(() => {
        const redirect = () => {
            const raw = window.location.hash.replace(/^#/, '');
            const target = EXTERNAL_HASH_REDIRECTS[raw];
            if (target) navigate(target, { replace: true });
        };
        redirect();
        window.addEventListener('hashchange', redirect);
        return () => window.removeEventListener('hashchange', redirect);
    }, [navigate]);

    if (useV2) {
        return (
            <div className="settings-layout settings-layout--ia-v2">
                <SettingsSidebarV2
                    activeSectionId={v2Section}
                    onSectionChange={setV2Section}
                />
                <main className="settings-layout__content" role="main" key={v2Section || 'empty'}>
                    <SetupChecklistStrip onNavigateSection={setV2Section} />
                    <SectionRenderer sectionId={v2Section} />
                </main>
            </div>
        );
    }

    return (
        <div className="settings-layout">
            {/* Phase 8: deprecation hint for the ?ia=v1 escape hatch.
                Removed in the next release — at that point the v1
                SettingsSidebar + the inline section JSX in SettingsView
                can be deleted entirely. */}
            <V1DeprecationBanner />
            {/* Sidebar Navigation */}
            <SettingsSidebar
                activeSection={activeSection}
                onSectionChange={onSectionChange}
                sections={sections}
                title={title}
                subtitle={subtitle}
            />

            {/* Content Area */}
            <main className="settings-layout__content" role="main" key={contentKey}>
                {children}
            </main>
        </div>
    );
}

/**
 * SetupChecklistStrip — TRUST-GATE-1.21b.
 *
 * Compact readiness checklist rendered above the active V2 panel while
 * the platform isn't fully ready. Reuses platformReadiness/setupSteps
 * from the Outlet context (same /setup/status poll AppShell already
 * runs for PlatformReadinessBanner) — no new backend call. Absent
 * entirely once readiness.fullPlatformReady is true.
 */
function SetupChecklistStrip({ onNavigateSection }) {
    const navigate = useNavigate();
    const { platformReadiness, setupSteps } = useOutletContext() || {};

    const items = useMemo(() => buildSetupChecklist({
        readiness: platformReadiness,
        setupSteps,
        pluginCount: getAllPluginManifests().length,
    }), [platformReadiness, setupSteps]);

    if (platformReadiness?.fullPlatformReady) return null;
    // Wait for the first readiness poll before rendering anything —
    // avoids a flash of "all pending" on initial mount.
    if (!platformReadiness) return null;

    return (
        <div
            role="status"
            aria-label="Setup readiness checklist"
            style={{
                display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10,
                padding: '10px 14px', marginBottom: 16, borderRadius: 12,
                background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.12), rgba(255,255,255,0.03))',
                border: '1px solid rgba(245, 158, 11, 0.22)',
            }}
        >
            {items.map(item => (
                <button
                    key={item.id}
                    type="button"
                    onClick={() => onNavigateSection?.(item.sectionId)}
                    style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '5px 10px', borderRadius: 999, cursor: 'pointer',
                        fontSize: 12, fontWeight: 600,
                        background: item.done ? 'rgba(48, 255, 144, 0.1)' : 'rgba(255,255,255,0.05)',
                        border: `1px solid ${item.done ? 'rgba(48, 255, 144, 0.35)' : 'rgba(255,255,255,0.16)'}`,
                        color: item.done ? '#30ff90' : 'var(--m-text-secondary, #d4d4d8)',
                    }}
                >
                    <span aria-hidden="true">{item.done ? '✓' : '○'}</span>
                    {item.label}
                </button>
            ))}
            <span style={{ flex: 1 }} />
            <button
                type="button"
                onClick={() => navigate('/setup?force=true')}
                style={{
                    padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
                    fontSize: 12, fontWeight: 600,
                    background: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.3)',
                    color: '#fbbf24',
                }}
            >
                Review Setup
            </button>
        </div>
    );
}

function V1DeprecationBanner() {
    const dismiss = () => {
        if (typeof window === 'undefined') return;
        const url = new URL(window.location.href);
        url.searchParams.delete('ia');
        window.location.replace(url.toString());
    };
    return (
        <div role="status" style={{
            position: 'fixed', top: 64, left: '50%', transform: 'translateX(-50%)',
            zIndex: 100, maxWidth: 640, padding: '10px 16px',
            background: 'rgba(217, 119, 6, 0.14)',
            border: '1px solid rgba(217, 119, 6, 0.45)',
            borderRadius: 6, fontSize: 13, color: '#fbbf24',
            display: 'flex', alignItems: 'center', gap: 12,
        }}>
            <span>
                You're viewing the <strong>legacy</strong> settings layout
                (<code>?ia=v1</code>). It will be removed in the next release.
            </span>
            <button type="button" onClick={dismiss} style={{
                background: 'transparent', color: '#fbbf24',
                border: '1px solid #fbbf24', borderRadius: 4,
                padding: '2px 10px', fontSize: 12, cursor: 'pointer',
            }}>
                Switch to new layout
            </button>
        </div>
    );
}

// Re-export section constants for convenience
export { DEFAULT_SECTIONS };
