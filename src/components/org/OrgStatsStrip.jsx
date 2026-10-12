/**
 * OrgStatsStrip — condensed horizontal stats strip for /orgs/:orgId.
 *
 * Mirrors the pattern used on /orgs (the dashboard-style .quick-stats-strip).
 * Single glass surface, inline colour-coded tiles. No panel-on-panel.
 *
 * Data from useScopeData.scopeStats.
 */

const Icon = {
    divisions: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75">
            <polygon points="12 2 2 7 12 12 22 7 12 2" />
            <polyline points="2 17 12 22 22 17" />
            <polyline points="2 12 12 17 22 12" />
        </svg>
    ),
    departments: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75">
            <line x1="4" y1="9" x2="20" y2="9" />
            <line x1="4" y1="15" x2="20" y2="15" />
            <line x1="10" y1="3" x2="8" y2="21" />
            <line x1="16" y1="3" x2="14" y2="21" />
        </svg>
    ),
    teams: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
    ),
    members: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
        </svg>
    ),
    assistants: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75">
            <rect x="3" y="11" width="18" height="10" rx="2" />
            <circle cx="12" cy="5" r="3" />
        </svg>
    ),
    agents: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
        </svg>
    ),
    workflows: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75">
            <circle cx="18" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <path d="M6 21V9a9 9 0 0 0 9 9" />
        </svg>
    ),
    files: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
        </svg>
    ),
    actions: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
    ),
};

// Tile order + accent colours. Keep consistent with ScopeHUD palette.
// `scopes` field controls which entity types show each tile.
const TILE_DEFS = [
    { key: 'divisions',   label: 'Divisions',   colour: '#a78bfa', scopes: ['org'] },
    { key: 'departments', label: 'Depts',       colour: '#3b82f6', scopes: ['org', 'division'] },
    { key: 'teams',       label: 'Teams',       colour: '#22c55e', scopes: ['org', 'division', 'department'] },
    { key: 'members',     label: 'Members',     colour: '#f59e0b', scopes: ['org', 'division', 'department'] },
    { key: 'assistants',  label: 'Assistants',  colour: '#ec4899', scopes: ['org', 'division', 'department'] },
    { key: 'agents',      label: 'Agents',      colour: '#8b5cf6', scopes: ['org', 'division', 'department'] },
    { key: 'workflows',   label: 'Workflows',   colour: '#14b8a6', scopes: ['org', 'division', 'department'] },
    { key: 'files',       label: 'Files',       colour: 'rgba(255,255,255,0.75)', scopes: ['org', 'division', 'department'] },
    { key: 'actions',     label: 'Actions',     colour: '#eab308', scopes: ['org', 'division', 'department'] },
];

export default function OrgStatsStrip({ stats = {}, entityType = 'org' }) {
    const visible = TILE_DEFS.filter(d => d.scopes.includes(entityType));
    // Aim for 2 rows — columns = ceil(N/2). 9→5, 8→4, 7→4, 6→3.
    const cols = Math.max(3, Math.ceil(visible.length / 2));

    return (
        <div className="quick-stats-strip" style={{ '--stats-cols': cols }}>
            {visible.map(def => {
                const value = stats[def.key] ?? 0;
                return (
                    <div key={def.key} className="quick-stat-tile" title={def.label}>
                        <span className="quick-stat-tile__icon" style={{ color: def.colour }}>
                            {Icon[def.key]}
                        </span>
                        <span className="quick-stat-tile__value" style={{ color: def.colour }}>
                            {value}
                        </span>
                        <span className="quick-stat-tile__label">{def.label}</span>
                    </div>
                );
            })}
        </div>
    );
}
