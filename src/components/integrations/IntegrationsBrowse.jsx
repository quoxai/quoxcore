/**
 * IntegrationsBrowse — Marketplace-style integration discovery
 * Grouped by category with expand/collapse, not a flat grid of every
 * available type (the type count grows — see integrationTypeRegistry.js).
 */

import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIntegrationTypes } from '../../hooks/useIntegrationTypes';
import { useVaultCredentials } from '../../hooks/useVaultCredentials';
import IntegrationModal, { typeIcons as brandIcons } from './IntegrationModal';
import '../vault/vault.css';

const POPULAR_IDS = [
    'openai', 'anthropic', 'github', 'slack', 'aws', 'stripe',
    'jira', 'notion', 'discord', 'docker', 'datadog', 'vercel'
];

const CATEGORY_ORDER = [
    { id: 'ai', name: 'AI & Machine Learning', icon: 'brain' },
    { id: 'developer', name: 'Developer Tools', icon: 'code' },
    { id: 'cloud', name: 'Cloud Providers', icon: 'cloud' },
    { id: 'data', name: 'Databases', icon: 'database' },
    { id: 'devops', name: 'DevOps & CI/CD', icon: 'wrench' },
    { id: 'security', name: 'Security', icon: 'shield' },
    { id: 'communication', name: 'Communication', icon: 'message' },
    { id: 'messaging', name: 'Messaging', icon: 'mail' },
    { id: 'crm', name: 'CRM & Sales', icon: 'chart' },
    { id: 'ecommerce', name: 'Payments & Commerce', icon: 'credit' },
    { id: 'automation', name: 'Automation', icon: 'cog' },
    { id: 'social', name: 'Social Media', icon: 'share' },
    { id: 'documents', name: 'Documents & Storage', icon: 'file' },
    { id: 'creative', name: 'Design & Creative', icon: 'palette' },
    { id: 'infra', name: 'Infrastructure', icon: 'server' },
    { id: 'notification', name: 'Notifications', icon: 'bell' },
    { id: 'custom', name: 'Other', icon: 'package' },
];

const CATEGORY_ICONS = {
    brain: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9.5 2a5.5 5.5 0 0 0-4.88 8.01A4.5 4.5 0 0 0 6 18.5h.5"/><path d="M14.5 2a5.5 5.5 0 0 1 4.88 8.01A4.5 4.5 0 0 1 18 18.5h-.5"/><path d="M8 18.5a4 4 0 0 0 8 0"/><path d="M12 2v20"/></svg>,
    code: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>,
    cloud: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>,
    database: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>,
    wrench: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>,
    shield: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
    message: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
    mail: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>,
    chart: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
    credit: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>,
    cog: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
    share: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>,
    file: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>,
    palette: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.93 1.5-1.5 0-.38-.15-.72-.38-1-.23-.26-.38-.6-.38-1 0-.93.68-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-5.5-4.5-10-10-10z"/></svg>,
    server: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>,
    bell: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
    package: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
    star: <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" opacity="0.7"/></svg>,
};

const ITEMS_PER_CATEGORY = 6;

function getInitials(name) {
    if (!name) return '?';
    const words = name.split(/[\s-]+/);
    if (words.length === 1) return name.slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
}

/* Card */
function Card({ type, count, onClick, icons }) {
    const connected = count > 0;
    const icon = icons?.[type.id];
    const accent = type.color || '#6b7280';

    return (
        <button className="browse-card" onClick={() => onClick(type)} style={{ '--accent': accent }}>
            <div className="browse-card__icon" style={{ background: `${accent}12`, color: accent }}>
                {icon || <span className="browse-card__initials">{getInitials(type.name)}</span>}
            </div>
            <div className="browse-card__body">
                <div className="browse-card__name">{type.name}</div>
                <div className="browse-card__desc">{type.description || '\u00a0'}</div>
            </div>
            {connected && (
                <div className="browse-card__connected">
                    <span className="browse-card__dot" />
                    {count}
                </div>
            )}
        </button>
    );
}

/* Category Section */
function CategoryGroup({ category, items, credCountMap, onCardClick, icons }) {
    const [expanded, setExpanded] = useState(false);
    const shown = expanded ? items : items.slice(0, ITEMS_PER_CATEGORY);
    const hasMore = items.length > ITEMS_PER_CATEGORY;

    return (
        <div className="browse-category">
            <div className="browse-category__header">
                <div className="browse-category__title">
                    <span className="browse-category__icon">
                        {CATEGORY_ICONS[category.icon] || CATEGORY_ICONS.package}
                    </span>
                    <span>{category.name}</span>
                    <span className="browse-category__count">{items.length}</span>
                </div>
                {hasMore && (
                    <button className="browse-category__toggle" onClick={() => setExpanded(!expanded)}>
                        {expanded ? 'Show less' : `Show all ${items.length}`}
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                            style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
                            <polyline points="6 9 12 15 18 9" />
                        </svg>
                    </button>
                )}
            </div>
            <div className="browse-grid">
                {shown.map(type => (
                    <Card key={type.id} type={type} count={credCountMap[type.id] || 0} onClick={onCardClick} icons={icons} />
                ))}
            </div>
        </div>
    );
}

/* Main */
export default function IntegrationsBrowse() {
    const navigate = useNavigate();
    const { types, categories, loading: typesLoading } = useIntegrationTypes();
    const { credentials, loading: credsLoading, refresh } = useVaultCredentials();

    const [searchQuery, setSearchQuery] = useState('');
    const [modalOpen, setModalOpen] = useState(false);
    const [modalPresetType, setModalPresetType] = useState(null);
    const typeIcons = brandIcons || {};

    const credCountMap = useMemo(() => {
        const map = {};
        if (!credentials) return map;
        for (const cred of credentials) {
            map[cred.integration_type] = (map[cred.integration_type] || 0) + 1;
        }
        return map;
    }, [credentials]);

    const allTypes = useMemo(() => {
        if (!types) return [];
        return Object.values(types).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }, [types]);

    const searchResults = useMemo(() => {
        if (!searchQuery.trim()) return null;
        const q = searchQuery.toLowerCase().trim();
        return allTypes.filter(t =>
            (t.name || '').toLowerCase().includes(q) ||
            (t.description || '').toLowerCase().includes(q) ||
            (t.id || '').toLowerCase().includes(q)
        );
    }, [allTypes, searchQuery]);

    const popularTypes = useMemo(() => {
        if (searchQuery.trim()) return [];
        return POPULAR_IDS.map(id => types?.[id]).filter(Boolean);
    }, [types, searchQuery]);

    const groupedByCategory = useMemo(() => {
        const groups = {};
        for (const t of allTypes) {
            const cat = t.category || 'custom';
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(t);
        }
        return groups;
    }, [allTypes]);

    const handleCardClick = useCallback((type) => {
        setModalPresetType(type.id);
        setModalOpen(true);
    }, []);
    const handleModalClose = useCallback(() => { setModalOpen(false); setModalPresetType(null); }, []);
    const handleModalSave = useCallback(async () => {
        await refresh();
        setModalOpen(false);
        setModalPresetType(null);
    }, [refresh]);

    const totalConnected = Object.keys(credCountMap).length;

    if (typesLoading && credsLoading) {
        return (
            <div className="vault-page">
                <div className="vault-page__loading">Loading integrations...</div>
            </div>
        );
    }

    return (
        <div className="browse-page">
            {/* Header */}
            <div className="browse-header">
                <div className="browse-header__title-row">
                    <span className="browse-header__icon">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                            <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
                        </svg>
                    </span>
                    <h1 className="browse-header__title">Integrations</h1>
                    <span className="browse-header__stats">
                        {allTypes.length} available{totalConnected > 0 ? ` · ${totalConnected} connected` : ''}
                    </span>
                </div>
                <div className="browse-header__actions">
                    <button className="vault-btn vault-btn--secondary" onClick={() => navigate('/vault')}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        </svg>
                        Vault
                    </button>
                </div>
            </div>

            {/* Search */}
            <div className="browse-search">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.4">
                    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                    className="browse-search__input"
                    type="text"
                    placeholder="Search integrations..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    autoComplete="off"
                />
                {searchQuery && (
                    <button className="browse-search__clear" onClick={() => setSearchQuery('')}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                )}
            </div>

            {/* Search results mode */}
            {searchResults !== null ? (
                <div>
                    <div className="browse-category__header" style={{ marginBottom: 14 }}>
                        <div className="browse-category__title">
                            <span>Results for &ldquo;{searchQuery}&rdquo;</span>
                            <span className="browse-category__count">{searchResults.length}</span>
                        </div>
                    </div>
                    {searchResults.length === 0 ? (
                        <div className="vault-placeholder">
                            <h2 className="vault-placeholder__title">No matches found</h2>
                            <p className="vault-placeholder__text">Try a different search term</p>
                        </div>
                    ) : (
                        <div className="browse-grid browse-grid--3col">
                            {searchResults.map(type => (
                                <Card key={type.id} type={type} count={credCountMap[type.id] || 0} onClick={handleCardClick} icons={typeIcons} />
                            ))}
                        </div>
                    )}
                </div>
            ) : (
                <>
                    {/* Popular */}
                    {popularTypes.length > 0 && (
                        <div className="browse-category">
                            <div className="browse-category__header">
                                <div className="browse-category__title">
                                    <span className="browse-category__icon">{CATEGORY_ICONS.star}</span>
                                    <span>Popular</span>
                                </div>
                            </div>
                            <div className="browse-grid browse-grid--3col">
                                {popularTypes.map(type => (
                                    <Card key={type.id} type={type} count={credCountMap[type.id] || 0} onClick={handleCardClick} icons={typeIcons} />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Categories */}
                    {CATEGORY_ORDER.map(cat => {
                        const items = groupedByCategory[cat.id];
                        if (!items || items.length === 0) return null;
                        return (
                            <CategoryGroup
                                key={cat.id}
                                category={cat}
                                items={items}
                                credCountMap={credCountMap}
                                onCardClick={handleCardClick}
                                icons={typeIcons}
                            />
                        );
                    })}
                </>
            )}

            {/* Add Credential Modal */}
            {modalOpen && (
                <IntegrationModal
                    isOpen={modalOpen}
                    onClose={handleModalClose}
                    onSave={handleModalSave}
                    editingIntegration={modalPresetType ? { integration_type: modalPresetType } : null}
                />
            )}
        </div>
    );
}
