/**
 * OrgTeamsPanel — rebuilt from scratch.
 *
 * Same pattern as OrgDivisionsPanel (.divpanel): no .qx-card wrapper,
 * plain block glass via .teampanel. Clip-path keeps shimmer contained
 * without clipping content. Descriptions flow (no nowrap/ellipsis).
 */

import { useNavigate } from 'react-router-dom';
import Button from '../ui/Button';

const Plus = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
);

const TeamIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
);

const Arrow = () => (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="5" y1="12" x2="19" y2="12" />
        <polyline points="12 5 19 12 12 19" />
    </svg>
);

export default function OrgTeamsPanel({ teams = [], isAdmin = false, onCreateTeam }) {
    const navigate = useNavigate();

    return (
        <section className="teampanel">
            <header className="teampanel__head">
                <div className="teampanel__title-wrap">
                    <h3 className="teampanel__title">Teams</h3>
                    <span className="teampanel__count">{teams.length}</span>
                </div>
                {isAdmin && onCreateTeam && (
                    <Button size="sm" variant="secondary" onClick={onCreateTeam}>
                        <Plus /><span>Create Team</span>
                    </Button>
                )}
            </header>

            {teams.length === 0 ? (
                <div className="teampanel__empty">
                    <div className="teampanel__empty-icon"><TeamIcon /></div>
                    <div className="teampanel__empty-title">No teams yet</div>
                    <p className="teampanel__empty-msg">
                        Teams are the working units of your organisation. Create them at the org
                        level or attach them to departments for scoped collaboration.
                    </p>
                </div>
            ) : (
                <div className="teampanel__list">
                    {teams.map(team => (
                        <TeamCard key={team.id} team={team} onClick={() => navigate(`/teams/${team.id}`)} />
                    ))}
                </div>
            )}
        </section>
    );
}

function TeamCard({ team, onClick }) {
    return (
        <article
            className="teamcard"
            role="button"
            tabIndex={0}
            onClick={onClick}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
        >
            <div className="teamcard__iconbox"><TeamIcon /></div>
            <div className="teamcard__body">
                <div className="teamcard__name">{team.name}</div>
                {team.description && (
                    <p className="teamcard__desc">{team.description}</p>
                )}
                {team.slug && (
                    <div className="teamcard__slug">{team.slug}</div>
                )}
            </div>
            <div className="teamcard__meta">
                <div className="teamcard__count">
                    <span className="teamcard__count-num">{team.member_count ?? 0}</span>
                    <span className="teamcard__count-label">members</span>
                </div>
                <span className="teamcard__arrow"><Arrow /></span>
            </div>
        </article>
    );
}
