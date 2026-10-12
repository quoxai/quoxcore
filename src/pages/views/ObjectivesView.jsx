/**
 * ObjectivesView — Background task objectives management
 *
 * Phase 4.B: Shared UI components, useObjectivesStream hook, preview-plan flow,
 * keyboard navigation, ARIA accessibility, CSS variable migration.
 *
 * Master-detail layout: objective list + detail panel with task timeline.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useOutletContext, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import EvolutionStagePill from '../../components/automation/EvolutionStagePill';
import { PageSection } from '../../components/layout';
import Modal from '../../components/ui/Modal.jsx';
import Button, { ButtonGroup } from '../../components/ui/Button.jsx';
import Badge, { StatusBadge as SharedStatusBadge } from '../../components/ui/Badge.jsx';
import PlatformDependencyNotice from '../../components/ui/PlatformDependencyNotice.jsx';
import {
  createObjective,
  startObjective, cancelObjective,
  saveAsTemplate, listTemplates, instantiateTemplate as instantiateTemplateApi,
  approvePlan, rejectPlan,
  approveCheckpoint, rejectCheckpoint,
  getUIPref, setUIPref,
  fetchRelevantWisdom,
} from '../../services/objectivesClient';
import { extractVariables } from '../../services/templateVariables';
import { LOOP_SCOPE_PRESETS, getPreset, matchPreset } from '../../config/loopScopePresets';
import { useObjectiveManager } from '../../hooks/useObjectiveManager';
import { useRunningProcesses } from '../../hooks/useRunningProcesses';
import ZombiePanel from '../../components/objectives/ZombiePanel';
import LLMAuthBanner from '../../components/ui/LLMAuthBanner'
import MarkdownContent from '../../components/ui/MarkdownContent'
import { getBuiltInTeam } from '../../config/teams/index.js';
import { createOrgSchedule } from '../../services/teamService';
import PrismSidebar from '../../components/objectives/PrismSidebar';
import PlansAwaitingApproval from '../../components/objectives/PlansAwaitingApproval';
import TaskTimelineNode from '../../components/objectives/TaskTimelineNode';
import ObjectiveControlBar from '../../components/objectives/ObjectiveControlBar';
import ObjectiveSummaryBar from '../../components/objectives/ObjectiveSummaryBar';
import ExecutionAnalysis from '../../components/objectives/ExecutionAnalysis';
import EnvelopeAuditTrail from '../../components/objectives/EnvelopeAuditTrail';
import { getRuntimeAssistantConfig } from '../../services/entityRegistry';
import { getPlatformDependencyIssue } from '../../services/platformDependencyIssues';
import {
  TopologyBadge, TaskWaterfallChart, LiveTokenBurnGauge,
  CircuitBreakerAlert,
  PipelineStageIndicator, GaugeCluster, SwimlaneDiagram,
  ExecutionTimeline, StepIndicator,
} from '../../components/orchestration';
import ObjectiveBudgetBanner from '../../components/objectives/ObjectiveBudgetBanner';
import './objectives-view.css';

// ==========================================
// Status config — maps to CSS variables + shared Badge colors
// ==========================================
const STATUS_CONFIG = {
  pending:    { label: 'Pending',    badgeColor: 'amber', dotClass: 'dot-pending' },
  decomposed: { label: 'Planned',   badgeColor: 'purple', dotClass: 'dot-decomposed' },
  running:    { label: 'Running',    badgeColor: 'blue', dotClass: 'dot-running' },
  paused:     { label: 'Paused',     badgeColor: 'amber', dotClass: 'dot-paused' },
  completed:  { label: 'Completed',  badgeColor: 'green', dotClass: 'dot-completed' },
  completed_with_errors: { label: 'Partial', badgeColor: 'orange', dotClass: 'dot-partial' },
  failed:     { label: 'Failed',     badgeColor: 'red', dotClass: 'dot-failed' },
  cancelled:  { label: 'Cancelled',  badgeColor: 'default', dotClass: 'dot-cancelled' },
};

const TASK_STATUS_CONFIG = {
  pending:       { label: 'Pending',   badgeColor: 'default', icon: '○' },
  running:       { label: 'Running',   badgeColor: 'blue', icon: '◉' },
  waiting_child: { label: 'Waiting',   badgeColor: 'amber', icon: '⏳' },
  completed:     { label: 'Done',      badgeColor: 'green', icon: '●' },
  failed:        { label: 'Failed',    badgeColor: 'red', icon: '✕' },
  skipped:       { label: 'Skipped',   badgeColor: 'default', icon: '⊘' },
  cancelled:     { label: 'Cancelled', badgeColor: 'default', icon: '⊘' },
};

const commanderLlm = getRuntimeAssistantConfig('quox')?.llm;

// Format relative time (e.g., "5m ago", "2h ago", "3d ago")
function formatRelativeTime(date) {
  const diff = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Format elapsed duration (e.g., "2m 15s", "1h 3m", "3d 2h")
function formatElapsed(startDate, endDate) {
  if (!startDate) return null;
  const start = new Date(startDate).getTime();
  const end = endDate ? new Date(endDate).getTime() : Date.now();
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

// Resolve team name from team_id
function resolveTeamName(teamId) {
  if (!teamId) return null;
  const team = getBuiltInTeam(teamId);
  return team?.displayName || teamId;
}

// ==========================================
// ObjectiveStatusBadge — uses shared Badge component
// ==========================================
function ObjectiveStatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  return (
    <Badge color={cfg.badgeColor} pill>
      {status === 'running' && <span className="obj-pulse-dot" />}
      {cfg.label}
    </Badge>
  );
}

// ==========================================
// ProgressBar
// ==========================================
function ProgressBar({ completed, total, failed }) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 120 }}>
      <div className="obj-progress-track">
        <div
          className={`obj-progress-fill ${failed > 0 ? 'obj-progress-warn' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="obj-text-xs obj-text-secondary" style={{ whiteSpace: 'nowrap' }}>
        {completed}/{total}
      </span>
    </div>
  );
}

// ==========================================
// Connection Indicator
// ==========================================
function ConnectionIndicator({ state }) {
  const colors = {
    connected: 'var(--m-success, #4ade80)',
    connecting: 'var(--m-warning, #fbbf24)',
    disconnected: 'var(--m-text-tertiary, #71717a)',
    error: 'var(--m-error, #f87171)',
  };
  const labels = {
    connected: 'Live updates active',
    connecting: 'Connecting to event stream...',
    disconnected: 'Not connected. Select a running objective to stream updates',
    error: 'Connection lost, auto-reconnecting...',
  };
  const shortLabels = {
    connected: 'Live',
    connecting: 'Connecting',
    disconnected: '',
    error: 'Reconnecting',
  };
  const short = shortLabels[state] || '';
  return (
    <span className="obj-connection-indicator" title={labels[state] || state} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: colors[state] || colors.disconnected,
        display: 'inline-block',
        animation: state === 'error' ? 'pulse 1.5s ease-in-out infinite' : undefined,
      }} />
      {short && (
        <span style={{ fontSize: 10, color: colors[state] || colors.disconnected, opacity: 0.8 }}>{short}</span>
      )}
    </span>
  );
}

// ==========================================
// New Objective Modal — uses shared Modal
// ==========================================

// P6.B: var history key for server-side prefs
const VAR_HISTORY_PREF_KEY = 'template_var_history'

function TemplateSection({ templates, onRun, onRunWithVars, disabled, authFetch }) {
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(false);

  // WC-4: Variable input state
  const [varFormTplId, setVarFormTplId] = useState(null);
  const [varFormDefs, setVarFormDefs] = useState([]);
  const [varFormValues, setVarFormValues] = useState({});

  // P6.B: in-memory cache of server-loaded var history (loaded once per session)
  const varHistoryRef = useRef(null);

  const recent = templates.slice(0, 3);
  const filtered = search.trim()
    ? templates.filter(t => t.name.toLowerCase().includes(search.toLowerCase()))
    : expanded ? templates : recent;

  const getVarHistory = async () => {
    if (varHistoryRef.current !== null) return varHistoryRef.current
    try {
      const value = await getUIPref(authFetch, VAR_HISTORY_PREF_KEY)
      varHistoryRef.current = (value && typeof value === 'object') ? value : {}
    } catch {
      varHistoryRef.current = {}
    }
    return varHistoryRef.current
  }

  const handleTemplateClick = async (tpl) => {
    // Check if template has variables
    const vars = extractVariables(tpl.template_json)
    if (vars.length > 0) {
      // Load last-used values from server (cached in memory for this session)
      const history = await getVarHistory()
      const lastUsed = history[tpl.id] || {}
      const initial = {}
      for (const v of vars) initial[v.name] = lastUsed[v.name] || v.defaultValue || ''
      setVarFormTplId(tpl.id)
      setVarFormDefs(vars)
      setVarFormValues(initial)
    } else {
      onRun(tpl.id)
    }
  }

  const submitVarForm = async () => {
    if (!varFormTplId) return
    // Save to server for next time; update in-memory cache
    try {
      const history = await getVarHistory()
      const updated = { ...history, [varFormTplId]: varFormValues }
      varHistoryRef.current = updated
      setUIPref(authFetch, VAR_HISTORY_PREF_KEY, updated).catch(() => {/* non-critical */})
    } catch { /* ignore — form still submits */ }
    if (onRunWithVars) {
      onRunWithVars(varFormTplId, varFormValues)
    }
    setVarFormTplId(null)
    setVarFormDefs([])
    setVarFormValues({})
  }

  const dismissVarForm = () => {
    setVarFormTplId(null)
    setVarFormDefs([])
    setVarFormValues({})
  }

  const tplBtn = (tpl) => {
    const vars = extractVariables(tpl.template_json)
    const hasVars = vars.length > 0
    return (
      <button
        key={tpl.id}
        onClick={() => handleTemplateClick(tpl)}
        disabled={disabled}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          padding: '7px 12px', background: 'rgba(99,102,241,0.06)',
          border: '1px solid rgba(99,102,241,0.15)', borderRadius: 6,
          cursor: 'pointer', textAlign: 'left', transition: 'background 0.15s',
          color: 'rgba(255,255,255,0.85)', fontSize: 13,
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(99,102,241,0.12)' }}
        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(99,102,241,0.06)' }}
      >
        <span style={{ color: '#818cf8', fontSize: 12 }}>◆</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tpl.name}</span>
        {hasVars && (
          <span style={{ fontSize: 10, color: '#818cf8', fontFamily: "'SF Mono', monospace", flexShrink: 0 }} title={`${vars.length} variable(s)`}>
            {`{${vars.length}}`}
          </span>
        )}
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', fontFamily: "'SF Mono', monospace", flexShrink: 0 }}>
          {new Date(tpl.created_at).toLocaleDateString()}
        </span>
      </button>
    );
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(99,102,241,0.8)' }} strokeWidth="2" strokeLinecap="round">
          <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>
          <polyline points="17 21 17 13 7 13 7 21"/>
        </svg>
        <span className="obj-label" style={{ margin: 0, flex: 1 }}>Saved Templates</span>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>{templates.length}</span>
      </div>

      {templates.length > 3 && (
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search templates..."
          style={{
            width: '100%', marginBottom: 6, padding: '6px 10px',
            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 6, color: 'rgba(255,255,255,0.8)', fontSize: 12, outline: 'none',
          }}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: expanded || search ? 200 : 'none', overflowY: expanded || search ? 'auto' : 'visible' }}>
        {filtered.map(tpl => tplBtn(tpl))}
      </div>

      {!search && templates.length > 3 && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          style={{
            marginTop: 4, background: 'none', border: 'none', cursor: 'pointer',
            color: 'rgba(99,102,241,0.7)', fontSize: 11, padding: '2px 0',
          }}
        >
          Show all {templates.length} templates...
        </button>
      )}

      {/* WC-4: Variable input form — shown when a parameterised template is selected */}
      {varFormTplId && varFormDefs.length > 0 && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8,
          padding: '10px 12px', background: 'rgba(99,102,241,0.08)', borderRadius: 8,
          border: '1px solid rgba(99,102,241,0.2)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', fontWeight: 600 }}>
              Configure variables
            </span>
            <button
              onClick={dismissVarForm}
              style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: 14, padding: '0 4px' }}
            >✕</button>
          </div>

          {varFormDefs.map(v => (
            <div key={v.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{
                fontSize: 11, color: 'rgba(255,255,255,0.6)', fontFamily: "'SF Mono', monospace",
                minWidth: 100, flexShrink: 0,
              }}>
                {v.label || v.name}
              </label>
              <input
                type="text"
                value={varFormValues[v.name] || ''}
                onChange={e => setVarFormValues(prev => ({ ...prev, [v.name]: e.target.value }))}
                placeholder={v.defaultValue || v.name}
                onKeyDown={e => { if (e.key === 'Enter') submitVarForm(); if (e.key === 'Escape') dismissVarForm() }}
                style={{
                  flex: 1, padding: '5px 8px', background: 'rgba(0,0,0,0.2)',
                  border: '1px solid rgba(255,255,255,0.1)', borderRadius: 5,
                  color: 'rgba(255,255,255,0.9)', fontSize: 12, outline: 'none',
                  fontFamily: "'SF Mono', monospace",
                }}
              />
              <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)', flexShrink: 0 }}>{v.type}</span>
            </div>
          ))}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 2 }}>
            <button
              onClick={submitVarForm}
              disabled={disabled}
              style={{
                padding: '5px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                background: '#6366f1', border: 'none', color: '#fff', cursor: 'pointer',
              }}
            >
              <span style={{ marginRight: 4 }}>▶</span>
              Run
            </button>
          </div>
        </div>
      )}

      <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: 12 }} />
    </div>
  );
}

function NewObjectiveModal({ isOpen, onClose, onSubmit }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [maxTokens, setMaxTokens] = useState(100000);
  const [maxToolCalls, setMaxToolCalls] = useState(50);
  const [maxDuration, setMaxDuration] = useState(600);
  const [checkpointAfterEach, setCheckpointAfterEach] = useState(false);
  // STUDY-REV R3: optional re-observe loop. When goalCondition is set,
  // the post-task evaluator runs and may decompose more tasks up to
  // maxIterations cycles before the objective is finalised.
  const [goalCondition, setGoalCondition] = useState('');
  const [maxIterations, setMaxIterations] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  // DEVSUITE-DEVMODE 5c: quoxified-loop creation surface (owner-signed-off
  // UX 2026-08-11). Explicit mode choice, default dag — no auto-classifier
  // by design. In loop mode goal_condition/max_iterations are REUSED as the
  // stop condition / turn cap (same columns, relabeled), the capability
  // scope is a deny-by-default allowlist, and pre-start approval is forced.
  const [executionMode, setExecutionMode] = useState('dag');
  const [loopBackend, setLoopBackend] = useState('claude');
  const [scopePreset, setScopePreset] = useState('read-only');
  const [scopeTools, setScopeTools] = useState(() => getPreset('read-only').tools);
  const [customTool, setCustomTool] = useState('');
  // Pre-start approval: exists in the API for both modes but was never
  // sent by this modal (quox#405). Off by default for dag (old behavior),
  // forced ON for loop (the gate is the plan review).
  const [requireApproval, setRequireApproval] = useState(false);

  const isLoop = executionMode === 'loop';

  const applyPreset = (id) => {
    setScopePreset(id);
    const preset = getPreset(id);
    if (preset?.tools) setScopeTools(preset.tools);
  };

  const toggleScopeTool = (tool) => {
    setScopeTools(prev => {
      const next = prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool];
      setScopePreset(matchPreset(next));
      return next;
    });
  };

  const addCustomTool = () => {
    const t = customTool.trim();
    if (!t || scopeTools.includes(t)) { setCustomTool(''); return; }
    const next = [...scopeTools, t];
    setScopeTools(next);
    setScopePreset(matchPreset(next));
    setCustomTool('');
  };

  // Templates
  const [templates, setTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);

  // Ask CommanderQ state (UX-6)
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);
  const { authFetch } = useAuth();

  // Load templates when modal opens
  useEffect(() => {
    if (!isOpen || !authFetch) return;
    setTemplatesLoading(true);
    listTemplates(authFetch)
      .then(data => setTemplates(data.templates || []))
      .catch(() => setTemplates([]))
      .finally(() => setTemplatesLoading(false));
  }, [isOpen, authFetch]);

  const handleAskCommanderQ = async () => {
    if (!aiPrompt.trim() || aiLoading) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await authFetch('/collector/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: `The user wants to create an objective for their AI agent team. Based on their request below, generate a structured objective with a concise title (max 200 chars) and detailed description (1-3 paragraphs explaining what agents should do). Return ONLY valid JSON with keys: "title" (string) and "description" (string). No markdown wrapping, no explanation, just the JSON object.\n\nUser request: ${aiPrompt.trim()}`,
          selected_agent: 'quox',
          provider: commanderLlm?.provider,
          model: commanderLlm?.model,
        })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Request failed: ${res.status}`);
      }
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Generation failed');
      const text = (data.result || '').trim();
      // Parse JSON from response — handle possible markdown wrapping
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.title) setTitle(parsed.title.slice(0, 200));
        if (parsed.description) setDescription(parsed.description.slice(0, 5000));
      } else {
        throw new Error('Could not parse structured response');
      }
    } catch (err) {
      setAiError(err.message);
    } finally {
      setAiLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim() || undefined,
        max_tokens: maxTokens,
        max_tool_calls: maxToolCalls,
        max_duration_ms: maxDuration * 1000,
        checkpoint_after_each_task: checkpointAfterEach,
        // R3 (dag) — only send if the user opted in; loop mode reuses the
        // same columns as stop condition / turn cap and always sends them.
        goal_condition: goalCondition.trim() || undefined,
        max_iterations: (isLoop || goalCondition.trim()) ? maxIterations : undefined,
        // quox#405 fix: the toggle now exists in the UI for both modes.
        // The server forces this ON for loop regardless of what we send.
        require_approval_before_start: isLoop ? true : requireApproval,
        // DEVSUITE-DEVMODE 5c: loop surface
        execution_mode: executionMode,
        capability_scope: isLoop ? scopeTools : undefined,
        loop_backend: isLoop ? loopBackend : undefined,
      });
      setTitle('');
      setDescription('');
      setGoalCondition('');
      setMaxIterations(5);
      setAiPrompt('');
      setAiError(null);
      setExecutionMode('dag');
      setLoopBackend('claude');
      applyPreset('read-only');
      setRequireApproval(false);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md">
      <Modal.Header title="New Objective" />
      <Modal.Body>
        {/* From Template — saved objective templates */}
        {templates.length > 0 && <TemplateSection templates={templates} onRun={async (tplId) => {
          // Create objective from template in 'decomposed' state for review
          setSubmitting(true);
          try {
            const result = await instantiateTemplateApi(authFetch, tplId, false);
            onClose(result?.id); // pass new objective ID back
          } catch (err) {
            setAiError(err.message);
          } finally {
            setSubmitting(false);
          }
        }} onRunWithVars={async (tplId, variableValues) => {
          // WC-4: Create objective from template with variable substitution
          setSubmitting(true);
          try {
            const result = await instantiateTemplateApi(authFetch, tplId, false, variableValues);
            onClose(result?.id);
          } catch (err) {
            setAiError(err.message);
          } finally {
            setSubmitting(false);
          }
        }} disabled={submitting} authFetch={authFetch} />}

        {/* Ask CommanderQ — natural language input (UX-6) */}
        <div className="obj-form-group" style={{ marginBottom: '16px' }}>
          <label className="obj-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--m-coral, #ff8a6b)', strokeWidth: 2 }}>
              <path d="M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 01-2 2h-4a2 2 0 01-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7z" />
              <path d="M10 21h4" />
            </svg>
            Ask CommanderQ
          </label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              value={aiPrompt}
              onChange={e => setAiPrompt(e.target.value)}
              placeholder="Describe what you want in plain English..."
              className="obj-input"
              style={{ flex: 1 }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAskCommanderQ(); } }}
              disabled={aiLoading}
            />
            <Button
              variant="secondary"
              onClick={handleAskCommanderQ}
              disabled={!aiPrompt.trim() || aiLoading}
              loading={aiLoading}
              style={{ whiteSpace: 'nowrap', minWidth: '80px' }}
            >
              {aiLoading ? 'Thinking...' : 'Generate'}
            </Button>
          </div>
          {aiError && (
            <p style={{ color: 'var(--m-error, #f87171)', fontSize: '12px', margin: '4px 0 0' }}>{aiError}</p>
          )}
          <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: '11px', margin: '4px 0 0' }}>
            e.g. "Run a security audit across all hosts" or "Monitor Docker containers and alert on high CPU"
          </p>
        </div>

        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', margin: '0 0 16px', paddingTop: '16px' }}>
          <form id="new-objective-form" onSubmit={handleSubmit}>
            <div className="obj-form-group">
              <label className="obj-label">Title</label>
              <input
                value={title} onChange={e => setTitle(e.target.value)}
                placeholder="e.g. Audit security across all hosts"
                maxLength={200}
                className="obj-input"
              />
            </div>
            <div className="obj-form-group">
              <label className="obj-label">Description</label>
              <textarea
                value={description} onChange={e => setDescription(e.target.value)}
                placeholder="Detailed description of what should be accomplished..."
                rows={4} maxLength={5000}
                className="obj-input obj-textarea"
              />
            </div>

            {/* DEVSUITE-DEVMODE 5c: execution mode — explicit choice, default dag */}
            <div className="obj-form-group">
              <label className="obj-label">Execution mode</label>
              <div className="qx-seg" role="radiogroup" aria-label="Execution mode">
                <button
                  type="button"
                  className={`qx-seg__btn${!isLoop ? ' qx-seg__btn--active' : ''}`}
                  aria-pressed={!isLoop}
                  onClick={() => setExecutionMode('dag')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
                    <rect x="8.5" y="14" width="7" height="7" rx="1.5" /><path d="M6.5 10v2a2 2 0 002 2M17.5 10v2a2 2 0 01-2 2" />
                  </svg>
                  Planned (DAG)
                </button>
                <button
                  type="button"
                  className={`qx-seg__btn${isLoop ? ' qx-seg__btn--active' : ''}`}
                  aria-pressed={isLoop}
                  onClick={() => setExecutionMode('loop')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 014-4h14" />
                    <path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 01-4 4H3" />
                  </svg>
                  Loop
                </button>
              </div>
              <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11, margin: '6px 0 0' }}>
                {isLoop
                  ? 'The model\'s own agentic loop, turn by turn: every turn WARD-witnessed, budget-capped, kill-switched. No upfront plan; the pre-start approval is the review.'
                  : 'Decomposes into a reviewable task plan before anything runs.'}
              </p>
            </div>

            {isLoop && (
              <>
                <div className="obj-form-group">
                  <label className="obj-label-sm">Backend</label>
                  <div className="qx-seg" role="radiogroup" aria-label="Loop backend">
                    <button
                      type="button"
                      className={`qx-seg__btn${loopBackend === 'claude' ? ' qx-seg__btn--active' : ''}`}
                      aria-pressed={loopBackend === 'claude'}
                      onClick={() => setLoopBackend('claude')}
                    >
                      Claude
                    </button>
                    <button
                      type="button"
                      className={`qx-seg__btn${loopBackend === 'codex' ? ' qx-seg__btn--active' : ''}`}
                      aria-pressed={loopBackend === 'codex'}
                      onClick={() => setLoopBackend('codex')}
                    >
                      Codex
                    </button>
                  </div>
                </div>

                <div className="obj-form-group">
                  <label className="obj-label-sm">
                    Capability scope <span style={{ color: 'rgba(255,255,255,0.7)', fontWeight: 400 }}>(deny-by-default)</span>
                  </label>
                  <select
                    className="obj-input obj-input-sm"
                    value={scopePreset}
                    onChange={e => applyPreset(e.target.value)}
                    style={{ marginBottom: 8 }}
                  >
                    {LOOP_SCOPE_PRESETS.map(p => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {scopeTools.map(tool => (
                      <button
                        key={tool}
                        type="button"
                        className="qx-chip"
                        onClick={() => toggleScopeTool(tool)}
                        title="Remove from scope"
                        style={{ cursor: 'pointer' }}
                      >
                        {tool}
                        <span aria-hidden="true" style={{ marginLeft: 4, opacity: 0.7 }}>×</span>
                      </button>
                    ))}
                    <input
                      value={customTool}
                      onChange={e => setCustomTool(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustomTool(); } }}
                      onBlur={addCustomTool}
                      placeholder="add tool…"
                      className="obj-input obj-input-sm"
                      style={{ width: 110, padding: '2px 8px' }}
                    />
                  </div>
                  <p style={{ color: 'var(--m-warning, #fbbf24)', fontSize: 11, margin: '6px 0 0' }}>
                    Any tool outside this scope forces escalation, fail-closed.
                    {scopeTools.length === 0 && ' Empty scope: EVERY tool call escalates.'}
                  </p>
                </div>
              </>
            )}
            <div className="obj-budget-grid">
              <div>
                <label className="obj-label-sm">Max Tokens</label>
                <input type="number" value={maxTokens} onChange={e => setMaxTokens(Number(e.target.value))}
                  min={0} max={10000000} className="obj-input obj-input-sm" />
              </div>
              <div>
                <label className="obj-label-sm">Max Tool Calls</label>
                <input type="number" value={maxToolCalls} onChange={e => setMaxToolCalls(Number(e.target.value))}
                  min={0} max={1000} className="obj-input obj-input-sm" />
              </div>
              <div>
                <label className="obj-label-sm">Timeout (sec)</label>
                <input type="number" value={maxDuration} onChange={e => setMaxDuration(Number(e.target.value))}
                  min={0} max={3600} className="obj-input obj-input-sm" />
              </div>
            </div>
            <div className="obj-form-group">
              <label className="obj-checkbox-label">
                <input type="checkbox" checked={checkpointAfterEach} onChange={e => setCheckpointAfterEach(e.target.checked)} />
                Checkpoint after each task (require approval to continue)
              </label>
            </div>

            {/* quox#405: pre-start approval toggle existed in the API, never in
                the UI. For loop mode it is forced on and locked — the gate IS
                the plan review (goal, budget, capability scope). */}
            <div className="obj-form-group">
              <label className="obj-checkbox-label" style={isLoop ? { opacity: 0.85 } : undefined}>
                <input
                  type="checkbox"
                  checked={isLoop ? true : requireApproval}
                  disabled={isLoop}
                  onChange={e => setRequireApproval(e.target.checked)}
                />
                {isLoop
                  ? 'Pre-start approval: always required for loop objectives'
                  : 'Require approval before start'}
                {isLoop && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--m-warning, #fbbf24)" strokeWidth="2" style={{ marginLeft: 6 }}>
                    <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" />
                  </svg>
                )}
              </label>
            </div>

            {/* STUDY-REV R3 (dag): optional re-observe loop — empty goal_condition
                disables it. In loop mode the SAME columns are the stop condition
                and turn cap, so the fields relabel rather than duplicate. */}
            <div className="obj-form-group">
              <label className="obj-label-sm" htmlFor="obj-goal-condition">
                {isLoop
                  ? <>Stop condition <span style={{ color: 'rgba(255,255,255,0.7)', fontWeight: 400 }}>(optional, the loop ends when this is met)</span></>
                  : <>Goal condition <span style={{ color: 'rgba(255,255,255,0.7)', fontWeight: 400 }}>(optional, re-observes until met)</span></>}
              </label>
              <textarea
                id="obj-goal-condition"
                value={goalCondition}
                onChange={e => setGoalCondition(e.target.value)}
                placeholder={isLoop
                  ? 'e.g. "The failing test passes and the suite is green", leave blank to run to the turn cap'
                  : 'e.g. "All servers report status: healthy", leave blank for a single-pass run'}
                className="obj-input"
                rows={2}
                style={{ resize: 'vertical', minHeight: 56 }}
              />
            </div>
            {(isLoop || goalCondition.trim()) && (
              <div className="obj-form-group">
                <label className="obj-label-sm" htmlFor="obj-max-iterations">
                  {isLoop ? 'Max turns' : 'Max iterations'}
                </label>
                <input
                  id="obj-max-iterations"
                  type="number"
                  value={maxIterations}
                  onChange={e => setMaxIterations(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                  min={1}
                  max={20}
                  className="obj-input obj-input-sm"
                  style={{ maxWidth: 100 }}
                />
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginLeft: 8 }}>
                  {isLoop
                    ? 'Hard turn cap: the session is stopped at this many turns even mid-goal.'
                    : "Loop stops at this cycle even if the goal isn't met."}
                </span>
              </div>
            )}
          </form>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          type="submit"
          form="new-objective-form"
          disabled={!title.trim() || submitting}
          loading={submitting}
          style={{ background: 'var(--m-coral, #ff8a6b)' }}
        >
          Create Objective
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

// TaskTimelineNode is now imported from components/objectives/TaskTimelineNode.jsx

// ==========================================
// Checkpoint Panel
// ==========================================

// DEVSUITE-DEVMODE: without a type label a live loop gate (budget, risk,
// interval) looks identical to the pre-start gate, so the reviewer cannot
// tell what they are actually approving. Labels reuse the global .qx-pill
// tokens; unknown types fall through to the raw value rather than hiding.
const CHECKPOINT_TYPE_LABELS = {
  before_start: 'Pre-start',
  loop_budget_threshold: 'Budget gate',
  loop_risk_action: 'Risk gate',
  loop_interval: 'Interval gate',
};

function CheckpointTypeBadge({ type }) {
  if (!type) return null;
  const label = CHECKPOINT_TYPE_LABELS[type] || type;
  const variant = type === 'before_start'
    ? 'qx-pill--info'
    : CHECKPOINT_TYPE_LABELS[type]
      ? 'qx-pill--warn'
      : 'qx-pill--ghost';
  return (
    <span className={`qx-pill qx-pill--sm ${variant}`} title={type}>{label}</span>
  );
}

function CheckpointPanel({ checkpoint, onApprove, onReject }) {
  const [notes, setNotes] = useState('');
  if (!checkpoint) return null;

  return (
    <div className="obj-checkpoint-panel" role="alert">
      <div className="obj-checkpoint-header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--m-warning, #fbbf24)" strokeWidth="2">
          <path d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span className="obj-text-sm" style={{ fontWeight: 600, color: 'var(--m-warning, #fbbf24)' }}>Checkpoint: {checkpoint.title}</span>
        <CheckpointTypeBadge type={checkpoint.checkpoint_type} />
      </div>
      <p className="obj-text-xs obj-text-secondary" style={{ margin: '0 0 8px' }}>{checkpoint.description}</p>
      <textarea
        value={notes} onChange={e => setNotes(e.target.value)}
        placeholder="Review notes (optional)..."
        rows={2}
        className="obj-input obj-textarea"
        style={{ marginBottom: 8 }}
        aria-label="Review notes"
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="success" size="sm" onClick={() => onApprove(checkpoint.id, notes)}>Approve</Button>
        <Button variant="outline-red" size="sm" onClick={() => onReject(checkpoint.id, notes)}>Reject</Button>
      </div>
    </div>
  );
}

// ==========================================
// Task Preview Panel (Phase 4.B Step 26)
// ==========================================
function TaskPreviewPanel({ tasks, onApprove, onReject, onAdjust, loading }) {
  const [adjustMode, setAdjustMode] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [adjustLoading, setAdjustLoading] = useState(false);

  const handleSubmitAdjustment = async () => {
    if (!feedback.trim()) return;
    setAdjustLoading(true);
    try {
      await onAdjust(feedback.trim());
      setFeedback('');
      setAdjustMode(false);
    } finally {
      setAdjustLoading(false);
    }
  };

  return (
    <div className="obj-preview-panel" role="region" aria-label="Task plan preview">
      <div className="obj-preview-header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--m-quox-secondary, #a78bfa)" strokeWidth="2">
          <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        </svg>
        <span className="obj-text-sm" style={{ fontWeight: 600, color: 'var(--m-quox-secondary, #a78bfa)' }}>
          Task Plan ({tasks.length} task{tasks.length !== 1 ? 's' : ''})
        </span>
      </div>
      <p className="obj-text-xs obj-text-secondary" style={{ margin: '0 0 12px' }}>
        Review the decomposed tasks before execution begins.
      </p>
      <div role="list" aria-label="Planned tasks">
        {tasks.map((task, idx) => (
          <TaskTimelineNode
            key={task.id}
            task={task}
            isLast={idx === tasks.length - 1}
            isPreview
            onRetry={() => {}}
            onSkip={() => {}}
          />
        ))}
      </div>

      {adjustMode && (
        <div style={{ margin: '12px 0', padding: 12, borderRadius: 8, background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.15)' }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#a78bfa', marginBottom: 6 }}>
            ✎ What should change?
          </label>
          <textarea
            value={feedback}
            onChange={e => setFeedback(e.target.value)}
            placeholder="e.g. Add a verification step after deployment, split task 3 into two smaller tasks, use sentinel instead of cipher for the security check..."
            rows={3}
            style={{
              width: '100%', padding: 8, borderRadius: 6, border: '1px solid rgba(139,92,246,0.2)',
              background: 'rgba(0,0,0,0.2)', color: 'var(--m-text-primary)', fontSize: 12,
              fontFamily: 'inherit', resize: 'vertical', outline: 'none',
              boxSizing: 'border-box',
            }}
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) handleSubmitAdjustment(); }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
            <Button variant="outline" size="sm" onClick={() => { setAdjustMode(false); setFeedback(''); }}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={handleSubmitAdjustment} loading={adjustLoading}
              disabled={!feedback.trim()}>
              Re-plan with adjustments
            </Button>
          </div>
        </div>
      )}

      <div className="obj-preview-actions">
        <Button variant="success" onClick={onApprove} loading={loading} icon={
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21"/></svg>
        }>Approve & Execute</Button>
        {!adjustMode && (
          <Button variant="outline" onClick={() => setAdjustMode(true)}>✎ Adjust Plan</Button>
        )}
        <Button variant="outline" onClick={onReject}>Re-plan</Button>
      </div>
    </div>
  );
}

// ==========================================
// Objective Detail Panel
// ==========================================
function ObjectiveDetail({ objective, connectionState, onRefresh, authFetch, isDecomposing, taskHeartbeats, now }) {
  const navigate = useNavigate();
  const [planActionLoading, setPlanActionLoading] = useState(false);

  // QMH-5/3 — surface the wisdom entries that influenced this objective's plan.
  // Real cognition (advisor + wisdomStore) writes execution_wisdom rows; the
  // /api/wisdom/relevant endpoint scores them against the objective text. This
  // panel shows the top matches so the user can see the system's prior knowledge.
  const [wisdom, setWisdom] = useState([]);
  const [wisdomLoading, setWisdomLoading] = useState(false);
  useEffect(() => {
    if (!objective?.id || !authFetch) {
      setWisdom([]);
      return;
    }
    let cancelled = false;
    setWisdomLoading(true);
    const text = `${objective.title || ''} ${objective.description || ''}`.trim();
    fetchRelevantWisdom(authFetch, text, 5)
      .then(res => { if (!cancelled) setWisdom(Array.isArray(res?.wisdom) ? res.wisdom : []); })
      .catch(() => { if (!cancelled) setWisdom([]); })
      .finally(() => { if (!cancelled) setWisdomLoading(false); });
    return () => { cancelled = true; };
  }, [objective?.id, objective?.title, objective?.description, authFetch]);

  if (!objective) {
    return (
      <div className="obj-empty-detail" role="status">
        Select an objective to view details
      </div>
    );
  }

  const handleAction = async (action) => {
    try {
      if (action === 'start') await startObjective(authFetch, objective.id);
      else if (action === 'resume') await startObjective(authFetch, objective.id);
      else if (action === 'cancel') await cancelObjective(authFetch, objective.id);
      else if (action === 'rerun' || action === 'clone') {
        // OBJ-5b: cancel-and-relaunch preserves prompt — clone the objective's
        // title/description/budget/team into a fresh objective and start it.
        // Works for any terminal state (cancelled, failed, completed*).
        const cloned = await createObjective(authFetch, {
          title: objective.title,
          description: objective.description || '',
          max_tokens: objective.max_tokens || undefined,
          max_tool_calls: objective.max_tool_calls || undefined,
          max_duration_ms: objective.max_duration_ms || undefined,
          team_id: objective.team_id || undefined,
          require_approval_before_start: objective.require_approval_before_start ? 1 : 0,
          checkpoint_after_each_task: objective.checkpoint_after_each_task ? 1 : 0,
        });
        if (cloned?.id) await startObjective(authFetch, cloned.id);
      }
      onRefresh();
    } catch (err) {
      console.error(`[Objectives] ${action} failed:`, err);
    }
  };

  const handleApprovePlan = async () => {
    setPlanActionLoading(true);
    try {
      // STUDY-REV R3.6 audit fix: approve THEN start, otherwise the objective
      // sits in 'decomposed' forever and the user can't tell why nothing runs.
      // Mirror handleRejectPlan, which already chains startObjective().
      await approvePlan(authFetch, objective.id);
      await startObjective(authFetch, objective.id);
      onRefresh();
    } catch (err) {
      console.error('[Objectives] Approve plan failed:', err);
    } finally {
      setPlanActionLoading(false);
    }
  };

  const handleRejectPlan = async () => {
    setPlanActionLoading(true);
    try {
      await rejectPlan(authFetch, objective.id);
      // Auto-trigger re-decomposition (was missing — objective sat in 'pending' forever)
      await startObjective(authFetch, objective.id);
      onRefresh();
    } catch (err) {
      console.error('[Objectives] Re-plan failed:', err);
    } finally {
      setPlanActionLoading(false);
    }
  };

  const handleAdjustPlan = async (feedback) => {
    await rejectPlan(authFetch, objective.id, feedback);
    // Auto-restart decomposition with the feedback baked in
    await startObjective(authFetch, objective.id);
    onRefresh();
  };

  // QE2: Task-level retry/skip/checkpoint actions removed — QuoxFlow manages execution

  const tasks = objective.tasks || [];

  return (
    <div className="obj-detail-panel" role="region" aria-label="Objective details">
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <h2 className="obj-detail-title">{objective.title}</h2>
          <ObjectiveStatusBadge status={objective.status} />
          {connectionState && <ConnectionIndicator state={connectionState} />}
          {objective.team_id && (() => {
            const team = getBuiltInTeam(objective.team_id);
            return (
              <>
                {team?.topology?.type && <TopologyBadge type={team.topology.type} size="sm" />}
                <button
                  onClick={() => navigate(`/agentic-teams/${objective.team_id}?objective=${objective.id}`)}
                  style={{
                    padding: '2px 10px', borderRadius: 5, fontSize: 11, fontWeight: 500,
                    background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.2)',
                    color: '#a78bfa', cursor: 'pointer', marginLeft: 'auto',
                    display: 'flex', alignItems: 'center', gap: 4,
                  }}
                >
                  ◆ Open in Team
                </button>
              </>
            );
          })()}
        </div>
        {objective.description && (
          <div className="obj-text-sm obj-text-secondary" style={{ margin: 0, lineHeight: 1.5 }}>
            <MarkdownContent compact>{objective.description}</MarkdownContent>
          </div>
        )}

        {/* STUDY-REV R3.5 — re-observe loop state. Shown only when the user
            opted into the loop by setting goal_condition. */}
        {objective.goal_condition && (() => {
          let log = [];
          try { log = JSON.parse(objective.goal_evaluation_log || '[]'); } catch { log = []; }
          const latest = Array.isArray(log) && log.length > 0 ? log[log.length - 1] : null;
          const used = Number(objective.iteration_count) || 0;
          const max = Number(objective.max_iterations) || 5;
          const status = latest ? (latest.met ? 'met' : 'not-met') : 'pending';
          const palette = status === 'met'
            ? { border: 'rgba(34,197,94,0.30)', bg: 'rgba(34,197,94,0.08)', label: '#86efac' }
            : status === 'not-met'
              ? { border: 'rgba(245,158,11,0.30)', bg: 'rgba(245,158,11,0.08)', label: '#fcd34d' }
              : { border: 'rgba(255,255,255,0.18)', bg: 'rgba(255,255,255,0.05)', label: 'rgba(255,255,255,0.85)' };
          return (
            <div style={{
              marginTop: 12, padding: '10px 14px', borderRadius: 10,
              background: palette.bg, border: `1px solid ${palette.border}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: palette.label, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Re-observe loop · iteration {used} / {max}
                </span>
                <span className="qx-pill" style={{ fontSize: 10 }}>
                  {status === 'met' ? 'Goal met' : status === 'not-met' ? 'Not met yet' : 'Awaiting first eval'}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)', lineHeight: 1.45 }}>
                <strong style={{ fontWeight: 600 }}>Goal:</strong> {objective.goal_condition}
              </div>
              {latest && (
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.78)', lineHeight: 1.45, marginTop: 4 }}>
                  <strong style={{ fontWeight: 600 }}>Last evaluation:</strong> {latest.reason}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* P8.B.3 — budget warning / danger banner */}
      {objective.budget_id && (
        <ObjectiveBudgetBanner
          authFetch={authFetch}
          budget={{ id: objective.budget_id, ...objective.budget }}
        />
      )}

      {/* QMH-5/3 — wisdom entries that influenced the plan. Surfaces real
          execution_wisdom (advisor + dream-cycle output), not a placeholder. */}
      {!wisdomLoading && wisdom.length > 0 && (
        <div style={{
          margin: '0 12px 12px', padding: '10px 14px', borderRadius: 8,
          background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.18)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a855f7" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
            </svg>
            <span style={{ fontSize: 11, fontWeight: 600, color: '#c4b5fd', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Influencing wisdom · {wisdom.length} entr{wisdom.length === 1 ? 'y' : 'ies'}
            </span>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {wisdom.map(w => (
              <li key={w.id} style={{
                fontSize: 12, lineHeight: 1.45,
                padding: '6px 8px', borderRadius: 4,
                background: 'rgba(255,255,255,0.03)',
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontWeight: 600, color: 'rgba(196,181,253,0.95)' }}>{w.pattern_name || 'pattern'}</span>
                  {typeof w.confidence === 'number' && (
                    <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)' }}>
                      conf {(w.confidence * 100).toFixed(0)}%
                    </span>
                  )}
                  {w.category && (
                    <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>· {w.category}</span>
                  )}
                </div>
                {w.lesson && (
                  <div style={{ color: 'rgba(255,255,255,0.7)', marginTop: 2 }}>{w.lesson}</div>
                )}
                {w.decomposition_directive && (
                  <div style={{ color: 'rgba(196,181,253,0.7)', marginTop: 2, fontStyle: 'italic' }}>
                    → {w.decomposition_directive}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Budget meters — GaugeCluster (EUX-4: real data from tasks) */}
      <div style={{ padding: '12px 12px 4px' }}>
        <GaugeCluster
          gauges={(() => {
            const completedCount = tasks.filter(t => t.status === 'completed').length;
            const totalTokens = tasks.reduce((sum, t) => sum + (t.tokens_used || 0), 0);
            const toolSet = new Set();
            tasks.forEach(t => {
              if (t.tools_used) {
                const list = Array.isArray(t.tools_used) ? t.tools_used
                  : typeof t.tools_used === 'string' ? t.tools_used.split(',').map(s => s.trim()).filter(Boolean)
                  : [];
                list.forEach(tool => toolSet.add(tool));
              }
            });
            return [
              { label: 'Tasks', value: completedCount, max: tasks.length || objective.task_count || 1, unit: '' },
              { label: 'Tokens', value: totalTokens || objective.tokens_used || 0, max: objective.max_tokens || 100000, unit: '' },
              { label: 'Tools', value: toolSet.size || objective.tool_calls_used || 0, max: objective.max_tool_calls || 50, unit: '' },
            ];
          })()}
          layout="row"
          size={56}
        />
      </div>

      {/* EUX-4: Execution summary — always visible for completed/failed objectives */}
      {['completed', 'completed_with_errors', 'failed'].includes(objective.status) && tasks.length > 0 && (() => {
        const failedTasks = tasks.filter(t => t.status === 'failed');
        const isFailed = objective.status === 'failed' || (failedTasks.length > 0 && tasks.filter(t => t.status === 'completed').length === 0);
        const totalDuration = tasks.reduce((sum, t) => sum + (t.duration_ms || 0), 0);
        const durationStr = totalDuration >= 60000
          ? `${Math.floor(totalDuration / 60000)}m ${Math.floor((totalDuration % 60000) / 1000)}s`
          : totalDuration > 0 ? `${(totalDuration / 1000).toFixed(1)}s` : null;
        const lastResult = [...tasks].reverse().find(t => t.status === 'completed' && t.result);
        const preview = lastResult?.result
          ? (typeof lastResult.result === 'string' ? lastResult.result : JSON.stringify(lastResult.result)).split('\n').filter(l => l.trim()).slice(0, 3).join('\n').slice(0, 300)
          : null;

        return (
          <div style={{ margin: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* Failed objective: prominent error card */}
            {isFailed && failedTasks.length > 0 && (
              <div style={{
                padding: '10px 14px', borderRadius: 8,
                background: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.2)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round">
                    <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                  </svg>
                  <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'rgba(252, 165, 165, 0.9)' }}>
                    {failedTasks.length} task{failedTasks.length !== 1 ? 's' : ''} failed
                  </span>
                </div>
                <div style={{
                  fontSize: '0.72rem', fontWeight: 600, color: 'rgba(252, 165, 165, 0.8)', marginBottom: 2,
                }}>
                  {failedTasks[0].agent_id ? `${failedTasks[0].agent_id.toUpperCase()}: ` : ''}{failedTasks[0].title}
                </div>
                {failedTasks[0].result && (
                  <pre style={{
                    margin: 0, padding: '6px 8px', borderRadius: 4,
                    background: 'rgba(0,0,0,0.2)',
                    fontSize: '0.7rem', color: 'rgba(239, 68, 68, 0.8)',
                    fontFamily: 'var(--m-font-mono, monospace)',
                    whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto', lineHeight: 1.5,
                  }}>
                    {typeof failedTasks[0].result === 'string' ? failedTasks[0].result.slice(0, 300) : 'Error during execution'}
                  </pre>
                )}
                {failedTasks.length > 1 && (
                  <div style={{ marginTop: 4, fontSize: '0.68rem', color: 'rgba(252, 165, 165, 0.5)' }}>
                    Also failed: {failedTasks.slice(1).map(t => t.title).join(', ')}
                  </div>
                )}
              </div>
            )}

            {/* Summary card */}
            <div style={{
              padding: '10px 14px', borderRadius: 8,
              background: isFailed ? 'rgba(239, 68, 68, 0.04)' : 'rgba(34, 197, 94, 0.06)',
              border: `1px solid ${isFailed ? 'rgba(239, 68, 68, 0.1)' : 'rgba(34, 197, 94, 0.15)'}`,
              fontSize: '0.78rem', lineHeight: 1.6,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>Execution Summary</span>
                {durationStr && (
                  <span style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--m-font-mono, monospace)' }}>
                    {durationStr}
                  </span>
                )}
              </div>
              <div style={{ color: 'rgba(255,255,255,0.6)' }}>
                {tasks.filter(t => t.status === 'completed').length} completed
                {failedTasks.length > 0 && `, ${failedTasks.length} failed`}
                {tasks.some(t => t.status === 'skipped') && `, ${tasks.filter(t => t.status === 'skipped').length} skipped`}
                {' '}of {tasks.length} tasks
                {objective.quoxflow_execution_id && (
                  <a
                    href={`/mission-control?tab=workflows&execution=${objective.quoxflow_execution_id}`}
                    onClick={(e) => { e.preventDefault(); navigate(`/mission-control?tab=workflows&execution=${objective.quoxflow_execution_id}`); }}
                    style={{ marginLeft: 8, fontSize: '0.7rem', color: 'rgba(99,102,241,0.6)', textDecoration: 'none' }}
                  >
                    QuoxFlow ↗
                  </a>
                )}
              </div>

              {/* Findings preview — always visible (EUX-4) */}
              {preview && !isFailed && (
                <div style={{
                  marginTop: 6, padding: '6px 8px', borderRadius: 4,
                  background: 'rgba(0,0,0,0.15)',
                  fontSize: '0.72rem', color: 'rgba(255,255,255,0.65)',
                  lineHeight: 1.5, whiteSpace: 'pre-wrap',
                  maxHeight: 100, overflow: 'hidden',
                }}>
                  {preview}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Action bar */}
      <ObjectiveControlBar
        status={objective.status}
        tasks={tasks}
        hasSkipped={tasks.some(t => t.status === 'skipped' || t.status === 'failed')}
        onPlanTasks={() => handleAction('start')}
        onCancel={() => handleAction('cancel')}
        onRerun={() => handleAction('rerun')}
        onClone={() => handleAction('clone')}
        onSaveTemplate={async (name) => {
          const result = await saveAsTemplate(authFetch, objective.id, name)
          return result
        }}
        onSaveTemplateWithVars={async (name, variables) => {
          const result = await saveAsTemplate(authFetch, objective.id, name, variables)
          return result
        }}
        onCreateSchedule={async (cronExpression, templateData) => {
          const templateJson = typeof templateData.template_json === 'string'
            ? JSON.parse(templateData.template_json)
            : templateData.template_json
          await createOrgSchedule(authFetch, {
            name: templateData.name,
            cronExpression,
            objectiveTemplate: templateJson,
          })
        }}
        onWatchOpsDeck={() => navigate(`/opsdeck?objective=${objective.id}`)}
        onCrystallise={() => navigate(`/workflow-builder?fromObjective=${objective.id}`)}
      />

      {/* Active Checkpoint */}
      {objective.active_checkpoint && (
        <CheckpointPanel
          checkpoint={objective.active_checkpoint}
          onApprove={(id, notes) =>
            approveCheckpoint(authFetch, objective.id, id, notes).then(onRefresh)
          }
          onReject={(id, notes) =>
            rejectCheckpoint(authFetch, objective.id, id, notes).then(onRefresh)
          }
        />
      )}

      {/* Step 26: Task Preview Panel (for decomposed status) */}
      {objective.status === 'decomposed' && tasks.length > 0 && (
        <TaskPreviewPanel
          tasks={tasks}
          onApprove={handleApprovePlan}
          onReject={handleRejectPlan}
          onAdjust={handleAdjustPlan}
          loading={planActionLoading}
        />
      )}

      {/* Circuit Breaker Alert — shown when objective paused by circuit breaker */}
      {objective.status === 'paused' && objective.tasks_failed >= 3 && (
        <CircuitBreakerAlert
          objectiveTitle={objective.title}
          teamName={objective.team_id ? resolveTeamName(objective.team_id) : null}
          consecutiveFailures={objective.tasks_failed}
          failedTasks={tasks.filter(t => t.status === 'failed').map(t => ({ title: t.title, agentId: t.agent_id, error: t.result?.slice(0, 100) }))}
          onResume={() => handleAction('resume')}
          onPause={null}
          onSwitchTeam={null}
        />
      )}

      {/* Pipeline Stage Indicator — for pipeline-topology teams */}
      {objective.team_id && (() => {
        const team = getBuiltInTeam(objective.team_id);
        if (team?.topology?.type === 'pipeline' && team.topology.pipelineStages) {
          const stages = team.topology.pipelineStages.map(s => {
            const stageTasks = tasks.filter(t => {
              try { const m = JSON.parse(t.metadata || '{}'); return m.stage === s.name; } catch { return false; }
            });
            const completed = stageTasks.filter(t => t.status === 'completed').length;
            const active = stageTasks.some(t => t.status === 'running');
            const failed = stageTasks.some(t => t.status === 'failed');
            return { name: s.name, status: failed ? 'failed' : active ? 'active' : completed === stageTasks.length && stageTasks.length > 0 ? 'completed' : 'pending', taskCount: stageTasks.length, completedCount: completed };
          });
          return <PipelineStageIndicator stages={stages} />;
        }
        return null;
      })()}

      {/* Milestone timeline — horizontal event dots */}
      {objective.status !== 'decomposed' && tasks.length > 0 && (() => {
        const milestones = [];
        if (objective.created_at) milestones.push({ label: 'Created', status: 'created', color: '#71717a' });
        if (objective.started_at) milestones.push({ label: 'Started', status: 'started', color: '#3b82f6' });
        const completedCount = tasks.filter(t => t.status === 'completed').length;
        if (completedCount > 0 && completedCount < tasks.length) {
          milestones.push({ label: `${completedCount}/${tasks.length} done`, status: 'checkpoint', color: '#10b981' });
        }
        if (tasks.some(t => t.status === 'failed')) milestones.push({ label: 'Failure', status: 'failed', color: '#ef4444' });
        if (objective.status === 'paused') milestones.push({ label: 'Paused', status: 'paused', color: '#f59e0b' });
        if (objective.status === 'completed') milestones.push({ label: 'Completed', status: 'completed', color: '#10b981' });
        else if (objective.status === 'failed') milestones.push({ label: 'Failed', status: 'failed', color: '#ef4444' });
        else if (objective.status === 'running') milestones.push({ label: 'Running', status: 'running', color: '#6366f1' });
        return milestones.length >= 2 ? (
          <div style={{ margin: '12px 0', borderRadius: 8, overflow: 'hidden' }}>
            <ExecutionTimeline events={milestones} compact={tasks.length > 6} />
          </div>
        ) : null;
      })()}

      {/* Task Timeline (for running/completed statuses) */}
      {objective.status !== 'decomposed' && tasks.length > 0 && (
        <div style={{ marginTop: 16 }} role="list" aria-label="Task timeline">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 className="obj-section-title" style={{ margin: 0 }}>
              Task Timeline ({tasks.filter(t => t.status === 'completed').length}/{tasks.length})
            </h3>
          </div>

          {['completed', 'completed_with_errors', 'failed'].includes(objective.status) && (
            <ObjectiveSummaryBar tasks={tasks} />
          )}

          {/* Swimlane diagram — agent lanes with task bars */}
          {tasks.length >= 2 && tasks.some(t => t.started_at) && (
            <div style={{ marginBottom: 16, borderRadius: 8, overflow: 'hidden' }}>
              <SwimlaneDiagram
                tasks={tasks.filter(t => t.started_at).map(t => ({
                  id: t.id, title: t.title, agentId: t.agent_id,
                  agentName: (t.agent_id || '').toUpperCase(),
                  agentColor: t.status === 'failed' ? '#ef4444' : t.status === 'completed' ? '#10b981' : '#6366f1',
                  status: t.status, startedAt: t.started_at, completedAt: t.completed_at,
                  durationMs: t.duration_ms || (t.completed_at && t.started_at ? new Date(t.completed_at) - new Date(t.started_at) : 0),
                }))}
                compact
              />
            </div>
          )}

          {/* Task list */}
          <div>
            {tasks.map((task, idx) => (
              <TaskTimelineNode
                key={task.id}
                task={task}
                isLast={idx === tasks.length - 1}
                onRetry={() => {}}
                onSkip={() => {}}
                heartbeat={taskHeartbeats?.[task.id]}
                now={now}
              />
            ))}
          </div>

          {/* Execution Analysis — per-node timeline with real data (EUX-1) */}
          {['completed', 'completed_with_errors', 'failed'].includes(objective.status) && tasks.length > 1 && (
            <ExecutionAnalysis
              tasks={tasks}
              quoxflowExecutionId={objective.quoxflow_execution_id}
              maxTokenBudget={objective.max_tokens}
            />
          )}

          {/* Audit Trail — real AEE envelopes or task-based fallback (EUX-2) */}
          {tasks.length > 0 && (
            <EnvelopeAuditTrail
              tasks={tasks}
              quoxflowExecutionId={objective.quoxflow_execution_id}
            />
          )}
        </div>
      )}

      {/* Decomposing — shown while plan is being generated */}
      {isDecomposing && tasks.length === 0 && (
        <div role="status" aria-busy="true" style={{ padding: '24px 0' }}>
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
            padding: '32px 20px',
            background: 'rgba(99,102,241,0.04)',
            border: '1px solid rgba(99,102,241,0.12)',
            borderRadius: 12,
          }}>
            {/* Animated planning indicator */}
            <div style={{ position: 'relative', width: 48, height: 48 }}>
              <div style={{
                width: 48, height: 48, borderRadius: '50%',
                border: '2px solid rgba(99,102,241,0.2)',
                borderTopColor: '#6366f1',
                animation: 'obj-spin 1s linear infinite',
              }} />
              <div style={{
                position: 'absolute', inset: 8,
                borderRadius: '50%', background: 'rgba(99,102,241,0.15)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ stroke: '#818cf8' }} strokeWidth="2" strokeLinecap="round">
                  <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/>
                  <path d="M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
                </svg>
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
                Planning execution
              </div>
              <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>
                QuoxEngine is decomposing this objective into agent tasks...
              </div>
            </div>
            {/* Skeleton task bars */}
            <div style={{ width: '100%', maxWidth: 320 }}>
              {[1, 2, 3].map(i => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                  marginBottom: 4, borderRadius: 6,
                  background: 'rgba(99,102,241,0.06)',
                  animation: `obj-skeleton-pulse 1.5s ease-in-out ${i * 0.3}s infinite`,
                }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'rgba(99,102,241,0.3)' }} />
                  <div style={{
                    height: 8, borderRadius: 4, flex: 1,
                    background: 'rgba(255,255,255,0.06)',
                    maxWidth: [180, 140, 200][i - 1],
                  }} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!isDecomposing && tasks.length === 0 && objective.status === 'pending' && (
        <div className="obj-empty-tasks" role="status">
          Click "Plan Tasks" to decompose this objective into tasks
        </div>
      )}
    </div>
  );
}

// ==========================================
// ObjectivesView (main page)
// ==========================================
function ObjectivesView({ embedded = false }) {
  const { setPageActions } = useOutletContext() || {};
  const { authFetch } = useAuth();
  const navigate = useNavigate();

  const [selectedId, setSelectedId] = useState(null);
  const [statusFilter, setStatusFilter] = useState(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [focusIndex, setFocusIndex] = useState(-1);
  // P6.B: PRISM visible by default. Collapse state is persisted server-side.
  const [showChat, setShowChat] = useState(true);
  const prismPrefLoadedRef = useRef(false);
  useEffect(() => {
    if (!authFetch || prismPrefLoadedRef.current) return;
    prismPrefLoadedRef.current = true;
    getUIPref(authFetch, 'prism_collapsed').then(val => {
      if (val === true) setShowChat(false);
    }).catch(() => {/* keep default */});
  }, [authFetch]);

  const listRef = useRef(null);

  // Unified objective management hook (UX-2)
  const {
    objectives, detail: selectedDetail, loading, error,
    actions, refresh: handleRefresh, connectionState,
    taskHeartbeats, isDecomposing, now,
  } = useObjectiveManager({ selectedId, statusFilter });
  const objectiveServiceIssue = getPlatformDependencyIssue(error, {
    service: 'tasks',
    feature: 'Objectives',
  });

  // Zombie process detection (UX-1)
  const { processes: runningProcesses } = useRunningProcesses();
  const handleZombieCancel = useCallback(async (id) => {
    try { await actions.cancel(id); } catch (err) { console.error('[Objectives] Zombie cancel failed:', err); }
  }, [actions]);
  const handleZombieRetry = useCallback(async (id) => {
    try { await actions.rerun(id); } catch (err) { console.error('[Objectives] Zombie retry failed:', err); }
  }, [actions]);

  // Set page actions
  useEffect(() => {
    if (setPageActions) {
      setPageActions(
        <Button variant="primary" size="sm" onClick={() => setShowNewModal(true)}
          style={{ background: 'var(--m-coral, #ff8a6b)' }}
          icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>}
        >New Objective</Button>
      );
    }
    return () => { if (setPageActions) setPageActions(null); };
  }, [setPageActions]);

  // Create handler
  const handleCreate = async (data) => {
    await actions.create(data);
  };

  // Status filter counts
  const statusCounts = useMemo(() => {
    const counts = { all: objectives.length };
    for (const o of objectives) {
      counts[o.status] = (counts[o.status] || 0) + 1;
    }
    return counts;
  }, [objectives]);

  const filteredObjectives = useMemo(() => {
    if (!statusFilter) return objectives;
    return objectives.filter(o => o.status === statusFilter);
  }, [objectives, statusFilter]);

  // Step 22: Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't capture if typing in an input/textarea
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusIndex(prev => Math.min(prev + 1, filteredObjectives.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusIndex(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' && focusIndex >= 0) {
        e.preventDefault();
        setSelectedId(filteredObjectives[focusIndex]?.id);
      } else if (e.key === 'n') {
        e.preventDefault();
        setShowNewModal(true);
      } else if (e.key === 'Escape') {
        if (showNewModal) setShowNewModal(false);
        else setSelectedId(null);
      } else if (e.key === 's' && selectedDetail?.status === 'pending') {
        e.preventDefault();
        startObjective(authFetch, selectedDetail.id).then(handleRefresh);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredObjectives, focusIndex, selectedDetail, showNewModal, authFetch, handleRefresh]);

  // Auto-select on keyboard nav
  useEffect(() => {
    if (focusIndex >= 0 && focusIndex < filteredObjectives.length) {
      setSelectedId(filteredObjectives[focusIndex].id);
    }
  }, [focusIndex, filteredObjectives]);

  return (
    <div className="objectives-view">
      {/* Item 3: Suppress banner + EvolutionStagePill when embedded inside MissionControl */}
      {!embedded && <LLMAuthBanner />}
      {!embedded && <EvolutionStagePill currentStage="objective" style={{ marginBottom: 12 }} />}
      {/* Filter strip */}
      <div className="obj-filter-strip" role="tablist" aria-label="Filter by status" style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        {[
          { key: null, label: 'All' },
          { key: 'running', label: 'Running' },
          { key: 'decomposed', label: 'Awaiting Approval' },
          { key: 'pending', label: 'Not Started' },
          { key: 'paused', label: 'Paused' },
          { key: 'completed', label: 'Completed' },
          { key: 'failed', label: 'Failed' }
        ].map(f => (
          <button
            key={f.key || 'all'}
            role="tab"
            aria-selected={statusFilter === f.key}
            onClick={() => setStatusFilter(f.key)}
            className={`obj-filter-btn ${statusFilter === f.key ? 'obj-filter-active' : ''}`}
          >
            {f.label}
            {statusCounts[f.key || 'all'] > 0 && (
              <span className="obj-filter-count">({statusCounts[f.key || 'all']})</span>
            )}
          </button>
        ))}
        <button
          onClick={() => setShowChat(v => {
            const next = !v;
            // P6.B: persist collapse state server-side (prism_collapsed = true means hidden)
            setUIPref(authFetch, 'prism_collapsed', !next).catch(() => {/* non-critical */});
            return next;
          })}
          title={showChat ? 'Hide PRISM' : 'Show PRISM'}
          style={{
            marginLeft: 'auto', flexShrink: 0,
            padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 500,
            background: showChat ? 'rgba(139,92,246,0.15)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${showChat ? 'rgba(139,92,246,0.25)' : 'rgba(255,255,255,0.08)'}`,
            color: showChat ? '#a78bfa' : 'rgba(255,255,255,0.5)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
            transition: 'all 0.15s',
          }}
        >
          <span style={{ fontSize: 14 }}>◈</span> PRISM
        </button>
      </div>

      {/* Zombie process warning (UX-1) */}
      <ZombiePanel
        processes={runningProcesses}
        onCancel={handleZombieCancel}
        onRetry={handleZombieRetry}
      />

      {/* UI-9: Plans Awaiting Approval banner restored to full width above
          the layout grid. Was previously nested inside obj-list-panel by
          OBJ-1 (so the PRISM sidebar kept full height) but the cramped
          left-column rendering made the banner unreadable. Banner only
          appears when there are decomposed objectives, so the height cost
          on the layout below is minimal. */}
      <PlansAwaitingApproval />

      {/* Main layout: list + detail + chat */}
      <div className="obj-layout">
        {/* Left: Objective list */}
        <div className="obj-list-panel" ref={listRef} role="listbox" aria-label="Objectives">
          {loading && (
            <div role="status" aria-label="Loading objectives">
              {[0, 1, 2, 3, 4].map(i => (
                <div key={i} className="obj-skeleton-card" style={{ animationDelay: `${i * 0.15}s` }}>
                  <div className="obj-skeleton-bar obj-skeleton-bar--title" style={{ animationDelay: `${i * 0.15}s` }} />
                  <div className="obj-skeleton-bar obj-skeleton-bar--desc" style={{ animationDelay: `${i * 0.15 + 0.05}s` }} />
                  <div className="obj-skeleton-bar obj-skeleton-bar--meta" style={{ animationDelay: `${i * 0.15 + 0.1}s` }} />
                </div>
              ))}
            </div>
          )}
          {error && (
            objectiveServiceIssue ? (
              <PlatformDependencyNotice issue={objectiveServiceIssue} compact style={{ marginBottom: 12 }} />
            ) : (
              <div className="obj-error-state" role="alert">Error: {error}</div>
            )
          )}
          {!loading && !error && filteredObjectives.length === 0 && (
            <div className="obj-empty-state">
              <div style={{ fontSize: 24, marginBottom: 8, opacity: 0.4 }}>◎</div>
              <div style={{ fontWeight: 500, color: 'var(--m-text-primary)', marginBottom: 6 }}>
                {statusFilter ? 'No matching objectives' : 'No objectives yet'}
              </div>
              <div style={{ lineHeight: 1.6, maxWidth: 280, margin: '0 auto' }}>
                {statusFilter
                  ? 'Try a different filter or create a new objective.'
                  : 'Objectives let your AI teams work on complex tasks autonomously. Each objective is decomposed into steps, executed by specialist agents, and fully auditable.'
                }
              </div>
            </div>
          )}
          {filteredObjectives.map((obj, idx) => {
            const taskTotal = obj.task_count || 0;
            const taskDone = obj.tasks_completed || 0;
            const elapsed = formatElapsed(obj.started_at || obj.created_at, obj.completed_at);
            const teamName = obj.team_id ? resolveTeamName(obj.team_id) : null;
            return (
              <div
                key={obj.id}
                role="option"
                aria-selected={selectedId === obj.id}
                tabIndex={focusIndex === idx ? 0 : -1}
                onClick={() => { setSelectedId(obj.id); setFocusIndex(idx); }}
                className={`obj-list-item obj-list-item--${obj.status || 'pending'} ${selectedId === obj.id ? 'obj-list-item-active' : ''}`}
              >
                {/* Title row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="obj-list-item-title">{obj.title}</span>
                  {/* DEVSUITE-DEVMODE 5c: loop runs render as flat task rows
                      like dag runs, so the chip is the only mode signal */}
                  {obj.execution_mode === 'loop' && (
                    <span className="qx-chip" title={`Agentic loop (${obj.loop_backend || 'claude'})`} style={{ flexShrink: 0 }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 014-4h14" />
                        <path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 01-4 4H3" />
                      </svg>
                      LOOP
                    </span>
                  )}
                </div>

                {/* Description preview */}
                {obj.description ? (
                  <div className="obj-list-item-desc">{obj.description}</div>
                ) : (
                  <div style={{ height: 8 }} />
                )}

                {/* Bottom metadata row */}
                <div className="obj-list-item-meta">
                  <ObjectiveStatusBadge status={obj.status} />

                  {taskTotal > 0 && (
                    <>
                      <span className="obj-list-item-meta-divider" />
                      <span className="obj-list-item-progress">{taskDone}/{taskTotal} tasks</span>
                    </>
                  )}

                  {elapsed && (
                    <>
                      <span className="obj-list-item-meta-divider" />
                      <span className="obj-list-item-time">{elapsed}</span>
                    </>
                  )}

                  {teamName && (
                    <>
                      <span className="obj-list-item-meta-divider" />
                      <span
                        className="obj-list-item-team"
                        onClick={(e) => { e.stopPropagation(); navigate(`/agentic-teams/${obj.team_id}?objective=${obj.id}`); }}
                        title={`Open ${teamName} team`}
                      >
                        ◆ {teamName}
                      </span>
                    </>
                  )}

                  <span className="obj-list-item-time" style={{ marginLeft: 'auto' }}>
                    {obj.updated_at
                      ? formatRelativeTime(new Date(obj.updated_at))
                      : new Date(obj.created_at).toLocaleDateString()
                    }
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Centre: Detail panel */}
        <div className="obj-detail-wrapper" style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
          <ObjectiveDetail
            objective={selectedDetail}
            connectionState={connectionState}
            onRefresh={handleRefresh}
            authFetch={authFetch}
            isDecomposing={isDecomposing}
            taskHeartbeats={taskHeartbeats}
            now={now}
          />
        </div>

        {/* Right: PRISM chat sidebar (persistent, collapsible) */}
        <div style={{
          width: showChat ? 380 : 0, flexShrink: 0,
          overflow: 'hidden', transition: 'width 0.2s ease',
          opacity: showChat ? 1 : 0, pointerEvents: showChat ? 'auto' : 'none',
        }}>
          <PrismSidebar
            context={{
              mode: 'objectives',
              objectives,
              selectedObjective: selectedDetail,
              teamName: selectedDetail?.team_id ? resolveTeamName(selectedDetail.team_id) : null,
            }}
            onAction={selectedDetail?.status === 'decomposed' ? async (feedback) => {
              await rejectPlan(authFetch, selectedDetail.id, feedback);
              await startObjective(authFetch, selectedDetail.id);
              handleRefresh();
            } : undefined}
          />
        </div>
      </div>

      {/* New Objective Modal */}
      <NewObjectiveModal
        isOpen={showNewModal}
        onClose={(newId) => {
          setShowNewModal(false);
          if (newId) {
            handleRefresh();
            setTimeout(() => setSelectedId(newId), 300);
          }
        }}
        onSubmit={handleCreate}
      />

    </div>
  );
}

export default ObjectivesView;
