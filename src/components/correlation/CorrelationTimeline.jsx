/**
 * CorrelationTimeline - Horizontal swimlane view for multi-agent traces
 *
 * Shows one lane per agent with handoff arrows between lanes.
 * Part of AOCL Compliance Suite (Enterprise)
 */

import { useState, useEffect, useMemo } from 'react'
import {
  findCorrelatedTraces,
  aggregateCorrelationStats
} from '../../services/correlation'
import CorrelationTree from './CorrelationTree'
import AgentHandoffDetail from './AgentHandoffDetail'
import './correlation.css'

export default function CorrelationTimeline({ runId, onClose }) {
  const [correlation, setCorrelation] = useState(null)
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [activeTab, setActiveTab] = useState('timeline')
  const [selectedHandoff, setSelectedHandoff] = useState(null)
  const [hoveredRun, setHoveredRun] = useState(null)

  useEffect(() => {
    loadCorrelation()
  }, [runId])

  async function loadCorrelation() {
    setLoading(true)
    setError(null)

    try {
      const corr = await findCorrelatedTraces(runId)
      if (!corr) {
        setError('No correlation data found')
        return
      }
      setCorrelation(corr)

      const s = await aggregateCorrelationStats(runId)
      setStats(s)
    } catch (err) {
      console.error('[CorrelationTimeline] Failed to load:', err)
      setError('Failed to load correlation data')
    } finally {
      setLoading(false)
    }
  }

  // Calculate timeline dimensions
  const timeline = useMemo(() => {
    if (!correlation) return null

    const startTime = new Date(correlation.startTime).getTime()
    const endTime = new Date(correlation.endTime).getTime()
    const totalDuration = endTime - startTime

    // Group runs by agent
    const agentLanes = {}
    for (const run of correlation.runs) {
      if (!agentLanes[run.agent]) {
        agentLanes[run.agent] = []
      }
      agentLanes[run.agent].push({
        ...run,
        startOffset: (new Date(run.startTime).getTime() - startTime) / totalDuration * 100,
        width: run.duration / totalDuration * 100
      })
    }

    return {
      startTime,
      endTime,
      totalDuration,
      agentLanes,
      agents: Object.keys(agentLanes)
    }
  }, [correlation])

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

  if (loading) {
    return (
      <div className="correlation-timeline">
        <div className="correlation-loading">Loading correlation data...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="correlation-timeline">
        <div className="correlation-header">
          <h3>Multi-Agent Correlation</h3>
          <button className="close-btn" onClick={onClose}>Close</button>
        </div>
        <div className="correlation-error">{error}</div>
      </div>
    )
  }

  return (
    <div className="correlation-timeline">
      <div className="correlation-header">
        <h3>Multi-Agent Correlation</h3>
        <div className="correlation-id">ID: {correlation?.correlationId}</div>
        <button className="close-btn" onClick={onClose}>Close</button>
      </div>

      {/* Summary Stats */}
      <div className="correlation-summary">
        <div className="summary-stat">
          <span className="stat-value">{correlation?.participants?.length || 0}</span>
          <span className="stat-label">Agents</span>
        </div>
        <div className="summary-stat">
          <span className="stat-value">{correlation?.runs?.length || 0}</span>
          <span className="stat-label">Runs</span>
        </div>
        <div className="summary-stat">
          <span className="stat-value">{correlation?.handoffCount || 0}</span>
          <span className="stat-label">Handoffs</span>
        </div>
        <div className="summary-stat">
          <span className="stat-value">{formatDuration(correlation?.totalDuration || 0)}</span>
          <span className="stat-label">Total Duration</span>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="correlation-tabs">
        <button
          className={`tab-btn ${activeTab === 'timeline' ? 'active' : ''}`}
          onClick={() => setActiveTab('timeline')}
        >
          Swimlane View
        </button>
        <button
          className={`tab-btn ${activeTab === 'tree' ? 'active' : ''}`}
          onClick={() => setActiveTab('tree')}
        >
          Tree View
        </button>
        <button
          className={`tab-btn ${activeTab === 'stats' ? 'active' : ''}`}
          onClick={() => setActiveTab('stats')}
        >
          Statistics
        </button>
      </div>

      {/* Timeline View */}
      {activeTab === 'timeline' && timeline && (
        <div className="swimlane-container">
          {/* Time axis */}
          <div className="time-axis">
            <span className="time-start">{formatTime(timeline.startTime)}</span>
            <span className="time-end">{formatTime(timeline.endTime)}</span>
          </div>

          {/* Agent swimlanes */}
          <div className="swimlanes">
            {timeline.agents.map(agent => (
              <div key={agent} className="swimlane">
                <div className="swimlane-label">
                  <span className="agent-name">{agent}</span>
                  <span className="agent-runs">{timeline.agentLanes[agent].length} runs</span>
                </div>
                <div className="swimlane-track">
                  {timeline.agentLanes[agent].map(run => (
                    <div
                      key={run.runId}
                      className={`run-bar ${run.status} ${hoveredRun === run.runId ? 'hovered' : ''}`}
                      style={{
                        left: `${run.startOffset}%`,
                        width: `${Math.max(run.width, 2)}%`
                      }}
                      onMouseEnter={() => setHoveredRun(run.runId)}
                      onMouseLeave={() => setHoveredRun(null)}
                      title={`${run.runId}\n${formatDuration(run.duration)}`}
                    >
                      <span className="run-duration">{formatDuration(run.duration)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Handoff arrows */}
          <div className="handoff-arrows">
            {correlation.handoffs.map(handoff => {
              const fromAgent = handoff.fromAgent
              const toAgent = handoff.toAgent
              const fromIndex = timeline.agents.indexOf(fromAgent)
              const toIndex = timeline.agents.indexOf(toAgent)

              if (fromIndex === -1 || toIndex === -1) return null

              // Calculate arrow position based on handoff time
              const handoffTime = new Date(handoff.timestamp).getTime()
              const xPos = (handoffTime - timeline.startTime) / timeline.totalDuration * 100

              return (
                <div
                  key={handoff.id}
                  className={`handoff-arrow ${handoff.type} ${selectedHandoff === handoff.id ? 'selected' : ''}`}
                  style={{
                    left: `${xPos}%`,
                    top: `${(fromIndex + 0.5) * 60}px`,
                    height: `${Math.abs(toIndex - fromIndex) * 60}px`
                  }}
                  onClick={() => setSelectedHandoff(handoff.id === selectedHandoff ? null : handoff.id)}
                  title={`${fromAgent} -> ${toAgent}\nLatency: ${handoff.latency}ms`}
                >
                  <div className="arrow-line" />
                  <div className="arrow-head" style={{
                    top: toIndex > fromIndex ? 'auto' : '0',
                    bottom: toIndex > fromIndex ? '0' : 'auto',
                    transform: toIndex > fromIndex ? 'rotate(180deg)' : 'none'
                  }} />
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Tree View */}
      {activeTab === 'tree' && (
        <CorrelationTree
          correlation={correlation}
          onSelectRun={setHoveredRun}
          selectedRun={hoveredRun}
        />
      )}

      {/* Statistics View */}
      {activeTab === 'stats' && stats && (
        <div className="correlation-stats">
          {/* Agent breakdown */}
          <div className="stats-section">
            <h4>Agent Performance</h4>
            <table className="stats-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Runs</th>
                  <th>Total Time</th>
                  <th>Avg Time</th>
                  <th>Messages</th>
                </tr>
              </thead>
              <tbody>
                {stats.agentStats.map(agent => (
                  <tr key={agent.agent}>
                    <td className="agent-cell">{agent.agent}</td>
                    <td>{agent.runCount}</td>
                    <td>{formatDuration(agent.totalDuration)}</td>
                    <td>{formatDuration(agent.avgDuration)}</td>
                    <td>{agent.messageCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Latency stats */}
          <div className="stats-section">
            <h4>Handoff Latency</h4>
            <div className="latency-stats">
              <div className="latency-stat">
                <span className="latency-value">{stats.latencyStats.avg}ms</span>
                <span className="latency-label">Average</span>
              </div>
              <div className="latency-stat">
                <span className="latency-value">{stats.latencyStats.max}ms</span>
                <span className="latency-label">Maximum</span>
              </div>
              <div className="latency-stat">
                <span className="latency-value">{stats.latencyStats.total}ms</span>
                <span className="latency-label">Total Overhead</span>
              </div>
            </div>
          </div>

          {/* Participants */}
          <div className="stats-section">
            <h4>Participants</h4>
            <div className="participant-list">
              {stats.participants.map(p => (
                <span key={p} className="participant-badge">{p}</span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Handoff Detail Panel */}
      {selectedHandoff && (
        <AgentHandoffDetail
          handoff={correlation.handoffs.find(h => h.id === selectedHandoff)}
          onClose={() => setSelectedHandoff(null)}
        />
      )}
    </div>
  )
}
