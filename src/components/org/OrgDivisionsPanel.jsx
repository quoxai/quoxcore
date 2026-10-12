/**
 * OrgDivisionsPanel — rebuilt from scratch.
 *
 * No .qx-card wrapper (its overflow: hidden was clipping content).
 * Plain divs, flow naturally, no flex/grid height pinning.
 */

import { useNavigate } from 'react-router-dom';
import Button from '../ui/Button';

const PALETTE = [
    '#a78bfa', '#3b82f6', '#06b6d4', '#14b8a6',
    '#22c55e', '#eab308', '#f59e0b', '#ec4899',
];

const Plus = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
);

const Arrow = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="5" y1="12" x2="19" y2="12" />
        <polyline points="12 5 19 12 12 19" />
    </svg>
);

const Layers = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <polygon points="12 2 2 7 12 12 22 7 12 2" />
        <polyline points="2 17 12 22 22 17" />
        <polyline points="2 12 12 17 22 12" />
    </svg>
);

export default function OrgDivisionsPanel({ divisions = [], isAdmin = false, onCreateDivision }) {
    const navigate = useNavigate();

    return (
        <section className="divpanel">
            <header className="divpanel__head">
                <div className="divpanel__title-wrap">
                    <h3 className="divpanel__title">Divisions</h3>
                    <span className="divpanel__count">{divisions.length}</span>
                </div>
                {isAdmin && onCreateDivision && (
                    <Button size="sm" variant="secondary" onClick={onCreateDivision}>
                        <Plus /><span>Create Division</span>
                    </Button>
                )}
            </header>

            {divisions.length === 0 ? (
                <div className="divpanel__empty">
                    <div className="divpanel__empty-icon"><Layers /></div>
                    <div className="divpanel__empty-title">No divisions yet</div>
                    <p className="divpanel__empty-msg">
                        Divisions group departments and teams by function. Each gets its own scope and AI assistant.
                    </p>
                    {isAdmin && onCreateDivision && (
                        <Button size="sm" variant="primary" onClick={onCreateDivision}>
                            <Plus /><span>Create the first Division</span>
                        </Button>
                    )}
                </div>
            ) : (
                <div className="divpanel__list">
                    {divisions.map((d, i) => (
                        <Card
                            key={d.id}
                            division={d}
                            accent={PALETTE[i % PALETTE.length]}
                            onClick={() => navigate(`/divisions/${d.id}`)}
                        />
                    ))}
                </div>
            )}
        </section>
    );
}

function Card({ division, accent, onClick }) {
    const deps = division.department_count ?? 0;
    const teams = division.team_count ?? 0;
    const members = division.member_count ?? 0;

    return (
        <article
            className="divcard"
            style={{ '--accent': accent }}
            onClick={onClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
        >
            <div className="divcard__top">
                <div className="divcard__iconbox"><Layers /></div>
                <div className="divcard__identity">
                    <div className="divcard__name">{division.name}</div>
                    {division.slug && <div className="divcard__slug">{division.slug}</div>}
                </div>
                <span className="divcard__open">Open <Arrow /></span>
            </div>

            {division.description && (
                <p className="divcard__desc">{division.description}</p>
            )}

            <div className="divcard__stats">
                <span className="divcard__stat divcard__stat--primary">
                    <span className="divcard__stat-num">{deps}</span>
                    <span className="divcard__stat-label">Departments</span>
                </span>
                <span className="divcard__stat">
                    <span className="divcard__stat-num">{teams}</span>
                    <span className="divcard__stat-label">Teams</span>
                </span>
                <span className="divcard__stat">
                    <span className="divcard__stat-num">{members}</span>
                    <span className="divcard__stat-label">Members</span>
                </span>
            </div>
        </article>
    );
}
