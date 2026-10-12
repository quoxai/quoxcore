/**
 * SettingsSidebar - Vertical navigation component for settings
 *
 * Features:
 * - Grouped navigation sections
 * - Icons for each menu item
 * - Active state highlighting with animation
 * - Responsive: collapses to horizontal nav on mobile
 *
 * @example
 * <SettingsSidebar
 *   activeSection="general"
 *   onSectionChange={setActiveSection}
 *   sections={SETTINGS_SECTIONS}
 * />
 */

import { useCallback } from 'react';
import './settings.css';

// Icons for settings sections (inline SVGs)
const icons = {
    privacy: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="M9 12l2 2 4-4" />
        </svg>
    ),
    core: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
        </svg>
    ),
    general: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    ),
    files: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
    ),
    infrastructure: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
            <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
            <line x1="6" y1="6" x2="6.01" y2="6" />
            <line x1="6" y1="18" x2="6.01" y2="18" />
        </svg>
    ),
    vault: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            <circle cx="12" cy="16" r="1" />
        </svg>
    ),
    assistants: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="4" />
            <line x1="4.93" y1="4.93" x2="9.17" y2="9.17" />
            <line x1="14.83" y1="14.83" x2="19.07" y2="19.07" />
            <line x1="14.83" y1="9.17" x2="19.07" y2="4.93" />
            <line x1="14.83" y1="9.17" x2="18.36" y2="5.64" />
            <line x1="4.93" y1="19.07" x2="9.17" y2="14.83" />
        </svg>
    ),
    plugins: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <path d="M9 1v3" />
            <path d="M15 1v3" />
            <path d="M9 20v3" />
            <path d="M15 20v3" />
        </svg>
    ),
    notifications: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
    ),
    services: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        </svg>
    ),
    telemetry: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="2" />
            <path d="M16.24 7.76a6 6 0 0 1 0 8.49" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
            <path d="M7.76 16.24a6 6 0 0 1 0-8.49" />
            <path d="M4.93 19.07a10 10 0 0 1 0-14.14" />
        </svg>
    ),
    account: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
        </svg>
    ),
    router: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
    ),
    voice: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
    ),
    backup: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
    ),
    docs: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            <line x1="8" y1="7" x2="16" y2="7" />
            <line x1="8" y1="11" x2="14" y2="11" />
        </svg>
    ),
    localInference: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
            <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
            <circle cx="6" cy="6" r="1" />
            <circle cx="6" cy="18" r="1" />
            <line x1="10" y1="6" x2="18" y2="6" />
            <line x1="10" y1="18" x2="18" y2="18" />
        </svg>
    ),
    quoxmind: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="6" />
            <circle cx="12" cy="12" r="2" fill="currentColor" />
            <line x1="12" y1="2" x2="12" y2="6" />
            <line x1="12" y1="18" x2="12" y2="22" />
            <line x1="2" y1="12" x2="6" y2="12" />
            <line x1="18" y1="12" x2="22" y2="12" />
        </svg>
    ),
    brain2: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="6" />
            <path d="M12 6v6l4 2" />
        </svg>
    ),
    appearance: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 3a9 9 0 0 0 0 18c2.5 0 2-2 3-3s2.5-1 3.5-1.5c1.5-.75 2.5-2 2.5-4.5A9 9 0 0 0 12 3z" />
            <circle cx="7.5" cy="10.5" r="1" fill="currentColor" />
            <circle cx="12" cy="7.5" r="1" fill="currentColor" />
            <circle cx="16.5" cy="10.5" r="1" fill="currentColor" />
        </svg>
    )
};

// Default settings navigation structure
const DEFAULT_SECTIONS = [
    {
        id: 'setup',
        title: 'Setup',
        items: [
            { id: 'core', label: 'Core Integrations', icon: 'core', description: 'API keys and service endpoints' },
            { id: 'plugins', label: 'Plugins', icon: 'plugins', description: 'Manage installed plugins' },
            { id: 'claude-desktop', label: 'Claude Desktop', icon: 'core', description: 'Install MCP bundle for Claude Desktop' }
        ]
    },
    {
        id: 'preferences',
        title: 'Preferences',
        items: [
            { id: 'general', label: 'General', icon: 'general', description: 'Basic preferences and behaviour' },
            { id: 'appearance', label: 'Appearance', icon: 'appearance', description: 'Background, colours and theme' },
            { id: 'dashboard', label: 'Dashboard', icon: 'infrastructure', description: 'Which dashboard tabs show and their order' },
            { id: 'voice', label: 'Voice', icon: 'voice', description: 'Voice output and TTS settings' },
            { id: 'files', label: 'Files', icon: 'files', description: 'File storage and limits' }
        ]
    },
    {
        id: 'ai',
        title: 'AI & Routing',
        items: [
            { id: 'quoxmind', label: 'QuoxMind', icon: 'quoxmind', description: 'Cognitive implant suite status and tiers' },
            { id: 'brain2', label: 'Qortex', icon: 'brain2', description: 'Quox Qortex: governed second-brain source feed' },
            { id: 'execution-policy', label: 'Execution Policy', icon: 'router', description: 'Capability defaults and fallback routing' },
            { id: 'router', label: 'Smart Router', icon: 'router', description: 'Configure query routing and thresholds' },
            { id: 'local-inference', label: 'Local Inference', icon: 'localInference', description: 'Self-hosted LLM servers', badge: 'BETA' }
        ]
    },
    {
        id: 'infrastructure',
        title: 'Infrastructure',
        items: [
            { id: 'infrastructure', label: 'Infrastructure', icon: 'infrastructure', description: 'Jump host and server settings' },
            { id: 'vault', label: 'Integrations Vault', icon: 'vault', description: 'API keys and credentials' },
            { id: 'services', label: 'Service Monitoring', icon: 'services', description: 'Health checks and alerts' }
        ]
    },
    {
        id: 'comms-group',
        title: 'Communications',
        items: [
            { id: 'notifications', label: 'Notifications', icon: 'notifications', description: 'Telegram, Slack, Email channels' },
            { id: 'backup', label: 'Backup & Restore', icon: 'backup', description: 'Schedules, retention, and restore' }
        ]
    },
    {
        id: 'account',
        title: 'Account',
        items: [
            { id: 'account', label: 'Account', icon: 'account', description: 'Profile and security' },
            { id: 'privacy', label: 'Privacy', icon: 'privacy', description: 'Cookie preferences and data controls' },
            { id: 'telemetry', label: 'Telemetry', icon: 'telemetry', description: 'QuoxCORE heartbeat' },
            { id: 'docs', label: 'Documentation', icon: 'docs', description: 'Testing and compliance guides' }
        ]
    }
];

/**
 * Get icon component by name
 */
function getIcon(iconName) {
    return icons[iconName] || icons.general;
}

/**
 * SettingsSidebar Component
 */
export default function SettingsSidebar({
    activeSection = 'general',
    onSectionChange,
    sections = DEFAULT_SECTIONS,
    title = 'Settings',
    subtitle = 'Manage your preferences'
}) {
    const handleItemClick = useCallback((itemId) => {
        onSectionChange?.(itemId);
    }, [onSectionChange]);

    return (
        <aside className="settings-sidebar" role="navigation" aria-label="Settings navigation">
            {/* Header */}
            <div className="settings-sidebar__header">
                <h1 className="settings-sidebar__title">{title}</h1>
                {subtitle && <p className="settings-sidebar__subtitle">{subtitle}</p>}
            </div>

            {/* Navigation */}
            <nav className="settings-sidebar__nav">
                {sections.map(section => (
                    <div key={section.id} className="settings-sidebar__section">
                        <div className="settings-sidebar__section-title">
                            {section.title}
                        </div>
                        {section.items.map(item => (
                            <button
                                key={item.id}
                                className={`settings-sidebar__item ${
                                    activeSection === item.id ? 'settings-sidebar__item--active' : ''
                                }`}
                                onClick={() => handleItemClick(item.id)}
                                aria-current={activeSection === item.id ? 'page' : undefined}
                                title={item.description}
                            >
                                <span className="settings-sidebar__item-icon">
                                    {getIcon(item.icon)}
                                </span>
                                <span className="settings-sidebar__item-label">
                                    {item.label}
                                </span>
                                {item.badge && (
                                    <span className="settings-sidebar__item-badge">
                                        {item.badge}
                                    </span>
                                )}
                            </button>
                        ))}
                    </div>
                ))}
            </nav>

            {/* Footer (optional) */}
            <div className="settings-sidebar__footer">
                <div className="settings-sidebar__version">
                    QuoxCORE v1.0
                </div>
            </div>
        </aside>
    );
}

// Export constants and helpers
export { DEFAULT_SECTIONS, icons, getIcon };
