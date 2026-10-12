/**
 * ScopeHUD — Command-centre stats HUD for scope dashboard pages.
 *
 * Displays a grid of stat tiles showing key metrics for the current scope.
 * Adapts which stats are shown based on entity type (org/division/department).
 */

import './ScopeDashboard.css';

// ---------------------------------------------------------------------------
// Icons (18px, stroke-only)
// ---------------------------------------------------------------------------

const DivisionIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polygon points="12 2 2 7 12 12 22 7 12 2" />
        <polyline points="2 17 12 22 22 17" />
        <polyline points="2 12 12 17 22 12" />
    </svg>
);

const DepartmentIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
        <line x1="4" y1="9" x2="20" y2="9" />
        <line x1="4" y1="15" x2="20" y2="15" />
        <line x1="10" y1="3" x2="8" y2="21" />
        <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
);

const TeamIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
);

const MemberIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
    </svg>
);

const AssistantIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="11" width="18" height="10" rx="2" />
        <circle cx="12" cy="5" r="3" />
        <circle cx="9" cy="16" r="1" fill="currentColor" />
        <circle cx="15" cy="16" r="1" fill="currentColor" />
    </svg>
);

const AgentIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
    </svg>
);

const WorkflowIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="18" cy="18" r="3" />
        <circle cx="6" cy="6" r="3" />
        <path d="M6 21V9a9 9 0 0 0 9 9" />
    </svg>
);

const FileIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
);

const ActionIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
);

// ---------------------------------------------------------------------------
// Stat definitions — order matters, scopes controls visibility per level
// ---------------------------------------------------------------------------

const STAT_DEFS = [
    { key: 'divisions',   label: 'Divisions',   icon: <DivisionIcon />,   colour: '#a78bfa', scopes: ['org'] },
    { key: 'departments', label: 'Departments', icon: <DepartmentIcon />, colour: '#3b82f6', scopes: ['org', 'division'] },
    { key: 'teams',       label: 'Teams',       icon: <TeamIcon />,       colour: '#22c55e', scopes: ['org', 'division', 'department'] },
    { key: 'members',     label: 'Members',     icon: <MemberIcon />,     colour: '#f59e0b', scopes: ['org', 'division', 'department'] },
    { key: 'assistants',  label: 'Assistants',  icon: <AssistantIcon />,  colour: '#ec4899', scopes: ['org', 'division', 'department'] },
    { key: 'agents',      label: 'Agents',      icon: <AgentIcon />,      colour: '#8b5cf6', scopes: ['org', 'division', 'department'] },
    { key: 'workflows',   label: 'Workflows',   icon: <WorkflowIcon />,   colour: '#14b8a6', scopes: ['org', 'division', 'department'] },
    { key: 'files',       label: 'Files',       icon: <FileIcon />,       colour: '#64748b', scopes: ['org', 'division', 'department'] },
    { key: 'actions',     label: 'Actions',     icon: <ActionIcon />,     colour: '#eab308', scopes: ['org', 'division', 'department'] },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ScopeHUD({ entityType, stats = {}, accentColour }) {
    const visibleStats = STAT_DEFS.filter(s => s.scopes.includes(entityType));

    return (
        <div className="scope-hud" style={{ '--scope-accent': accentColour }}>
            {visibleStats.map(def => {
                const count = stats[def.key] ?? 0;
                const hasData = count > 0;
                return (
                    <div
                        key={def.key}
                        className={`scope-hud__tile ${hasData ? '' : 'scope-hud__tile--empty'}`}
                        style={{ '--tile-colour': def.colour }}
                    >
                        <div className="scope-hud__tile-icon">{def.icon}</div>
                        <div className="scope-hud__tile-body">
                            <div className="scope-hud__tile-count">{count}</div>
                            <div className="scope-hud__tile-label">{def.label}</div>
                        </div>
                        {hasData && <div className="scope-hud__tile-bar" />}
                    </div>
                );
            })}
        </div>
    );
}
