/**
 * CorrelationTree - Tree view of run hierarchy
 *
 * Shows expandable nodes with quick stats per run.
 * Part of AOCL Compliance Suite (Enterprise)
 */

import { useState, useMemo } from 'react'

export default function CorrelationTree({
  correlation,
  onSelectRun,
  selectedRun
}) {
  const [expandedNodes, setExpandedNodes] = useState(new Set())

  // Build tree structure from runs
  const tree = useMemo(() => {
    if (!correlation?.runs) return []

    // Find root runs (no parent)
    const rootRuns = correlation.runs.filter(r => r.isRoot || !r.parentRunId)

    function buildNode(run, depth = 0) {
      const children = correlation.runs.filter(r => r.parentRunId === run.runId)

      return {
        ...run,
        depth,
        children: children.map(c => buildNode(c, depth + 1)),
        hasChildren: children.length > 0
      }
    }

    return rootRuns.map(r => buildNode(r, 0))
  }, [correlation])

  const toggleNode = (runId) => {
    setExpandedNodes(prev => {
      const next = new Set(prev)
      if (next.has(runId)) {
        next.delete(runId)
      } else {
        next.add(runId)
      }
      return next
    })
  }

  const formatDuration = (ms) => {
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    return `${(ms / 60000).toFixed(1)}m`
  }

  const formatTime = (ts) => {
    return new Date(ts).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  const getStatusIcon = (status) => {
    switch (status) {
      case 'complete':
      case 'success':
        return '[OK]'
      case 'error':
      case 'failed':
        return '[!]'
      case 'running':
      case 'in_progress':
        return '[~]'
      default:
        return '[-]'
    }
  }

  const getStatusClass = (status) => {
    switch (status) {
      case 'complete':
      case 'success':
        return 'status-complete'
      case 'error':
      case 'failed':
        return 'status-error'
      case 'running':
      case 'in_progress':
        return 'status-running'
      default:
        return 'status-unknown'
    }
  }

  function renderNode(node, index = 0) {
    const isExpanded = expandedNodes.has(node.runId)
    const isSelected = selectedRun === node.runId

    return (
      <div key={node.runId} className="tree-node-wrapper">
        <div
          className={`tree-node ${isSelected ? 'selected' : ''} ${getStatusClass(node.status)}`}
          style={{ paddingLeft: `${node.depth * 24 + 12}px` }}
          onClick={() => onSelectRun?.(node.runId)}
        >
          {/* Expand/collapse toggle */}
          {node.hasChildren ? (
            <button
              className="tree-toggle"
              onClick={(e) => {
                e.stopPropagation()
                toggleNode(node.runId)
              }}
            >
              {isExpanded ? 'v' : '>'}
            </button>
          ) : (
            <span className="tree-toggle-spacer" />
          )}

          {/* Connection lines */}
          {node.depth > 0 && (
            <div className="tree-connector">
              <span className="connector-line" />
            </div>
          )}

          {/* Node content */}
          <div className="tree-node-content">
            <span className={`tree-status ${getStatusClass(node.status)}`}>
              {getStatusIcon(node.status)}
            </span>
            <span className="tree-agent">{node.agent}</span>
            <span className="tree-duration">{formatDuration(node.duration)}</span>
            <span className="tree-time">{formatTime(node.startTime)}</span>
            {node.messageCount > 0 && (
              <span className="tree-messages">{node.messageCount} msgs</span>
            )}
          </div>

          {/* Run ID (abbreviated) */}
          <span className="tree-run-id" title={node.runId}>
            {node.runId.slice(-8)}
          </span>
        </div>

        {/* Children */}
        {isExpanded && node.hasChildren && (
          <div className="tree-children">
            {node.children.map((child, i) => renderNode(child, i))}
          </div>
        )}
      </div>
    )
  }

  if (!correlation || tree.length === 0) {
    return (
      <div className="correlation-tree-empty">
        <p>No run hierarchy available</p>
      </div>
    )
  }

  return (
    <div className="correlation-tree">
      <div className="tree-header">
        <span className="tree-col-agent">Agent</span>
        <span className="tree-col-duration">Duration</span>
        <span className="tree-col-time">Started</span>
        <span className="tree-col-messages">Messages</span>
        <span className="tree-col-id">Run ID</span>
      </div>

      <div className="tree-body">
        {tree.map((node, i) => renderNode(node, i))}
      </div>

      {/* Legend */}
      <div className="tree-legend">
        <span className="legend-item">
          <span className="status-dot status-complete" />
          Complete
        </span>
        <span className="legend-item">
          <span className="status-dot status-running" />
          Running
        </span>
        <span className="legend-item">
          <span className="status-dot status-error" />
          Error
        </span>
      </div>
    </div>
  )
}
