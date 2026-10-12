/**
 * OrgView - Organization Management
 *
 * Manage organization settings, teams, members, and structure.
 */

import { useState, useEffect } from 'react';
import { useOutletContext, Link } from 'react-router-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useAuth } from '../../contexts/AuthContext';
import { PageSection, PageGrid, PageCard } from '../../components/layout';
import Button from '../../components/ui/Button';
import { Input, FormField } from '../../components/ui/Input';
import './views.css';

function MemberCard({ member, onRemove }) {
    return (
        <div className="member-card">
            <div className="member-card__avatar">
                {member.display_name?.[0]?.toUpperCase() || member.email?.[0]?.toUpperCase() || 'U'}
            </div>
            <div className="member-card__info">
                <div className="member-card__name">{member.display_name || member.email}</div>
                <div className="member-card__email">{member.email}</div>
            </div>
            <div className="member-card__role">{member.role}</div>
            <div className="member-card__actions">
                <Button size="sm" variant="ghost" onClick={() => onRemove?.(member)} aria-label={`Remove ${member.display_name || member.email}`}>
                    Remove
                </Button>
            </div>
        </div>
    );
}

function TeamCard({ team, onSelect }) {
    return (
        <div className="team-card" onClick={() => onSelect?.(team)}>
            <div className="team-card__icon">##</div>
            <div className="team-card__info">
                <div className="team-card__name">{team.name}</div>
                <div className="team-card__count">{team.member_count} members</div>
            </div>
        </div>
    );
}

function OrgView() {
    const { halState } = useOutletContext() || {};
    const { user } = useAuth();
    const { currentOrg, orgs, selectOrg, isOrgAdmin } = useWorkspace();
    const [members, setMembers] = useState([]);
    const [teams, setTeams] = useState([]);
    const [divisions, setDivisions] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!currentOrg) return;
        const orgId = currentOrg.id;
        const headers = { 'Content-Type': 'application/json' };

        Promise.all([
            fetch(`/api/orgs/${orgId}/members`, { credentials: 'include', headers }).then(r => r.ok ? r.json() : { members: [] }),
            fetch(`/api/orgs/${orgId}/teams`, { credentials: 'include', headers }).then(r => r.ok ? r.json() : { teams: [] }),
            fetch(`/api/orgs/${orgId}/divisions`, { credentials: 'include', headers }).then(r => r.ok ? r.json() : { divisions: [] }),
        ]).then(([membersData, teamsData, divisionsData]) => {
            setMembers(membersData.members || []);
            setTeams(teamsData.teams || []);
            setDivisions(divisionsData.divisions || []);
        }).catch(err => {
            console.error('Error loading org data:', err);
        }).finally(() => {
            setLoading(false);
        });
    }, [currentOrg]);

    if (!currentOrg) {
        return (
            <div className="org-view view-page">
                <div className="empty-state">
                    <div className="empty-state__icon">||</div>
                    <div className="empty-state__title">No Organization Selected</div>
                    <div className="empty-state__description">
                        Select or create an organization to manage settings.
                    </div>
                    <Button variant="primary">Create Organization</Button>
                </div>
            </div>
        );
    }

    if (loading) {
        return <div className="loading-state">Loading organization...</div>;
    }

    return (
        <div className="org-view view-page">
            {/* Org Overview */}
            <PageSection title="Overview">
                <PageGrid columns={4}>
                    <PageCard>
                        <div className="stat-card">
                            <div className="stat-card__value">{members.length}</div>
                            <div className="stat-card__label">Members</div>
                        </div>
                    </PageCard>
                    <PageCard>
                        <div className="stat-card">
                            <div className="stat-card__value">{teams.length}</div>
                            <div className="stat-card__label">Teams</div>
                        </div>
                    </PageCard>
                    <PageCard>
                        <div className="stat-card">
                            <div className="stat-card__value">{divisions.length}</div>
                            <div className="stat-card__label">Divisions</div>
                        </div>
                    </PageCard>
                    <PageCard>
                        <div className="stat-card">
                            <div className="stat-card__value">Free</div>
                            <div className="stat-card__label">Plan</div>
                        </div>
                    </PageCard>
                </PageGrid>
            </PageSection>

            {/* Teams */}
            <PageSection
                title="Teams"
                badge={`${teams.length} teams`}
                actions={isOrgAdmin && <Button size="sm" variant="secondary">Create Team</Button>}
            >
                <PageGrid columns={3}>
                    {teams.map(team => (
                        <TeamCard key={team.id} team={team} onSelect={(t) => console.log('Select team', t)} />
                    ))}
                </PageGrid>
            </PageSection>

            {/* Members */}
            <PageSection
                title="Members"
                badge={`${members.length} members`}
                actions={isOrgAdmin && <Button size="sm" variant="secondary">Invite Member</Button>}
            >
                <div className="members-list">
                    {members.map(member => (
                        <MemberCard
                            key={member.id}
                            member={member}
                            onRemove={isOrgAdmin ? (m) => console.log('Remove', m) : undefined}
                        />
                    ))}
                </div>
            </PageSection>

            {/* Settings (Admin Only) */}
            {isOrgAdmin && (
                <PageSection title="Organization Settings" collapsible>
                    <PageCard>
                        <div className="org-settings">
                            <FormField label="Organization Name" htmlFor="org-name">
                                <Input id="org-name" value={currentOrg.name} readOnly />
                            </FormField>
                            <FormField label="Slug" htmlFor="org-slug">
                                <Input id="org-slug" value={currentOrg.slug || currentOrg.id} readOnly />
                            </FormField>
                            <div className="org-settings__actions">
                                <Button variant="danger">Delete Organization</Button>
                            </div>
                        </div>
                    </PageCard>
                </PageSection>
            )}

            {/* Switch Organization */}
            {orgs.length > 1 && (
                <PageSection title="Switch Organization" collapsible>
                    <div className="org-list">
                        {orgs.map(org => (
                            <Button
                                key={org.id}
                                variant={org.id === currentOrg.id ? 'primary' : 'secondary'}
                                onClick={() => selectOrg(org)}
                                aria-pressed={org.id === currentOrg.id}
                            >
                                {org.name}
                            </Button>
                        ))}
                    </div>
                </PageSection>
            )}
        </div>
    );
}

export default OrgView;
