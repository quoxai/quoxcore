/**
 * IntegrationSelect Component
 *
 * Dropdown selector for choosing integrations in workflows.
 * Only exposes integration ID and label - never actual keys.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { INTEGRATION_TYPES } from '../../config/integrationTypes';
import { VAULT_LIST } from '../../config/apiPaths';
import './integrations.css';

// Chevron down icon
const ChevronIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="6 9 12 15 18 9" />
    </svg>
);

export default function IntegrationSelect({
    type, // Integration type to filter (e.g., 'openai')
    value, // Selected integration ID
    onChange, // (id) => void
    placeholder = 'Select integration',
    disabled = false,
    className = ''
}) {
    const [integrations, setIntegrations] = useState([]);
    const [loading, setLoading] = useState(true);
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef(null);

    // Fetch integrations of this type
    useEffect(() => {
        async function fetchIntegrations() {
            try {
                setLoading(true);
                const orgId = localStorage.getItem('current_org_id');
                if (!orgId) { setIntegrations([]); return; }
                const response = await fetch(`${VAULT_LIST(orgId)}?type=${type}`, {
                    credentials: 'include'
                });

                if (!response.ok) {
                    setIntegrations([]);
                    return;
                }

                const data = await response.json();
                setIntegrations(data.credentials || []);
            } catch (err) {
                console.error('Failed to fetch integrations:', err);
                setIntegrations([]);
            } finally {
                setLoading(false);
            }
        }

        if (type) {
            fetchIntegrations();
        }
    }, [type]);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
                setIsOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Handle selection
    const handleSelect = useCallback((id) => {
        onChange?.(id);
        setIsOpen(false);
    }, [onChange]);

    // Get selected integration
    const selectedIntegration = integrations.find(i => i.id === value);
    const typeConfig = INTEGRATION_TYPES[type] || { name: type, color: '#6B7280' };

    return (
        <div className={`integration-select ${className}`} ref={dropdownRef}>
            <button
                type="button"
                className="integration-select__trigger"
                onClick={() => !disabled && setIsOpen(!isOpen)}
                disabled={disabled}
                aria-haspopup="listbox"
                aria-expanded={isOpen}
            >
                {selectedIntegration ? (
                    <>
                        <span
                            className="integration-select__trigger-icon"
                            style={{ backgroundColor: `${typeConfig.color}20`, color: typeConfig.color }}
                        >
                            {typeConfig.name.charAt(0)}
                        </span>
                        <span className="integration-select__trigger-label">
                            {selectedIntegration.label}
                        </span>
                        <span className="integration-select__trigger-preview">
                            {selectedIntegration.key_preview}
                        </span>
                    </>
                ) : (
                    <span className="integration-select__trigger-label" style={{ color: 'var(--ui-text-muted)' }}>
                        {loading ? 'Loading...' : placeholder}
                    </span>
                )}
                <span className="integration-select__trigger-arrow">
                    <ChevronIcon />
                </span>
            </button>

            {isOpen && (
                <div className="integration-select__dropdown" role="listbox">
                    {integrations.length === 0 ? (
                        <div style={{
                            padding: '16px',
                            textAlign: 'center',
                            color: 'var(--ui-text-muted)',
                            fontSize: '13px'
                        }}>
                            No {typeConfig.name} integrations found.
                            <br />
                            <Link
                                to={`/vault/credentials?type=${encodeURIComponent(type)}`}
                                style={{ color: 'var(--ui-blue)', textDecoration: 'none' }}
                            >
                                Add one in Vault
                            </Link>
                        </div>
                    ) : (
                        integrations.map(integration => (
                            <button
                                key={integration.id}
                                type="button"
                                role="option"
                                aria-selected={integration.id === value}
                                className={`integration-select__option ${
                                    integration.id === value ? 'integration-select__option--selected' : ''
                                }`}
                                onClick={() => handleSelect(integration.id)}
                            >
                                <span
                                    className="integration-select__trigger-icon"
                                    style={{ backgroundColor: `${typeConfig.color}20`, color: typeConfig.color }}
                                >
                                    {typeConfig.name.charAt(0)}
                                </span>
                                <span>{integration.label}</span>
                                <span style={{
                                    fontFamily: 'var(--ui-font-mono)',
                                    fontSize: '12px',
                                    color: 'var(--ui-text-muted)'
                                }}>
                                    {integration.key_preview}
                                </span>
                                {integration.is_default && (
                                    <span className="integration-select__option-default">
                                        Default
                                    </span>
                                )}
                            </button>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
