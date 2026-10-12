/**
 * ModelSelector — Stream C Phase 2
 *
 * Compact provider/model selector for the chat toolbar.
 * Shows current model, opens dropdown to switch providers and models.
 * Reads defaults from the active assistant's llm config.
 */

import { useState, useRef, useEffect, useMemo } from 'react';
import { MODEL_CATALOG, getModelsForProvider, getDefaultModel } from '../../config/modelCatalog';
import { INTEGRATION_TYPES } from '../../config/integrationTypes';
import './ModelSelector.css';

const cpuIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="4" width="16" height="16" rx="2"/>
        <rect x="9" y="9" width="6" height="6"/>
        <line x1="9" y1="1" x2="9" y2="4"/>
        <line x1="15" y1="1" x2="15" y2="4"/>
        <line x1="9" y1="20" x2="9" y2="23"/>
        <line x1="15" y1="20" x2="15" y2="23"/>
        <line x1="20" y1="9" x2="23" y2="9"/>
        <line x1="20" y1="14" x2="23" y2="14"/>
        <line x1="1" y1="9" x2="4" y2="9"/>
        <line x1="1" y1="14" x2="4" y2="14"/>
    </svg>
);

const chevronIcon = (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9"/>
    </svg>
);

// Unified to Quox palette (no random blues / off-palette greens/violets)
const tierColors = {
    fast: '#30ff90',      // Quox green
    smart: '#38bdf8',     // Quox cyan
    frontier: '#a855f7'   // Quox purple
};

/**
 * @param {Object} props
 * @param {string} props.provider - Currently selected provider ID
 * @param {string} props.model - Currently selected model ID
 * @param {function} props.onChange - Called with (provider, model) on selection
 * @param {string} [props.defaultProvider] - Agent's default provider
 * @param {string} [props.defaultModel] - Agent's default model
 * @param {boolean} [props.disabled] - Disable selection
 */
export default function ModelSelector({ provider, model, onChange, defaultProvider, defaultModel, disabled = false }) {
    const [open, setOpen] = useState(false);
    const dropdownRef = useRef(null);

    // Close on outside click
    useEffect(() => {
        if (!open) return;
        const handleClick = (e) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [open]);

    // Current model display info
    const currentProvider = MODEL_CATALOG[provider];
    const currentModels = getModelsForProvider(provider);
    const currentModel = currentModels.find(m => m.id === model) || currentModels.find(m => m.default) || currentModels[0];

    // Short display name
    const displayName = useMemo(() => {
        if (!currentModel) return 'Select model';
        return currentModel.name;
    }, [currentModel]);

    const isDefault = provider === defaultProvider && model === defaultModel;

    const handleSelect = (newProvider, newModel) => {
        onChange(newProvider, newModel);
        setOpen(false);
    };

    const handleResetDefault = () => {
        if (defaultProvider && defaultModel) {
            onChange(defaultProvider, defaultModel);
            setOpen(false);
        }
    };

    return (
        <div ref={dropdownRef} style={styles.container}>
            <button
                style={{ ...styles.trigger, ...(disabled ? styles.triggerDisabled : {}) }}
                onClick={() => !disabled && setOpen(!open)}
                title={`${currentProvider?.name || provider}: ${currentModel?.name || model}`}
                disabled={disabled}
            >
                <span style={{ ...styles.providerDot, backgroundColor: INTEGRATION_TYPES[provider]?.color || '#6b7280' }} />
                <span style={styles.triggerText}>{displayName}</span>
                {!isDefault && (
                    <span style={styles.customBadge}>custom</span>
                )}
                <span style={{ ...styles.chevron, transform: open ? 'rotate(180deg)' : 'none' }}>{chevronIcon}</span>
            </button>

            {open && (
                <div className="ms-dropdown">
                    {/* Reset to default */}
                    {!isDefault && defaultProvider && (
                        <button style={styles.resetBtn} onClick={handleResetDefault}>
                            Reset to agent default
                        </button>
                    )}

                    {/* Provider sections */}
                    {Object.values(MODEL_CATALOG).map(prov => {
                        const provColor = INTEGRATION_TYPES[prov.vaultType]?.color || '#6b7280';
                        return (
                            <div key={prov.id} style={styles.providerSection}>
                                <div style={styles.providerHeader}>
                                    <span style={{ ...styles.providerDot, backgroundColor: provColor }} />
                                    <span style={styles.providerName}>{prov.name}</span>
                                </div>
                                {prov.models.map(m => {
                                    const isSelected = prov.id === provider && m.id === model;
                                    return (
                                        <button
                                            key={m.id}
                                            style={{
                                                ...styles.modelItem,
                                                ...(isSelected ? styles.modelItemSelected : {})
                                            }}
                                            onClick={() => handleSelect(prov.id, m.id)}
                                        >
                                            <span style={styles.modelName}>{m.name}</span>
                                            <span style={{
                                                ...styles.tierBadge,
                                                color: tierColors[m.tier] || '#6b7280',
                                                borderColor: tierColors[m.tier] || '#6b7280'
                                            }}>
                                                {m.tier}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

const styles = {
    container: {
        position: 'relative',
        display: 'inline-flex'
    },
    trigger: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '7px 14px',
        background: 'rgba(255,255,255,0.08)',
        backdropFilter: 'blur(32px) saturate(1.8)',
        WebkitBackdropFilter: 'blur(32px) saturate(1.8)',
        border: '1px solid rgba(255,255,255,0.22)',
        borderRadius: '999px',
        color: '#ffffff',
        fontSize: '12px',
        cursor: 'pointer',
        outline: 'none',
        transition: 'border-color 0.15s ease, background 0.15s ease',
        whiteSpace: 'nowrap',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.22), inset 0 -1px 0 rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.35)'
    },
    triggerDisabled: {
        cursor: 'not-allowed',
        opacity: 0.68
    },
    triggerText: {
        maxWidth: '150px',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
    },
    providerDot: {
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        flexShrink: 0
    },
    customBadge: {
        fontSize: '9px',
        color: '#a855f7',
        background: 'rgba(168, 85, 247, 0.14)',
        padding: '1px 5px',
        borderRadius: '4px',
        textTransform: 'uppercase',
        letterSpacing: '0.04em'
    },
    chevron: {
        display: 'inline-flex',
        transition: 'transform 0.2s'
    },
    dropdown: {
        position: 'absolute',
        top: 'calc(100% + 6px)',
        left: 0,
        zIndex: 1000,
        // Opaque enough to stop bleed-through. Dark base so scrolled content
        // behind it can't read; backdrop-filter adds the blur polish.
        background: 'rgba(14, 16, 26, 0.88)',
        backdropFilter: 'blur(40px) saturate(2.2)',
        WebkitBackdropFilter: 'blur(40px) saturate(2.2)',
        border: '1px solid rgba(255,255,255,0.22)',
        borderRadius: '14px',
        boxShadow: '0 24px 64px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.22)',
        maxHeight: '360px',
        overflowY: 'auto',
        minWidth: '260px',
        padding: '6px'
    },
    resetBtn: {
        display: 'block',
        width: '100%',
        padding: '6px 10px',
        background: 'none',
        border: 'none',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        color: '#38bdf8',
        fontSize: '11px',
        cursor: 'pointer',
        textAlign: 'left',
        marginBottom: '4px'
    },
    providerSection: {
        marginBottom: '2px'
    },
    providerHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 10px 2px',
        fontSize: '10px',
        fontWeight: '600',
        color: 'var(--text-tertiary, #71717a)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em'
    },
    providerName: {
        // inherits from providerHeader
    },
    modelItem: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        padding: '5px 10px 5px 22px',
        background: 'none',
        border: 'none',
        borderRadius: '4px',
        color: 'var(--text-secondary, #a1a1aa)',
        fontSize: '12px',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background 0.15s'
    },
    modelItemSelected: {
        background: 'rgba(56, 189, 248, 0.12)',
        color: 'var(--text-primary, #f4f4f5)'
    },
    modelName: {
        flex: 1
    },
    tierBadge: {
        fontSize: '9px',
        padding: '1px 4px',
        borderRadius: '3px',
        border: '1px solid',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        flexShrink: 0
    }
};
