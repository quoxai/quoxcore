/**
 * ExecutionAnalysis — EUX-1: Per-node execution timeline with real data
 *
 * Replaces the placeholder Execution Analysis <details> toggle with a
 * horizontal bar chart showing each task's agent, duration, tokens, tools,
 * and expandable result. Fetches QuoxFlow envelopes when an execution ID
 * is available for richer tool/decision data.
 *
 * Props:
 *   tasks              — objective.tasks array
 *   quoxflowExecutionId — objective.quoxflow_execution_id (optional)
 *   maxTokenBudget     — objective.max_tokens for budget reference (optional)
 */

import { useState, useEffect, useMemo } from 'react'
import Badge from '../ui/Badge'
import MarkdownContent from '../ui/MarkdownContent'
import { getObjectiveExecution } from '../../services/objectiveQuoxFlowBridge'
// AEE-FULL Gap 3: dual-read both legacy and canonical LLM completion intents.
// See src/lib/aee/llmIntents.js for the WARD-immutability rationale.
import { LLM_COMPLETED_INTENTS } from '../../lib/aee/llmIntents.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(ms) {
  if (!ms || ms <= 0) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  return `${min}m ${sec}s`
}

function parseToolsUsed(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) return parsed } catch { /* ignore */ }
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

const STATUS_COLORS = {
  completed: '#10b981',
  failed: '#ef4444',
  skipped: '#71717a',
  cancelled: '#71717a',
  running: '#6366f1',
  pending: '#52525b',
}

const STATUS_BG = {
  completed: 'rgba(16, 185, 129, 0.08)',
  failed: 'rgba(239, 68, 68, 0.08)',
  skipped: 'rgba(113, 113, 122, 0.06)',
  cancelled: 'rgba(113, 113, 122, 0.06)',
}

// ─── TaskExecutionRow ─────────────────────────────────────────────────────────

function TaskExecutionRow({ task, maxDurationMs, envelopeTools, index }) {
  const [expanded, setExpanded] = useState(false)

  const color = STATUS_COLORS[task.status] || STATUS_COLORS.pending
  const bg = STATUS_BG[task.status] || 'rgba(99, 102, 241, 0.04)'
  const durationMs = task.duration_ms || 0
  const barWidth = maxDurationMs > 0 ? Math.max(2, (durationMs / maxDurationMs) * 100) : 0
  const tools = envelopeTools || parseToolsUsed(task.tools_used)
  const hasResult = task.result && task.status !== 'skipped'

  return (
    <div
      role="listitem"
      style={{
        background: bg,
        borderRadius: 8,
        border: `1px solid ${color}15`,
        overflow: 'hidden',
        transition: 'background 0.15s',
        animation: `eux-fade-in 0.3s ease-out ${index * 0.04}s both`,
      }}
    >
      {/* Main row — clickable to expand */}
      <div
        role={hasResult ? 'button' : undefined}
        tabIndex={hasResult ? 0 : undefined}
        onClick={() => hasResult && setExpanded(e => !e)}
        onKeyDown={hasResult ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(x => !x) } } : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          width: '100%', padding: '8px 12px',
          background: 'none', border: 'none', cursor: hasResult ? 'pointer' : 'default',
          textAlign: 'left', color: 'inherit', font: 'inherit',
        }}
        aria-expanded={hasResult ? expanded : undefined}
        aria-label={hasResult ? `View result: ${task.title}` : undefined}
      >
        {/* Status dot */}
        <span style={{
          width: 7, height: 7, borderRadius: task.status === 'failed' ? 1 : '50%',
          background: color, flexShrink: 0,
          transform: task.status === 'failed' ? 'rotate(45deg)' : 'none',
        }} />

        {/* Agent badge */}
        <Badge color={task.status === 'failed' ? 'red' : task.status === 'completed' ? 'green' : 'default'} pill>
          {(task.agent_id || 'system').toUpperCase()}
        </Badge>

        {/* Task title */}
        <span style={{
          flex: '1 1 0', minWidth: 0, fontSize: 12, fontWeight: 500,
          color: 'rgba(255,255,255,0.85)', whiteSpace: 'nowrap',
          overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {task.title}
        </span>

        {/* Tools badges */}
        {tools.length > 0 && (
          <span style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
            {tools.slice(0, 3).map((t, i) => (
              <span key={i} style={{
                fontSize: 9, padding: '1px 5px', borderRadius: 4,
                background: 'rgba(99, 102, 241, 0.12)', color: 'rgba(165, 180, 252, 0.85)',
                whiteSpace: 'nowrap',
              }}>
                {t}
              </span>
            ))}
            {tools.length > 3 && (
              <span style={{ fontSize: 9, color: 'rgba(161,161,170,0.5)' }}>+{tools.length - 3}</span>
            )}
          </span>
        )}

        {/* Tokens */}
        {task.tokens_used > 0 && (
          <span style={{
            fontSize: 10, color: 'rgba(161,161,170,0.6)', fontFamily: 'var(--m-font-mono, monospace)',
            fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 50, textAlign: 'right',
          }}>
            {task.tokens_used.toLocaleString()} tok
          </span>
        )}

        {/* Duration */}
        <span style={{
          fontSize: 10, fontWeight: 600, color: color,
          fontFamily: 'var(--m-font-mono, monospace)',
          fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 42, textAlign: 'right',
        }}>
          {formatDuration(durationMs)}
        </span>

        {/* Expand chevron */}
        {hasResult && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(161,161,170,0.4)"
            strokeWidth="2" strokeLinecap="round" style={{
              flexShrink: 0, transition: 'transform 0.2s',
              transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </div>

      {/* Duration bar — sits below the row */}
      <div style={{ padding: '0 12px 6px 29px' }}>
        <div style={{
          height: 3, borderRadius: 2, overflow: 'hidden',
          background: 'rgba(255,255,255,0.04)',
        }}>
          <div style={{
            width: `${barWidth}%`, height: '100%', borderRadius: 2,
            background: `linear-gradient(90deg, ${color}80, ${color}40)`,
            transition: 'width 0.6s ease-out',
          }} />
        </div>
      </div>

      {/* Expanded result */}
      {expanded && hasResult && (
        <div style={{
          padding: '0 12px 10px 29px', fontSize: 12,
          borderTop: '1px solid rgba(255,255,255,0.04)',
        }}>
          {task.status === 'failed' ? (
            <div style={{
              marginTop: 8, padding: '8px 10px', borderRadius: 6,
              background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)',
              color: 'rgba(239,68,68,0.9)', fontSize: 11, lineHeight: 1.5,
              fontFamily: 'var(--m-font-mono, monospace)', whiteSpace: 'pre-wrap',
              maxHeight: 200, overflowY: 'auto',
            }}>
              {task.result}
            </div>
          ) : (
            <div style={{ marginTop: 8, maxHeight: 300, overflowY: 'auto' }}>
              <MarkdownContent compact>{task.result}</MarkdownContent>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── ExecutionAnalysis ────────────────────────────────────────────────────────

export default function ExecutionAnalysis({ tasks, quoxflowExecutionId, maxTokenBudget }) {
  const [envelopeData, setEnvelopeData] = useState(null)

  // Fetch QuoxFlow envelopes if execution ID is available
  useEffect(() => {
    if (!quoxflowExecutionId) return
    let cancelled = false
    getObjectiveExecution(quoxflowExecutionId).then(data => {
      if (!cancelled && data) setEnvelopeData(data)
    })
    return () => { cancelled = true }
  }, [quoxflowExecutionId])

  // Extract tools from envelopes keyed by agent/task correlation
  const envelopeToolMap = useMemo(() => {
    if (!envelopeData?.envelopes) return {}
    const map = {}
    for (const env of envelopeData.envelopes) {
      if (LLM_COMPLETED_INTENTS.includes(env.intent) || env.intent === 'quox.agent.tool.call') {
        const key = env.payload?.task_id || env.payload?.node_id || env.from
        if (!map[key]) map[key] = []
        const toolName = env.payload?.tool || env.payload?.tool_name
        if (toolName && !map[key].includes(toolName)) map[key].push(toolName)
      }
    }
    return map
  }, [envelopeData])

  const finishedTasks = (tasks || []).filter(t => ['completed', 'failed', 'skipped', 'cancelled'].includes(t.status))
  const maxDurationMs = Math.max(...finishedTasks.map(t => t.duration_ms || 0), 1)
  const totalDurationMs = finishedTasks.reduce((sum, t) => sum + (t.duration_ms || 0), 0)
  const totalTokens = finishedTasks.reduce((sum, t) => sum + (t.tokens_used || 0), 0)
  const completedCount = finishedTasks.filter(t => t.status === 'completed').length
  const failedCount = finishedTasks.filter(t => t.status === 'failed').length
  const agentSet = new Set(finishedTasks.map(t => t.agent_id).filter(Boolean))

  if (finishedTasks.length === 0) return null

  return (
    <div style={{ marginTop: 16 }}>
      {/* Header with summary stats */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 10,
      }}>
        <h3 className="obj-section-title" style={{ margin: 0 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ verticalAlign: -2, marginRight: 6, opacity: 0.6 }}>
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
          Execution Analysis
        </h3>
        <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'rgba(161,161,170,0.6)' }}>
          <span>{agentSet.size} agent{agentSet.size !== 1 ? 's' : ''}</span>
          <span style={{ fontFamily: 'var(--m-font-mono, monospace)', fontVariantNumeric: 'tabular-nums' }}>
            {formatDuration(totalDurationMs)}
          </span>
          {totalTokens > 0 && (
            <span style={{ fontFamily: 'var(--m-font-mono, monospace)', fontVariantNumeric: 'tabular-nums' }}>
              {totalTokens.toLocaleString()} tokens
              {maxTokenBudget > 0 && (
                <span style={{ color: totalTokens > maxTokenBudget ? '#ef4444' : 'inherit' }}>
                  {' '}/ {maxTokenBudget.toLocaleString()}
                </span>
              )}
            </span>
          )}
          {failedCount > 0 && (
            <span style={{ color: '#ef4444' }}>
              {failedCount} failed
            </span>
          )}
        </div>
      </div>

      {/* Task execution rows */}
      <div role="list" aria-label="Execution analysis" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {finishedTasks.map((task, idx) => (
          <TaskExecutionRow
            key={task.id}
            task={task}
            maxDurationMs={maxDurationMs}
            envelopeTools={envelopeToolMap[task.id] || envelopeToolMap[task.agent_id]}
            index={idx}
          />
        ))}
      </div>

      {/* Thinking decisions from QuoxFlow (if available) */}
      {envelopeData?.thinkingDecisions?.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{
            cursor: 'pointer', fontSize: 11, fontWeight: 600,
            color: 'rgba(161,161,170,0.5)', marginBottom: 6,
          }}>
            Agent Thinking Decisions ({envelopeData.thinkingDecisions.length})
          </summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {envelopeData.thinkingDecisions.map((decision, i) => (
              <div key={i} style={{
                padding: '6px 10px', borderRadius: 6,
                background: 'rgba(139, 92, 246, 0.06)',
                border: '1px solid rgba(139, 92, 246, 0.1)',
                fontSize: 11, lineHeight: 1.5, color: 'rgba(255,255,255,0.7)',
              }}>
                {decision.reasoning || decision.decision || JSON.stringify(decision)}
                {decision.confidence != null && (
                  <span style={{
                    marginLeft: 8, fontSize: 10, color: 'rgba(139, 92, 246, 0.7)',
                    fontFamily: 'var(--m-font-mono, monospace)',
                  }}>
                    {Math.round(decision.confidence * 100)}% conf
                  </span>
                )}
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Fade-in animation */}
      <style>{`
        @keyframes eux-fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
