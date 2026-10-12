/**
 * RichObjectCard — Inline chat card for rich object data.
 *
 * Renders interactive cards for objectives, plans, progress, completions,
 * guardian alerts, and saved workflows. Styled as dark glassmorphic cards
 * with action buttons that call real APIs.
 *
 * Props:
 *   data      - { type, ...payload } object describing what to render
 *   authFetch - Authenticated fetch function from auth context
 */

import { useState, useEffect, useRef } from 'react';
import { approvePlan, cancelObjective, saveAsTemplate, createFromChat } from '../../services/objectivesClient';
import { readTaskServiceJson } from '../../services/taskServiceClient';
import { StepIndicator } from '../orchestration';

// ── Shared styles ────────────────────────────────────────────────────

const CARD_BASE = {
  background: 'rgba(12, 14, 20, 0.85)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  borderRadius: 10,
  maxWidth: 400,
  marginTop: 8,
  position: 'relative',
  overflow: 'hidden',
  fontFamily: "'Inter', -apple-system, sans-serif",
};

const ACCENT_BAR = {
  position: 'absolute',
  top: 0,
  left: 0,
  bottom: 0,
  width: 4,
  borderRadius: '10px 0 0 10px',
};

const ACCENT_COLORS = {
  objective_created: '#3b82f6',   // blue
  objective_plan: '#8b5cf6',      // purple
  objective_progress: '#6366f1',  // indigo
  objective_complete: '#22c55e',  // green
  guardian_alert: '#ef4444',      // red
  workflow_saved: '#14b8a6',      // teal
  browser_objective: '#f59e0b',   // amber
  browser_extraction: '#06b6d4', // BQ cyan
  noc_check_result: '#4ecdc4',   // noc cyan
  wazuh_alert: '#ff6b35',        // ARGUS orange (matches argus.json)
  wazuh_cve: '#00a9e5',          // Wazuh cyan (matches plugin manifest)
};

const HEADER_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '10px 12px 4px 16px',
  fontSize: '0.7rem',
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'rgba(255, 255, 255, 0.5)',
};

const TITLE_STYLE = {
  padding: '2px 12px 6px 16px',
  fontSize: '0.85rem',
  fontWeight: 600,
  color: 'rgba(255, 255, 255, 0.9)',
  lineHeight: 1.3,
};

const BODY_STYLE = {
  padding: '4px 12px 8px 16px',
  fontSize: '0.78rem',
  color: 'rgba(255, 255, 255, 0.65)',
  lineHeight: 1.5,
};

const STAT_FONT = {
  fontFamily: "'SF Mono', 'JetBrains Mono', 'Fira Code', monospace",
  fontSize: '0.72rem',
};

const ACTIONS_STYLE = {
  display: 'flex',
  gap: 6,
  padding: '6px 12px 10px 16px',
  flexWrap: 'wrap',
};

const PILL_BTN = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 10px',
  borderRadius: 20,
  border: '1px solid rgba(255, 255, 255, 0.12)',
  background: 'rgba(255, 255, 255, 0.05)',
  color: 'rgba(255, 255, 255, 0.75)',
  fontSize: '0.7rem',
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'background 0.15s, border-color 0.15s',
};

const PILL_BTN_PRIMARY = {
  ...PILL_BTN,
  background: 'rgba(99, 102, 241, 0.15)',
  borderColor: 'rgba(99, 102, 241, 0.3)',
  color: 'rgba(165, 180, 252, 0.9)',
};

const PILL_BTN_DANGER = {
  ...PILL_BTN,
  background: 'rgba(239, 68, 68, 0.1)',
  borderColor: 'rgba(239, 68, 68, 0.2)',
  color: 'rgba(252, 165, 165, 0.85)',
};

const PILL_BTN_SUCCESS = {
  ...PILL_BTN,
  background: 'rgba(34, 197, 94, 0.1)',
  borderColor: 'rgba(34, 197, 94, 0.2)',
  color: 'rgba(134, 239, 172, 0.85)',
};

const TASK_ROW = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 0',
  fontSize: '0.75rem',
  color: 'rgba(255, 255, 255, 0.65)',
};

const STATUS_DOT = (color) => ({
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: color,
  flexShrink: 0,
});

const PROGRESS_TRACK = {
  height: 4,
  background: 'rgba(255, 255, 255, 0.08)',
  borderRadius: 2,
  overflow: 'hidden',
  margin: '4px 0 2px 0',
};

// ── Status badge helpers ─────────────────────────────────────────────

function StatusBadge({ status }) {
  const colors = {
    pending: '#94a3b8',
    decomposing: '#f59e0b',
    decomposed: '#8b5cf6',
    running: '#6366f1',
    completed: '#22c55e',
    failed: '#ef4444',
    cancelled: '#94a3b8',
    paused: '#f59e0b',
  };
  const color = colors[status] || '#94a3b8';
  return (
    <span style={{
      ...STAT_FONT,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '2px 8px',
      borderRadius: 10,
      background: `${color}22`,
      color: color,
      fontWeight: 600,
    }}>
      <span style={STATUS_DOT(color)} />
      {status}
    </span>
  );
}

// ── Card type renderers ──────────────────────────────────────────────

function ObjectiveCreatedCard({ data, navigate }) {
  return (
    <>
      <div style={HEADER_STYLE}>
        <span style={{ fontSize: 14 }}>&#9881;</span>
        <span>Objective Created</span>
      </div>
      <div style={TITLE_STYLE}>{data.title}</div>
      <div style={BODY_STYLE}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <StatusBadge status={data.status} />
          {data.taskCount > 0 && (
            <span style={STAT_FONT}>{data.taskCount} task{data.taskCount !== 1 ? 's' : ''}</span>
          )}
          {data.teamId && (
            <span style={{ ...STAT_FONT, color: 'rgba(255, 255, 255, 0.45)' }}>Team: {data.teamId}</span>
          )}
        </div>
      </div>
      <div style={ACTIONS_STYLE}>
        <button
          style={PILL_BTN_PRIMARY}
          onClick={() => navigate(`/opsdeck?objective=${data.objectiveId}`)}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(99, 102, 241, 0.25)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(99, 102, 241, 0.15)'; }}
        >
          <span style={{ fontSize: 11 }}>&#9673;</span> Watch in OpsDeck
        </button>
        <button
          style={PILL_BTN}
          onClick={() => navigate('/mission-control?tab=objectives')}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
        >
          <span style={{ fontSize: 11 }}>&#9776;</span> Mission Control
        </button>
      </div>
    </>
  );
}

function ObjectivePlanCard({ data, authFetch, navigate, onAction }) {
  const [acting, setActing] = useState(null);

  const handleApprove = async () => {
    if (!data.objectiveId || !authFetch) return;
    setActing('approve');
    try {
      await approvePlan(authFetch, data.objectiveId);
      onAction?.('approved');
    } catch (err) {
      console.error('[RichObjectCard] Approve failed:', err);
      onAction?.('error', err.message);
    } finally {
      setActing(null);
    }
  };

  const handleCancel = async () => {
    if (!data.objectiveId || !authFetch) return;
    setActing('cancel');
    try {
      await cancelObjective(authFetch, data.objectiveId);
      onAction?.('cancelled');
    } catch (err) {
      console.error('[RichObjectCard] Cancel failed:', err);
      onAction?.('error', err.message);
    } finally {
      setActing(null);
    }
  };

  return (
    <>
      <div style={HEADER_STYLE}>
        <span style={{ fontSize: 14 }}>&#9998;</span>
        <span>Objective Plan</span>
        <StatusBadge status={data.status || 'decomposed'} />
      </div>
      <div style={TITLE_STYLE}>{data.title}</div>

      {/* Task list */}
      {data.tasks && data.tasks.length > 0 && (
        <div style={{ ...BODY_STYLE, paddingTop: 0 }}>
          {data.tasks.slice(0, 8).map((t, i) => (
            <div key={i} style={TASK_ROW}>
              <span style={STATUS_DOT(t.status === 'completed' ? '#22c55e' : t.status === 'running' ? '#6366f1' : '#94a3b8')} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
              {t.agent_id && (
                <span style={{ ...STAT_FONT, color: 'rgba(255, 255, 255, 0.35)', fontSize: '0.65rem' }}>
                  {t.agent_id.toUpperCase()}
                </span>
              )}
            </div>
          ))}
          {data.tasks.length > 8 && (
            <div style={{ ...STAT_FONT, color: 'rgba(255, 255, 255, 0.35)', paddingTop: 2 }}>
              +{data.tasks.length - 8} more
            </div>
          )}
        </div>
      )}

      {/* Advisory */}
      {data.advisory && (
        <div style={{
          margin: '0 12px 6px 16px',
          padding: '6px 8px',
          borderRadius: 6,
          background: 'rgba(139, 92, 246, 0.08)',
          border: '1px solid rgba(139, 92, 246, 0.15)',
          fontSize: '0.72rem',
          color: 'rgba(196, 181, 253, 0.8)',
          lineHeight: 1.4,
        }}>
          <span style={{ fontWeight: 600 }}>&#9733; QuoxMind:</span> {data.advisory}
        </div>
      )}

      <div style={ACTIONS_STYLE}>
        <button
          style={acting === 'approve' ? { ...PILL_BTN_SUCCESS, opacity: 0.6 } : PILL_BTN_SUCCESS}
          onClick={handleApprove}
          disabled={!!acting}
          onMouseEnter={(e) => { if (!acting) e.currentTarget.style.background = 'rgba(34, 197, 94, 0.2)'; }}
          onMouseLeave={(e) => { if (!acting) e.currentTarget.style.background = 'rgba(34, 197, 94, 0.1)'; }}
        >
          <span style={{ fontSize: 11 }}>&#10003;</span> {acting === 'approve' ? 'Approving...' : 'Approve & Run'}
        </button>
        <button
          style={PILL_BTN}
          onClick={() => navigate(`/mission-control?tab=objectives&id=${data.objectiveId}`)}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
        >
          <span style={{ fontSize: 11 }}>&#9998;</span> Adjust Plan
        </button>
        <button
          style={acting === 'cancel' ? { ...PILL_BTN_DANGER, opacity: 0.6 } : PILL_BTN_DANGER}
          onClick={handleCancel}
          disabled={!!acting}
          onMouseEnter={(e) => { if (!acting) e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)'; }}
          onMouseLeave={(e) => { if (!acting) e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'; }}
        >
          <span style={{ fontSize: 11 }}>&#10005;</span> {acting === 'cancel' ? 'Cancelling...' : 'Cancel'}
        </button>
      </div>
    </>
  );
}

function ObjectiveProgressCard({ data }) {
  const tasks = data.tasks || [];
  const completed = data.tasksCompleted || data.completedTasks || tasks.filter(t => t.status === 'completed').length;
  const total = data.taskCount || tasks.length || 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Find the currently running task
  const runningTask = tasks.find(t => t.status === 'running');

  // Calculate elapsed time from first started task
  const firstStarted = tasks.map(t => t.started_at).filter(Boolean).sort()[0];
  const elapsedMs = firstStarted ? Date.now() - new Date(firstStarted).getTime() : 0;
  const elapsedStr = elapsedMs >= 3600000
    ? `${Math.floor(elapsedMs / 3600000)}h ${Math.floor((elapsedMs % 3600000) / 60000)}m`
    : elapsedMs >= 60000
    ? `${Math.floor(elapsedMs / 60000)}m ${Math.floor((elapsedMs % 60000) / 1000)}s`
    : elapsedMs > 0 ? `${Math.floor(elapsedMs / 1000)}s` : null;

  return (
    <>
      <div style={HEADER_STYLE}>
        <span style={{ fontSize: 14 }}>&#9654;</span>
        <span>Objective Running</span>
        <StatusBadge status={data.status || 'running'} />
      </div>
      <div style={TITLE_STYLE}>{data.title}</div>
      <div style={BODY_STYLE}>
        {/* Progress bar + stats */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={STAT_FONT}>{completed}/{total} tasks</span>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {elapsedStr && (
              <span style={{ ...STAT_FONT, color: 'rgba(161, 161, 170, 0.6)' }}>{elapsedStr}</span>
            )}
            <span style={{ ...STAT_FONT, color: 'rgba(99, 102, 241, 0.9)' }}>{pct}%</span>
          </div>
        </div>
        <div style={PROGRESS_TRACK}>
          <div style={{
            height: '100%',
            width: `${pct}%`,
            background: 'linear-gradient(90deg, #6366f1, #8b5cf6)',
            borderRadius: 2,
            transition: 'width 0.3s ease',
          }} />
        </div>

        {/* Currently running task — highlighted */}
        {runningTask && (
          <div style={{
            marginTop: 8, padding: '6px 10px', borderRadius: 6,
            background: 'rgba(99, 102, 241, 0.08)',
            border: '1px solid rgba(99, 102, 241, 0.15)',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <div style={{
              width: 6, height: 6, borderRadius: '50%', background: '#6366f1',
              animation: 'eux-pulse 1.5s ease-in-out infinite',
            }} />
            <span style={{ ...STAT_FONT, color: 'rgba(165, 180, 252, 0.9)', fontWeight: 600 }}>
              {(runningTask.agent_id || '').toUpperCase()}
            </span>
            <span style={{ flex: 1, fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.7)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {runningTask.title}
            </span>
          </div>
        )}

        {/* Lifecycle indicator */}
        {(() => {
          const status = data.status || 'running';
          const lifecycleSteps = [
            { label: 'Plan', status: ['decomposed','running','completed','completed_with_errors','failed','paused'].includes(status) ? 'completed' : status === 'decomposing' ? 'active' : 'pending' },
            { label: 'Execute', status: ['completed','completed_with_errors','failed'].includes(status) ? 'completed' : status === 'running' ? 'active' : 'pending' },
            { label: 'Done', status: ['completed','completed_with_errors'].includes(status) ? 'completed' : status === 'failed' ? 'error' : 'pending' },
          ];
          return (
            <div style={{ margin: '8px 0 4px' }}>
              <StepIndicator steps={lifecycleSteps} variant="compact" />
            </div>
          );
        })()}

        {/* Task list */}
        {tasks.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {tasks.slice(0, 6).map((t, i) => (
              <div key={i} style={{
                ...TASK_ROW,
                opacity: t.status === 'running' ? 1 : t.status === 'completed' ? 0.6 : 0.4,
              }}>
                <span style={STATUS_DOT(
                  t.status === 'completed' ? '#22c55e'
                    : t.status === 'running' ? '#6366f1'
                    : t.status === 'failed' ? '#ef4444'
                    : '#94a3b8'
                )} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                <span style={{ ...STAT_FONT, fontSize: '0.6rem', color: 'rgba(255, 255, 255, 0.35)' }}>
                  {t.agent_id ? t.agent_id.toUpperCase() : t.status}
                </span>
              </div>
            ))}
            {tasks.length > 6 && (
              <div style={{ ...STAT_FONT, color: 'rgba(255, 255, 255, 0.3)', paddingTop: 2 }}>+{tasks.length - 6} more</div>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes eux-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </>
  );
}

function ObjectiveCompleteCard({ data, authFetch, navigate, onAction }) {
  const [acting, setActing] = useState(null);

  const handleSaveAsWorkflow = async () => {
    if (!data.objectiveId || !authFetch) return;
    setActing('save');
    try {
      await saveAsTemplate(authFetch, data.objectiveId, data.title || 'Untitled Workflow');
      onAction?.('saved');
    } catch (err) {
      console.error('[RichObjectCard] Save as workflow failed:', err);
      onAction?.('error', err.message);
    } finally {
      setActing(null);
    }
  };

  // STUDY-REV-2 P1.E — Chat→Objective CTA
  const handleConvertToObjective = async () => {
    if (!authFetch) return;
    setActing('objective');
    try {
      const result = await createFromChat(authFetch, {
        title: data.title || 'New objective',
        snippet: data.findings || '',
        chatId: data.objectiveId,
      });
      const newId = result?.id || result?.objectiveId;
      if (newId) {
        navigate(`/mission-control?tab=objectives&id=${newId}`);
      } else {
        onAction?.('saved');
      }
    } catch (err) {
      console.error('[RichObjectCard] Convert to objective failed:', err);
      onAction?.('error', err.message);
    } finally {
      setActing(null);
    }
  };

  const tasks = data.tasks || [];
  const completedTasks = tasks.filter(t => t.status === 'completed');
  const failedTasks = tasks.filter(t => t.status === 'failed');
  const totalCount = data.taskCount || tasks.length;
  const totalDurationMs = tasks.reduce((sum, t) => sum + (t.duration_ms || 0), 0);
  const totalTokens = tasks.reduce((sum, t) => sum + (t.tokens_used || 0), 0);
  const successRate = totalCount > 0 ? Math.round((completedTasks.length / totalCount) * 100) : (data.successRate ?? 100);
  const isFailed = data.status === 'failed' || (failedTasks.length > 0 && completedTasks.length === 0);

  // Format duration
  const durationStr = data.duration || (totalDurationMs >= 60000
    ? `${Math.floor(totalDurationMs / 60000)}m ${Math.floor((totalDurationMs % 60000) / 1000)}s`
    : totalDurationMs > 0 ? `${(totalDurationMs / 1000).toFixed(1)}s` : null);

  // Extract findings from the last completed task
  const lastResult = [...completedTasks].reverse().find(t => t.result);
  let findings = null;
  if (lastResult?.result) {
    const text = typeof lastResult.result === 'string' ? lastResult.result : JSON.stringify(lastResult.result);
    findings = text.split('\n').filter(l => l.trim()).slice(0, 3).join('\n').slice(0, 300);
  }

  // Extract error from last failed task
  const lastFailed = failedTasks.length > 0 ? failedTasks[failedTasks.length - 1] : null;

  return (
    <>
      <div style={HEADER_STYLE}>
        {isFailed ? (
          <>
            <span style={{ fontSize: 14, color: '#ef4444' }}>&#10005;</span>
            <span style={{ color: 'rgba(252, 165, 165, 0.85)' }}>Objective Failed</span>
          </>
        ) : (
          <>
            <span style={{ fontSize: 14 }}>&#10004;</span>
            <span>Objective Complete</span>
          </>
        )}
      </div>
      <div style={TITLE_STYLE}>{data.title}</div>

      {/* Failed: show error prominently */}
      {isFailed && lastFailed && (
        <div style={{
          margin: '0 12px 6px 16px', padding: '8px 10px', borderRadius: 6,
          background: 'rgba(239, 68, 68, 0.08)',
          border: '1px solid rgba(239, 68, 68, 0.15)',
        }}>
          <div style={{ fontSize: '0.72rem', fontWeight: 600, color: 'rgba(252, 165, 165, 0.9)', marginBottom: 2 }}>
            {lastFailed.agent_id ? `${lastFailed.agent_id.toUpperCase()}: ` : ''}{lastFailed.title}
          </div>
          {lastFailed.result && (
            <div style={{
              fontSize: '0.7rem', color: 'rgba(239, 68, 68, 0.8)', lineHeight: 1.4,
              fontFamily: "'SF Mono', monospace", whiteSpace: 'pre-wrap',
              maxHeight: 80, overflow: 'hidden',
            }}>
              {typeof lastFailed.result === 'string' ? lastFailed.result.slice(0, 200) : 'Error during execution'}
            </div>
          )}
        </div>
      )}

      <div style={BODY_STYLE}>
        {/* Stats row */}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {totalCount > 0 && (
            <div>
              <div style={{ ...STAT_FONT, fontSize: '1.1rem', fontWeight: 700, color: isFailed ? 'rgba(239, 68, 68, 0.9)' : 'rgba(34, 197, 94, 0.9)' }}>
                {completedTasks.length}/{totalCount}
              </div>
              <div style={{ fontSize: '0.65rem', color: 'rgba(255, 255, 255, 0.4)' }}>Tasks</div>
            </div>
          )}
          {durationStr && (
            <div>
              <div style={{ ...STAT_FONT, fontSize: '1.1rem', fontWeight: 700, color: 'rgba(255, 255, 255, 0.8)' }}>
                {durationStr}
              </div>
              <div style={{ fontSize: '0.65rem', color: 'rgba(255, 255, 255, 0.4)' }}>Duration</div>
            </div>
          )}
          {totalCount > 1 && (
            <div>
              <div style={{ ...STAT_FONT, fontSize: '1.1rem', fontWeight: 700, color: successRate >= 80 ? 'rgba(34, 197, 94, 0.9)' : successRate >= 50 ? 'rgba(245, 158, 11, 0.9)' : 'rgba(239, 68, 68, 0.9)' }}>
                {successRate}%
              </div>
              <div style={{ fontSize: '0.65rem', color: 'rgba(255, 255, 255, 0.4)' }}>Success</div>
            </div>
          )}
          {totalTokens > 0 && (
            <div>
              <div style={{ ...STAT_FONT, fontSize: '1.1rem', fontWeight: 700, color: 'rgba(255, 255, 255, 0.7)' }}>
                {totalTokens.toLocaleString()}
              </div>
              <div style={{ fontSize: '0.65rem', color: 'rgba(255, 255, 255, 0.4)' }}>Tokens</div>
            </div>
          )}
        </div>

        {/* Key findings — visible, not hidden */}
        {findings && !isFailed && (
          <div style={{
            marginTop: 8, padding: '6px 10px', borderRadius: 6,
            background: 'rgba(34, 197, 94, 0.06)',
            border: '1px solid rgba(34, 197, 94, 0.1)',
            fontSize: '0.72rem', color: 'rgba(255, 255, 255, 0.7)', lineHeight: 1.5,
            whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'hidden',
          }}>
            {findings}
          </div>
        )}
      </div>

      <div style={ACTIONS_STYLE}>
        <button
          style={PILL_BTN_PRIMARY}
          onClick={() => navigate(`/mission-control?tab=objectives&id=${data.objectiveId}`)}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(99, 102, 241, 0.25)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(99, 102, 241, 0.15)'; }}
        >
          <span style={{ fontSize: 11 }}>&#128269;</span> View Full Report
        </button>
        {!isFailed && (
          <>
            {/* STUDY-REV-2 P1.E — Chat→Objective CTA */}
            <button
              style={acting === 'objective' ? { ...PILL_BTN_SUCCESS, opacity: 0.6 } : PILL_BTN_SUCCESS}
              onClick={handleConvertToObjective}
              disabled={!!acting}
              title="Promote this idea to a goal-bound Objective. Plans + executes once."
              onMouseEnter={(e) => { if (!acting) e.currentTarget.style.background = 'rgba(34, 197, 94, 0.18)'; }}
              onMouseLeave={(e) => { if (!acting) e.currentTarget.style.background = 'rgba(34, 197, 94, 0.1)'; }}
            >
              <span style={{ fontSize: 11 }}>&#127919;</span> {acting === 'objective' ? 'Creating...' : 'Convert to Objective'}
            </button>
            <button
              style={acting === 'save' ? { ...PILL_BTN, opacity: 0.6 } : PILL_BTN}
              onClick={handleSaveAsWorkflow}
              disabled={!!acting}
              onMouseEnter={(e) => { if (!acting) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
              onMouseLeave={(e) => { if (!acting) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
            >
              <span style={{ fontSize: 11 }}>&#128190;</span> {acting === 'save' ? 'Saving...' : 'Save as Workflow'}
            </button>
            <button
              style={PILL_BTN}
              onClick={() => navigate('/mission-control?tab=schedules')}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
            >
              <span style={{ fontSize: 11 }}>&#128339;</span> Schedule
            </button>
          </>
        )}
      </div>
    </>
  );
}

function GuardianAlertCard({ data, authFetch, navigate, onAction }) {
  const [acting, setActing] = useState(null);

  const handleResume = async () => {
    // QE2: Resume removed — QuoxFlow manages execution state
    onAction?.('resumed');
  };

  const handleCancel = async () => {
    if (!data.objectiveId || !authFetch) return;
    setActing('cancel');
    try {
      await cancelObjective(authFetch, data.objectiveId);
      onAction?.('cancelled');
    } catch (err) {
      console.error('[RichObjectCard] Cancel failed:', err);
      onAction?.('error', err.message);
    } finally {
      setActing(null);
    }
  };

  return (
    <>
      <div style={HEADER_STYLE}>
        <span style={{ fontSize: 14, color: 'rgba(239, 68, 68, 0.9)' }}>&#9888;</span>
        <span style={{ color: 'rgba(252, 165, 165, 0.85)' }}>Guardian Alert</span>
      </div>
      {data.ruleName && (
        <div style={{ ...TITLE_STYLE, color: 'rgba(252, 165, 165, 0.9)' }}>{data.ruleName}</div>
      )}
      <div style={BODY_STYLE}>
        <div style={{ color: 'rgba(255, 255, 255, 0.7)', lineHeight: 1.5 }}>
          {data.reason || 'An execution constraint was triggered.'}
        </div>
      </div>
      <div style={ACTIONS_STYLE}>
        <button
          style={acting === 'resume' ? { ...PILL_BTN_SUCCESS, opacity: 0.6 } : PILL_BTN_SUCCESS}
          onClick={handleResume}
          disabled={!!acting}
          onMouseEnter={(e) => { if (!acting) e.currentTarget.style.background = 'rgba(34, 197, 94, 0.2)'; }}
          onMouseLeave={(e) => { if (!acting) e.currentTarget.style.background = 'rgba(34, 197, 94, 0.1)'; }}
        >
          <span style={{ fontSize: 11 }}>&#9654;</span> {acting === 'resume' ? 'Resuming...' : 'Resume'}
        </button>
        <button
          style={acting === 'cancel' ? { ...PILL_BTN_DANGER, opacity: 0.6 } : PILL_BTN_DANGER}
          onClick={handleCancel}
          disabled={!!acting}
          onMouseEnter={(e) => { if (!acting) e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)'; }}
          onMouseLeave={(e) => { if (!acting) e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'; }}
        >
          <span style={{ fontSize: 11 }}>&#10005;</span> {acting === 'cancel' ? 'Cancelling...' : 'Cancel'}
        </button>
      </div>
    </>
  );
}

function WorkflowSavedCard({ data, navigate }) {
  return (
    <>
      <div style={HEADER_STYLE}>
        <span style={{ fontSize: 14 }}>&#128190;</span>
        <span>Workflow Saved</span>
      </div>
      <div style={TITLE_STYLE}>{data.title || 'Workflow Template'}</div>
      <div style={BODY_STYLE}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {data.templateId && (
            <span style={STAT_FONT}>ID: {data.templateId.slice(0, 12)}...</span>
          )}
          {data.scheduled && data.cronHuman && (
            <span style={{ ...STAT_FONT, color: 'rgba(20, 184, 166, 0.85)' }}>
              &#128339; {data.cronHuman}
            </span>
          )}
          {!data.scheduled && (
            <span style={{ ...STAT_FONT, color: 'rgba(255, 255, 255, 0.4)' }}>No schedule</span>
          )}
        </div>
      </div>
      <div style={ACTIONS_STYLE}>
        <button
          style={PILL_BTN}
          onClick={() => navigate('/mission-control?tab=schedules')}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
        >
          <span style={{ fontSize: 11 }}>&#128339;</span> View Schedules
        </button>
      </div>
    </>
  );
}

// ── BQ-CA-4: Extraction Result Card ────────────────────────────────

function ExtractionResultCard({ data, navigate }) {
  const [showAll, setShowAll] = useState(false);
  const type = data.extraction_type || 'generic';
  const typeColor = { table: '#06b6d4', links: '#a855f7', metadata: '#f59e0b', schema: '#30ff90' }[type] || '#06b6d4';
  const extData = data.data;
  const rowCount = data.row_count || 0;

  const handleCopy = async (format) => {
    try {
      const text = format === 'csv' && type === 'table' && extData?.tables?.[0]
        ? [extData.tables[0].headers.join(','), ...extData.tables[0].rows.map(r => r.join(','))].join('\n')
        : JSON.stringify(extData, null, 2);
      await navigator.clipboard.writeText(text);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <>
      <div style={{ ...HEADER_STYLE, color: 'rgba(255,255,255,0.6)' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: typeColor }}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="9" y1="3" x2="9" y2="21" />
        </svg>
        <span>Extraction</span>
        <span style={{
          ...STAT_FONT, padding: '2px 8px', borderRadius: 10,
          background: `${typeColor}22`, color: typeColor, fontWeight: 600,
        }}>{type}</span>
      </div>
      {data.url && (
        <div style={{ padding: '2px 12px 4px 16px', fontSize: '0.72rem', color: 'rgba(255,255,255,0.6)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {data.url}
        </div>
      )}
      <div style={BODY_STYLE}>
        {/* Table preview */}
        {type === 'table' && extData?.tables?.[0] && (() => {
          const table = extData.tables[0];
          const visibleRows = showAll ? table.rows : (table.rows || []).slice(0, 5);
          return (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.7rem', fontFamily: "'JetBrains Mono', monospace" }}>
                <thead>
                  <tr>{(table.headers || []).map((h, i) => (
                    <th key={i} style={{ textAlign: 'left', padding: '3px 6px', borderBottom: '1px solid rgba(255,255,255,0.1)', color: '#fff', fontWeight: 600, fontSize: '0.65rem', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {visibleRows.map((row, ri) => (
                    <tr key={ri}>{row.map((cell, ci) => (
                      <td key={ci} style={{ padding: '2px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', color: '#fff', fontSize: '0.65rem', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cell}</td>
                    ))}</tr>
                  ))}
                </tbody>
              </table>
              {(table.rows || []).length > 5 && !showAll && (
                <button onClick={() => setShowAll(true)} style={{ ...PILL_BTN, marginTop: 4, fontSize: '0.65rem' }}>
                  Show all {table.rows.length} rows
                </button>
              )}
            </div>
          );
        })()}

        {/* Links preview */}
        {type === 'links' && Array.isArray(extData) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {extData.slice(0, showAll ? extData.length : 8).map((link, i) => (
              <a key={i} href={link.href} target="_blank" rel="noopener noreferrer" style={{
                fontSize: '0.7rem', color: '#38bdf8', textDecoration: 'none',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{link.text || link.href}</a>
            ))}
            {extData.length > 8 && !showAll && (
              <button onClick={() => setShowAll(true)} style={{ ...PILL_BTN, marginTop: 2, fontSize: '0.65rem' }}>
                Show all {extData.length} links
              </button>
            )}
          </div>
        )}

        {/* Metadata preview */}
        {type === 'metadata' && extData && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {Object.entries(extData).filter(([, v]) => v && typeof v !== 'object').slice(0, 6).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', gap: 6, fontSize: '0.7rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 70, fontWeight: 600 }}>{k}</span>
                <span style={{ color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(v)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Fallback */}
        {!['table', 'links', 'metadata'].includes(type) && extData && (
          <pre style={{ fontSize: '0.65rem', color: '#fff', background: 'rgba(0,0,0,0.2)', padding: 6, borderRadius: 4, overflow: 'auto', maxHeight: 120, margin: 0 }}>
            {JSON.stringify(extData, null, 2)}
          </pre>
        )}

        {/* Row count */}
        <div style={{ ...STAT_FONT, color: 'rgba(255,255,255,0.6)', marginTop: 6, fontSize: '0.65rem' }}>
          {rowCount} {type === 'links' ? 'link' : 'row'}{rowCount !== 1 ? 's' : ''} extracted
        </div>
      </div>
      <div style={ACTIONS_STYLE}>
        <button style={{ ...PILL_BTN, background: 'rgba(48,255,144,0.1)', borderColor: 'rgba(48,255,144,0.2)', color: '#30ff90' }}
          onClick={() => handleCopy('csv')}>Copy CSV</button>
        <button style={{ ...PILL_BTN, background: 'rgba(56,189,248,0.1)', borderColor: 'rgba(56,189,248,0.2)', color: '#38bdf8' }}
          onClick={() => handleCopy('json')}>Copy JSON</button>
        <button style={{ ...PILL_BTN, background: 'rgba(6,182,212,0.1)', borderColor: 'rgba(6,182,212,0.2)', color: '#06b6d4' }}
          onClick={() => navigate('/browser-q')}>View Results</button>
      </div>
    </>
  );
}

function BrowserObjectiveCard({ data, navigate }) {
  const [expanded, setExpanded] = useState(false);
  const completed = data.steps_completed || 0;
  const total = data.steps_total || 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const isDone = data.status === 'completed' || data.status === 'failed';

  // Format elapsed time
  const elapsed = data.elapsed_ms || 0;
  const elapsedStr = elapsed >= 60000
    ? `${Math.floor(elapsed / 60000)}m ${Math.round((elapsed % 60000) / 1000)}s`
    : `${(elapsed / 1000).toFixed(1)}s`;

  const orgId = data.org_id || '';
  const screenshots = data.screenshots || [];
  const firstThumb = screenshots.length > 0 ? screenshots[screenshots.length - 1] : null;

  // BQ-specific status colors (cyan theme)
  const statusColor = data.status === 'completed' ? '#30ff90'
    : data.status === 'failed' ? '#ef4444'
    : data.status === 'running' ? '#06b6d4'
    : data.status === 'paused' ? '#f59e0b'
    : 'rgba(255,255,255,0.6)';

  return (
    <>
      <div style={{ ...HEADER_STYLE, color: 'rgba(255,255,255,0.6)' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: '#06b6d4' }}>
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
        <span>Browser-Q</span>
        <span style={{
          ...STAT_FONT, display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 10,
          background: `${statusColor}22`, color: statusColor, fontWeight: 600,
        }}>
          <span style={STATUS_DOT(statusColor)} />
          {data.status || 'running'}
        </span>
      </div>
      <div style={TITLE_STYLE}>{data.intent || 'Browser Objective'}</div>
      <div style={BODY_STYLE}>
        {/* URL */}
        {data.url && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
            fontSize: '0.72rem', color: 'rgba(255,255,255,0.6)', overflow: 'hidden',
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
            </svg>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.url}</span>
          </div>
        )}

        {/* Progress + elapsed row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ ...STAT_FONT, color: '#fff' }}>{completed}/{total} steps</span>
          <span style={{ ...STAT_FONT, color: statusColor }}>{elapsedStr}</span>
        </div>
        <div style={PROGRESS_TRACK}>
          <div style={{
            height: '100%',
            width: `${pct}%`,
            background: isDone
              ? (data.status === 'completed' ? 'linear-gradient(90deg, #30ff90, #10b981)' : 'linear-gradient(90deg, #ef4444, #dc2626)')
              : 'linear-gradient(90deg, #06b6d4, #38bdf8)',
            borderRadius: 2,
            transition: 'width 0.3s ease',
          }} />
        </div>

        {/* Screenshot — clickable to expand */}
        {firstThumb && orgId && (
          <div
            onClick={() => setExpanded(!expanded)}
            style={{
              marginTop: 8, borderRadius: 6, overflow: 'hidden', cursor: 'pointer',
              border: '1px solid rgba(255,255,255,0.08)',
              maxHeight: expanded ? 300 : 120,
              transition: 'max-height 0.3s ease',
            }}
          >
            <img
              src={`/screencap/api/browser-q/gallery/${firstThumb}/image?org_id=${orgId}&type=${expanded ? 'full' : 'thumb'}`}
              alt="Browser screenshot"
              style={{ width: '100%', height: 'auto', display: 'block', objectFit: 'contain' }}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          </div>
        )}

        {/* Screenshot count */}
        {screenshots.length > 1 && (
          <div style={{ ...STAT_FONT, color: 'rgba(255,255,255,0.6)', marginTop: 4, fontSize: '0.65rem' }}>
            {screenshots.length} screenshot{screenshots.length !== 1 ? 's' : ''} captured
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={ACTIONS_STYLE}>
        {data.objective_id && (
          <button
            style={{ ...PILL_BTN, background: 'rgba(6,182,212,0.12)', borderColor: 'rgba(6,182,212,0.25)', color: '#06b6d4' }}
            onClick={() => navigate(`/browser-q/run/${data.objective_id}`)}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,0.2)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,0.12)'; }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" strokeWidth="2" style={{ stroke: 'currentColor' }}>
              <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            View Run
          </button>
        )}
        {isDone && data.objective_id && (
          <button
            style={PILL_BTN_SUCCESS}
            onClick={() => navigate(`/browser-q/run/${data.objective_id}`)}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(34,197,94,0.2)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(34,197,94,0.1)'; }}
          >
            {'\u21BB'} Rerun
          </button>
        )}
      </div>
    </>
  );
}

// ── NOC Check Result Card (NQ-6) ────────────────────────────────────

function NocCheckResultCard({ data, authFetch, navigate }) {
  const [saving, setSaving] = useState(false)
  const toolName = data.tool_name || data.toolName || 'NOC Check'
  const status = data.success !== false ? 'pass' : 'fail'
  const statusColor = status === 'pass' ? '#30ff90' : '#ff5555'

  const handleSaveCheck = async () => {
    if (!authFetch) return
    setSaving(true)
    try {
      await saveAsTemplate(authFetch, data.objectiveId || `noc-${Date.now()}`, `NOC: ${toolName}`, [])
    } catch { /* best effort */ }
    setSaving(false)
  }

  return (
    <div>
      <div style={HEADER_STYLE}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={statusColor} strokeWidth="2">
          <path d={status === 'pass' ? 'M22 11.08V12a10 10 0 1 1-5.93-9.14' : 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z'} />
          {status === 'pass' && <polyline points="22 4 12 14.01 9 11.01" />}
          {status === 'fail' && <><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></>}
        </svg>
        <span style={{ fontWeight: 600, color: '#fff' }}>{toolName}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: statusColor, fontWeight: 600 }}>
          {status === 'pass' ? 'PASS' : 'FAIL'}
        </span>
      </div>
      {data.summary && <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', marginTop: 8 }}>{data.summary}</div>}
      {data.duration_ms && (
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 4, fontFamily: STAT_FONT }}>
          {data.duration_ms}ms
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          onClick={handleSaveCheck}
          disabled={saving}
          style={{
            ...PILL_BTN_PRIMARY,
            flex: 1,
            opacity: saving ? 0.5 : 1,
          }}
        >
          {saving ? 'Saving...' : 'Save as Check'}
        </button>
      </div>
    </div>
  )
}

// ── Wazuh cards (ARGUS rich content) ─────────────────────────────────

function severityFromRuleLevel(level) {
  // Maps Wazuh rule.level (1-15) to .qx-severity --level-N (5 = critical, 1 = info)
  const n = Number(level) || 0;
  if (n >= 12) return { tier: 5, label: 'Critical', color: '#ff5555' };
  if (n >= 9)  return { tier: 4, label: 'High',     color: '#ff8a4d' };
  if (n >= 6)  return { tier: 3, label: 'Medium',   color: '#ffc94d' };
  if (n >= 3)  return { tier: 2, label: 'Low',      color: '#ffea4d' };
  return { tier: 1, label: 'Info', color: '#9ee5ff' };
}

function WazuhAlertCard({ data, navigate }) {
  const ruleId = data.rule_id || data.ruleId || data.rule?.id || '?';
  const ruleLevel = data.rule_level ?? data.ruleLevel ?? data.rule?.level ?? 0;
  const description = data.description || data.rule?.description || 'Wazuh alert';
  const agentName = data.agent_name || data.agentName || data.agent?.name;
  const agentId = data.agent_id || data.agentId || data.agent?.id;
  const timestamp = data.timestamp || data.ts;
  const mitreTactics = data.mitre?.tactic || data.mitreTactic;
  const mitreTechs = data.mitre?.technique || data.mitreTechnique;
  const sev = severityFromRuleLevel(ruleLevel);

  return (
    <div>
      <div style={HEADER_STYLE}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff6b35" strokeWidth="2">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <span>WAZUH ALERT</span>
        <span style={{ marginLeft: 'auto', color: sev.color, fontSize: 11, fontWeight: 700 }}>
          L{ruleLevel} · {sev.label.toUpperCase()}
        </span>
      </div>
      <div style={TITLE_STYLE}>{description}</div>
      <div style={BODY_STYLE}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          <span style={{ ...STAT_LABEL, fontFamily: STAT_FONT }}>Rule {ruleId}</span>
          {agentName && <span style={STAT_LABEL}>{agentName}{agentId ? ` (${agentId})` : ''}</span>}
          {timestamp && <span style={STAT_LABEL}>{new Date(timestamp).toLocaleString()}</span>}
        </div>
        {(mitreTactics || mitreTechs) && (
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginBottom: 8 }}>
            <strong style={{ color: '#fff' }}>MITRE: </strong>
            {[].concat(mitreTactics || []).join(', ')}
            {mitreTactics && mitreTechs ? ' / ' : ''}
            {[].concat(mitreTechs || []).join(', ')}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            onClick={() => navigate('/wazuh')}
            style={{ ...PILL_BTN_PRIMARY, flex: 1 }}
          >
            Open SIEM
          </button>
          {agentId && (
            <button
              onClick={() => navigate(`/wazuh?tab=alerts&agentId=${encodeURIComponent(agentId)}`)}
              style={PILL_BTN_GHOST}
            >
              View agent alerts
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function WazuhCVECard({ data, navigate }) {
  const cve = data.cve || data.cve_id || data.cveId || 'CVE-?';
  const cvss = data.cvss || data.cvssScore || data.score;
  const severity = (data.severity || '').toLowerCase();
  const pkg = data.package || data.packageName || data.pkg;
  const installed = data.installed_version || data.version;
  const fixed = data.fixed_version || data.fix;
  const agentName = data.agent_name || data.agentName || data.agent?.name;
  const agentId = data.agent_id || data.agentId || data.agent?.id;
  const sevColor = severity === 'critical' ? '#ff5555'
                 : severity === 'high'     ? '#ff8a4d'
                 : severity === 'medium'   ? '#ffc94d'
                 :                           '#9ee5ff';
  const sevLabel = severity ? severity.toUpperCase() : 'UNKNOWN';

  return (
    <div>
      <div style={HEADER_STYLE}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00a9e5" strokeWidth="2">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          <path d="M9 12l2 2 4-4" strokeLinecap="round"/>
        </svg>
        <span>VULNERABILITY</span>
        <span style={{ marginLeft: 'auto', color: sevColor, fontSize: 11, fontWeight: 700 }}>
          {cvss ? `CVSS ${cvss} · ` : ''}{sevLabel}
        </span>
      </div>
      <div style={TITLE_STYLE} title={cve}>{cve}</div>
      <div style={BODY_STYLE}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {pkg && <span style={{ ...STAT_LABEL, fontFamily: STAT_FONT }}>{pkg}</span>}
          {installed && <span style={STAT_LABEL}>installed {installed}</span>}
          {fixed && <span style={{ ...STAT_LABEL, color: '#22c55e' }}>fix {fixed}</span>}
          {agentName && <span style={STAT_LABEL}>{agentName}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            onClick={() => navigate(`/wazuh?tab=vulnerabilities${agentId ? `&agentId=${encodeURIComponent(agentId)}` : ''}`)}
            style={{ ...PILL_BTN_PRIMARY, flex: 1 }}
          >
            View on agent
          </button>
          <button
            onClick={() => window.open(`https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cve)}`, '_blank', 'noopener')}
            style={PILL_BTN_GHOST}
          >
            NVD ↗
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────

export default function RichObjectCard({ data: initialData, authFetch }) {
  const navigate = (path) => { window.location.href = path; };
  const [actionResult, setActionResult] = useState(null);
  const [data, setData] = useState(initialData);
  const pollRef = useRef(null);

  // Auto-poll for status updates on non-terminal objectives
  useEffect(() => {
    if (!data?.objectiveId || !authFetch) return;
    const terminal = ['completed', 'completed_with_errors', 'failed', 'cancelled'];
    if (terminal.includes(data.status)) return;

    const poll = async () => {
      try {
        const res = await authFetch(`/tasks/api/objectives/${data.objectiveId}`);
        const obj = await readTaskServiceJson(res, 'Failed to refresh objective status');
        const tasks = (obj.tasks || []).map(t => ({
          title: t.title, agent_id: t.agent_id, status: t.status,
          result: t.result, duration_ms: t.duration_ms, tokens_used: t.tokens_used,
          started_at: t.started_at, completed_at: t.completed_at,
        }));
        const done = tasks.filter(t => t.status === 'completed').length;
        const failed = tasks.filter(t => t.status === 'failed').length;
        const newType = obj.status === 'running' ? 'objective_progress'
          : terminal.includes(obj.status) ? 'objective_complete'
          : obj.status === 'decomposed' ? 'objective_plan'
          : data.type;
        setData(prev => ({
          ...prev,
          type: newType,
          status: obj.status,
          taskCount: tasks.length,
          tasksCompleted: done,
          tasksFailed: failed,
          tasks,
        }));
        if (terminal.includes(obj.status)) {
          clearInterval(pollRef.current);
        }
      } catch { /* poll failure — try again next cycle */ }
    };

    poll(); // immediate first check
    pollRef.current = setInterval(poll, 5000); // then every 5s
    return () => clearInterval(pollRef.current);
  }, [data?.objectiveId, authFetch]);

  if (!data || !data.type) return null;

  const accentColor = ACCENT_COLORS[data.type] || '#94a3b8';

  const handleAction = (action, detail) => {
    setActionResult({ action, detail, ts: Date.now() });
    // Auto-clear after 3s
    setTimeout(() => setActionResult(null), 3000);
  };

  const renderCard = () => {
    switch (data.type) {
      case 'objective_created':
        return <ObjectiveCreatedCard data={data} navigate={navigate} />;
      case 'objective_plan':
        return <ObjectivePlanCard data={data} authFetch={authFetch} navigate={navigate} onAction={handleAction} />;
      case 'objective_progress':
        return <ObjectiveProgressCard data={data} />;
      case 'objective_complete':
        return <ObjectiveCompleteCard data={data} authFetch={authFetch} navigate={navigate} onAction={handleAction} />;
      case 'guardian_alert':
        return <GuardianAlertCard data={data} authFetch={authFetch} navigate={navigate} onAction={handleAction} />;
      case 'workflow_saved':
        return <WorkflowSavedCard data={data} navigate={navigate} />;
      case 'browser_extraction':
        return <ExtractionResultCard data={data} navigate={navigate} />;
      case 'browser_objective':
      case 'browser_automation':
        return <BrowserObjectiveCard data={data} navigate={navigate} />;
      case 'noc_check_result':
        return <NocCheckResultCard data={data} authFetch={authFetch} navigate={navigate} />;
      case 'wazuh_alert':
        return <WazuhAlertCard data={data} navigate={navigate} />;
      case 'wazuh_cve':
        return <WazuhCVECard data={data} navigate={navigate} />;
      default:
        return null;
    }
  };

  const cardContent = renderCard();
  if (!cardContent) return null;

  return (
    <div style={CARD_BASE}>
      <div style={{ ...ACCENT_BAR, background: accentColor }} />
      {cardContent}
      {/* Action feedback toast */}
      {actionResult && (
        <div style={{
          position: 'absolute',
          bottom: 4,
          right: 8,
          padding: '3px 8px',
          borderRadius: 6,
          background: actionResult.action === 'error'
            ? 'rgba(239, 68, 68, 0.15)'
            : 'rgba(34, 197, 94, 0.15)',
          color: actionResult.action === 'error'
            ? 'rgba(252, 165, 165, 0.9)'
            : 'rgba(134, 239, 172, 0.9)',
          fontSize: '0.65rem',
          fontWeight: 500,
          pointerEvents: 'none',
        }}>
          {actionResult.action === 'error'
            ? `Error: ${actionResult.detail || 'Failed'}`
            : actionResult.action === 'approved' ? 'Plan approved'
            : actionResult.action === 'cancelled' ? 'Cancelled'
            : actionResult.action === 'saved' ? 'Saved as workflow'
            : actionResult.action === 'resumed' ? 'Resumed'
            : actionResult.action}
        </div>
      )}
    </div>
  );
}
