/**
 * SettingsSidebarV2 — SET-IA Phase 1 dev preview.
 *
 * Scope-grouped, role-gated sidebar driven by settingsSections.js
 * registry and useResolvedCapabilities. Hidden-not-greyed: a section
 * the user cannot read is not rendered at all.
 *
 * Behind the `?ia=v2` query flag in SettingsView until Phase 7 makes
 * it the default.
 *
 * Visual chrome reuses the v1 BEM class names (.settings-sidebar__nav,
 * __section, __section-title, __item, __item--active) so the existing
 * glass panel, padding, and active-state pill styles apply unchanged.
 */

import { useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
    SETTINGS_SECTIONS,
    SCOPE_ACCOUNT,
    SCOPE_ORG,
    SCOPE_INSTANCE,
    isSectionVisible,
} from '../../config/settingsSections.js';
import { getPinnedSetupSections } from '../../config/settingsSetupChecklist.js';
import { getAllPluginManifests } from '../../config/plugins';
import { useResolvedCapabilities } from '../../hooks/useResolvedCapabilities.js';
import { useWorkspace } from '../../contexts/WorkspaceContext.jsx';
import './settings.css';

const SCOPE_ORDER = [SCOPE_ACCOUNT, SCOPE_ORG, SCOPE_INSTANCE];
const SCOPE_LABELS = {
    [SCOPE_ACCOUNT]:  'Account',
    [SCOPE_ORG]:      'Organization',
    [SCOPE_INSTANCE]: 'Instance',
};
const SCOPE_SETUP = 'setup';

export default function SettingsSidebarV2({ activeSectionId, onSectionChange }) {
    const { ready, principal } = useResolvedCapabilities();
    const { currentOrg } = useWorkspace();
    // Shared with AppShell's PlatformReadinessBanner — same /setup/status
    // poll, exposed via the Outlet context. No extra request from here.
    const { platformReadiness, setupSteps } = useOutletContext() || {};

    const pinnedSections = useMemo(() => {
        if (!ready) return [];
        return getPinnedSetupSections({
            readiness: platformReadiness,
            setupSteps,
            pluginCount: getAllPluginManifests().length,
            principal,
        }).map(({ section }) => section);
    }, [ready, principal, platformReadiness, setupSteps]);

    const groups = useMemo(() => {
        if (!ready) return [];
        const scopeGroups = SCOPE_ORDER
            .map(scope => ({
                scope,
                label: scope === SCOPE_ORG && currentOrg?.name
                    ? `Organization · ${currentOrg.name}`
                    : SCOPE_LABELS[scope],
                sections: SETTINGS_SECTIONS
                    .filter(s => s.scope === scope && isSectionVisible(s, principal))
                    .sort((a, b) => a.order - b.order),
            }))
            .filter(g => g.sections.length > 0);

        if (pinnedSections.length === 0) return scopeGroups;

        // Pin is a shortcut, not a move — pinned sections stay in their
        // normal scope group below AND appear again at the top.
        return [
            { scope: SCOPE_SETUP, label: 'Setup', sections: pinnedSections },
            ...scopeGroups,
        ];
    }, [ready, principal, currentOrg?.name, pinnedSections]);

    return (
        <nav className="settings-sidebar settings-sidebar--v2" aria-label="Settings navigation">
            <div className="settings-sidebar__header">
                <h2 className="settings-sidebar__title">Settings</h2>
                <p className="settings-sidebar__subtitle">
                    {ready ? 'Manage your preferences' : 'Loading…'}
                </p>
            </div>

            <div className="settings-sidebar__nav">
                {groups.map(group => (
                    <div key={group.scope}
                        className={`settings-sidebar__section settings-sidebar__section--${group.scope}`}>
                        <div className="settings-sidebar__section-title">{group.label}</div>
                        {group.sections.map(section => {
                            const isActive = section.id === activeSectionId;
                            return (
                                <button
                                    key={`${group.scope}-${section.id}`}
                                    type="button"
                                    className={`settings-sidebar__item${isActive ? ' settings-sidebar__item--active' : ''}`}
                                    onClick={() => onSectionChange?.(section.id)}
                                    aria-current={isActive ? 'page' : undefined}
                                >
                                    <span className="settings-sidebar__item-label">{section.label}</span>
                                </button>
                            );
                        })}
                    </div>
                ))}
            </div>
        </nav>
    );
}
