/**
 * AgenticTeamView — Individual agentic team page
 *
 * Stream E Phase E3: Overview + Objectives + Schedules + Context + Settings tabs.
 * Overview tab features clickable agent cards with a slide-out detail panel.
 */

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { PageSection } from '../../components/layout';
import Badge from '../../components/ui/Badge.jsx';
import { Spinner } from '../../components/ui/Loading';
import { ConfirmModal } from '../../components/org/EntityModal';
import { useTeamDetail } from '../../hooks/useTeamData';
import { useAuth } from '../../contexts/AuthContext';
import MarkdownContent from '../../components/ui/MarkdownContent';
import PlatformDependencyNotice from '../../components/ui/PlatformDependencyNotice.jsx';
import ReportingSettingsSection from '../../components/objectives/ReportingSettingsSection';
import { TopologyBadge, AgentLeaderboard, AgentActivityPulse } from '../../components/orchestration';
import { createObjective, startObjective, rejectPlan } from '../../services/objectivesClient';
import { useObjectiveManager } from '../../hooks/useObjectiveManager';
import { installTeam, updateTeam, uninstallTeam, getTeamContext, updateTeamContext, listSchedules, createSchedule, deleteSchedule, toggleSchedule, exportTeam } from '../../services/teamService';
import PrismSidebar from '../../components/objectives/PrismSidebar';
import { cronToHuman, formatCountdown, isValidCron, getScheduledDays, cronMatchesDate } from '../../services/cronHelper';
import { agentRegistry } from '../../config/agentRegistry';
import { assistants, getAssistant } from '../../config/assistants';
import { chiefs } from '../../config/chiefs';
import { DEFAULT_LLM_CONFIG } from '../../services/llmService';
import { readTaskServiceJson } from '../../services/taskServiceClient';
import { getPlatformDependencyIssue } from '../../services/platformDependencyIssues';
import LLMAuthBanner from '../../components/ui/LLMAuthBanner'
// TeamBreadcrumb removed — AppShell breadcrumb is sufficient

const ROLE_COLORS = {
  orchestrator: '#f59e0b',
  manager: '#3b82f6',
  analyst: '#8b5cf6',
  specialist: '#10b981',
};

const ROLE_LABELS = {
  orchestrator: 'Orchestrator',
  manager: 'Manager',
  analyst: 'Analyst',
  specialist: 'Specialist',
};

const DOMAIN_COLORS = {
  security: '#f87171',
  infrastructure: '#60a5fa',
  development: '#4ade80',
  operations: '#fbbf24',
  data: '#a78bfa',
  communication: '#f472b6',
  monitoring: '#34d399',
  automation: '#fb923c',
  analysis: '#818cf8',
  integration: '#38bdf8',
  compliance: '#e879f9',
  coordination: '#38bdf8',
  cryptography: '#c084fc',
  networking: '#2dd4bf',
  virtualization: '#fb923c',
  devops: '#4ade80',
  research: '#fbbf24',
  'code generation': '#34d399',
  'file operations': '#94a3b8',
  testing: '#f472b6',
};

function getDomainColor(domain) {
  const lower = domain.toLowerCase();
  for (const [key, color] of Object.entries(DOMAIN_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return '#71717a';
}

const TABS = [
  { id: 'overview', label: 'Overview', icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.3" strokeLinecap="round"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg> },
  { id: 'objectives', label: 'Objectives', icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.3" strokeLinecap="round"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r="0.5" fill="rgba(255,255,255,0.8)"/></svg> },
  { id: 'schedules', label: 'Schedules', icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.3" strokeLinecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.5v3.5l2.5 1.5"/></svg> },
  { id: 'context', label: 'Context', icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.3" strokeLinecap="round"><path d="M2 4h12M2 8h12M2 12h8"/></svg> },
  { id: 'performance', label: 'Performance', icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.3" strokeLinecap="round"><path d="M2 12l3-4 3 2 4-6"/><path d="M14 4v3h-3"/></svg> },
  { id: 'settings', label: 'Settings', icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.3" strokeLinecap="round"><circle cx="8" cy="8" r="2.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.4 1.4M11.55 11.55l1.4 1.4M3.05 12.95l1.4-1.4M11.55 4.45l1.4-1.4"/></svg> },
];

const OBJ_STATUS_COLORS = {
  pending: '#f59e0b',
  decomposing: '#8b5cf6',
  decomposed: '#a855f7',
  running: '#3b82f6',
  paused: '#f59e0b',
  completed: '#10b981',
  completed_with_errors: '#f97316',
  failed: '#ef4444',
  cancelled: '#71717a',
};

function InlineDependencyError({ error, service, feature, onDismiss, compact = true, style }) {
  if (!error) return null;

  const issue = getPlatformDependencyIssue(error, { service, feature });
  if (issue) {
    return (
      <PlatformDependencyNotice
        issue={issue}
        compact={compact}
        onDismiss={onDismiss}
        style={style}
      />
    );
  }

  return (
    <div style={{
      padding: 12,
      marginBottom: 12,
      borderRadius: 6,
      background: 'rgba(239,68,68,0.1)',
      color: 'var(--m-error, #ef4444)',
      fontSize: compact ? 12 : 13,
      display: onDismiss ? 'flex' : 'block',
      alignItems: onDismiss ? 'center' : undefined,
      justifyContent: onDismiss ? 'space-between' : undefined,
      gap: onDismiss ? 12 : undefined,
      ...style,
    }}>
      <span>{error}</span>
      {typeof onDismiss === 'function' && (
        <button
          onClick={onDismiss}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--m-error, #ef4444)',
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          &times;
        </button>
      )}
    </div>
  );
}

// ─── Helpers to resolve agent metadata from registry/assistants ───

function getAgentMeta(agentId) {
  const regEntry = agentRegistry?.agents?.[agentId];
  const assistant = assistants?.[agentId];
  const chief = chiefs?.[agentId];
  // Priority: assistant > chief > registry > defaults
  return {
    name: assistant?.name || chief?.name || regEntry?.name || agentId.toUpperCase(),
    shortName: assistant?.shortName || chief?.shortName || agentId.toUpperCase(),
    color: assistant?.color || chief?.color || ROLE_COLORS.specialist,
    specialty: assistant?.specialty || chief?.specialty || regEntry?.description || '',
    personality: assistant?.personality || chief?.personality || '',
    role: regEntry?.role || assistant?.role || chief?.role || 'specialist',
    level: regEntry?.level ?? assistant?.level ?? chief?.level ?? 1,
    domains: (Array.isArray(regEntry?.capabilities) ? regEntry.capabilities : []),
    tools: regEntry?.tools || [],
    workflows: regEntry?.workflows || [],
    systemPrompt: regEntry?.systemPrompt || assistant?.systemPrompt || chief?.systemPrompt || '',
    llm: assistant?.llm || regEntry?.llm || chief?.llm || null,
    tagline: assistant?.description || chief?.description || '',
    isChief: !!chief,
    canDelegateTo: chief?.canDelegateTo || [],
  };
}

// ─── Agent Detail Panel (slide-out) ───

function AgentDetailPanel({ agentId, teamRole, teamDomains, onClose, accentColor }) {
  const meta = getAgentMeta(agentId);
  const navigate = useNavigate();
  const roleColor = ROLE_COLORS[teamRole] || meta.color || '#71717a';
  const [showFullPrompt, setShowFullPrompt] = useState(false);

  // Extract expertise lines from system prompt
  const expertiseLines = useMemo(() => {
    if (!meta.systemPrompt) return [];
    const lines = meta.systemPrompt.split('\n');
    let inExpertise = false;
    const result = [];
    for (const line of lines) {
      if (/^(EXPERTISE|CAPABILITIES|SKILLS|DOMAIN)/i.test(line.trim())) {
        inExpertise = true;
        continue;
      }
      if (inExpertise && /^[A-Z]{2,}/.test(line.trim()) && !/^-/.test(line.trim())) {
        break;
      }
      if (inExpertise && line.trim().startsWith('-')) {
        result.push(line.trim().replace(/^-\s*/, ''));
      }
    }
    return result;
  }, [meta.systemPrompt]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 900,
      display: 'flex', justifyContent: 'flex-end',
    }}>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'absolute', inset: 0,
          background: 'rgba(0,0,0,0.5)',
          backdropFilter: 'blur(4px)',
        }}
      />

      {/* Panel */}
      <div style={{
        position: 'relative',
        width: 520, maxWidth: '92vw',
        height: '100vh',
        background: 'var(--m-bg-base, rgba(255,255,255,0.04))',
        borderLeft: `1px solid var(--m-border-subtle, rgba(255,255,255,0.08))`,
        overflowY: 'auto',
        animation: 'slideInRight 0.25s ease-out',
      }}>
        {/* Header with accent gradient */}
        <div style={{
          padding: '28px 32px 24px',
          background: `linear-gradient(160deg, ${roleColor}18 0%, ${meta.color}08 40%, transparent 80%)`,
          borderBottom: '1px solid var(--m-border-subtle, rgba(255,255,255,0.06))',
          position: 'sticky', top: 0, zIndex: 1,
          backdropFilter: 'blur(16px)',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
            {/* Agent avatar — large */}
            <div style={{
              width: 64, height: 64, borderRadius: 16,
              background: `${meta.color}15`,
              border: `2px solid ${meta.color}40`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 22, fontWeight: 800, color: meta.color,
              flexShrink: 0,
              letterSpacing: meta.shortName.length > 2 ? -0.5 : 0,
            }}>
              {meta.shortName}
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                color: 'var(--m-text-primary, #f4f4f5)',
                fontWeight: 700, fontSize: 20, lineHeight: 1.3, marginBottom: 6,
              }}>
                {meta.name}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Badge color={teamRole === 'orchestrator' ? 'amber' : teamRole === 'manager' ? 'blue' : teamRole === 'analyst' ? 'purple' : 'green'} pill>
                  {ROLE_LABELS[teamRole] || teamRole}
                </Badge>
                {meta.isChief && <Badge color="default" pill>C-Suite</Badge>}
                {meta.llm && (
                  <span style={{ color: 'var(--m-text-tertiary, #52525b)', fontSize: 11 }}>
                    {meta.llm.model || DEFAULT_LLM_CONFIG.model}
                  </span>
                )}
              </div>
              {meta.tagline && (
                <div style={{ color: 'var(--m-text-secondary, #a1a1aa)', fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
                  {meta.tagline}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              {/* Chat button */}
              <button
                onClick={() => {
                  const chatId = meta.isChief ? `chief-${agentId}` : agentId;
                  navigate('/', { state: { assistant: chatId } });
                }}
                style={{
                  background: `${roleColor}20`, border: `1px solid ${roleColor}40`, borderRadius: 8,
                  padding: '6px 14px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 6,
                  color: roleColor, fontSize: 13, fontWeight: 600,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = `${roleColor}30`}
                onMouseLeave={e => e.currentTarget.style.background = `${roleColor}20`}
                title={`Chat with ${meta.name}`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                Chat
              </button>

              {/* Close button */}
              <button onClick={onClose} style={{
                background: 'rgba(255,255,255,0.06)', border: 'none', borderRadius: 8,
                width: 34, height: 34, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--m-text-secondary)', flexShrink: 0,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
              onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.5" strokeLinecap="round">
                  <path d="M1 1l12 12M13 1L1 13"/>
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Content sections */}
        <div style={{ padding: '24px 32px 36px' }}>

          {/* Specialty card */}
          {meta.specialty && (
            <div style={{
              padding: '16px 18px', borderRadius: 12, marginBottom: 24,
              background: `linear-gradient(135deg, ${meta.color}08, var(--m-bg-elevated, rgba(255,255,255,0.05)))`,
              border: '1px solid var(--m-border-subtle, rgba(255,255,255,0.06))',
            }}>
              <div style={{
                color: meta.color, fontSize: 11, fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8,
              }}>
                Specialty
              </div>
              <div style={{
                color: 'var(--m-text-primary, #f4f4f5)', fontSize: 14, lineHeight: 1.5, fontWeight: 500,
              }}>
                {meta.specialty}
              </div>
            </div>
          )}

          {/* Personality / Training */}
          {meta.personality && (
            <Section title="Personality & Training" icon={
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round">
                <circle cx="8" cy="5" r="3.5"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/>
              </svg>
            }>
              <div style={{
                padding: '14px 16px', borderRadius: 10,
                background: 'var(--m-bg-elevated, rgba(255,255,255,0.05))',
                border: '1px solid var(--m-border-subtle, rgba(255,255,255,0.06))',
                color: 'var(--m-text-secondary, #a1a1aa)', fontSize: 13, lineHeight: 1.65,
                fontStyle: 'italic',
              }}>
                &ldquo;{meta.personality}&rdquo;
              </div>
            </Section>
          )}

          {/* Expertise (extracted from system prompt) */}
          {expertiseLines.length > 0 && (
            <Section title="Expertise" icon={
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round">
                <path d="M8 1l2 4.5L15 6l-3.5 3.2.8 4.8L8 11.5 3.7 14l.8-4.8L1 6l5-0.5z"/>
              </svg>
            }>
              <div style={{
                display: 'grid', gap: 6,
              }}>
                {expertiseLines.map((line, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                    padding: '8px 12px', borderRadius: 8,
                    background: 'var(--m-bg-elevated, rgba(255,255,255,0.05))',
                    border: '1px solid var(--m-border-subtle, rgba(255,255,255,0.04))',
                  }}>
                    <div style={{
                      width: 6, height: 6, borderRadius: '50%',
                      background: meta.color, flexShrink: 0, marginTop: 5,
                      opacity: 0.6,
                    }} />
                    <span style={{ color: 'var(--m-text-secondary, #a1a1aa)', fontSize: 12, lineHeight: 1.5 }}>
                      {line}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Team Role Domains */}
          {teamDomains && teamDomains.length > 0 && (
            <Section title="Team Domains" icon={
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round">
                <circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2.5 3 5 3 6s-1 3.5-3 6c-2-2.5-3-5-3-6s1-3.5 3-6z"/>
              </svg>
            }>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {teamDomains.map(d => (
                  <span key={d} style={{
                    padding: '4px 12px', borderRadius: 6,
                    background: `${getDomainColor(d)}12`,
                    border: `1px solid ${getDomainColor(d)}25`,
                    color: getDomainColor(d),
                    fontSize: 12, fontWeight: 500,
                  }}>
                    {d}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {/* Delegation (for chiefs) */}
          {meta.canDelegateTo.length > 0 && (
            <Section title="Can Delegate To" icon={
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round">
                <path d="M2 8h12M9 4l4 4-4 4"/>
              </svg>
            }>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {meta.canDelegateTo.map(id => {
                  const delegateMeta = getAgentMeta(id);
                  return (
                    <span key={id} style={{
                      padding: '3px 10px', borderRadius: 6,
                      background: `${delegateMeta.color}10`,
                      border: `1px solid ${delegateMeta.color}20`,
                      color: delegateMeta.color,
                      fontSize: 11, fontWeight: 600,
                    }}>
                      {delegateMeta.shortName}
                    </span>
                  );
                })}
              </div>
            </Section>
          )}

          {/* Registry Domains */}
          {meta.domains.length > 0 && (
            <Section title="Agent Capabilities" icon={
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round">
                <path d="M2 12l4-5 3 3 5-6"/>
              </svg>
            }>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {meta.domains.map(d => (
                  <span key={d} style={{
                    padding: '4px 12px', borderRadius: 6,
                    background: 'rgba(255,255,255,0.04)',
                    color: 'var(--m-text-secondary, #a1a1aa)',
                    fontSize: 12,
                  }}>
                    {d}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {/* Tools */}
          {meta.tools.length > 0 && (
            <Section title={`Tools (${meta.tools.length})`} icon={
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round">
                <path d="M10.3 1.7a2.4 2.4 0 013 3L6 12l-4 1 1-4z"/>
              </svg>
            } collapsible defaultOpen={meta.tools.length <= 8}>
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4,
                maxHeight: 200, overflowY: 'auto',
              }}>
                {meta.tools.map(t => (
                  <div key={t} style={{
                    padding: '6px 10px', borderRadius: 6,
                    background: 'var(--m-bg-elevated, rgba(255,255,255,0.05))',
                    fontSize: 11, color: 'var(--m-text-secondary)',
                    fontFamily: 'monospace',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {t}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Workflows */}
          {meta.workflows.length > 0 && (
            <Section title={`Workflows (${meta.workflows.length})`} icon={
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round">
                <path d="M2 8h4l2-4 2 8 2-4h4"/>
              </svg>
            } collapsible>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {meta.workflows.map(w => (
                  <div key={w} style={{
                    padding: '6px 10px', borderRadius: 6,
                    background: 'var(--m-bg-elevated, rgba(255,255,255,0.05))',
                    fontSize: 11, color: 'var(--m-text-secondary)',
                  }}>
                    {w}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* LLM Config */}
          {meta.llm && (
            <Section title="LLM Configuration" icon={
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round">
                <rect x="2" y="2" width="12" height="12" rx="3"/><path d="M5.5 6h5M5.5 8.5h3.5M5.5 11h4.5"/>
              </svg>
            }>
              <div style={{
                padding: '12px 16px', borderRadius: 10,
                background: 'var(--m-bg-elevated, rgba(255,255,255,0.05))',
                border: '1px solid var(--m-border-subtle, rgba(255,255,255,0.06))',
                display: 'flex', flexDirection: 'column', gap: 10,
              }}>
                <InfoRow label="Provider" value={meta.llm.provider || DEFAULT_LLM_CONFIG.provider} />
                <InfoRow label="Model" value={meta.llm.model || DEFAULT_LLM_CONFIG.model} />
                {meta.llm.temperature != null && <InfoRow label="Temperature" value={meta.llm.temperature} />}
                {meta.llm.maxTokens && <InfoRow label="Max Tokens" value={meta.llm.maxTokens.toLocaleString()} />}
              </div>
            </Section>
          )}

          {/* System Prompt (collapsible) */}
          {meta.systemPrompt && (
            <Section title="System Prompt" icon={
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round">
                <path d="M4 4h8M4 7h8M4 10h5"/>
              </svg>
            } collapsible defaultOpen={false}>
              <div style={{
                padding: '14px 16px', borderRadius: 10,
                background: 'var(--m-bg-elevated, rgba(255,255,255,0.05))',
                border: '1px solid var(--m-border-subtle, rgba(255,255,255,0.06))',
                maxHeight: showFullPrompt ? 'none' : 200,
                overflow: 'hidden',
                position: 'relative',
              }}>
                <pre style={{
                  color: 'var(--m-text-secondary, #a1a1aa)', fontSize: 11, lineHeight: 1.6,
                  fontFamily: 'monospace', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {meta.systemPrompt}
                </pre>
                {!showFullPrompt && meta.systemPrompt.length > 400 && (
                  <div style={{
                    position: 'absolute', bottom: 0, left: 0, right: 0, height: 60,
                    background: 'linear-gradient(transparent, var(--m-bg-elevated, rgba(255,255,255,0.05)))',
                    display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 8,
                  }}>
                    <button onClick={() => setShowFullPrompt(true)} style={{
                      background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: 6,
                      padding: '4px 14px', color: 'var(--m-text-secondary)', fontSize: 11, cursor: 'pointer',
                    }}>
                      Show full prompt
                    </button>
                  </div>
                )}
              </div>
            </Section>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--m-border-subtle, rgba(255,255,255,0.06))' }}>
            {/* Agent Settings — only for agents registered in the main agent system */}
            {!meta.isChief && (
              <button
                onClick={() => navigate(`/agents/${agentId}`)}
                style={{
                  padding: '10px 20px', borderRadius: 10,
                  background: `${meta.color}12`,
                  border: `1px solid ${meta.color}30`,
                  color: meta.color, cursor: 'pointer',
                  fontSize: 13, fontWeight: 500,
                  display: 'flex', alignItems: 'center', gap: 8,
                  transition: 'background 0.15s, border-color 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = `${meta.color}20`; e.currentTarget.style.borderColor = `${meta.color}50`; }}
                onMouseLeave={e => { e.currentTarget.style.background = `${meta.color}12`; e.currentTarget.style.borderColor = `${meta.color}30`; }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.5" strokeLinecap="round">
                  <circle cx="7" cy="7" r="2.5"/><path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M3.05 3.05l1.06 1.06M9.89 9.89l1.06 1.06M3.05 10.95l1.06-1.06M9.89 4.11l1.06-1.06"/>
                </svg>
                Agent Settings
              </button>
            )}
            {/* Chief info badge — for C-suite agents that don't have a standalone settings page */}
            {meta.isChief && (
              <span style={{
                padding: '10px 20px', borderRadius: 10,
                background: `${meta.color}08`,
                border: `1px solid ${meta.color}18`,
                color: 'var(--m-text-tertiary, #71717a)',
                fontSize: 12, fontWeight: 500,
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.3" strokeLinecap="round">
                  <circle cx="8" cy="8" r="6"/><path d="M8 5.5v3M8 10.5h.01"/>
                </svg>
                C-Suite agent, configured via team settings
              </span>
            )}
            {/* Chat — uses the agent's ID as selected_agent for the collector */}
            {!meta.isChief && (
              <button
                onClick={() => navigate(`/?agent=${agentId}`)}
                style={{
                  padding: '10px 20px', borderRadius: 10,
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid var(--m-border-subtle)',
                  color: 'var(--m-text-secondary)', cursor: 'pointer',
                  fontSize: 13, fontWeight: 500,
                  display: 'flex', alignItems: 'center', gap: 8,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.4" strokeLinecap="round">
                  <path d="M14.5 1.5L6.5 9.5M14.5 1.5L10 14.5 6.5 9.5 1.5 6 14.5 1.5Z"/>
                </svg>
                Chat with Agent
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Animation keyframe (injected once) */}
      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

function Section({ title, icon, children, collapsible, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div style={{ marginBottom: 18 }}>
      <div
        onClick={collapsible ? () => setOpen(!open) : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          color: 'var(--m-text-primary)', fontWeight: 600, fontSize: 12,
          textTransform: 'uppercase', letterSpacing: 0.5,
          marginBottom: open ? 10 : 0,
          cursor: collapsible ? 'pointer' : 'default',
          userSelect: 'none',
        }}
      >
        <span style={{ color: 'var(--m-text-tertiary)' }}>{icon}</span>
        {title}
        {collapsible && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" strokeWidth="1.5" strokeLinecap="round"
            style={{ marginLeft: 'auto', transform: open ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.15s', stroke: 'rgba(255,255,255,0.8)' }}>
            <path d="M2 3.5l3 3 3-3"/>
          </svg>
        )}
      </div>
      {open && children}
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ color: 'var(--m-text-secondary, #a1a1aa)', fontSize: 12 }}>{label}</span>
      <span style={{ color: 'var(--m-text-primary)', fontSize: 12, fontWeight: 500, fontFamily: 'monospace' }}>{value}</span>
    </div>
  );
}

// ─── Agent Card (clickable, in the overview grid) ───

function AgentCard({ agent, isOrchestrator, onClick, isSelected }) {
  const meta = getAgentMeta(agent.agentId);
  const roleColor = ROLE_COLORS[agent.role] || '#71717a';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
      style={{
        background: isSelected
          ? `linear-gradient(135deg, ${roleColor}12 0%, var(--m-bg-elevated, rgba(255,255,255,0.05)) 100%)`
          : 'var(--m-bg-elevated, rgba(255,255,255,0.05))',
        border: `1px solid ${isSelected ? `${roleColor}44` : 'var(--m-border-subtle, rgba(255,255,255,0.06))'}`,
        borderRadius: 14,
        padding: 0,
        cursor: 'pointer', textAlign: 'left', width: '100%',
        transition: 'border-color 0.2s, box-shadow 0.2s, transform 0.15s',
        display: 'flex', flexDirection: 'column',
        position: 'relative',
        overflow: 'hidden',
      }}
      onMouseEnter={e => {
        if (!isSelected) {
          e.currentTarget.style.borderColor = `${roleColor}40`;
          e.currentTarget.style.boxShadow = `0 4px 20px ${roleColor}15, 0 0 0 1px ${roleColor}15`;
        }
        e.currentTarget.style.transform = 'translateY(-2px)';
      }}
      onMouseLeave={e => {
        if (!isSelected) {
          e.currentTarget.style.borderColor = 'var(--m-border-subtle, rgba(255,255,255,0.06))';
          e.currentTarget.style.boxShadow = 'none';
        }
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      {/* Top accent line */}
      <div style={{
        height: 3, width: '100%',
        background: isOrchestrator
          ? `linear-gradient(90deg, ${roleColor}, ${roleColor}60)`
          : `linear-gradient(90deg, ${meta.color}60, transparent)`,
      }} />

      <div style={{ padding: isOrchestrator ? '18px 20px' : '16px 18px', width: '100%', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {/* Avatar — larger with abbreviation */}
          <div style={{
            width: isOrchestrator ? 56 : 48, height: isOrchestrator ? 56 : 48,
            borderRadius: isOrchestrator ? 14 : 12,
            background: `${meta.color}15`,
            border: `2px solid ${meta.color}${isOrchestrator ? '50' : '30'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: isOrchestrator ? 18 : 15, color: meta.color, fontWeight: 800,
            flexShrink: 0,
            letterSpacing: meta.shortName.length > 2 ? -0.5 : 0,
          }}>
            {meta.shortName}
          </div>

          {/* Info */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{
                color: 'var(--m-text-primary, #f4f4f5)',
                fontWeight: 600, fontSize: isOrchestrator ? 15 : 14,
              }}>
                {meta.name}
              </span>
              {isOrchestrator && (
                <span style={{
                  padding: '1px 7px', borderRadius: 4,
                  background: roleColor, fontSize: 9, fontWeight: 700,
                  color: '#000', letterSpacing: 0.5, textTransform: 'uppercase',
                }}>
                  LEAD
                </span>
              )}
            </div>
            <div style={{
              color: 'var(--m-text-tertiary, #71717a)', fontSize: 12,
              lineHeight: 1.4,
              display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}>
              {meta.specialty || meta.tagline || ROLE_LABELS[agent.role] || agent.role}
            </div>
          </div>

          {/* Chevron */}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={isSelected ? roleColor : 'var(--m-text-tertiary, #71717a)'} strokeWidth="1.5" strokeLinecap="round"
            style={{ flexShrink: 0, opacity: isSelected ? 0.8 : 0.4, transition: 'opacity 0.15s' }}>
            <path d="M6 3l5 5-5 5"/>
          </svg>
        </div>

        {/* Domains — show team-assigned domains */}
        {agent.domains && agent.domains.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--m-border-subtle, rgba(255,255,255,0.04))' }}>
            {agent.domains.slice(0, 4).map(d => (
              <span key={d} style={{
                padding: '2px 8px', borderRadius: 5,
                background: `${getDomainColor(d)}10`,
                border: `1px solid ${getDomainColor(d)}18`,
                color: getDomainColor(d),
                fontSize: 10, fontWeight: 500,
              }}>
                {d}
              </span>
            ))}
            {agent.domains.length > 4 && (
              <span style={{ color: 'var(--m-text-tertiary)', fontSize: 10, padding: '2px 4px' }}>
                +{agent.domains.length - 4} more
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Policies Panel ───

function PoliciesPanel({ policies }) {
  if (!policies) return null;

  const items = [
    { label: 'Max Token Budget', value: policies.maxBudgetTokens?.toLocaleString(), icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round"><path d="M13 2L3 14M5 2h4l-1 6h4L6 14"/></svg> },
    { label: 'Max Tool Calls', value: policies.maxBudgetToolCalls, icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round"><path d="M10.3 1.7a2.4 2.4 0 013 3L6 12l-4 1 1-4z"/></svg> },
    { label: 'Max Duration', value: policies.maxDurationMs ? `${Math.round(policies.maxDurationMs / 60000)} min` : null, icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.5v3.5l2.5 1.5"/></svg> },
    { label: 'Max Parallel', value: policies.maxParallelTasks, icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round"><path d="M2 4h12M2 8h12M2 12h12"/></svg> },
    { label: 'Approval Required', value: policies.requireApprovalBeforeStart ? 'Yes' : 'No', color: policies.requireApprovalBeforeStart ? '#f59e0b' : '#10b981' },
    { label: 'VOLT Required', value: policies.voltRequired ? 'Yes' : 'No', color: policies.voltRequired ? '#f59e0b' : '#71717a' },
  ].filter(i => i.value != null);

  return (
    <div style={{
      background: 'var(--m-bg-elevated, rgba(255,255,255,0.05))',
      border: '1px solid var(--m-border-subtle, rgba(255,255,255,0.06))',
      borderRadius: 12, padding: 20,
    }}>
      <div style={{
        color: 'var(--m-text-primary)', fontWeight: 600, fontSize: 13, marginBottom: 16,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round">
          <path d="M7 1l5 3v4c0 3-2.5 4.8-5 6-2.5-1.2-5-3-5-6V4l5-3z"/>
        </svg>
        Policies
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {items.map(({ label, value, icon, color }) => (
          <div key={label} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 0',
            borderBottom: '1px solid var(--m-border-subtle, rgba(255,255,255,0.04))',
          }}>
            {icon && <span style={{ color: 'var(--m-text-tertiary)', flexShrink: 0 }}>{icon}</span>}
            <span style={{ color: 'var(--m-text-secondary, #a1a1aa)', fontSize: 12, flex: 1 }}>{label}</span>
            <span style={{
              color: color || 'var(--m-text-primary)', fontSize: 13, fontWeight: 500,
              fontVariantNumeric: 'tabular-nums',
            }}>{value}</span>
          </div>
        ))}
      </div>
      {policies.allowedChannels && policies.allowedChannels.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ color: 'var(--m-text-tertiary)', fontSize: 11, marginBottom: 6 }}>Notification Channels</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {policies.allowedChannels.map(ch => (
              <Badge key={ch} color="default" pill>{ch}</Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── New Objective Modal ───

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low', color: '#6b7280' },
  { value: 'medium', label: 'Medium', color: '#f59e0b' },
  { value: 'high', label: 'High', color: '#f97316' },
  { value: 'critical', label: 'Critical', color: 'var(--m-error, #ef4444)' },
];

function NewObjectiveModal({ teamId, manifest, onClose, onCreated }) {
  const { authFetch } = useAuth();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [requireApproval, setRequireApproval] = useState(manifest?.policies?.requireApprovalBeforeStart ?? true);
  const [checkpointAfterEach, setCheckpointAfterEach] = useState(manifest?.policies?.checkpointAfterEachTask ?? false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);

  const teamName = manifest?.displayName || teamId;
  const memberCount = (manifest?.members?.length || 0) + 1;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      // Ensure the team is installed in the task service before creating the objective
      if (manifest) {
        setStatus('Installing team...');
        await installTeam(authFetch, manifest);
      }
      setStatus('Creating objective...');
      const obj = await createObjective(authFetch, {
        title: title.trim(),
        description: description.trim() || null,
        team_id: teamId,
        priority,
        require_approval_before_start: requireApproval,
        checkpoint_after_each_task: checkpointAfterEach,
      });
      onCreated(obj);
      onClose();
    } catch (err) { setError(err.message); }
    finally { setSubmitting(false); setStatus(null); }
  };

  const inputStyle = {
    width: '100%', padding: '10px 14px', borderRadius: 8,
    background: 'var(--m-bg-base, rgba(255,255,255,0.04))', border: '1px solid var(--m-border-subtle)',
    color: 'var(--m-text-primary)', fontSize: 14, outline: 'none', boxSizing: 'border-box',
  };
  const labelStyle = { display: 'block', color: 'var(--m-text-secondary)', fontSize: 12, fontWeight: 500, marginBottom: 6, letterSpacing: '0.02em' };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <form onClick={e => e.stopPropagation()} onSubmit={handleSubmit}
        style={{ background: 'var(--m-bg-elevated, rgba(255,255,255,0.05))', border: '1px solid var(--m-border-subtle)', borderRadius: 16, padding: '32px 36px', width: 640, maxHeight: '90vh', overflowY: 'auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.3" strokeLinecap="round"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r="0.5" fill="rgba(255,255,255,0.8)"/></svg>
          <span style={{ color: 'var(--m-text-primary)', fontWeight: 600, fontSize: 18 }}>New Team Objective</span>
        </div>
        <div style={{ color: 'var(--m-text-tertiary, #71717a)', fontSize: 13, marginBottom: 24 }}>
          Define what you want <strong style={{ color: 'var(--m-text-secondary)' }}>{teamName}</strong> ({memberCount} agents) to accomplish. Be specific: the team will decompose this into tasks and execute them.
        </div>

        {error && (
          <InlineDependencyError
            error={error}
            service="tasks"
            feature="Agentic Teams"
            compact={false}
            style={{ marginBottom: 16 }}
          />
        )}

        {/* Title */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Objective Title *</label>
          <input value={title} onChange={e => setTitle(e.target.value)}
            placeholder="e.g. Conduct a full security audit of our production infrastructure and produce a remediation report"
            required autoFocus style={inputStyle} />
        </div>

        {/* Description */}
        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>Detailed Brief</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)}
            placeholder={"Provide context, constraints, and success criteria for the team.\n\nExamples:\n• What specific areas should the team focus on?\n• Are there any constraints or boundaries?\n• What does a successful outcome look like?\n• Any relevant background information?"}
            rows={7}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
          <div style={{ fontSize: 11, color: 'var(--m-text-tertiary, #71717a)', marginTop: 4 }}>
            The more detail you provide, the better the team can plan and execute.
          </div>
        </div>

        {/* Priority + Options row */}
        <div style={{ display: 'flex', gap: 20, marginBottom: 24 }}>
          {/* Priority */}
          <div style={{ flex: '0 0 auto' }}>
            <label style={labelStyle}>Priority</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {PRIORITY_OPTIONS.map(p => (
                <button key={p.value} type="button" onClick={() => setPriority(p.value)}
                  style={{
                    padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer',
                    background: priority === p.value ? `${p.color}20` : 'transparent',
                    border: `1px solid ${priority === p.value ? p.color : 'var(--m-border-subtle)'}`,
                    color: priority === p.value ? p.color : 'var(--m-text-secondary)',
                    transition: 'all 0.15s',
                  }}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Checkboxes */}
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Execution Controls</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--m-text-secondary)', marginBottom: 8 }}>
              <input type="checkbox" checked={requireApproval} onChange={e => setRequireApproval(e.target.checked)}
                style={{ accentColor: '#3b82f6', width: 15, height: 15 }} />
              Require approval before execution
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--m-text-secondary)' }}>
              <input type="checkbox" checked={checkpointAfterEach} onChange={e => setCheckpointAfterEach(e.target.checked)}
                style={{ accentColor: '#3b82f6', width: 15, height: 15 }} />
              Checkpoint after each task
            </label>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', borderTop: '1px solid var(--m-border-subtle)', paddingTop: 20 }}>
          {status && <span style={{ flex: 1, fontSize: 12, color: 'var(--m-text-tertiary)', alignSelf: 'center' }}>{status}</span>}
          <button type="button" onClick={onClose} style={{ padding: '10px 20px', borderRadius: 8, background: 'transparent', border: '1px solid var(--m-border-subtle)', color: 'var(--m-text-secondary)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button type="submit" disabled={submitting || !title.trim()} style={{ padding: '10px 22px', borderRadius: 8, background: '#3b82f6', border: 'none', color: '#fff', cursor: submitting ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600, opacity: submitting ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 7 }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.5" strokeLinecap="round"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r="0.5" fill="rgba(255,255,255,0.8)"/></svg>
            {submitting ? 'Creating...' : 'Create Objective'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Objectives Tab ───

function formatElapsed(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return `${min}m ${rem}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function TaskRow({ task, heartbeat, now, onRetry, onSkip, retryLoading, objectiveStatus, allTasks }) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = task.status === 'running';
  const isCompleted = task.status === 'completed';
  const isFailed = task.status === 'failed';
  const isSkipped = task.status === 'skipped';
  const hasResult = !!(task.result && task.result.trim());

  // Graduated heartbeat staleness: warming (30s), stale (45s), dead (90s)
  const hbAge = heartbeat ? (now - heartbeat.ts) : Infinity;
  const hbState = !heartbeat ? 'none' : hbAge < 30000 ? 'fresh' : hbAge < 45000 ? 'warming' : hbAge < 90000 ? 'stale' : 'dead';

  // Live elapsed: use heartbeat elapsed_ms + time since last heartbeat for smooth ticking
  const liveElapsed = heartbeat ? heartbeat.elapsed_ms + (now - heartbeat.ts) : null;

  // Duration for completed/failed tasks
  const durationMs = task.duration_ms;

  // Token usage display
  const tokensUsed = task.tokens_used;

  // Status colors
  const dotColor = isRunning
    ? (hbState === 'fresh' ? '#3b82f6' : hbState === 'warming' ? '#f97316' : hbState === 'stale' ? '#f59e0b' : '#ef4444')
    : isCompleted ? '#10b981' : isFailed ? '#ef4444' : isSkipped ? '#71717a' : '#52525b';

  // Status icon for completed/failed
  const statusIcon = isCompleted
    ? <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#10b981" strokeWidth="1.8" strokeLinecap="round"><path d="M2.5 6l2.5 2.5 4.5-5"/></svg>
    : isFailed
    ? <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#ef4444" strokeWidth="1.8" strokeLinecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>
    : null;

  // Cropped result preview — first meaningful line, max 120 chars
  const resultPreview = useMemo(() => {
    if (!hasResult) return null;
    const lines = task.result.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('|'));
    const first = lines[0] || '';
    return first.length > 120 ? first.slice(0, 120) + '...' : first;
  }, [task.result, hasResult]);

  const borderColor = isRunning ? 'rgba(59,130,246,0.15)'
    : isFailed ? 'rgba(239,68,68,0.12)'
    : isCompleted && expanded ? `${dotColor}18`
    : 'transparent';

  const bgColor = isRunning ? 'rgba(59,130,246,0.04)'
    : isFailed ? 'rgba(239,68,68,0.03)'
    : 'var(--m-bg-base, rgba(17,17,20,0.5))';

  return (
    <div style={{
      borderRadius: 8, overflow: 'hidden',
      border: `1px solid ${borderColor}`,
      background: bgColor,
      transition: 'background 0.15s, border-color 0.15s',
      animation: isCompleted ? 'taskComplete 0.6s ease-out' : isFailed ? 'taskFail 0.6s ease-out' : undefined,
    }}>
      {/* Main row — clickable to expand if has result */}
      <div
        onClick={hasResult ? () => setExpanded(e => !e) : undefined}
        style={{
          padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10,
          cursor: hasResult ? 'pointer' : 'default',
        }}
      >
        {/* Status indicator */}
        {statusIcon || (
          <div style={{
            width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
            background: dotColor,
            boxShadow: isRunning && hbState === 'fresh' ? `0 0 8px ${dotColor}60` : 'none',
            animation: isRunning && hbState === 'fresh' ? 'heartbeatPulse 2s ease-in-out infinite' : undefined,
            transition: 'background 1s ease',
          }} />
        )}

        {/* Task title */}
        <span style={{
          color: (isSkipped || (!isRunning && !isCompleted && !isFailed)) ? 'var(--m-text-tertiary)' : 'var(--m-text-primary)',
          fontSize: 12.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontWeight: isRunning ? 500 : 400,
        }}>{task.title}</span>

        {/* Dependency indicator — resolve ULIDs to step numbers */}
        {task.depends_on && (() => {
          let deps = task.depends_on;
          try { if (typeof deps === 'string') deps = JSON.parse(deps); } catch { /* leave as-is */ }
          if (!Array.isArray(deps)) deps = [deps];
          const labels = deps.map(depId => {
            const idx = allTasks?.findIndex(t => t.id === depId);
            return idx >= 0 ? `Step ${idx + 1}` : null;
          }).filter(Boolean);
          if (!labels.length) return null;
          return (
            <span style={{ color: 'var(--m-text-tertiary)', fontSize: 9, flexShrink: 0, opacity: 0.7 }}>
              ← {labels.join(', ')}
            </span>
          );
        })()}

        {/* Agent label (subtle, inline) */}
        <span style={{
          color: 'var(--m-text-tertiary)', fontSize: 10, flexShrink: 0,
          fontFamily: 'var(--m-font-mono)',
          opacity: 0.7, letterSpacing: 0.3,
        }}>{task.agent_id}</span>

        {/* Running: live elapsed + staleness warning */}
        {isRunning && liveElapsed != null && (
          <span style={{
            fontSize: 11, flexShrink: 0, fontVariantNumeric: 'tabular-nums',
            fontFamily: 'var(--m-font-mono)',
            color: hbState === 'fresh' ? '#60a5fa' : hbState === 'warming' ? '#f97316' : '#f59e0b',
            fontWeight: 500,
          }}>
            {formatElapsed(liveElapsed)}
          </span>
        )}
        {isRunning && hbState === 'stale' && (
          <span style={{ fontSize: 10, color: '#f59e0b', fontWeight: 600, flexShrink: 0, letterSpacing: 0.3, textTransform: 'uppercase' }}>stale</span>
        )}
        {isRunning && hbState === 'dead' && (
          <span style={{ fontSize: 10, color: 'var(--m-error, #ef4444)', fontWeight: 600, flexShrink: 0, letterSpacing: 0.3, textTransform: 'uppercase' }}>unresponsive</span>
        )}

        {/* Completed/Failed: show duration + tokens */}
        {(isCompleted || isFailed) && durationMs != null && (
          <span style={{
            fontSize: 10, color: 'var(--m-text-tertiary)', flexShrink: 0, fontVariantNumeric: 'tabular-nums',
            fontFamily: 'var(--m-font-mono)',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            {formatElapsed(durationMs)}
            {tokensUsed > 0 && (
              <span style={{ opacity: 0.5 }}>{tokensUsed.toLocaleString()} tok</span>
            )}
          </span>
        )}

        {/* Retry button for failed tasks — only after objective finishes (autonomous kickback handles mid-run retries) */}
        {isFailed && onRetry && ['completed_with_errors', 'failed', 'cancelled'].includes(objectiveStatus) && (
          <button
            onClick={(e) => { e.stopPropagation(); onRetry(task.id); }}
            disabled={retryLoading === task.id}
            title="Retry this task"
            style={{
              padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500,
              background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)',
              color: '#60a5fa', cursor: retryLoading === task.id ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
              opacity: retryLoading === task.id ? 0.5 : 1,
              transition: 'background 0.15s, opacity 0.15s',
            }}
          >
            {retryLoading === task.id ? (
              <Spinner size="sm" />
            ) : (
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.8" strokeLinecap="round">
                <path d="M1 2v5h5"/><path d="M3.5 10a5.5 5.5 0 1 0 1-7.5L1 5.5"/>
              </svg>
            )}
            Retry
          </button>
        )}

        {/* Skip button for failed tasks — only after objective finishes */}
        {isFailed && onSkip && ['completed_with_errors', 'failed', 'cancelled'].includes(objectiveStatus) && (
          <button
            onClick={(e) => { e.stopPropagation(); onSkip(task.id); }}
            title="Skip this task"
            style={{
              padding: '3px 8px', borderRadius: 6, fontSize: 11, fontWeight: 500,
              background: 'transparent', border: '1px solid var(--m-border-subtle, rgba(255,255,255,0.08))',
              color: 'var(--m-text-tertiary)', cursor: 'pointer', flexShrink: 0,
              transition: 'background 0.15s',
            }}
          >
            Skip
          </button>
        )}

        {/* Expand chevron for tasks with results */}
        {hasResult && (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--m-text-tertiary)"
            strokeWidth="1.5" strokeLinecap="round" style={{
              flexShrink: 0, opacity: 0.5,
              transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s ease',
            }}>
            <path d="M3 4.5l3 3 3-3"/>
          </svg>
        )}
      </div>

      {/* Preview line — shown when collapsed and has result */}
      {hasResult && !expanded && resultPreview && (
        <div style={{
          padding: '0 14px 8px 36px', /* 36px = 14px padding + 10px dot + 12px gap */
          fontSize: 11, color: 'var(--m-text-tertiary)', lineHeight: 1.4,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          opacity: 0.6,
        }}>
          {resultPreview}
        </div>
      )}

      {/* Expanded result panel */}
      {hasResult && expanded && (
        <div style={{
          margin: '0 10px 10px 10px', padding: '12px 14px',
          borderRadius: 6,
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.04)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{
              fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5,
              color: isFailed ? '#ef4444' : 'var(--m-text-tertiary)',
            }}>
              {isFailed ? 'Error' : 'Result'}
            </span>
            {tokensUsed > 0 && (
              <span style={{
                fontSize: 10, color: 'var(--m-text-tertiary)', opacity: 0.5,
                fontFamily: 'var(--m-font-mono)',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {tokensUsed.toLocaleString()} tokens
              </span>
            )}
          </div>
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            <MarkdownContent compact>{task.result}</MarkdownContent>
          </div>
        </div>
      )}
    </div>
  );
}

function ObjectivesTab({ teamId, manifest, linkedObjectiveId, onPrismContext }) {
  const { authFetch } = useAuth();
  const navigate = useNavigate();
  const [showModal, setShowModal] = useState(false);
  const [selectedId, setSelectedId] = useState(linkedObjectiveId || null);
  const [retryLoading, setRetryLoading] = useState(null);
  const [statusFilter, setStatusFilter] = useState(null);
  const [focusIndex, setFocusIndex] = useState(-1);

  // UX-2: Unified objective management hook (replaces ~130 lines of duplicated state/fetch/stream)
  const {
    objectives, detail, loading, error,
    actions, refresh, connectionState,
    taskHeartbeats, isDecomposing, now,
  } = useObjectiveManager({ teamId, selectedId, statusFilter });

  const [adjustMode, setAdjustMode] = useState(false);
  const [adjustFeedback, setAdjustFeedback] = useState('');
  const [adjustLoading, setAdjustLoading] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);

  const handleAction = async (action, id) => {
    if (actionLoading) return;
    setActionError(null);
    setActionLoading(action);
    try {
      if (action === 'start') await actions.start(id);
      else if (action === 'approve') await actions.approvePlan(id);
      else if (action === 'cancel') await actions.cancel(id);
      else refresh();
    } catch (err) {
      console.error(`[Teams] Action ${action} failed:`, err.message);
      setActionError(`${action} failed: ${err.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleAdjustPlan = async (id) => {
    if (!adjustFeedback.trim()) return;
    setAdjustLoading(true);
    try {
      await actions.rejectPlan(id, adjustFeedback.trim());
      await actions.start(id);
      setAdjustFeedback('');
      setAdjustMode(false);
    } catch (err) {
      setActionError(`Adjust failed: ${err.message}`);
    } finally {
      setAdjustLoading(false);
    }
  };

  const handleRetry = async (taskId) => {
    // QE2: retryTask removed — QuoxFlow manages execution
  };

  // QE2: retryTask/skipTask removed — QuoxFlow manages execution

  // Status filter counts
  const statusCounts = useMemo(() => {
    const counts = { all: objectives.length };
    for (const o of objectives) { counts[o.status] = (counts[o.status] || 0) + 1; }
    return counts;
  }, [objectives]);

  const filteredObjectives = useMemo(() => {
    if (!statusFilter) return objectives;
    return objectives.filter(o => o.status === statusFilter);
  }, [objectives, statusFilter]);

  // Keyboard navigation (j/k/Enter)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusIndex(prev => Math.min(prev + 1, filteredObjectives.length - 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusIndex(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' && focusIndex >= 0) {
        e.preventDefault();
        setSelectedId(filteredObjectives[focusIndex]?.id);
      } else if (e.key === 'Escape') {
        setSelectedId(null);
        setFocusIndex(-1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredObjectives, focusIndex]);

  // Auto-select on keyboard nav
  useEffect(() => {
    if (focusIndex >= 0 && focusIndex < filteredObjectives.length) {
      setSelectedId(filteredObjectives[focusIndex].id);
    }
  }, [focusIndex, filteredObjectives]);

  // Propagate context to parent for PRISM sidebar
  useEffect(() => {
    if (onPrismContext) onPrismContext(objectives, detail);
  }, [objectives, detail, onPrismContext]);

  // Re-run handler for completed/failed objectives
  const handleRerun = async (obj) => {
    setActionError(null);
    setActionLoading('rerun');
    try {
      const newObj = await actions.create({
        title: obj.title,
        description: obj.description || null,
        team_id: teamId,
        priority: obj.priority || 'medium',
      });
      await actions.start(newObj.id);
      setSelectedId(newObj.id);
    } catch (err) {
      setActionError(`Re-run failed: ${err.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  // Connection status bar config
  const connColor = connectionState === 'connected' ? '#10b981' : connectionState === 'connecting' ? '#f59e0b' : connectionState === 'error' ? '#ef4444' : '#52525b';
  const connLabel = connectionState === 'connected' ? 'Live' : connectionState === 'connecting' ? 'Connecting' : connectionState === 'error' ? 'Disconnected' : 'Offline';

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--m-text-secondary)' }}><Spinner size="sm" /> Loading objectives...</div>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'var(--m-text-primary)', fontWeight: 600, fontSize: 14 }}>Team Objectives</span>
          <Badge color="default" pill>{objectives.length}</Badge>
        </div>
        <button onClick={() => setShowModal(true)} style={{ padding: '7px 16px', borderRadius: 7, background: '#3b82f6', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.5" strokeLinecap="round"/></svg>
          New Objective
        </button>
      </div>

      {/* Status filter strip */}
      {objectives.length > 0 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 14 }} role="tablist" aria-label="Filter by status">
          {[
            { key: null, label: 'All' },
            { key: 'running', label: 'Running' },
            { key: 'pending', label: 'Pending' },
            { key: 'completed', label: 'Done' },
            { key: 'failed', label: 'Failed' },
          ].map(f => (
            <button key={f.key || 'all'} role="tab" aria-selected={statusFilter === f.key}
              onClick={() => { setStatusFilter(f.key); setFocusIndex(-1); }}
              style={{
                padding: '4px 12px', borderRadius: 6, fontSize: 11, fontWeight: statusFilter === f.key ? 600 : 400,
                background: statusFilter === f.key ? 'rgba(255,255,255,0.08)' : 'transparent',
                border: `1px solid ${statusFilter === f.key ? 'rgba(255,255,255,0.15)' : 'transparent'}`,
                color: statusFilter === f.key ? 'var(--m-text-primary)' : 'var(--m-text-tertiary)',
                cursor: 'pointer', transition: 'all 0.15s',
              }}
            >
              {f.label}
              {statusCounts[f.key || 'all'] > 0 && (
                <span style={{ marginLeft: 4, opacity: 0.6 }}>({statusCounts[f.key || 'all']})</span>
              )}
            </button>
          ))}
        </div>
      )}

      {error && <InlineDependencyError error={error} service="tasks" feature="Agentic Teams" />}
      {actionError && (
        <InlineDependencyError
          error={actionError}
          service="tasks"
          feature="Agentic Teams"
          onDismiss={() => setActionError(null)}
        />
      )}

      {!error && objectives.length === 0 ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--m-text-secondary)' }}>
          <svg width="32" height="32" viewBox="0 0 16 16" fill="none" strokeWidth="1" strokeLinecap="round"
            style={{ margin: '0 auto 8px', display: 'block', opacity: 0.3, stroke: 'rgba(255,255,255,0.8)' }}>
            <circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r="0.5" fill="rgba(255,255,255,0.8)"/>
          </svg>
          <div style={{ fontSize: 14, marginBottom: 4 }}>No objectives yet</div>
          <div style={{ fontSize: 12, marginBottom: 12 }}>Define a goal and this team will decompose it into tasks, assign agents, and execute autonomously.</div>
          <button onClick={() => setShowModal(true)} style={{ padding: '7px 16px', borderRadius: 7, background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)', color: '#60a5fa', cursor: 'pointer', fontSize: 12, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            ◎ Create First Objective
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: selectedId ? 'minmax(0, 1fr) minmax(0, 1.2fr)' : '1fr', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 600, overflowY: 'auto' }}>
            {filteredObjectives.map((obj, idx) => {
              const statusColor = OBJ_STATUS_COLORS[obj.status] || '#71717a';
              const isSelected = selectedId === obj.id;
              const progress = obj.task_count > 0 ? Math.round(((obj.tasks_completed || 0) / obj.task_count) * 100) : 0;
              return (
                <button key={obj.id} onClick={() => setSelectedId(isSelected ? null : obj.id)}
                  style={{ background: isSelected ? 'var(--m-bg-base, rgba(255,255,255,0.04))' : 'var(--m-bg-elevated, rgba(255,255,255,0.05))', border: `1px solid ${isSelected ? statusColor + '44' : idx === focusIndex ? 'rgba(255,255,255,0.2)' : 'var(--m-border-subtle, rgba(255,255,255,0.06))'}`, borderRadius: 10, padding: 14, textAlign: 'left', cursor: 'pointer', width: '100%', transition: 'border-color 0.15s' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ color: 'var(--m-text-primary)', fontWeight: 500, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{obj.title}</span>
                    <Badge color={statusColor === '#10b981' ? 'green' : statusColor === '#3b82f6' ? 'blue' : statusColor === '#a855f7' ? 'purple' : statusColor === '#ef4444' ? 'red' : 'default'} pill>{obj.status}</Badge>
                  </div>
                  {obj.task_count > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--m-bg-base, rgba(17,17,20,0.8))' }}>
                        <div style={{ width: `${progress}%`, height: '100%', borderRadius: 2, background: statusColor, transition: 'width 0.3s' }} />
                      </div>
                      <span style={{ color: 'var(--m-text-tertiary)', fontSize: 11, flexShrink: 0 }}>{obj.tasks_completed || 0}/{obj.task_count}</span>
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {selectedId && detail && (
            <div style={{ background: 'var(--m-bg-elevated, rgba(255,255,255,0.05))', border: '1px solid var(--m-border-subtle)', borderRadius: 12, padding: 20, maxHeight: 600, overflowY: 'auto' }}>
              {/* Persistent connection status bar */}
              {connectionState && connectionState !== 'disconnected' && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14,
                  padding: '6px 12px', borderRadius: 6,
                  background: `${connColor}10`, border: `1px solid ${connColor}20`,
                  fontSize: 11, fontWeight: 500, color: connColor,
                }}>
                  <span style={{
                    width: 7, height: 7, borderRadius: '50%', background: connColor,
                    animation: connectionState === 'connected' ? 'heartbeatPulse 3s ease-in-out infinite' : undefined,
                  }} />
                  {connLabel}
                  {connectionState === 'connected' && <span style={{ color: 'var(--m-text-tertiary)', fontWeight: 400, marginLeft: 'auto', fontSize: 10 }}>Streaming updates</span>}
                  {connectionState === 'error' && <span style={{ color: 'var(--m-error, #ef4444)', fontWeight: 400, marginLeft: 'auto', fontSize: 10 }}>Reconnecting...</span>}
                </div>
              )}

              <div style={{ color: 'var(--m-text-primary)', fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{detail.title}</div>
              {detail.description && <div style={{ color: 'var(--m-text-secondary)', fontSize: 12, margin: '4px 0 12px', lineHeight: 1.5 }}><MarkdownContent compact>{detail.description}</MarkdownContent></div>}
              <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                <Badge color={OBJ_STATUS_COLORS[detail.status] === '#10b981' ? 'green' : OBJ_STATUS_COLORS[detail.status] === '#3b82f6' ? 'blue' : OBJ_STATUS_COLORS[detail.status] === '#a855f7' ? 'purple' : OBJ_STATUS_COLORS[detail.status] === '#ef4444' ? 'red' : 'default'} pill>{detail.status}</Badge>
                {detail.orchestrator_agent_id && <Badge color="amber" pill>{detail.orchestrator_agent_id}</Badge>}
              </div>
              {/* Budget meters */}
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 14,
                padding: '10px 14px', borderRadius: 8,
                background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)',
              }}>
                <div>
                  <div style={{ color: 'var(--m-text-tertiary)', fontSize: 10, fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 2 }}>Tokens</div>
                  <div style={{ color: 'var(--m-text-primary)', fontSize: 14, fontWeight: 600, fontFamily: 'var(--m-font-mono)' }}>{(detail.tokens_used || 0).toLocaleString()}</div>
                  {detail.max_tokens && <div style={{ color: 'var(--m-text-tertiary)', fontSize: 10 }}>/ {detail.max_tokens.toLocaleString()}</div>}
                </div>
                <div>
                  <div style={{ color: 'var(--m-text-tertiary)', fontSize: 10, fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 2 }}>Tool Calls</div>
                  <div style={{ color: 'var(--m-text-primary)', fontSize: 14, fontWeight: 600, fontFamily: 'var(--m-font-mono)' }}>{detail.tool_calls_used || 0}</div>
                  {detail.max_tool_calls && <div style={{ color: 'var(--m-text-tertiary)', fontSize: 10 }}>/ {detail.max_tool_calls}</div>}
                </div>
                <div>
                  <div style={{ color: 'var(--m-text-tertiary)', fontSize: 10, fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 2 }}>Tasks</div>
                  <div style={{ color: 'var(--m-text-primary)', fontSize: 14, fontWeight: 600, fontFamily: 'var(--m-font-mono)' }}>{detail.tasks_completed || 0}/{detail.task_count || 0}</div>
                  {detail.tasks_failed > 0 && <div style={{ color: 'var(--m-error, #ef4444)', fontSize: 10 }}>{detail.tasks_failed} failed</div>}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
                {detail.status === 'pending' && (
                  <button onClick={() => handleAction('start', detail.id)} disabled={!!actionLoading} style={{ padding: '6px 14px', borderRadius: 7, background: '#3b82f6', border: 'none', color: '#fff', fontSize: 12, cursor: actionLoading ? 'not-allowed' : 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 5, opacity: actionLoading ? 0.6 : 1 }}>
                    {actionLoading === 'start' ? <Spinner size="sm" /> : <svg width="10" height="10" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>}
                    {actionLoading === 'start' ? 'Starting...' : 'Start'}
                  </button>
                )}
                {detail.status === 'decomposing' && (
                  <span style={{ padding: '6px 14px', borderRadius: 7, background: 'rgba(139,92,246,0.15)', color: '#8b5cf6', fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Spinner size="sm" /> Decomposing into tasks...
                  </span>
                )}
                {detail.status === 'decomposed' && (
                  <>
                    <button onClick={() => handleAction('approve', detail.id)} disabled={!!actionLoading} style={{ padding: '6px 14px', borderRadius: 7, background: '#10b981', border: 'none', color: '#fff', fontSize: 12, cursor: actionLoading ? 'not-allowed' : 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 5, opacity: actionLoading ? 0.6 : 1 }}>
                      {actionLoading === 'approve' ? <Spinner size="sm" /> : <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.5" strokeLinecap="round"><path d="M2 5l2.5 2.5 3.5-5"/></svg>}
                      {actionLoading === 'approve' ? 'Approving...' : 'Approve Plan'}
                    </button>
                    <button onClick={() => setAdjustMode(!adjustMode)} style={{ padding: '6px 14px', borderRadius: 7, background: adjustMode ? 'rgba(139,92,246,0.2)' : 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.25)', color: '#a78bfa', fontSize: 12, cursor: 'pointer', fontWeight: 500 }}>
                      ✎ Adjust
                    </button>
                  </>
                )}
                {['running', 'in_progress', 'decomposing'].includes(detail.status) && (
                  <button onClick={() => navigate(`/opsdeck?objective=${detail.id}`)} style={{ padding: '6px 14px', borderRadius: 7, background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.25)', color: '#818cf8', fontSize: 12, cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.4"/><circle cx="12" cy="12" r="5" opacity="0.6"/><circle cx="12" cy="12" r="1.5" fill="rgba(255,255,255,0.8)" stroke="none"/></svg>
                    Watch
                  </button>
                )}
                {!['completed', 'failed', 'cancelled', 'completed_with_errors'].includes(detail.status) && (
                  <button onClick={() => handleAction('cancel', detail.id)} disabled={!!actionLoading} style={{ padding: '6px 14px', borderRadius: 7, background: 'transparent', border: '1px solid var(--m-border-subtle)', color: 'var(--m-text-secondary)', fontSize: 12, cursor: actionLoading ? 'not-allowed' : 'pointer', opacity: actionLoading ? 0.6 : 1 }}>Cancel</button>
                )}
                {['completed', 'completed_with_errors', 'failed'].includes(detail.status) && (
                  <button onClick={() => handleRerun(detail)} disabled={!!actionLoading}
                    style={{ padding: '6px 14px', borderRadius: 7, background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', color: '#60a5fa', fontSize: 12, cursor: actionLoading ? 'not-allowed' : 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 5, opacity: actionLoading ? 0.6 : 1 }}>
                    {actionLoading === 'rerun' ? '...' : '↻'} Re-run
                  </button>
                )}
              </div>
              {adjustMode && detail.status === 'decomposed' && (
                <div style={{ margin: '10px 0', padding: 12, borderRadius: 8, background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.15)' }}>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#a78bfa', marginBottom: 6 }}>
                    ✎ What should change?
                  </label>
                  <textarea
                    value={adjustFeedback}
                    onChange={e => setAdjustFeedback(e.target.value)}
                    placeholder="e.g. Add a verification step, use sentinel for security, split task 3..."
                    rows={3}
                    style={{
                      width: '100%', padding: 8, borderRadius: 6, border: '1px solid rgba(139,92,246,0.2)',
                      background: 'rgba(0,0,0,0.2)', color: 'var(--m-text-primary)', fontSize: 12,
                      fontFamily: 'inherit', resize: 'vertical', outline: 'none', boxSizing: 'border-box',
                    }}
                    autoFocus
                    onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) handleAdjustPlan(detail.id); }}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                    <button onClick={() => { setAdjustMode(false); setAdjustFeedback(''); }}
                      style={{ padding: '5px 12px', borderRadius: 6, background: 'transparent', border: '1px solid var(--m-border-subtle)', color: 'var(--m-text-secondary)', fontSize: 11, cursor: 'pointer' }}>Cancel</button>
                    <button onClick={() => handleAdjustPlan(detail.id)} disabled={!adjustFeedback.trim() || adjustLoading}
                      style={{ padding: '5px 12px', borderRadius: 6, background: 'rgba(139,92,246,0.2)', border: '1px solid rgba(139,92,246,0.3)', color: '#a78bfa', fontSize: 11, cursor: !adjustFeedback.trim() || adjustLoading ? 'not-allowed' : 'pointer', fontWeight: 500, opacity: !adjustFeedback.trim() ? 0.5 : 1 }}>
                      {adjustLoading ? 'Re-planning...' : 'Re-plan with adjustments'}
                    </button>
                  </div>
                </div>
              )}
              {detail.tasks && detail.tasks.length > 0 && (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span style={{ color: 'var(--m-text-secondary)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Tasks</span>
                    <span style={{ color: 'var(--m-text-tertiary)', fontSize: 11 }}>{detail.tasks.filter(t => t.status === 'completed').length}/{detail.tasks.length} complete</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {detail.tasks.map((task) => (
                      <TaskRow key={task.id} task={task} heartbeat={taskHeartbeats[task.id]} now={now}
                        onRetry={handleRetry} onSkip={handleSkip} retryLoading={retryLoading}
                        objectiveStatus={detail.status} allTasks={detail.tasks} />
                    ))}
                  </div>

                  {/* Stats strip — tokens, tool calls, timing */}
                  {['completed', 'completed_with_errors', 'failed'].includes(detail.status) && (
                    <div style={{
                      display: 'flex', gap: 16, marginTop: 12, padding: '8px 12px',
                      borderRadius: 6, background: 'rgba(255,255,255,0.02)',
                      border: '1px solid rgba(255,255,255,0.04)',
                      fontFamily: 'var(--m-font-mono)',
                      fontSize: 10, color: 'var(--m-text-tertiary)',
                      fontVariantNumeric: 'tabular-nums',
                    }}>
                      {detail.tokens_used > 0 && (
                        <span>{detail.tokens_used.toLocaleString()} tokens</span>
                      )}
                      {detail.tool_calls_used > 0 && (
                        <span>{detail.tool_calls_used} tool calls</span>
                      )}
                      {detail.tasks_failed > 0 && (
                        <span style={{ color: 'var(--m-error, #ef4444)' }}>{detail.tasks_failed} failed</span>
                      )}
                      {detail.completed_at && detail.started_at && (
                        <span style={{ marginLeft: 'auto' }}>
                          {formatElapsed(new Date(detail.completed_at) - new Date(detail.started_at))} total
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>
      )}
      {showModal && <NewObjectiveModal teamId={teamId} manifest={manifest} onClose={() => setShowModal(false)} onCreated={() => refresh()} />}
    </div>
  );
}

// ─── Context Tab ───

function ContextTab({ teamId }) {
  const { authFetch } = useAuth();
  const [context, setContext] = useState({});
  const [instanceId, setInstanceId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [contextError, setContextError] = useState(null);

  useEffect(() => {
    getTeamContext(authFetch, teamId)
      .then(data => { setContext(data.context || {}); setInstanceId(data.instance_id || null); })
      .catch(() => setContext({}))
      .finally(() => setLoading(false));
  }, [authFetch, teamId]);

  const handleAdd = async () => {
    if (!newKey.trim() || !instanceId) return;
    setSaving(true);
    try {
      await updateTeamContext(authFetch, teamId, instanceId, newKey.trim(), newValue);
      setContext(prev => ({ ...prev, [newKey.trim()]: newValue }));
      setNewKey(''); setNewValue('');
    } catch (err) { console.error('[Context] Save error:', err.message); setContextError(err.message); }
    finally { setSaving(false); }
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--m-text-secondary)' }}>Loading context...</div>;

  const entries = Object.entries(context);
  const inputStyle = { width: '100%', padding: '6px 10px', borderRadius: 5, background: 'var(--m-bg-base, rgba(255,255,255,0.04))', border: '1px solid var(--m-border-subtle)', color: 'var(--m-text-primary)', fontSize: 12, outline: 'none', boxSizing: 'border-box' };

  return (
    <div>
      <div style={{ color: 'var(--m-text-primary)', fontWeight: 600, fontSize: 14, marginBottom: 6 }}>Shared Context</div>
      <p style={{ color: 'var(--m-text-secondary)', fontSize: 12, marginBottom: 16 }}>Key-value pairs shared across all tasks in this team's active instance.</p>
      {contextError && <div style={{ padding: 10, marginBottom: 12, borderRadius: 6, background: 'rgba(239,68,68,0.1)', color: 'var(--m-error, #ef4444)', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><span>{contextError}</span><button onClick={() => setContextError(null)} style={{ background: 'none', border: 'none', color: 'var(--m-error, #ef4444)', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>&times;</button></div>}

      {entries.length === 0 && !instanceId && (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--m-text-tertiary)', fontSize: 13 }}>No active team instance. Run an objective first to create shared context.</div>
      )}

      {entries.length > 0 && (
        <div style={{ background: 'var(--m-bg-elevated, rgba(255,255,255,0.05))', border: '1px solid var(--m-border-subtle)', borderRadius: 10, marginBottom: 16, overflow: 'hidden' }}>
          {entries.map(([key, value], i) => (
            <div key={key} style={{ display: 'flex', padding: '10px 14px', borderBottom: i < entries.length - 1 ? '1px solid var(--m-border-subtle, rgba(255,255,255,0.04))' : 'none' }}>
              <div style={{ width: 160, flexShrink: 0, color: 'var(--m-text-secondary)', fontSize: 12, fontWeight: 500 }}>{key}</div>
              <div style={{ color: 'var(--m-text-primary)', fontSize: 12, flex: 1 }}>{String(value)}</div>
            </div>
          ))}
        </div>
      )}

      {instanceId && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 11, marginBottom: 4 }}>Key</label>
            <input value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="key" style={inputStyle} />
          </div>
          <div style={{ flex: 2 }}>
            <label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 11, marginBottom: 4 }}>Value</label>
            <input value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="value" style={inputStyle} />
          </div>
          <button onClick={handleAdd} disabled={saving || !newKey.trim()}
            style={{ padding: '6px 14px', borderRadius: 6, background: '#3b82f6', border: 'none', color: '#fff', fontSize: 12, cursor: saving ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>
            {saving ? 'Saving...' : 'Add'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Performance Tab (EX-3) ───

function PerformanceTab({ teamId }) {
  const { authFetch } = useAuth()
  const [agents, setAgents] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch(`/tasks/api/teams/${teamId}/performance`)
        const data = await readTaskServiceJson(res, 'Failed to load team performance', { fallback: { agents: [] } })
        setAgents((data.agents || []).map(a => ({
          id: a.agentId, name: a.agentId.toUpperCase(), color: '#71717a',
          score: a.score || 50, successRate: a.successRate || 0,
          avgDurationMs: a.avgLatencyMs || 0, tokensUsed: a.totalTokens || 0,
          taskCount: a.taskCount || 0, trend: 'flat',
        })))
      } catch (e) { console.warn('[Performance] Fetch failed:', e.message) }
      finally { setLoading(false) }
    })()
  }, [teamId, authFetch])

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--m-text-secondary)' }}><Spinner size="sm" /> Loading performance data...</div>

  if (agents.length === 0) return (
    <div style={{ padding: 40, textAlign: 'center', color: 'var(--m-text-secondary)', fontSize: 13 }}>
      <div style={{ fontSize: 24, marginBottom: 8, opacity: 0.4 }}>◎</div>
      No performance data yet. Run objectives with this team to start tracking agent performance.
    </div>
  )

  return (
    <div style={{ padding: '0 4px' }}>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--m-text-primary)' }}>Agent Leaderboard</h3>
        <span style={{ fontSize: 10, color: 'var(--m-text-tertiary)', fontFamily: 'var(--m-font-mono)' }}>{agents.length} agents tracked</span>
      </div>
      <div style={{ background: 'var(--m-bg-elevated, rgba(255,255,255,0.05))', border: '1px solid var(--m-border-subtle, rgba(255,255,255,0.06))', borderRadius: 12, overflow: 'hidden' }}>
        <AgentLeaderboard agents={agents} />
      </div>
    </div>
  )
}

// ─── Settings Tab ───

function SettingsTab({ teamId, team, onUpdated }) {
  const { authFetch } = useAuth();
  const navigate = useNavigate();
  const manifest = team?.manifest;

  const [displayName, setDisplayName] = useState(manifest?.displayName || '');
  const [description, setDescription] = useState(manifest?.description || '');
  const [maxTokens, setMaxTokens] = useState(manifest?.policies?.maxBudgetTokens || 200000);
  const [maxToolCalls, setMaxToolCalls] = useState(manifest?.policies?.maxBudgetToolCalls || 100);
  const [maxParallel, setMaxParallel] = useState(manifest?.policies?.maxParallelTasks || 3);
  const [maxDuration, setMaxDuration] = useState(manifest?.policies?.maxDurationMs || 600000);
  const autonomy = manifest?.autonomyPolicies || {};
  const [maxDailyTokens, setMaxDailyTokens] = useState(autonomy.maxDailyTokens || 500000);
  const [maxDailyToolCalls, setMaxDailyToolCalls] = useState(autonomy.maxDailyToolCalls || 500);
  const [maxUnattended, setMaxUnattended] = useState(autonomy.maxUnattendedObjectives || 10);
  const [alertBudgetPct, setAlertBudgetPct] = useState(autonomy.alertAtBudgetPercent || 80);
  const [canAutoStart, setCanAutoStart] = useState(autonomy.canStartWithoutApproval || false);
  const [notifyComplete, setNotifyComplete] = useState(autonomy.notifyOnCompletion !== false);
  const [notifyError, setNotifyError] = useState(autonomy.notifyOnError !== false);
  // UX-7: Reporting & checkpoint preferences
  const [reportingFrequency, setReportingFrequency] = useState(manifest?.policies?.reportingFrequency || 'end_of_run');
  const [checkpointPolicy, setCheckpointPolicy] = useState(manifest?.policies?.checkpointPolicy || 'on_failure');
  const [maxTaskTimeout, setMaxTaskTimeout] = useState(Math.round((manifest?.policies?.maxTaskDurationMs || 1800000) / 1000));

  const [saving, setSaving] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false);
  const [message, setMessage] = useState(null);

  const handleSave = async () => {
    setSaving(true); setMessage(null);
    try {
      await updateTeam(authFetch, teamId, {
        displayName: displayName.trim(), description: description.trim(),
        policies: { maxBudgetTokens: Number(maxTokens), maxBudgetToolCalls: Number(maxToolCalls), maxParallelTasks: Number(maxParallel), maxDurationMs: Number(maxDuration), reportingFrequency, checkpointPolicy, maxTaskDurationMs: maxTaskTimeout * 1000 },
        autonomyPolicies: { maxDailyTokens: Number(maxDailyTokens), maxDailyToolCalls: Number(maxDailyToolCalls), maxUnattendedObjectives: Number(maxUnattended), alertAtBudgetPercent: Number(alertBudgetPct), canStartWithoutApproval: canAutoStart, notifyOnCompletion: notifyComplete, notifyOnError: notifyError },
      });
      setMessage({ type: 'success', text: 'Settings saved' });
      if (onUpdated) onUpdated();
    } catch (err) { setMessage({ type: 'error', text: err.message }); }
    finally { setSaving(false); }
  };

  const handleUninstall = async () => {
    setShowUninstallConfirm(false); setUninstalling(true);
    try { await uninstallTeam(authFetch, teamId); navigate('/teams-overview'); }
    catch (err) { setMessage({ type: 'error', text: err.message }); setUninstalling(false); }
  };

  const inputStyle = { width: '100%', padding: '8px 12px', borderRadius: 6, background: 'var(--m-bg-base, rgba(255,255,255,0.04))', border: '1px solid var(--m-border-subtle)', color: 'var(--m-text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box' };

  return (
    <div>
      {message && (
        <div style={{
          padding: 12, marginBottom: 16, borderRadius: 8,
          background: message.type === 'success' ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
          border: `1px solid ${message.type === 'success' ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`,
          color: message.type === 'success' ? '#10b981' : '#ef4444',
          fontSize: 13, display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            {message.type === 'success'
              ? <><circle cx="7" cy="7" r="6" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2"/><path d="M4.5 7l1.8 1.8 3.2-3.6" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></>
              : <><circle cx="7" cy="7" r="6" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2"/><path d="M7 4.5v3M7 9.5v.01" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round"/></>
            }
          </svg>
          {message.text}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 20, marginBottom: 24 }}>
        <div style={{ background: 'var(--m-bg-elevated, rgba(255,255,255,0.05))', border: '1px solid var(--m-border-subtle, rgba(255,255,255,0.06))', borderRadius: 12, padding: 20 }}>
          <div style={{ color: 'var(--m-text-primary)', fontWeight: 600, fontSize: 13, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round"><circle cx="7" cy="7" r="6"/><path d="M7 4v3h3"/></svg>
            General
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 12, marginBottom: 4 }}>Team Name</label>
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 12, marginBottom: 4 }}>Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
        </div>

        <div style={{ background: 'var(--m-bg-elevated, rgba(255,255,255,0.05))', border: '1px solid var(--m-border-subtle, rgba(255,255,255,0.06))', borderRadius: 12, padding: 20 }}>
          <div style={{ color: 'var(--m-text-primary)', fontWeight: 600, fontSize: 13, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round"><rect x="2" y="2" width="10" height="10" rx="2"/><path d="M5 7h4M7 5v4"/></svg>
            Budget & Execution
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 11, marginBottom: 4 }}>Max Tokens</label><input type="number" value={maxTokens} onChange={e => setMaxTokens(e.target.value)} style={inputStyle} /></div>
            <div><label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 11, marginBottom: 4 }}>Max Tool Calls</label><input type="number" value={maxToolCalls} onChange={e => setMaxToolCalls(e.target.value)} style={inputStyle} /></div>
            <div><label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 11, marginBottom: 4 }}>Max Parallel Tasks</label><input type="number" value={maxParallel} onChange={e => setMaxParallel(e.target.value)} min="1" max="10" style={inputStyle} /></div>
            <div><label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 11, marginBottom: 4 }}>Max Duration (ms)</label><div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><input type="number" value={maxDuration} onChange={e => setMaxDuration(e.target.value)} style={inputStyle} /><span style={{ color: 'var(--m-text-tertiary)', fontSize: 11, whiteSpace: 'nowrap' }}>= {Math.round(maxDuration / 60000)} min</span></div></div>
          </div>
          <div style={{ color: 'var(--m-text-tertiary)', fontSize: 10, marginTop: 6, lineHeight: 1.5 }}>
            These limits apply per objective. The team will stop if any limit is reached.
          </div>
        </div>
      </div>

      <div style={{ background: 'var(--m-bg-elevated, rgba(255,255,255,0.05))', border: '1px solid var(--m-border-subtle, rgba(255,255,255,0.06))', borderRadius: 12, padding: 20, marginBottom: 24 }}>
        <div style={{ color: 'var(--m-text-primary)', fontWeight: 600, fontSize: 13, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round"><path d="M7 1l5 3v4c0 3-2.5 4.8-5 6-2.5-1.2-5-3-5-6V4l5-3z"/></svg>
          Autonomy Policies
        </div>
        <p style={{ color: 'var(--m-text-secondary)', fontSize: 12, marginBottom: 16, marginTop: 4 }}>Budget guardrails for scheduled (autonomous) execution.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
          <div><label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 11, marginBottom: 4 }}>Max Daily Tokens</label><input type="number" value={maxDailyTokens} onChange={e => setMaxDailyTokens(e.target.value)} style={inputStyle} /></div>
          <div><label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 11, marginBottom: 4 }}>Max Daily Tool Calls</label><input type="number" value={maxDailyToolCalls} onChange={e => setMaxDailyToolCalls(e.target.value)} style={inputStyle} /></div>
          <div><label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 11, marginBottom: 4 }}>Max Unattended Objectives</label><input type="number" value={maxUnattended} onChange={e => setMaxUnattended(e.target.value)} min="1" max="100" style={inputStyle} /></div>
          <div><label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 11, marginBottom: 4 }}>Alert at Budget %</label><input type="number" value={alertBudgetPct} onChange={e => setAlertBudgetPct(e.target.value)} min="50" max="100" style={inputStyle} /></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 6, padding: '12px 14px', borderRadius: 8, background: 'var(--m-bg-base, rgba(17,17,20,0.8))' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--m-text-secondary)', fontSize: 12, cursor: 'pointer' }}><input type="checkbox" checked={canAutoStart} onChange={e => setCanAutoStart(e.target.checked)} style={{ accentColor: '#8b5cf6' }} /> Auto-approve scheduled objectives</label>
          <div style={{ gridColumn: '1 / -1', color: 'var(--m-text-tertiary)', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 }}>Notifications</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--m-text-secondary)', fontSize: 12, cursor: 'pointer' }}><input type="checkbox" checked={notifyComplete} onChange={e => setNotifyComplete(e.target.checked)} style={{ accentColor: '#8b5cf6' }} /> Notify on completion</label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--m-text-secondary)', fontSize: 12, cursor: 'pointer' }}><input type="checkbox" checked={notifyError} onChange={e => setNotifyError(e.target.checked)} style={{ accentColor: '#8b5cf6' }} /> Notify on error</label>
        </div>
      </div>

      {/* UX-7: Reporting & Checkpoints */}
      <div style={{ marginBottom: 24 }}>
        <ReportingSettingsSection
          reportingFrequency={reportingFrequency}
          checkpointPolicy={checkpointPolicy}
          maxTaskTimeout={maxTaskTimeout}
          onReportingFrequencyChange={setReportingFrequency}
          onCheckpointPolicyChange={setCheckpointPolicy}
          onMaxTaskTimeoutChange={setMaxTaskTimeout}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 32 }}>
        <button onClick={handleSave} disabled={saving}
          style={{ padding: '9px 24px', borderRadius: 8, background: '#3b82f6', border: 'none', color: '#fff', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 500, opacity: saving ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.5" strokeLinecap="round"><path d="M4.5 7l1.8 1.8 3.2-3.6"/></svg>
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      <div style={{ padding: 20, borderRadius: 12, border: '1px solid rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.03)' }}>
        <div style={{ color: 'var(--m-error, #ef4444)', fontWeight: 600, fontSize: 13, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round"><path d="M6.13 2.44L1.36 10.5a1 1 0 00.87 1.5h9.54a1 1 0 00.87-1.5L7.87 2.44a1 1 0 00-1.74 0z"/><path d="M7 6v2M7 10v.01"/></svg>
          Danger Zone
        </div>
        <p style={{ color: 'var(--m-text-secondary)', fontSize: 12, marginBottom: 12, marginTop: 0 }}>Uninstalling archives this team. Existing objectives and data are preserved.</p>
        <button onClick={() => setShowUninstallConfirm(true)} disabled={uninstalling}
          style={{ padding: '7px 16px', borderRadius: 7, background: 'transparent', border: '1px solid rgba(239,68,68,0.4)', color: 'var(--m-error, #ef4444)', fontSize: 12, cursor: uninstalling ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round"><path d="M1.5 3h9M4.5 3V2a1 1 0 011-1h1a1 1 0 011 1v1M9.5 3v7a1 1 0 01-1 1h-5a1 1 0 01-1-1V3"/></svg>
          {uninstalling ? 'Uninstalling...' : 'Uninstall Team'}
        </button>
      </div>
      <ConfirmModal isOpen={showUninstallConfirm} onClose={() => setShowUninstallConfirm(false)} onConfirm={handleUninstall}
        title="Uninstall Team" message={`Are you sure you want to uninstall "${displayName}"? This archives the team. Existing objectives and data are preserved.`}
        confirmLabel="Uninstall" danger loading={uninstalling} />
    </div>
  );
}

// ─── Schedules Tab ───

const SCHEDULE_PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Daily 9am', cron: '0 9 * * *' },
  { label: 'Weekdays 9am', cron: '0 9 * * 1-5' },
  { label: 'Weekly Mon 9am', cron: '0 9 * * 1' },
  { label: 'Monthly 1st 9am', cron: '0 9 1 * *' },
  { label: 'Custom', cron: '' },
];

const SCHED_STATUS_COLORS = { triggered: '#3b82f6', completed: '#10b981', error: '#ef4444' };

function CreateScheduleModal({ teamId, onClose, onCreated }) {
  const { authFetch } = useAuth();
  const [name, setName] = useState('');
  const [selectedPreset, setSelectedPreset] = useState(null);
  const [customCron, setCustomCron] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [maxFailures, setMaxFailures] = useState(3);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const cronExpr = selectedPreset?.cron || customCron;
  const cronPreview = cronExpr ? cronToHuman(cronExpr) : '';
  const cronValid = cronExpr ? isValidCron(cronExpr) : false;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !title.trim() || !cronValid) return;
    setSubmitting(true); setError(null);
    try {
      await createSchedule(authFetch, teamId, { name: name.trim(), cronExpression: cronExpr.trim(), objectiveTemplate: { title: title.trim(), description: description.trim() || null }, maxConsecutiveFailures: Number(maxFailures) || 3 });
      onCreated(); onClose();
    } catch (err) { setError(err.message); }
    finally { setSubmitting(false); }
  };

  const inputStyle = { width: '100%', padding: '8px 12px', borderRadius: 6, background: 'var(--m-bg-base, rgba(255,255,255,0.04))', border: '1px solid var(--m-border-subtle)', color: 'var(--m-text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box' };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <form onClick={e => e.stopPropagation()} onSubmit={handleSubmit}
        style={{ background: 'var(--m-bg-elevated, rgba(255,255,255,0.05))', border: '1px solid var(--m-border-subtle)', borderRadius: 14, padding: 28, width: 520, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ color: 'var(--m-text-primary)', fontWeight: 600, fontSize: 17, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.3" strokeLinecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.5v3.5l2.5 1.5"/></svg>
          Create Schedule
        </div>
        {error && (
          <InlineDependencyError
            error={error}
            service="tasks"
            feature="Agentic Team schedules"
            compact={false}
          />
        )}

        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 12, marginBottom: 4 }}>Schedule Name *</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Daily Security Scan" required style={inputStyle} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 12, marginBottom: 6 }}>Frequency *</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
            {SCHEDULE_PRESETS.map(preset => {
              const isSelected = selectedPreset?.label === preset.label;
              return (
                <button key={preset.label} type="button"
                  onClick={() => { setSelectedPreset(preset); if (preset.cron) setCustomCron(''); }}
                  style={{ padding: '8px 10px', borderRadius: 7, fontSize: 12, cursor: 'pointer', background: isSelected ? 'rgba(59,130,246,0.15)' : 'var(--m-bg-base, rgba(255,255,255,0.04))', border: `1px solid ${isSelected ? '#3b82f6' : 'var(--m-border-subtle)'}`, color: isSelected ? '#3b82f6' : 'var(--m-text-secondary)', fontWeight: isSelected ? 600 : 400 }}>
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>

        {selectedPreset?.label === 'Custom' && (
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 12, marginBottom: 4 }}>Cron Expression *</label>
            <input value={customCron} onChange={e => setCustomCron(e.target.value)} placeholder="0 9 * * 1-5"
              style={{ ...inputStyle, border: `1px solid ${customCron && !cronValid ? '#ef4444' : 'var(--m-border-subtle)'}`, fontFamily: 'monospace' }} />
          </div>
        )}

        {cronExpr && (
          <div style={{ marginBottom: 14, padding: '8px 12px', borderRadius: 6, background: cronValid ? 'rgba(59,130,246,0.08)' : 'rgba(239,68,68,0.08)', fontSize: 12, color: cronValid ? '#60a5fa' : '#ef4444' }}>
            {cronValid ? cronPreview : 'Invalid cron expression'}
          </div>
        )}

        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 12, marginBottom: 4 }}>Objective Title *</label>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Run security audit on all hosts" required style={inputStyle} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 12, marginBottom: 4 }}>Description</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional details..." rows={3}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', color: 'var(--m-text-secondary)', fontSize: 12, marginBottom: 4 }}>Max Consecutive Failures (auto-disable)</label>
          <input type="number" value={maxFailures} onChange={e => setMaxFailures(e.target.value)} min="1" max="20"
            style={{ width: 80, padding: '6px 10px', borderRadius: 5, background: 'var(--m-bg-base)', border: '1px solid var(--m-border-subtle)', color: 'var(--m-text-primary)', fontSize: 12, outline: 'none' }} />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={{ padding: '9px 18px', borderRadius: 8, background: 'transparent', border: '1px solid var(--m-border-subtle)', color: 'var(--m-text-secondary)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button type="submit" disabled={submitting || !name.trim() || !title.trim() || !cronValid}
            style={{ padding: '9px 18px', borderRadius: 8, background: '#3b82f6', border: 'none', color: '#fff', cursor: submitting ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 500, opacity: submitting ? 0.6 : 1 }}>
            {submitting ? 'Creating...' : 'Create Schedule'}
          </button>
        </div>
      </form>
    </div>
  );
}

function SchedulesTab({ teamId }) {
  const { authFetch } = useAuth();
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const fetchSchedules = useCallback(async () => {
    try { const data = await listSchedules(authFetch, teamId); setSchedules(data.schedules || []); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [authFetch, teamId]);

  useEffect(() => { fetchSchedules(); }, [fetchSchedules]);

  const [schedError, setSchedError] = useState(null);
  const handleToggle = async (scheduleId, currentEnabled) => {
    setSchedError(null);
    try { await toggleSchedule(authFetch, teamId, scheduleId, !currentEnabled); fetchSchedules(); }
    catch (err) { console.error('[Schedules] Toggle error:', err.message); setSchedError(err.message); }
  };

  const handleDelete = async (scheduleId) => {
    setDeleteTarget(null);
    try { await deleteSchedule(authFetch, teamId, scheduleId); fetchSchedules(); }
    catch (err) { console.error('[Schedules] Delete error:', err.message); setSchedError(err.message); }
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--m-text-secondary)' }}><Spinner size="sm" /> Loading schedules...</div>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'var(--m-text-primary)', fontWeight: 600, fontSize: 14 }}>Schedules</span>
          <Badge color="default" pill>{schedules.length}</Badge>
        </div>
        <button onClick={() => setShowModal(true)}
          style={{ padding: '7px 16px', borderRadius: 7, background: '#3b82f6', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.5" strokeLinecap="round"/></svg>
          Create Schedule
        </button>
      </div>

      {error && <InlineDependencyError error={error} service="tasks" feature="Agentic Team schedules" />}
      {schedError && (
        <InlineDependencyError
          error={schedError}
          service="tasks"
          feature="Agentic Team schedules"
          onDismiss={() => setSchedError(null)}
        />
      )}

      {!error && schedules.length === 0 ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--m-text-secondary)' }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style={{ margin: '0 auto 8px', display: 'block', opacity: 0.3 }}>
            <circle cx="12" cy="12" r="10" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.5"/><path d="M12 6v6l4 2" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <div style={{ fontSize: 14, marginBottom: 4 }}>No schedules yet</div>
          <div style={{ fontSize: 12 }}>Create a schedule to run this team autonomously on a cron timer.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {schedules.map(sched => {
            const statusColor = SCHED_STATUS_COLORS[sched.last_status] || '#71717a';
            let template = {};
            try { template = JSON.parse(sched.objective_template_json || '{}'); } catch {};
            return (
              <div key={sched.id} style={{ background: 'var(--m-bg-elevated, rgba(255,255,255,0.05))', border: `1px solid ${sched.enabled ? 'var(--m-border-subtle, rgba(255,255,255,0.06))' : 'rgba(255,255,255,0.03)'}`, borderRadius: 10, padding: 16, opacity: sched.enabled ? 1 : 0.6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ color: 'var(--m-text-primary)', fontWeight: 500, fontSize: 13, flex: 1 }}>{sched.name}</span>
                  {sched.last_status && <Badge color={statusColor === '#10b981' ? 'green' : statusColor === '#ef4444' ? 'red' : 'blue'} pill>{sched.last_status}</Badge>}
                  <Badge color={sched.enabled ? 'green' : 'default'} pill>{sched.enabled ? 'Active' : 'Disabled'}</Badge>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 8, fontSize: 12, color: 'var(--m-text-secondary)' }}>
                  <span>{cronToHuman(sched.cron_expression)}</span>
                  <span style={{ fontFamily: 'var(--m-font-mono)', fontSize: 10, opacity: 0.5 }}>{sched.cron_expression}</span>
                  {sched.next_trigger_at && sched.enabled ? <span>Next: {formatCountdown(sched.next_trigger_at)}</span> : null}
                </div>
                <div style={{ fontSize: 11, color: 'var(--m-text-tertiary)', marginBottom: 10 }}>Objective: {template.title || 'N/A'}</div>
                {/* 7-day calendar strip */}
                <div style={{ display: 'flex', gap: 3, marginBottom: 10 }}>
                  {Array.from({ length: 7 }, (_, i) => {
                    const d = new Date();
                    d.setDate(d.getDate() + i);
                    const fires = cronMatchesDate(sched.cron_expression, d);
                    const dayLabel = ['Su','Mo','Tu','We','Th','Fr','Sa'][d.getDay()];
                    return (
                      <div key={i} style={{
                        width: 28, textAlign: 'center', padding: '3px 0', borderRadius: 4,
                        background: fires ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.02)',
                        border: `1px solid ${fires ? 'rgba(59,130,246,0.3)' : 'rgba(255,255,255,0.04)'}`,
                        color: fires ? '#60a5fa' : 'var(--m-text-tertiary, #52525b)',
                        fontSize: 9, fontWeight: fires ? 600 : 400,
                      }}>
                        <div>{dayLabel}</div>
                        <div style={{ fontSize: 10, fontWeight: 600 }}>{d.getDate()}</div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => handleToggle(sched.id, sched.enabled)} style={{ padding: '5px 12px', borderRadius: 5, background: 'transparent', border: '1px solid var(--m-border-subtle)', color: 'var(--m-text-secondary)', fontSize: 11, cursor: 'pointer' }}>{sched.enabled ? 'Disable' : 'Enable'}</button>
                  <button onClick={() => setDeleteTarget({ id: sched.id, name: sched.name })} style={{ padding: '5px 12px', borderRadius: 5, background: 'transparent', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--m-error, #ef4444)', fontSize: 11, cursor: 'pointer' }}>Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {showModal && <CreateScheduleModal teamId={teamId} onClose={() => setShowModal(false)} onCreated={() => fetchSchedules()} />}
      <ConfirmModal isOpen={!!deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={() => handleDelete(deleteTarget?.id)}
        title="Delete Schedule" message={`Delete schedule "${deleteTarget?.name || ''}"? This cannot be undone.`} confirmLabel="Delete" danger />
    </div>
  );
}

// ─── Orchestrator Chat ───

function OrchestratorChat({ orchestratorId }) {
  const { authFetch } = useAuth();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef(null);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const meta = getAgentMeta(orchestratorId);

  // Chiefs aren't registered collector agents — route through CommanderQ with context
  const isChiefOrch = meta.isChief;
  const chatAgent = isChiefOrch ? 'quox' : orchestratorId;

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setMessages(prev => [...prev.slice(-48), { role: 'user', text }]);
    setInput(''); setSending(true);
    try {
      // For chief agents, prepend context so CommanderQ responds in role
      const prompt = isChiefOrch
        ? `[Acting as ${meta.name} (${meta.shortName}) — ${meta.specialty}]\n\n${text}`
        : text;
      const res = await authFetch('/collector/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, selected_agent: chatAgent, provider: meta.llm?.provider || DEFAULT_LLM_CONFIG.provider, model: meta.llm?.model || DEFAULT_LLM_CONFIG.model }) });
      if (!res.ok) throw new Error('Chat request failed');
      const data = await res.json();
      const reply = data.result || data.response || data.text || data.content || 'No response';
      setMessages(prev => [...prev.slice(-49), { role: 'assistant', text: reply }]);
    } catch (err) { setMessages(prev => [...prev.slice(-49), { role: 'error', text: err.message }]); }
    finally { setSending(false); }
  };

  return (
    <div style={{ background: 'var(--m-bg-elevated, rgba(255,255,255,0.05))', border: '1px solid var(--m-border-subtle, rgba(255,255,255,0.06))', borderRadius: 12, padding: 18, marginTop: 24 }}>
      <div style={{ color: meta.color || '#f59e0b', fontWeight: 600, fontSize: 13, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 24, height: 24, borderRadius: 6, background: `${meta.color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: meta.color }}>
          {meta.shortName}
        </div>
        <span style={{ flex: 1 }}>Chat with {meta.name}</span>
        {messages.length > 0 && (
          <button onClick={() => setMessages([])} title="Clear chat"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--m-text-dim, #666)', padding: 2, lineHeight: 1 }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5.3 4V2.7a1.3 1.3 0 011.4-1.4h2.6a1.3 1.3 0 011.4 1.4V4m2 0v9.3a1.3 1.3 0 01-1.4 1.4H4.7a1.3 1.3 0 01-1.4-1.4V4" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        )}
      </div>

      {messages.length > 0 && (
        <div style={{ maxHeight: 300, overflowY: 'auto', marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {messages.map((msg, i) => (
            <div key={i} style={{ padding: '8px 12px', borderRadius: 8, background: msg.role === 'user' ? 'rgba(59,130,246,0.1)' : msg.role === 'error' ? 'rgba(239,68,68,0.1)' : 'var(--m-bg-base, rgba(17,17,20,0.8))', fontSize: 12, color: msg.role === 'error' ? '#ef4444' : 'var(--m-text-primary)', alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%', whiteSpace: 'pre-wrap' }}>
              {msg.text}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      )}

      {sending && (
        <div style={{ fontSize: 11, color: 'var(--m-text-dim, #666)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Spinner size="sm" /> Thinking...
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <input value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
          placeholder={sending ? 'Waiting for response...' : `Message ${meta.name}...`}
          disabled={sending}
          style={{ flex: 1, padding: '8px 12px', borderRadius: 7, background: 'var(--m-bg-base, rgba(255,255,255,0.04))', border: '1px solid var(--m-border-subtle)', color: 'var(--m-text-primary)', fontSize: 13, outline: 'none', opacity: sending ? 0.6 : 1 }} />
        <button onClick={handleSend} disabled={sending || !input.trim()}
          style={{ padding: '8px 14px', borderRadius: 7, background: meta.color || '#f59e0b', border: 'none', color: '#000', fontSize: 12, fontWeight: 600, cursor: sending || !input.trim() ? 'not-allowed' : 'pointer', opacity: sending || !input.trim() ? 0.5 : 1 }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ display: 'block' }}><path d="M14.5 1.5L6.5 9.5M14.5 1.5L10 14.5 6.5 9.5 1.5 6 14.5 1.5Z" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      </div>
    </div>
  );
}

// ─── Main View ───

export default function AgenticTeamView({ teamId: teamIdProp, onClose, embedded } = {}) {
  const params = useParams();
  const teamId = teamIdProp || params.teamId;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { authFetch } = useAuth();
  const { team, loading, error, refresh } = useTeamDetail(teamId);
  const linkedObjectiveId = searchParams.get('objective');
  const [activeTab, setActiveTab] = useState(linkedObjectiveId ? 'objectives' : 'overview');
  const [selectedAgentId, setSelectedAgentId] = useState(null);
  const [showChat, setShowChat] = useState(true);
  // Track objectives for PRISM context (fetched by ObjectivesTab, shared via ref)
  const [prismObjectives, setPrismObjectives] = useState([]);
  const [prismSelectedObj, setPrismSelectedObj] = useState(null);
  const handlePrismContext = useCallback((objs, sel) => {
    setPrismObjectives(objs);
    setPrismSelectedObj(sel);
  }, []);

  const manifest = team?.manifest;

  const allMembers = useMemo(() => {
    if (!manifest) return [];
    const orch = { ...manifest.orchestrator, role: 'orchestrator' };
    return [orch, ...(manifest.members || [])];
  }, [manifest]);

  if (loading) {
    return (
      <PageSection title="Team">
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--m-text-secondary)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <Spinner size="lg" /> Loading team details...
        </div>
      </PageSection>
    );
  }

  if (error || !team) {
    const teamIssue = getPlatformDependencyIssue(error, {
      service: 'tasks',
      feature: 'Agentic Teams',
    });
    return (
      <PageSection title="Team Not Found">
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--m-text-secondary)' }}>
          {teamIssue ? (
            <PlatformDependencyNotice issue={teamIssue} compact={false} style={{ textAlign: 'left', margin: '0 auto', maxWidth: 720 }} />
          ) : (
            <>{error || 'Team not found.'}</>
          )}
          <br />
          <button onClick={() => onClose ? onClose() : navigate('/teams-overview')}
            style={{ marginTop: 16, padding: '8px 16px', borderRadius: 8, background: 'var(--m-bg-elevated)', border: '1px solid var(--m-border-subtle)', color: 'var(--m-text-primary)', cursor: 'pointer' }}>
            Back to Agentic Teams
          </button>
        </div>
      </PageSection>
    );
  }

  const accentColor = manifest?.accentColor || '#3090ff';
  const orchestrator = allMembers.find(m => m.role === 'orchestrator') || allMembers[0];
  const members = allMembers.filter(m => m.role !== 'orchestrator');
  const selectedMember = selectedAgentId ? allMembers.find(m => m.agentId === selectedAgentId) : null;

  return (
    <div className={`agentic-team-view${embedded ? ' agentic-team-view--embedded' : ''}`} style={{ display: 'flex', flexDirection: 'column', height: embedded ? '100%' : 'calc(100vh - 90px)', overflow: 'hidden', background: embedded ? 'transparent' : undefined }}>
      {!embedded && <LLMAuthBanner />}
      <style>{`
        .app-shell__content:has(.agentic-team-view) {
          padding: 0;
          overflow: hidden;
        }
        .agentic-team-view { padding: 0 20px; }
        /* Item 2: embedded variant — strip padding + background to avoid glass-on-glass */
        .agentic-team-view--embedded { padding: 0; background: transparent; }
        @keyframes heartbeatPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(0.85); }
        }
        @keyframes taskComplete {
          0% { background: rgba(16,185,129,0.15); }
          100% { background: var(--m-bg-base, rgba(17,17,20,0.8)); }
        }
        @keyframes taskFail {
          0% { background: rgba(239,68,68,0.15); }
          100% { background: var(--m-bg-base, rgba(17,17,20,0.8)); }
        }
      `}</style>
      {/* Export button — hidden when embedded to keep drawer chrome minimal */}
      {team.source !== 'core' && !embedded && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button
            onClick={async () => {
              try {
                const m = await exportTeam(authFetch, teamId);
                const blob = new Blob([JSON.stringify(m, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = `${teamId}-team.json`; a.click();
                URL.revokeObjectURL(url);
              } catch (err) { console.error('[Export] Failed:', err.message); }
            }}
            style={{ padding: '6px 14px', borderRadius: 7, background: 'transparent', border: '1px solid var(--m-border-subtle, rgba(255,255,255,0.06))', color: 'var(--m-text-secondary, #a1a1aa)', cursor: 'pointer', fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6, transition: 'border-color 0.15s, color 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = accentColor; e.currentTarget.style.color = 'var(--m-text-primary, #f4f4f5)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--m-border-subtle, rgba(255,255,255,0.06))'; e.currentTarget.style.color = 'var(--m-text-secondary, #a1a1aa)'; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Export
          </button>
        </div>
      )}

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 24, borderBottom: '1px solid var(--m-border-subtle, rgba(255,255,255,0.06))', alignItems: 'center' }}>
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '10px 18px', background: 'none', border: 'none',
              borderBottom: activeTab === tab.id ? `2px solid ${accentColor}` : '2px solid transparent',
              color: activeTab === tab.id ? 'var(--m-text-primary, #f4f4f5)' : 'var(--m-text-secondary, #a1a1aa)',
              cursor: 'pointer', fontSize: 13, fontWeight: activeTab === tab.id ? 600 : 400,
              transition: 'color 0.15s, border-color 0.15s',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
            <span style={{ opacity: activeTab === tab.id ? 1 : 0.5 }}>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
        <button
          onClick={() => setShowChat(v => !v)}
          title={showChat ? 'Hide PRISM' : 'Show PRISM'}
          style={{
            marginLeft: 'auto', flexShrink: 0,
            padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 500,
            background: showChat ? 'rgba(139,92,246,0.15)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${showChat ? 'rgba(139,92,246,0.25)' : 'rgba(255,255,255,0.08)'}`,
            color: showChat ? '#a78bfa' : 'rgba(255,255,255,0.5)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
            transition: 'all 0.15s', marginBottom: 2,
          }}
        >
          <span style={{ fontSize: 14 }}>◈</span> PRISM
        </button>
      </div>

      {/* Main content + PRISM sidebar */}
      <div style={{ display: 'flex', gap: 0, flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* Tab content */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto' }}>
          {/* Overview tab */}
          {activeTab === 'overview' && (
            <div>
              {/* Details bar */}
              <div style={{
                display: 'flex', gap: 24, flexWrap: 'wrap',
                padding: '14px 20px', borderRadius: 12, marginBottom: 24,
                background: 'var(--m-bg-elevated, rgba(255,255,255,0.05))',
                border: '1px solid var(--m-border-subtle, rgba(255,255,255,0.06))',
              }}>
                <div>
                  <div style={{ color: 'var(--m-text-tertiary, #71717a)', fontSize: 11 }}>Version</div>
                  <div style={{ color: 'var(--m-text-primary)', fontSize: 13, fontWeight: 500 }}>{manifest?.version || '--'}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--m-text-tertiary, #71717a)', fontSize: 11 }}>Author</div>
                  <div style={{ color: 'var(--m-text-primary)', fontSize: 13, fontWeight: 500 }}>{manifest?.author || '--'}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--m-text-tertiary, #71717a)', fontSize: 11 }}>Tier</div>
                  <div style={{ marginTop: 2 }}>
                    <Badge color={manifest?.tier === 'free' ? 'green' : manifest?.tier === 'custom' ? 'purple' : 'blue'} pill>
                      {manifest?.tier === 'free' ? 'Free' : manifest?.tier === 'custom' ? 'Custom' : `$${manifest?.price}/mo`}
                    </Badge>
                  </div>
                </div>
                <div>
                  <div style={{ color: 'var(--m-text-tertiary, #71717a)', fontSize: 11 }}>Status</div>
                  <div style={{ marginTop: 2 }}><Badge color={team.status === 'active' ? 'green' : 'default'} pill>{team.status}</Badge></div>
                </div>
                <div>
                  <div style={{ color: 'var(--m-text-tertiary, #71717a)', fontSize: 11 }}>Agents</div>
                  <div style={{ color: 'var(--m-text-primary)', fontSize: 13, fontWeight: 500 }}>{allMembers.length}</div>
                </div>
                {manifest?.topology?.type && (
                  <div>
                    <div style={{ color: 'var(--m-text-tertiary, #71717a)', fontSize: 11 }}>Topology</div>
                    <div style={{ marginTop: 3 }}><TopologyBadge type={manifest.topology.type} size="sm" /></div>
                  </div>
                )}
              </div>

              {/* Two-column: Agent Grid + Policies */}
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 340px)', gap: 24, alignItems: 'start' }}>
                <div>
                  <div style={{ color: 'var(--m-text-primary)', fontWeight: 600, fontSize: 14, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.5" strokeLinecap="round">
                      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
                      <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
                    </svg>
                    Team Members
                    <span style={{ color: 'var(--m-text-tertiary)', fontSize: 12, fontWeight: 400 }}>Click to view details</span>
                  </div>

                  {/* Orchestrator */}
                  <div style={{ marginBottom: 12 }}>
                    <AgentCard
                      agent={orchestrator}
                      isOrchestrator
                      onClick={() => setSelectedAgentId(selectedAgentId === orchestrator.agentId ? null : orchestrator.agentId)}
                      isSelected={selectedAgentId === orchestrator.agentId}
                    />
                  </div>

                  {/* Members grid */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
                    {members.map(member => (
                      <AgentCard
                        key={member.agentId}
                        agent={member}
                        isOrchestrator={false}
                        onClick={() => setSelectedAgentId(selectedAgentId === member.agentId ? null : member.agentId)}
                        isSelected={selectedAgentId === member.agentId}
                      />
                    ))}
                  </div>
                </div>

                <div>
                  <PoliciesPanel policies={manifest?.policies} />
                </div>
              </div>

              {/* Orchestrator Chat */}
              {manifest?.orchestrator?.agentId && (
                <OrchestratorChat orchestratorId={manifest.orchestrator.agentId} />
              )}
            </div>
          )}

          {activeTab === 'objectives' && <ObjectivesTab teamId={teamId} manifest={manifest} linkedObjectiveId={linkedObjectiveId} onPrismContext={handlePrismContext} />}
          {activeTab === 'schedules' && <SchedulesTab teamId={teamId} />}
          {activeTab === 'context' && <ContextTab teamId={teamId} />}
          {activeTab === 'performance' && <PerformanceTab teamId={teamId} />}
          {activeTab === 'settings' && <SettingsTab teamId={teamId} team={team} onUpdated={refresh} />}
        </div>

        {/* Right: PRISM chat sidebar (persistent, collapsible) */}
        <div style={{
          width: showChat ? 380 : 0, flexShrink: 0,
          borderLeft: showChat ? '1px solid rgba(139,92,246,0.1)' : 'none',
          overflow: 'hidden', transition: 'width 0.2s ease',
          opacity: showChat ? 1 : 0, pointerEvents: showChat ? 'auto' : 'none',
          height: 'calc(100vh - 200px)',
        }}>
          <PrismSidebar
            context={{
              mode: activeTab === 'objectives' ? 'objectives' : 'team-detail',
              team,
              activeTab,
              objectives: prismObjectives,
              selectedObjective: activeTab === 'objectives' ? prismSelectedObj : null,
              teamName: manifest?.displayName || teamId,
            }}
            onAction={prismSelectedObj?.status === 'decomposed' ? async (feedback) => {
              await rejectPlan(authFetch, prismSelectedObj.id, feedback);
              await startObjective(authFetch, prismSelectedObj.id);
            } : undefined}
          />
        </div>
      </div>

      {/* Agent Detail Slide Panel */}
      {selectedAgentId && selectedMember && (
        <AgentDetailPanel
          agentId={selectedAgentId}
          teamRole={selectedMember.role}
          teamDomains={selectedMember.domains}
          onClose={() => setSelectedAgentId(null)}
          accentColor={accentColor}
        />
      )}
    </div>
  );
}
