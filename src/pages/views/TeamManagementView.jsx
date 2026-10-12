/**
 * TeamManagementView - Team Dashboard
 *
 * Comprehensive team management with:
 * - Profile editing
 * - Members management with roles
 * - Team assistant
 * - Coming soon: Projects, Workflows
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate, useOutletContext } from 'react-router-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useAuth } from '../../contexts/AuthContext';
import { PageHeader, PageSection, PageGrid, PageCard } from '../../components/layout';
import Button from '../../components/ui/Button';
import { Input, FormField } from '../../components/ui/Input';
import { Empty } from '../../components/ui/Empty';
import {
    ScopeAssistantCard,
    MembersList,
    ConfirmModal
} from '../../components/org';
import InviteMemberModal from '../../components/org/InviteMemberModal';
import './views.css';

// Mock data for dev mode
const DEV_MOCK_TEAM = {
    id: 'team-001',
    name: 'Frontend',
    slug: 'frontend',
    description: 'UI/UX development team responsible for the web dashboard and mobile apps.',
    member_count: 4,
    my_role: 'admin',
    project_count: 3,
    workflow_count: 2,
    members: [
        { id: '1', user_id: '1', display_name: 'Admin User', primary_email: 'admin@example.com', role: 'admin', avatar_url: null },
        { id: '2', user_id: '2', display_name: 'Sarah Chen', primary_email: 'sarah@example.com', role: 'member', avatar_url: null },
        { id: '3', user_id: '3', display_name: 'Mike Johnson', primary_email: 'mike@example.com', role: 'member', avatar_url: null },
        { id: '4', user_id: '4', display_name: 'Lisa Park', primary_email: 'lisa@example.com', role: 'viewer', avatar_url: null },
    ]
};

// Icons
const BackIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="19" y1="12" x2="5" y2="12"/>
        <polyline points="12 19 5 12 12 5"/>
    </svg>
);

const TeamIcon = () => (
    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
);

const PlusIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
);

function TeamManagementView() {
    const { teamId } = useParams();
    const navigate = useNavigate();
    const { halState } = useOutletContext() || {};
    const { user, authFetch, isDevMode } = useAuth();
    const { currentOrg, orgs, updateTeam, deleteTeam, addTeamMember, updateTeamMemberRole, removeTeamMember, selectOrg, selectScope } = useWorkspace();

    const [team, setTeam] = useState(null);
    const [parentOrg, setParentOrg] = useState(null);
    const [members, setMembers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showAddMember, setShowAddMember] = useState(false);
    const [activeTab, setActiveTab] = useState('workflows');
    const [inboxItems, setInboxItems] = useState([]);
    const [inboxLoading, setInboxLoading] = useState(false);

    // Editable fields
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [hasChanges, setHasChanges] = useState(false);

    // Check if we're in dev mode
    const isDevOrg = currentOrg?.id === 'dev-org-001' || isDevMode || user?.is_dev_mode;

    // Permission check - compute from parent org, not currentOrg
    const parentOrgRole = parentOrg?.membership?.role || parentOrg?.role;
    const isOrgAdmin = ['owner', 'admin'].includes(parentOrgRole);
    const isTeamAdmin = team?.my_role === 'admin' || isOrgAdmin;

    useEffect(() => {
        const loadTeam = async () => {
            if (!currentOrg) {
                setLoading(false);
                return;
            }

            setLoading(true);
            try {
                // Find and set the parent org
                const foundParentOrg = orgs.find(o => o.id === currentOrg.id);
                if (foundParentOrg) {
                    setParentOrg(foundParentOrg);
                }

                if (isDevOrg) {
                    // Use mock data in dev mode
                    await new Promise(r => setTimeout(r, 300));
                    if (teamId?.startsWith('team-')) {
                        setTeam({ ...DEV_MOCK_TEAM, id: teamId, org_id: currentOrg.id, org_name: currentOrg.name });
                        setMembers(DEV_MOCK_TEAM.members);
                        setName(DEV_MOCK_TEAM.name);
                        setDescription(DEV_MOCK_TEAM.description);
                    } else {
                        setTeam(null);
                    }
                } else {
                    // Fetch from API
                    const res = await authFetch(`/api/orgs/${currentOrg.id}/teams/${teamId}`);
                    if (res.ok) {
                        const data = await res.json();
                        setTeam({ ...data.team, org_id: currentOrg.id, org_name: currentOrg.name });
                        setMembers(data.team.members || []);
                        setName(data.team.name || '');
                        setDescription(data.team.description || '');
                    } else {
                        setTeam(null);
                    }
                }
            } catch (err) {
                console.error('Failed to load team:', err);
                setTeam(null);
            } finally {
                setLoading(false);
            }
        };

        if (teamId && currentOrg) {
            loadTeam();
        }
    }, [teamId, currentOrg, orgs, isDevOrg, authFetch]);

    // Load inbox items for this team
    useEffect(() => {
        const loadInbox = async () => {
            if (!currentOrg?.id || !team) return;
            setInboxLoading(true);
            try {
                const res = await authFetch(`/api/orgs/${currentOrg.id}/inbox?limit=5`);
                if (res.ok) {
                    const data = await res.json();
                    setInboxItems(data.data || []);
                }
            } catch (err) {
                console.error('Failed to load inbox:', err);
            } finally {
                setInboxLoading(false);
            }
        };
        if (activeTab === 'inbox' && currentOrg?.id && team) {
            loadInbox();
        }
    }, [activeTab, currentOrg?.id, team, authFetch]);

    // Track changes
    useEffect(() => {
        if (team) {
            const changed = name !== (team.name || '') ||
                description !== (team.description || '');
            setHasChanges(changed);
        }
    }, [name, description, team]);

    const handleSave = async () => {
        setSaving(true);
        try {
            if (isDevOrg) {
                // Mock save in dev mode
                setTeam(prev => ({ ...prev, name, description }));
                setHasChanges(false);
            } else if (updateTeam && currentOrg) {
                const updated = await updateTeam(currentOrg.id, teamId, { name, description });
                setTeam(prev => ({ ...prev, ...updated }));
                setHasChanges(false);
            }
        } catch (err) {
            console.error('Failed to save team:', err);
            alert('Failed to save changes: ' + err.message);
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        setDeleting(true);
        try {
            if (isDevOrg) {
                // Mock delete in dev mode
                navigate('/teams');
            } else if (deleteTeam && currentOrg) {
                await deleteTeam(currentOrg.id, teamId);
                navigate('/teams');
            }
        } catch (err) {
            console.error('Failed to delete team:', err);
            alert('Failed to delete team: ' + err.message);
        } finally {
            setDeleting(false);
            setShowDeleteConfirm(false);
        }
    };

    const handleChatWithTeam = () => {
        if (team?.scope) {
            selectScope(team.scope);
        }
        navigate('/', { state: { scope: 'team', scopeId: team?.id, scopeName: team?.name } });
    };

    const handleRoleChange = async (userId, newRole) => {
        try {
            if (isDevOrg) {
                // Mock role change in dev mode
                setMembers(prev => prev.map(m =>
                    (m.id === userId || m.user_id === userId)
                        ? { ...m, role: newRole }
                        : m
                ));
            } else if (updateTeamMemberRole && currentOrg) {
                await updateTeamMemberRole(currentOrg.id, teamId, userId, newRole);
                setMembers(prev => prev.map(m =>
                    (m.id === userId || m.user_id === userId)
                        ? { ...m, role: newRole }
                        : m
                ));
            }
        } catch (err) {
            console.error('Failed to update role:', err);
            alert('Failed to update member role');
        }
    };

    const handleRemoveMember = async (userId) => {
        try {
            if (isDevOrg) {
                // Mock remove in dev mode
                setMembers(prev => prev.filter(m => m.id !== userId && m.user_id !== userId));
            } else if (removeTeamMember && currentOrg) {
                await removeTeamMember(currentOrg.id, teamId, userId);
                setMembers(prev => prev.filter(m => m.id !== userId && m.user_id !== userId));
            }
        } catch (err) {
            console.error('Failed to remove member:', err);
            alert('Failed to remove member');
        }
    };

    const handleAddMember = () => {
        setShowAddMember(true);
    };

    // Loading state
    if (loading) {
        return (
            <div className="team-management-view view-page">
                <PageHeader title="Team" />
                <div className="loading-state">Loading team...</div>
            </div>
        );
    }

    // Not found state
    if (!team) {
        return (
            <div className="team-management-view view-page">
                <PageHeader title="Team Not Found" />
                <div className="entity-empty-state" style={{ marginTop: '60px' }}>
                    <div className="entity-empty-state__icon">
                        <TeamIcon />
                    </div>
                    <div className="entity-empty-state__title">Team not found</div>
                    <div className="entity-empty-state__description">
                        The team you're looking for doesn't exist or you don't have access.
                    </div>
                    <Button variant="primary" onClick={() => navigate('/teams')}>
                        Back to Teams
                    </Button>
                </div>
            </div>
        );
    }

    // Format members for MembersList (uses name/email not display_name/primary_email)
    const formattedMembers = members.map(m => ({
        id: m.user_id || m.id,
        name: m.display_name || m.name,
        email: m.primary_email || m.email,
        role: m.role,
        avatar_url: m.avatar_url
    }));

    return (
        <div className="team-management-view view-page org-components">
            {/* Prominent Team Header with Description */}
            <div className="team-header">
                <div className="team-header__main">
                    <div className="team-header__identity">
                        <div className="team-header__avatar">
                            <TeamIcon />
                        </div>
                        <div className="team-header__info">
                            <div className="team-header__title-row">
                                <h1 className="team-header__title">{team.name}</h1>
                                <span className={`team-header__badge ${isTeamAdmin ? 'team-header__badge--admin' : ''}`}>
                                    {isTeamAdmin ? 'Admin' : (team.my_role || 'Member')}
                                </span>
                            </div>
                            <p className="team-header__parent">
                                Team in <a href="#" onClick={(e) => { e.preventDefault(); navigate(`/orgs/${team.org_id}`); }}>{team.org_name}</a>
                            </p>
                            <p className="team-header__description">
                                {description || 'No description provided'}
                            </p>
                        </div>
                    </div>
                    <div className="team-header__actions">
                        <Button variant="ghost" onClick={() => navigate('/teams')}>
                            <BackIcon />
                            <span style={{ marginLeft: '6px' }}>Back</span>
                        </Button>
                        <Button variant="primary" onClick={handleChatWithTeam}>
                            Chat with Assistant
                        </Button>
                    </div>
                </div>
            </div>

            {/* Main Grid Layout */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: '24px' }}>
                {/* Left Column - Main Content */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                    {/* Profile Card */}
                    <PageSection title="Profile">
                        <PageCard>
                            <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-start' }}>
                                {/* Team Icon */}
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
                                    <div className="entity-avatar entity-avatar--xl entity-avatar--team">
                                        <TeamIcon />
                                    </div>
                                </div>

                                {/* Form Fields */}
                                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
                                    <FormField label="Team Name" htmlFor="team-name">
                                        <Input
                                            id="team-name"
                                            value={name}
                                            onChange={(e) => setName(e.target.value)}
                                            placeholder="Team name"
                                            disabled={!isTeamAdmin}
                                        />
                                    </FormField>
                                    <FormField label="Description" htmlFor="team-desc">
                                        <Input
                                            id="team-desc"
                                            value={description}
                                            onChange={(e) => setDescription(e.target.value)}
                                            placeholder="What does this team do?"
                                            disabled={!isTeamAdmin}
                                        />
                                    </FormField>
                                    {isTeamAdmin && hasChanges && (
                                        <Button
                                            variant="primary"
                                            onClick={handleSave}
                                            loading={saving}
                                            style={{ alignSelf: 'flex-start' }}
                                        >
                                            Save Changes
                                        </Button>
                                    )}
                                </div>
                            </div>
                        </PageCard>
                    </PageSection>

                    {/* Members Section */}
                    <PageSection
                        title="Team Members"
                        badge={`${members.length} members`}
                        actions={
                            isTeamAdmin && (
                                <Button size="sm" variant="secondary" onClick={handleAddMember}>
                                    <PlusIcon />
                                    <span style={{ marginLeft: '6px' }}>Add Member</span>
                                </Button>
                            )
                        }
                    >
                        {members.length === 0 ? (
                            <div className="entity-empty-state" style={{ padding: '32px' }}>
                                <div className="entity-empty-state__icon">
                                    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
                                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                                        <circle cx="9" cy="7" r="4"/>
                                    </svg>
                                </div>
                                <div className="entity-empty-state__title">No Members</div>
                                <div className="entity-empty-state__description">
                                    Add team members to start collaborating.
                                </div>
                                {isTeamAdmin && (
                                    <Button size="sm" variant="primary" onClick={handleAddMember}>
                                        Add First Member
                                    </Button>
                                )}
                            </div>
                        ) : (
                            <MembersList
                                members={formattedMembers}
                                canEdit={isTeamAdmin}
                                canRemove={isTeamAdmin}
                                canInvite={false}
                                currentUserId={user?.id}
                                onRoleChange={handleRoleChange}
                                onRemove={handleRemoveMember}
                                roleOptions={['admin', 'member', 'viewer']}
                            />
                        )}
                    </PageSection>

                    {/* Workflows & Inbox Tabs */}
                    <PageSection>
                        <div role="tablist" style={{ display: 'flex', gap: 'var(--m-space-1)', marginBottom: 'var(--m-space-4)', borderBottom: '1px solid var(--m-border-default)' }}>
                            {['workflows', 'inbox', 'activity'].map(tab => (
                                <button
                                    key={tab}
                                    role="tab"
                                    aria-selected={activeTab === tab}
                                    aria-controls={`tabpanel-${tab}`}
                                    onClick={() => setActiveTab(tab)}
                                    style={{
                                        padding: 'var(--m-space-2) var(--m-space-4)',
                                        background: 'none',
                                        border: 'none',
                                        borderBottom: activeTab === tab ? '2px solid var(--m-quox-primary)' : '2px solid transparent',
                                        color: activeTab === tab ? 'var(--m-text-primary)' : 'var(--m-text-tertiary)',
                                        fontWeight: activeTab === tab ? 600 : 400,
                                        fontSize: 'var(--m-text-sm)',
                                        cursor: 'pointer',
                                        textTransform: 'capitalize',
                                        transition: 'all var(--m-duration-fast) var(--m-ease-default)'
                                    }}
                                >
                                    {tab}
                                </button>
                            ))}
                        </div>

                        {activeTab === 'workflows' && (
                            <div style={{ padding: 'var(--m-space-4) 0' }}>
                                {(team.workflow_count || 0) === 0 ? (
                                    <Empty
                                        icon={
                                            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
                                                <polyline points="16 18 22 12 16 6"/>
                                                <polyline points="8 6 2 12 8 18"/>
                                            </svg>
                                        }
                                        title="No workflows yet"
                                        description="Automate team processes with custom workflows."
                                    >
                                        <Button variant="primary" size="sm" onClick={() => navigate('/workflow-builder')}>
                                            Create Workflow
                                        </Button>
                                    </Empty>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--m-space-2)' }}>
                                        <p style={{ fontSize: 'var(--m-text-sm)', color: 'var(--m-text-tertiary)', margin: 0 }}>
                                            {team.workflow_count} workflow{team.workflow_count !== 1 ? 's' : ''} active
                                        </p>
                                        <Button variant="secondary" size="sm" onClick={() => navigate('/workflow-builder')}>
                                            Manage Workflows
                                        </Button>
                                    </div>
                                )}
                            </div>
                        )}

                        {activeTab === 'inbox' && (
                            <div style={{ padding: 'var(--m-space-4) 0' }}>
                                {inboxLoading ? (
                                    <div style={{ padding: 'var(--m-space-6)', textAlign: 'center', color: 'var(--m-text-tertiary)', fontSize: 'var(--m-text-sm)' }}>
                                        Loading inbox items...
                                    </div>
                                ) : inboxItems.length === 0 ? (
                                    <Empty
                                        icon={
                                            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
                                                <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
                                                <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
                                            </svg>
                                        }
                                        title="Inbox is clear"
                                        description="No pending approvals or tasks for this team."
                                    />
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--m-space-2)' }}>
                                        {inboxItems.slice(0, 5).map(item => (
                                            <div
                                                key={item.id}
                                                onClick={() => navigate(`/inbox`)}
                                                style={{
                                                    padding: 'var(--m-space-2-5) var(--m-space-3)',
                                                    background: 'var(--m-bg-elevated)',
                                                    borderRadius: 'var(--m-radius-md)',
                                                    border: '1px solid var(--m-border-default)',
                                                    cursor: 'pointer',
                                                    transition: 'border-color var(--m-duration-fast) var(--m-ease-default)'
                                                }}
                                            >
                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                    <span style={{ fontSize: 'var(--m-text-sm)', fontWeight: 500, color: 'var(--m-text-primary)' }}>
                                                        {item.title}
                                                    </span>
                                                    <span style={{
                                                        fontSize: 'var(--m-text-xs)',
                                                        padding: 'var(--m-space-0-5) var(--m-space-1-5)',
                                                        borderRadius: 'var(--m-radius-sm)',
                                                        background: item.priority === 'urgent' ? 'var(--m-error-muted)' : 'var(--m-info-muted)',
                                                        color: item.priority === 'urgent' ? 'var(--m-error)' : 'var(--m-text-tertiary)'
                                                    }}>
                                                        {item.kind}
                                                    </span>
                                                </div>
                                                {item.body_md && (
                                                    <p style={{ fontSize: 'var(--m-text-xs)', color: 'var(--m-text-tertiary)', margin: 'var(--m-space-1) 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                        {item.body_md.slice(0, 80)}
                                                    </p>
                                                )}
                                            </div>
                                        ))}
                                        <Button variant="ghost" size="sm" onClick={() => navigate('/inbox')} style={{ alignSelf: 'flex-start' }}>
                                            View all inbox items
                                        </Button>
                                    </div>
                                )}
                            </div>
                        )}

                        {activeTab === 'activity' && (
                            <div style={{ padding: 'var(--m-space-4) 0' }}>
                                <Empty
                                    icon={
                                        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
                                            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                                        </svg>
                                    }
                                    title="Activity feed"
                                    description="Recent team actions will appear here as your team uses the platform."
                                />
                            </div>
                        )}
                    </PageSection>
                </div>

                {/* Right Column - Sidebar */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                    {/* Stats */}
                    <PageSection title="Overview">
                        <div className="stats-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                            <div className="stat-card-v2">
                                <div className="stat-card-v2__value">{members.length}</div>
                                <div className="stat-card-v2__label">Members</div>
                            </div>
                            <div className="stat-card-v2">
                                <div className="stat-card-v2__value">{team.project_count || 0}</div>
                                <div className="stat-card-v2__label">Projects</div>
                            </div>
                            <div className="stat-card-v2">
                                <div className="stat-card-v2__value">{team.workflow_count || 0}</div>
                                <div className="stat-card-v2__label">Workflows</div>
                            </div>
                            <div className="stat-card-v2">
                                <div className="stat-card-v2__value">{team.inbox_count || 0}</div>
                                <div className="stat-card-v2__label">Inbox Items</div>
                            </div>
                        </div>
                    </PageSection>

                    {/* Team Assistant */}
                    <PageSection title="Assistant">
                        <ScopeAssistantCard
                            name={`${team.name} Assistant`}
                            scope="team"
                            onChat={handleChatWithTeam}
                        />
                    </PageSection>

                    {/* Team Inbox Link */}
                    <PageSection>
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '16px',
                            background: 'var(--ui-bg-secondary)',
                            borderRadius: '8px',
                            border: '1px solid var(--ui-border)'
                        }}>
                            <div>
                                <h4 style={{ margin: 0, fontSize: '14px', color: 'var(--ui-text-primary)' }}>Team Inbox</h4>
                                <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--ui-text-muted)' }}>
                                    Approvals and tasks for this team
                                </p>
                            </div>
                            <Button as="a" href={`/inbox?scope=${team.scope?.id || ''}`} variant="secondary" size="sm">
                                View Inbox
                            </Button>
                        </div>
                    </PageSection>

                    {/* Parent Link */}
                    <PageSection>
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '16px',
                            background: 'var(--ui-bg-secondary)',
                            borderRadius: '8px',
                            border: '1px solid var(--ui-border)'
                        }}>
                            <div>
                                <h4 style={{ margin: 0, fontSize: '14px', color: 'var(--ui-text-primary)' }}>Organisation</h4>
                                <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--ui-text-muted)' }}>
                                    {currentOrg?.name || 'View parent organisation'}
                                </p>
                            </div>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => currentOrg && navigate(`/orgs/${currentOrg.id}`)}
                            >
                                View
                            </Button>
                        </div>
                    </PageSection>

                    {/* Danger Zone - Only org admins can delete teams (TEAM_DELETE capability) */}
                    {isOrgAdmin && (
                        <PageSection title="Danger Zone" collapsible defaultCollapsed>
                            <div style={{
                                padding: '16px',
                                background: 'rgba(255, 59, 48, 0.05)',
                                border: '1px solid rgba(255, 59, 48, 0.2)',
                                borderRadius: '8px'
                            }}>
                                <p style={{
                                    margin: '0 0 12px 0',
                                    fontSize: '13px',
                                    color: 'var(--text-secondary)'
                                }}>
                                    Permanently delete this team and remove all members.
                                </p>
                                <Button
                                    variant="danger"
                                    size="sm"
                                    onClick={() => setShowDeleteConfirm(true)}
                                >
                                    Delete Team
                                </Button>
                            </div>
                        </PageSection>
                    )}
                </div>
            </div>

            {/* Modals */}
            <ConfirmModal
                isOpen={showDeleteConfirm}
                onClose={() => setShowDeleteConfirm(false)}
                onConfirm={handleDelete}
                title="Delete Team"
                message={`Are you sure you want to delete "${team.name}"? This action cannot be undone and will remove all team members.`}
                confirmLabel="Delete Team"
                danger
                loading={deleting}
            />

            <InviteMemberModal
                isOpen={showAddMember}
                onClose={() => setShowAddMember(false)}
                orgId={team.org_id}
                orgName={team.org_name}
                onSuccess={() => console.log('Invite sent successfully')}
            />
        </div>
    );
}

export default TeamManagementView;
