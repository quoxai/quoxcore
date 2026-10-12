/**
 * CredentialPickerModal — Expanded credential browser
 *
 * Full modal view with search, type filter, health badges, and comparison.
 * Opened from CredentialPicker's "Browse all" action.
 *
 * @param {boolean} isOpen
 * @param {Function} onClose
 * @param {Function} onSelect - Called with { id, label, type, keyPreview }
 * @param {string} [type] - Pre-filter to a specific type
 * @param {string} [value] - Currently selected credential ID
 */

import { useState, useMemo } from 'react';
import Modal from '../ui/Modal';
import { useVaultCredentials } from '../../hooks/useVaultCredentials';
import { INTEGRATION_TYPES } from '../../config/integrationTypes';

const STATUS_COLORS = {
    success: '#4ade80',
    failed: '#f87171',
    untested: '#a1a1aa'
};

const SearchIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
);

const CheckIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2">
        <polyline points="20 6 9 17 4 12" />
    </svg>
);

export default function CredentialPickerModal({
    isOpen,
    onClose,
    onSelect,
    type: initialType,
    value
}) {
    const [search, setSearch] = useState('');
    const [typeFilter, setTypeFilter] = useState(initialType || '');

    const { credentials, loading } = useVaultCredentials({
        type: typeFilter || undefined
    });

    // Client-side search
    const filtered = useMemo(() => {
        if (!search.trim()) return credentials;
        const q = search.toLowerCase();
        return credentials.filter(c =>
            (c.label || '').toLowerCase().includes(q) ||
            (c.key_preview || '').toLowerCase().includes(q) ||
            (c.description || '').toLowerCase().includes(q) ||
            (c.integration_type || '').toLowerCase().includes(q)
        );
    }, [credentials, search]);

    // Available types for filter dropdown
    const availableTypes = useMemo(() => {
        const types = new Set(credentials.map(c => c.integration_type));
        return Array.from(types).sort();
    }, [credentials]);

    const handleSelect = (cred) => {
        onSelect({
            id: cred.id,
            label: cred.label,
            type: cred.integration_type,
            keyPreview: cred.key_preview
        });
        onClose();
    };

    const getTypeName = (typeId) => {
        return INTEGRATION_TYPES[typeId]?.name || typeId;
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="lg">
            <Modal.Header title="Select Credential" onClose={onClose} />
            <Modal.Body>
                <div className="cred-modal">
                    {/* Toolbar: search + type filter */}
                    <div className="cred-modal__toolbar">
                        <div className="cred-modal__search">
                            <SearchIcon />
                            <input
                                type="text"
                                className="cred-modal__search-input"
                                placeholder="Search by label, key, or description..."
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                autoFocus
                            />
                        </div>
                        {!initialType && (
                            <select
                                className="cred-modal__type-filter"
                                value={typeFilter}
                                onChange={(e) => setTypeFilter(e.target.value)}
                            >
                                <option value="">All types</option>
                                {availableTypes.map(t => (
                                    <option key={t} value={t}>{getTypeName(t)}</option>
                                ))}
                            </select>
                        )}
                    </div>

                    {/* Results */}
                    <div className="cred-modal__list">
                        {loading && (
                            <div className="cred-modal__empty">Loading credentials...</div>
                        )}

                        {!loading && filtered.length === 0 && (
                            <div className="cred-modal__empty">
                                {search ? 'No credentials match your search' : 'No credentials available'}
                            </div>
                        )}

                        {filtered.map(cred => {
                            const isSelected = cred.id === value;
                            const healthStatus = cred.test_status || cred.last_test_status || 'untested';

                            return (
                                <button
                                    key={cred.id}
                                    className={`cred-modal__item ${isSelected ? 'cred-modal__item--selected' : ''}`}
                                    onClick={() => handleSelect(cred)}
                                >
                                    {/* Health dot */}
                                    <span
                                        className="cred-picker__status-dot"
                                        style={{ background: STATUS_COLORS[healthStatus] || STATUS_COLORS.untested }}
                                    />

                                    {/* Info */}
                                    <div className="cred-modal__item-info">
                                        <div className="cred-modal__item-row">
                                            <span className="cred-modal__item-label">{cred.label}</span>
                                            {cred.is_default && (
                                                <span className="cred-picker__badge cred-picker__badge--default">Default</span>
                                            )}
                                            {cred.visibility === 'personal' && (
                                                <span className="cred-picker__badge cred-picker__badge--personal">Personal</span>
                                            )}
                                        </div>
                                        <div className="cred-modal__item-meta">
                                            <span className="cred-modal__item-type">{getTypeName(cred.integration_type)}</span>
                                            <span className="cred-picker__preview">{cred.key_preview}</span>
                                            {cred.description && (
                                                <span className="cred-modal__item-desc">{cred.description}</span>
                                            )}
                                        </div>
                                    </div>

                                    {/* Selected check */}
                                    {isSelected && <CheckIcon />}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </Modal.Body>
        </Modal>
    );
}
