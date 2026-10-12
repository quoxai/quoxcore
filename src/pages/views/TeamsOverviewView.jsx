/**
 * TeamsOverviewView — Agentic Teams dashboard
 *
 * Shows installed teams as rich status cards with agent role breakdowns,
 * plus a Create Team modal for custom team creation.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageSection } from '../../components/layout';
import Badge from '../../components/ui/Badge.jsx';
import { Spinner } from '../../components/ui/Loading';
import PlatformDependencyNotice from '../../components/ui/PlatformDependencyNotice.jsx';
import { useTeamData } from '../../hooks/useTeamData';
import { useAuth } from '../../contexts/AuthContext';
import { createTeam } from '../../services/teamService';
import { getPlatformDependencyIssue } from '../../services/platformDependencyIssues';
import { TopologyBadge, TopologyMiniMap } from '../../components/orchestration';
import { chiefs } from '../../config/chiefs';
import PrismSidebar from '../../components/objectives/PrismSidebar';
import './teams-overview-view.css';

const ROLE_COLORS = {
  orchestrator: '#f59e0b',
  manager: '#3b82f6',
  analyst: '#8b5cf6',
  specialist: '#10b981',
};

const ROLE_ICONS = {
  orchestrator: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.4" strokeLinecap="round">
      <path d="M8 1v3M8 12v3M14 8h-3M4 8H1M12.2 3.8l-2.1 2.1M5.9 10.1l-2.1 2.1M12.2 12.2l-2.1-2.1M5.9 5.9L3.8 3.8"/>
    </svg>
  ),
  manager: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.4" strokeLinecap="round">
      <circle cx="8" cy="5" r="3"/><path d="M2.5 14c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/>
    </svg>
  ),
  analyst: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.4" strokeLinecap="round">
      <path d="M2 12l4-5 3 3 5-6"/>
    </svg>
  ),
  specialist: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.4" strokeLinecap="round">
      <path d="M7 1l5 3v4c0 3-2.5 4.8-5 6-2.5-1.2-5-3-5-6V4l5-3z"/>
    </svg>
  ),
};

function getRoleCounts(members, orchestrator) {
  const counts = { orchestrator: 1 };
  for (const m of members || []) {
    counts[m.role] = (counts[m.role] || 0) + 1;
  }
  return counts;
}

const TIER_CONFIG = {
  free: { color: 'green', label: 'Free' },
  custom: { color: 'purple', label: 'Custom' },
  tier_a: { color: 'blue', label: null },
  tier_b: { color: 'blue', label: null },
  tier_c: { color: 'blue', label: null },
};

// Resolve orchestrator shortName from chiefs registry
function getOrchestratorLabel(manifest) {
  const orchId = manifest?.orchestrator?.agentId;
  if (!orchId) return null;
  const chief = chiefs?.[orchId];
  return chief?.shortName || orchId.toUpperCase();
}

function getTeamIcon(team, accentColor) {
  const icons = {
    cpu: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="1.5" strokeLinecap="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/></svg>,
    'bar-chart': <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="1.5" strokeLinecap="round"><path d="M12 20V10M18 20V4M6 20v-4"/></svg>,
    shield: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="1.5" strokeLinecap="round"><path d="M12 2l8 4v6c0 5.5-3.8 8.2-8 10-4.2-1.8-8-4.5-8-10V6l8-4z"/></svg>,
    globe: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="1.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2c2.7 3 4.2 6.4 4.4 10-.2 3.6-1.7 7-4.4 10-2.7-3-4.2-6.4-4.4-10 .2-3.6 1.7-7 4.4-10z"/></svg>,
    code: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="1.5" strokeLinecap="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>,
    'book-open': <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="1.5" strokeLinecap="round"><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2zM22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/></svg>,
    rocket: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="1.5" strokeLinecap="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11.95A22.18 22.18 0 0112 15z"/></svg>,
    briefcase: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="1.5" strokeLinecap="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2M12 12v2"/></svg>,
  };
  return icons[team.icon] || <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="1.5" strokeLinecap="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>;
}

function TeamCard({ team, onClick }) {
  const accentColor = team.accentColor || '#3090ff';
  const agentCount = team.agentCount || 0;
  const manifest = team.manifest || {};
  const roleCounts = getRoleCounts(manifest.members, manifest.orchestrator);
  const tierCfg = TIER_CONFIG[team.tier] || TIER_CONFIG.tier_a;
  const tierLabel = tierCfg.label || (team.price ? `$${team.price}` : team.tier);
  const orchLabel = getOrchestratorLabel(manifest);
  const isChiefTeam = team.id?.startsWith('chief-');

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
      className={`tov-card ${team.status === 'active' ? 'tov-card--active' : ''}`}
      style={{ '--team-accent': accentColor }}
    >
      {/* Topology mini map — decorative top-right */}
      {manifest.topology?.type && (
        <div className="tov-card__topology-map">
          <TopologyMiniMap type={manifest.topology.type} agents={agentCount || 6} size={50} accentColor={accentColor} />
        </div>
      )}

      {/* Top accent bar */}
      <div className="tov-card__accent" />

      {/* Header */}
      <div className="tov-card__header">
        <div className="tov-card__header-row">
          <div className="tov-card__icon-box">
            {getTeamIcon(team, accentColor)}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="tov-card__name">
              {team.displayName}
            </div>
            <div className="tov-card__health-dot" />
            <div className="tov-card__badges">
              <Badge color={tierCfg.color} pill>{tierLabel}</Badge>
              {team.source === 'core' && (
                <span className="tov-card__builtin">Built-in</span>
              )}
              {manifest.topology?.type && (
                <TopologyBadge type={manifest.topology.type} size="sm" />
              )}
              {orchLabel && (
                <span className="tov-card__led-by">
                  Led by {orchLabel}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="tov-card__body">
        <p className="tov-card__desc">
          {team.description}
        </p>

        {/* Role breakdown chips */}
        <div className="tov-card__roles">
          {Object.entries(roleCounts).map(([role, count]) => {
            const color = ROLE_COLORS[role] || '#71717a';
            return (
              <div
                key={role}
                className="tov-role-chip"
                style={{ '--role-color': color }}
              >
                {ROLE_ICONS[role] || null}
                <span>{count} {role}{count !== 1 ? 's' : ''}</span>
              </div>
            );
          })}
          <div className="tov-role-chip tov-role-chip--agents">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ stroke: 'currentColor' }} strokeWidth="1.3" strokeLinecap="round">
              <path d="M11 14v-1.3a2.7 2.7 0 00-2.7-2.7H4.7A2.7 2.7 0 002 12.7V14"/>
              <circle cx="6.5" cy="5.5" r="2.5"/>
              <path d="M14 14v-1.3a2.7 2.7 0 00-2-2.6M10.5 3.1a2.5 2.5 0 010 4.8"/>
            </svg>
            {agentCount} agents
          </div>
        </div>
      </div>
    </div>
  );
}

// Known core + built-in agents for the orchestrator/member dropdowns
const KNOWN_AGENTS = [
  { id: 'quox', label: 'CommanderQ (Orchestrator)' },
  { id: 'sentinel', label: 'WARDEN (Security)' },
  { id: 'nova', label: 'DAEDALUS (DevOps)' },
  { id: 'cipher', label: 'CIPHER (Crypto/Network)' },
  { id: 'atlas', label: 'HYPERION (Infrastructure)' },
  { id: 'gemini', label: 'GEMINI (Multi-Model)' },
  { id: 'metrics', label: 'METRICS (Analytics)' },
  { id: 'insight', label: 'INSIGHT (Research)' },
  { id: 'scholar', label: 'SCHOLAR (Knowledge)' },
  { id: 'beacon', label: 'VIGIL (Alerts)' },
  { id: 'quoxcode', label: 'QUOXCODE (Code)' },
  { id: 'archivist', label: 'ARCHIVIST (Files)' },
  { id: 'corey', label: 'COREY (CORE Systems)' },
  { id: 'netwatch', label: 'NETWATCH (Network)' },
  { id: 'forge', label: 'VULCAN (Generation)' },
  { id: 'tester', label: 'TESTER (QA)' },
  { id: 'prism', label: 'PRISM (Analysis)' },
];

function CreateTeamModal({ onClose, onCreated }) {
  const { authFetch } = useAuth();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [orchestrator, setOrchestrator] = useState('quox');
  const [selectedMembers, setSelectedMembers] = useState([]);
  const [requireApproval, setRequireApproval] = useState(false);
  const [checkpointAfterTask, setCheckpointAfterTask] = useState(false);
  const [voltRequired, setVoltRequired] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const toggleMember = (agentId) => {
    setSelectedMembers(prev =>
      prev.includes(agentId)
        ? prev.filter(id => id !== agentId)
        : [...prev, agentId]
    );
  };

  const availableMembers = KNOWN_AGENTS.filter(a => a.id !== orchestrator);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim() || selectedMembers.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await createTeam(authFetch, {
        displayName: name.trim(),
        description: description.trim() || undefined,
        orchestratorAgentId: orchestrator,
        members: selectedMembers.map(id => ({
          agentId: id,
          role: 'specialist',
          domains: [],
        })),
        policies: {
          requireApprovalBeforeStart: requireApproval,
          checkpointAfterEachTask: checkpointAfterTask,
          voltRequired,
        },
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const inputStyle = {
    width: '100%', padding: '8px 12px', borderRadius: 6,
    background: 'var(--m-bg-base, rgba(255,255,255,0.04))',
    border: '1px solid var(--m-border-subtle)',
    color: 'var(--m-text-primary)', fontSize: 13,
    outline: 'none', boxSizing: 'border-box',
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <form
        onClick={e => e.stopPropagation()}
        onSubmit={handleSubmit}
        style={{
          background: 'var(--m-bg-elevated, rgba(255,255,255,0.05))',
          border: '1px solid var(--m-border-subtle)',
          borderRadius: 14, padding: 28, width: 540,
          maxHeight: '85vh', overflowY: 'auto',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          color: 'var(--m-text-primary)', fontWeight: 600, fontSize: 17, marginBottom: 20,
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="1.5" strokeLinecap="round">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
          </svg>
          Create Agentic Team
        </div>

        {error && (
          <div style={{
            padding: 10, marginBottom: 12, borderRadius: 6,
            background: 'rgba(239,68,68,0.1)', color: 'var(--m-status-danger, #ef4444)', fontSize: 13,
          }}>
            {error}
          </div>
        )}

        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 12, marginBottom: 4 }}>
            Team Name *
          </label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. DevOps Strike Team" required style={inputStyle} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 12, marginBottom: 4 }}>
            Description
          </label>
          <textarea value={description} onChange={e => setDescription(e.target.value)}
            placeholder="What does this team specialize in?" rows={2}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 12, marginBottom: 4 }}>
            Orchestrator Agent
          </label>
          <select value={orchestrator} onChange={e => setOrchestrator(e.target.value)} style={inputStyle}>
            {KNOWN_AGENTS.map(a => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 12, marginBottom: 6 }}>
            Team Members * (select at least 1)
          </label>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4,
            maxHeight: 200, overflowY: 'auto',
            padding: 8, borderRadius: 8,
            background: 'var(--m-bg-base, rgba(255,255,255,0.04))',
            border: '1px solid var(--m-border-subtle)',
          }}>
            {availableMembers.map(a => (
              <label key={a.id} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '5px 8px', borderRadius: 5, cursor: 'pointer',
                fontSize: 12, color: selectedMembers.includes(a.id) ? 'var(--m-text-primary)' : 'var(--m-text-secondary)',
                background: selectedMembers.includes(a.id) ? 'rgba(139,92,246,0.12)' : 'transparent',
                transition: 'background 0.15s',
              }}>
                <input type="checkbox" checked={selectedMembers.includes(a.id)} onChange={() => toggleMember(a.id)}
                  style={{ accentColor: '#8b5cf6' }}
                />
                {a.label}
              </label>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 12, marginBottom: 6 }}>
            Policies
          </label>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 8,
            padding: '10px 12px', borderRadius: 8,
            background: 'var(--m-bg-base, rgba(17,17,20,0.8))',
          }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--m-text-primary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={requireApproval} onChange={e => setRequireApproval(e.target.checked)} style={{ accentColor: '#8b5cf6' }} />
              Require approval before start
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--m-text-primary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={checkpointAfterTask} onChange={e => setCheckpointAfterTask(e.target.checked)} style={{ accentColor: '#8b5cf6' }} />
              Checkpoint after each task
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--m-text-primary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={voltRequired} onChange={e => setVoltRequired(e.target.checked)} style={{ accentColor: '#8b5cf6' }} />
              VOLT audit trail required
            </label>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}
            style={{
              padding: '9px 18px', borderRadius: 8,
              background: 'transparent',
              border: '1px solid var(--m-border-subtle)',
              color: 'var(--m-text-secondary)', cursor: 'pointer', fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button type="submit" disabled={submitting || !name.trim() || selectedMembers.length === 0}
            style={{
              padding: '9px 18px', borderRadius: 8,
              background: '#8b5cf6', border: 'none',
              color: 'var(--m-text-inverse, #fff)', cursor: submitting ? 'not-allowed' : 'pointer',
              fontSize: 13, fontWeight: 500, opacity: submitting ? 0.6 : 1,
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.5" strokeLinecap="round"/></svg>
            {submitting ? 'Creating...' : 'Create Team'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function TeamsOverviewView({ onTeamSelect } = {}) {
  const navigate = useNavigate();
  const { teams, loading, error, refresh } = useTeamData();
  const teamServiceIssue = getPlatformDependencyIssue(error, {
    service: 'tasks',
    feature: 'Agentic Teams',
  });
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showChat, setShowChat] = useState(true);

  const totalAgents = teams.reduce((sum, t) => sum + (t.agentCount || 0), 0);
  const activeCount = teams.filter(t => t.status === 'active').length;

  return (
    <PageSection title="Agentic Teams" subtitle="Specialist agent teams that collaborate on complex objectives" className="teams-overview-view">
      <div className="teams-overview-view__body">
        {/* Main content */}
        <div className="teams-overview-view__main">
          {/* Header bar with stats + actions */}
          <div className="tov-stats-header">
            {!loading && teams.length > 0 ? (
              <div className="tov-stats">
                <div>
                  <div className="tov-stat__label">Teams</div>
                  <div className="tov-stat__value">{teams.length}</div>
                </div>
                <div className="tov-stat__divider" />
                <div>
                  <div className="tov-stat__label">Total Agents</div>
                  <div className="tov-stat__value">{totalAgents}</div>
                </div>
                <div className="tov-stat__divider" />
                <div>
                  <div className="tov-stat__label">Active</div>
                  <div className="tov-stat__value tov-stat__value--active">{activeCount}</div>
                </div>
              </div>
            ) : (
              <div className="tov-stats-empty">
                {loading ? 'Loading teams...' : 'No teams yet'}
              </div>
            )}

            <div className="tov-actions">
              <button
                onClick={() => setShowChat(v => !v)}
                title={showChat ? 'Hide PRISM' : 'Show PRISM'}
                className={`tov-btn-prism ${showChat ? 'tov-btn-prism--active' : ''}`}
              >
                <span style={{ fontSize: 14 }}>◈</span> PRISM
              </button>
              <button
                onClick={() => setShowCreateModal(true)}
                className="tov-btn-create"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" style={{ stroke: 'rgba(255,255,255,0.9)' }} strokeWidth="2" strokeLinecap="round"/></svg>
                Create Team
              </button>
            </div>
          </div>

          {loading && (
            <div className="tov-loading">
              <Spinner size="lg" />
              Loading teams...
            </div>
          )}

          {error && (
            teamServiceIssue ? (
              <PlatformDependencyNotice issue={teamServiceIssue} compact style={{ marginBottom: 20 }} />
            ) : (
              <div className="tov-error">
                {error}
              </div>
            )
          )}

          {!loading && teams.length === 0 && (
            <div className="tov-empty">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" strokeWidth="1" strokeLinecap="round"
                className="tov-empty__icon"
                style={{ stroke: 'rgba(255,255,255,0.8)' }}>
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
              </svg>
              <div className="tov-empty__title">No teams installed</div>
              <div className="tov-empty__text">Agentic teams coordinate multiple AI agents to accomplish complex objectives autonomously.</div>
              <button onClick={() => setShowCreateModal(true)} className="tov-empty__btn">
                + Create Your First Team
              </button>
            </div>
          )}

          {!loading && teams.length > 0 && (
            <div className="tov-grid">
              {teams.map(team => (
                <TeamCard
                  key={team.id}
                  team={team}
                  onClick={() => onTeamSelect ? onTeamSelect(team.id) : navigate(`/agentic-teams/${team.id}`)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Right: PRISM chat sidebar (persistent, collapsible) */}
        <div
          className="teams-overview-view__sidebar"
          data-open={showChat ? 'true' : 'false'}
        >
          <PrismSidebar
            context={{
              mode: 'teams-overview',
              teams,
            }}
          />
        </div>
      </div>

      {showCreateModal && (
        <CreateTeamModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => refresh()}
        />
      )}
    </PageSection>
  );
}
