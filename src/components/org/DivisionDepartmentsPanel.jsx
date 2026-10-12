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

const Hash = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <line x1="4" y1="9" x2="20" y2="9" />
        <line x1="4" y1="15" x2="20" y2="15" />
        <line x1="10" y1="3" x2="8" y2="21" />
        <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
);

export default function DivisionDepartmentsPanel({ departments = [], isAdmin = false, onCreateDepartment }) {
    const navigate = useNavigate();

    return (
        <section className="divpanel">
            <header className="divpanel__head">
                <div className="divpanel__title-wrap">
                    <h3 className="divpanel__title">Departments</h3>
                    <span className="divpanel__count">{departments.length}</span>
                </div>
                {isAdmin && onCreateDepartment && (
                    <Button size="sm" variant="secondary" onClick={onCreateDepartment}>
                        <Plus /><span>Create Department</span>
                    </Button>
                )}
            </header>

            {departments.length === 0 ? (
                <div className="divpanel__empty">
                    <div className="divpanel__empty-icon"><Hash /></div>
                    <div className="divpanel__empty-title">No departments yet</div>
                    <p className="divpanel__empty-msg">
                        Departments group teams within this division. Each gets its own scope and AI assistant.
                    </p>
                    {isAdmin && onCreateDepartment && (
                        <Button size="sm" variant="primary" onClick={onCreateDepartment}>
                            <Plus /><span>Create the first Department</span>
                        </Button>
                    )}
                </div>
            ) : (
                <div className="divpanel__list">
                    {departments.map((d, i) => (
                        <Card
                            key={d.id}
                            department={d}
                            accent={PALETTE[i % PALETTE.length]}
                            onClick={() => navigate(`/departments/${d.id}`)}
                        />
                    ))}
                </div>
            )}
        </section>
    );
}

function Card({ department, accent, onClick }) {
    const teams = department.team_count ?? 0;
    const members = department.member_count ?? 0;

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
                <div className="divcard__iconbox"><Hash /></div>
                <div className="divcard__identity">
                    <div className="divcard__name">{department.name}</div>
                    {department.slug && <div className="divcard__slug">{department.slug}</div>}
                </div>
                <span className="divcard__open">Open <Arrow /></span>
            </div>

            {department.description && (
                <p className="divcard__desc">{department.description}</p>
            )}

            <div className="divcard__stats">
                <span className="divcard__stat divcard__stat--primary">
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
