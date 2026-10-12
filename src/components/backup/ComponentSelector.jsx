/**
 * Component Selector
 * Allows users to select which components to backup.
 */

import { formatBytes } from '../../services/backup/backupService'

/**
 * Component icon based on category
 */
function ComponentIcon({ category, icon }) {
    const icons = {
        database: (
            <><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></>
        ),
        brain: (
            <><path d="M9.5 2a5.5 5.5 0 00-3.15 10.03A5.5 5.5 0 004 17.5"/><path d="M14.5 2a5.5 5.5 0 013.15 10.03A5.5 5.5 0 0120 17.5"/><path d="M8 14v.5"/><path d="M16 14v.5"/><path d="M12 2v20"/></>
        ),
        folder: (
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
        ),
        'git-branch': (
            <><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 01-9 9"/></>
        ),
        key: (
            <><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></>
        ),
        puzzle: (
            <><path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 01-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 10-3.214 3.214c.446.166.855.497.925.968a.979.979 0 01-.276.837l-1.61 1.61a2.404 2.404 0 01-1.705.707 2.402 2.402 0 01-1.704-.706l-1.568-1.568a1.026 1.026 0 00-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 11-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 00-.289-.877l-1.568-1.568A2.402 2.402 0 011.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 103.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0112 2c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 113.237 3.237c-.464.18-.894.527-.967 1.02z"/></>
        ),
        users: (
            <><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></>
        ),
        wrench: (
            <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>
        ),
        server: (
            <><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></>
        ),
        settings: (
            <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06c.5-.5.67-1.2.33-1.82V15"/></>
        ),
        layers: (
            <><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></>
        ),
        'folder-open': (
            <><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><line x1="2" y1="10" x2="22" y2="10"/></>
        ),
        'file-code': (
            <><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></>
        )
    }

    const iconPath = icons[icon] || icons[category] || icons.folder

    return (
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="component-icon">
            {iconPath}
        </svg>
    )
}

/**
 * Category label map
 */
const CATEGORY_LABELS = {
    core: { label: 'Core', color: '#ef4444' },
    data: { label: 'Data', color: '#3b82f6' },
    config: { label: 'Config', color: '#8b5cf6' },
    workflow: { label: 'Workflow', color: '#10b981' },
    infrastructure: { label: 'Infrastructure', color: '#f59e0b' }
}

/**
 * Component card
 */
function ComponentCard({ component, selected, onChange, disabled }) {
    const categoryConfig = CATEGORY_LABELS[component.category] || CATEGORY_LABELS.data

    return (
        <label className={`component-card ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}`}>
            <input
                type="checkbox"
                checked={selected}
                onChange={(e) => onChange(component.component_key, e.target.checked)}
                disabled={disabled}
            />
            <div className="component-card-content">
                <div className="component-card-icon">
                    <ComponentIcon category={component.category} icon={component.icon} />
                </div>
                <div className="component-card-info">
                    <span className="component-name">{component.name}</span>
                    <span className="component-description">{component.description}</span>
                    <div className="component-meta">
                        <span
                            className="component-category"
                            style={{ backgroundColor: categoryConfig.color }}
                        >
                            {categoryConfig.label}
                        </span>
                        <span className="component-size">~{formatBytes(component.estimated_size_bytes || 0)}</span>
                    </div>
                </div>
                <div className="component-checkbox-indicator">
                    {selected && (
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M20 6L9 17l-5-5"/>
                        </svg>
                    )}
                </div>
            </div>
        </label>
    )
}

/**
 * Component Selector component
 */
export function ComponentSelector({ components, selected, onChange, disabled }) {
    const handleChange = (key, checked) => {
        if (checked) {
            onChange([...selected, key])
        } else {
            onChange(selected.filter(k => k !== key))
        }
    }

    const selectAll = () => {
        onChange(components.map(c => c.component_key))
    }

    const selectNone = () => {
        onChange([])
    }

    const totalSize = components
        .filter(c => selected.includes(c.component_key))
        .reduce((sum, c) => sum + (c.estimated_size_bytes || 0), 0)

    // Group by category
    const grouped = components.reduce((acc, comp) => {
        const cat = comp.category || 'data'
        if (!acc[cat]) acc[cat] = []
        acc[cat].push(comp)
        return acc
    }, {})

    return (
        <div className="component-selector">
            <div className="component-selector-header">
                <div className="component-selector-summary">
                    <span>{selected.length} of {components.length} components selected</span>
                    <span className="component-selector-size">~{formatBytes(totalSize)}</span>
                </div>
                <div className="component-selector-actions">
                    <button onClick={selectAll} disabled={disabled}>Select All</button>
                    <button onClick={selectNone} disabled={disabled}>Select None</button>
                </div>
            </div>

            {Object.entries(grouped).map(([category, comps]) => (
                <div key={category} className="component-category-group">
                    <h4 className="component-category-title">
                        <span
                            className="component-category-dot"
                            style={{ backgroundColor: CATEGORY_LABELS[category]?.color }}
                        ></span>
                        {CATEGORY_LABELS[category]?.label || category}
                    </h4>
                    <div className="component-cards">
                        {comps.map(comp => (
                            <ComponentCard
                                key={comp.component_key}
                                component={comp}
                                selected={selected.includes(comp.component_key)}
                                onChange={handleChange}
                                disabled={disabled}
                            />
                        ))}
                    </div>
                </div>
            ))}
        </div>
    )
}

export default ComponentSelector
