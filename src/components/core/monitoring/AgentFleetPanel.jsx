/**
 * AgentFleetPanel - Real-time fleet status display with interactive controls
 *
 * Connects to Quox Collector via WebSocket for live updates.
 * Displays QuoxAgent agents with CPU, memory, disk, and connection status.
 * Provides interactive controls: run jobs, view sessions, manage agents.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import './monitoring.css';

// Use proxied collector URLs (through nginx) for browser access
const getCollectorUrl = () => {
  if (import.meta.env.VITE_COLLECTOR_URL) return import.meta.env.VITE_COLLECTOR_URL;
  // Use relative path through nginx proxy
  return `${window.location.origin}/collector`;
};

const COLLECTOR_URL = getCollectorUrl();

// QuoxAgent agent API - routes through collector proxy
const getAgentUrl = (agent) => {
  if (!agent?.host_id) return null;
  // All agents accessible via collector proxy: /agent/{host_id}/*
  return `${window.location.origin}/agent/${agent.host_id}`;
};

// Connection status colors
const STATUS_COLORS = {
  connected: '#22c55e',  // Green
  stale: '#f59e0b',      // Orange
  dead: '#ef4444',       // Red
  unknown: '#6b7280'     // Gray
};

// Health status colors
const HEALTH_COLORS = {
  healthy: '#22c55e',
  warning: '#f59e0b',
  critical: '#ef4444',
  unknown: '#6b7280'
};

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
  if (!seconds) return 'N/A';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatTimestamp(ts) {
  if (!ts) return 'N/A';
  return new Date(ts).toLocaleString();
}

// Agent Detail Modal with actions
function AgentDetailModal({ agent, onClose, onRunJob }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [jobs, setJobs] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [jobCommand, setJobCommand] = useState('');
  const [jobResult, setJobResult] = useState(null);

  const agentUrl = getAgentUrl(agent);

  // Fetch jobs and sessions when switching tabs
  useEffect(() => {
    if (!agentUrl) return;

    const fetchData = async () => {
      setLoading(true);
      try {
        if (activeTab === 'jobs') {
          const res = await fetch(`${agentUrl}/api/v1/jobs`);
          if (res.ok) {
            const data = await res.json();
            setJobs(data.jobs || []);
          }
        } else if (activeTab === 'sessions') {
          const res = await fetch(`${agentUrl}/api/v1/sessions`);
          if (res.ok) {
            const data = await res.json();
            setSessions(data.sessions || []);
          }
        }
      } catch (err) {
        console.error('Failed to fetch:', err);
      }
      setLoading(false);
    };

    fetchData();
  }, [activeTab, agentUrl]);

  const handleRunJob = async () => {
    if (!jobCommand.trim() || !agentUrl) return;

    setLoading(true);
    setJobResult(null);

    try {
      // Generate a proper UUID for the job
      const jobId = crypto.randomUUID();

      const res = await fetch(`${agentUrl}/api/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: jobId,
          timestamp: new Date().toISOString(),
          origin: 'dashboard',
          targets: [agent.host_id],
          job: {
            name: 'Dashboard Command',
            type: 'script',  // Use script type for shell commands
            command: jobCommand,
            timeout: 30000000000  // 30 seconds in nanoseconds
          }
        })
      });

      // Handle both JSON and text responses
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text };
      }
      setJobResult({ success: res.ok, data });

      if (res.ok) {
        // Refresh jobs list
        const jobsRes = await fetch(`${agentUrl}/api/v1/jobs`);
        if (jobsRes.ok) {
          const jobsData = await jobsRes.json();
          setJobs(jobsData.jobs || []);
        }
      }
    } catch (err) {
      setJobResult({ success: false, error: err.message });
    }

    setLoading(false);
  };

  const { host_id, system, resources, status, capabilities, agent: agentInfo } = agent;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="agent-detail-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{host_id}</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-tabs">
          <button
            className={`tab ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            Overview
          </button>
          <button
            className={`tab ${activeTab === 'jobs' ? 'active' : ''}`}
            onClick={() => setActiveTab('jobs')}
          >
            Jobs
          </button>
          <button
            className={`tab ${activeTab === 'sessions' ? 'active' : ''}`}
            onClick={() => setActiveTab('sessions')}
          >
            Claude Sessions
          </button>
          <button
            className={`tab ${activeTab === 'run' ? 'active' : ''}`}
            onClick={() => setActiveTab('run')}
          >
            Run Command
          </button>
        </div>

        <div className="modal-content">
          {activeTab === 'overview' && (
            <div className="overview-tab">
              <div className="detail-section">
                <h4>System Information</h4>
                <div className="detail-grid">
                  <div className="detail-item">
                    <span className="label">Hostname</span>
                    <span className="value">{system?.hostname}</span>
                  </div>
                  <div className="detail-item">
                    <span className="label">OS</span>
                    <span className="value">{system?.os_version || system?.os}</span>
                  </div>
                  <div className="detail-item">
                    <span className="label">Architecture</span>
                    <span className="value">{system?.arch}</span>
                  </div>
                  <div className="detail-item">
                    <span className="label">Kernel</span>
                    <span className="value">{system?.kernel}</span>
                  </div>
                  <div className="detail-item">
                    <span className="label">System Uptime</span>
                    <span className="value">{formatUptime(system?.uptime_seconds)}</span>
                  </div>
                  <div className="detail-item">
                    <span className="label">Boot Time</span>
                    <span className="value">{formatTimestamp(system?.boot_time)}</span>
                  </div>
                </div>
              </div>

              <div className="detail-section">
                <h4>Agent Information</h4>
                <div className="detail-grid">
                  <div className="detail-item">
                    <span className="label">QuoxAgent Version</span>
                    <span className="value">{agentInfo?.version}</span>
                  </div>
                  <div className="detail-item">
                    <span className="label">Agent Uptime</span>
                    <span className="value">{formatUptime(agentInfo?.uptime_seconds)}</span>
                  </div>
                  <div className="detail-item">
                    <span className="label">Mode</span>
                    <span className="value">{agentInfo?.mode}</span>
                  </div>
                  <div className="detail-item">
                    <span className="label">Active Jobs</span>
                    <span className="value">{agentInfo?.active_jobs}</span>
                  </div>
                  <div className="detail-item">
                    <span className="label">Health</span>
                    <span className="value" style={{ color: HEALTH_COLORS[status?.health] }}>
                      {status?.health}
                    </span>
                  </div>
                  <div className="detail-item">
                    <span className="label">Connection</span>
                    <span className="value" style={{ color: STATUS_COLORS[status?.connection] }}>
                      {status?.connection}
                    </span>
                  </div>
                </div>
              </div>

              <div className="detail-section">
                <h4>Resources</h4>
                <div className="detail-grid">
                  <div className="detail-item">
                    <span className="label">CPU Cores</span>
                    <span className="value">{resources?.cpu?.cores}</span>
                  </div>
                  <div className="detail-item">
                    <span className="label">CPU Usage</span>
                    <span className="value">{(resources?.cpu?.usage_percent || 0).toFixed(1)}%</span>
                  </div>
                  <div className="detail-item">
                    <span className="label">Load (1/5/15m)</span>
                    <span className="value">
                      {resources?.cpu?.load_1m?.toFixed(2)} / {resources?.cpu?.load_5m?.toFixed(2)} / {resources?.cpu?.load_15m?.toFixed(2)}
                    </span>
                  </div>
                  <div className="detail-item">
                    <span className="label">Memory Total</span>
                    <span className="value">{formatBytes(resources?.memory?.total_bytes)}</span>
                  </div>
                  <div className="detail-item">
                    <span className="label">Memory Used</span>
                    <span className="value">{formatBytes(resources?.memory?.used_bytes)}</span>
                  </div>
                  <div className="detail-item">
                    <span className="label">Memory Usage</span>
                    <span className="value">{(resources?.memory?.usage_percent || 0).toFixed(1)}%</span>
                  </div>
                </div>
              </div>

              <div className="detail-section">
                <h4>Disk Usage</h4>
                <div className="disk-list">
                  {resources?.disk?.map((disk, i) => (
                    <div key={i} className="disk-item">
                      <span className="mount">{disk.mount_point}</span>
                      <span className="device">{disk.device}</span>
                      <div className="disk-bar">
                        <div
                          className="disk-bar-fill"
                          style={{ width: `${disk.usage_percent}%` }}
                        />
                      </div>
                      <span className="usage">{disk.usage_percent?.toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="detail-section">
                <h4>Network Interfaces</h4>
                <div className="network-list">
                  {resources?.network?.interfaces?.map((iface, i) => (
                    <div key={i} className="network-item">
                      <span className="iface-name">{iface.name}</span>
                      <span className="iface-ip">{iface.ip_addresses?.join(', ')}</span>
                      <span className="iface-mac">{iface.mac_address}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="detail-section">
                <h4>Capabilities</h4>
                <div className="capabilities-list">
                  {capabilities?.map((cap, i) => (
                    <span key={i} className="capability-badge">{cap}</span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'jobs' && (
            <div className="jobs-tab">
              {loading ? (
                <div className="loading">Loading jobs...</div>
              ) : jobs.length === 0 ? (
                <div className="empty">No jobs found</div>
              ) : (
                <div className="jobs-list">
                  {jobs.map((job, i) => (
                    <div key={i} className={`job-item ${job.status}`}>
                      <div className="job-header">
                        <span className="job-id">{job.id}</span>
                        <span className={`job-status ${job.status}`}>{job.status}</span>
                      </div>
                      <div className="job-details">
                        <span className="job-name">{job.name}</span>
                        <span className="job-type">{job.type}</span>
                        <span className="job-time">{formatTimestamp(job.received_at)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'sessions' && (
            <div className="sessions-tab">
              {loading ? (
                <div className="loading">Loading sessions...</div>
              ) : sessions.length === 0 ? (
                <div className="empty">No Claude sessions found</div>
              ) : (
                <div className="sessions-list">
                  {sessions.map((session, i) => (
                    <div key={i} className={`session-item ${session.status}`}>
                      <div className="session-header">
                        <span className="session-id">{session.id}</span>
                        <span className={`session-status ${session.status}`}>{session.status}</span>
                      </div>
                      <div className="session-details">
                        <span className="session-project">{session.project}</span>
                        <span className="session-time">Started: {formatTimestamp(session.started_at)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'run' && (
            <div className="run-tab">
              <div className="run-form">
                <label>Command to execute:</label>
                <input
                  type="text"
                  value={jobCommand}
                  onChange={e => setJobCommand(e.target.value)}
                  placeholder="e.g., uptime, df -h, docker ps"
                  className="command-input"
                  onKeyDown={e => e.key === 'Enter' && handleRunJob()}
                />
                <button
                  className="run-btn"
                  onClick={handleRunJob}
                  disabled={loading || !jobCommand.trim() || !agentUrl}
                >
                  {loading ? 'Running...' : 'Run'}
                </button>
              </div>

              {!agentUrl && (
                <div className="warning-box">
                  Cannot connect directly to this agent. Agent URL not configured.
                </div>
              )}

              <div className="info-box" style={{ marginTop: '0.5rem', padding: '0.75rem', background: 'rgba(59, 130, 246, 0.1)', borderRadius: '6px', fontSize: '0.85rem', color: '#93c5fd' }}>
                <strong>Note:</strong> Running commands requires agents in dev mode (MHA_DEV=1) or signed job envelopes.
                For quick commands, use the Bastion SSH panel instead.
              </div>

              {jobResult && (
                <div className={`job-result ${jobResult.success ? 'success' : 'error'}`}>
                  <h4>{jobResult.success ? 'Job Submitted' : 'Error'}</h4>
                  <pre>{typeof jobResult.data === 'object'
                    ? JSON.stringify(jobResult.data, null, 2)
                    : (jobResult.data?.message || jobResult.error || JSON.stringify(jobResult.data))}</pre>
                  {!jobResult.success && jobResult.data?.message?.includes('signature') && (
                    <p style={{ marginTop: '0.5rem', color: '#fbbf24', fontSize: '0.85rem' }}>
                      Agents require MHA_DEV=1 environment variable or signed job envelopes.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Memoized AgentCard to prevent re-renders when data hasn't changed
const AgentCard = memo(function AgentCard({ agent, onClick }) {
  const { host_id, system, resources, status, capabilities, agent: agentInfo } = agent;
  const connectionStatus = status?.connection || 'unknown';
  const healthStatus = status?.health || 'unknown';
  const lastSeen = status?.last_seen_seconds;

  return (
    <div
      className="agent-card clickable"
      style={{ borderLeftColor: STATUS_COLORS[connectionStatus] }}
      onClick={() => onClick(agent)}
    >
      <div className="agent-header">
        <div className="agent-name">
          <span className="host-id">{host_id}</span>
          <span className="health-badge" style={{ backgroundColor: HEALTH_COLORS[healthStatus] }}>
            {healthStatus}
          </span>
        </div>
        <div className="connection-status" style={{ color: STATUS_COLORS[connectionStatus] }}>
          {connectionStatus}
          {lastSeen !== undefined && ` (${lastSeen}s ago)`}
        </div>
      </div>

      <div className="agent-system">
        <span>{system?.hostname || 'unknown'}</span>
        <span className="separator">|</span>
        <span>{system?.os_version || system?.os || 'unknown'}</span>
        <span className="separator">|</span>
        <span>{system?.arch || 'unknown'}</span>
      </div>

      <div className="agent-resources">
        <div className="resource-bar">
          <div className="resource-label">CPU</div>
          <div className="bar-container">
            <div
              className="bar-fill cpu"
              style={{ width: `${Math.min(resources?.cpu?.usage_percent || 0, 100)}%` }}
            />
          </div>
          <div className="resource-value">{(resources?.cpu?.usage_percent || 0).toFixed(1)}%</div>
        </div>

        <div className="resource-bar">
          <div className="resource-label">MEM</div>
          <div className="bar-container">
            <div
              className="bar-fill memory"
              style={{ width: `${Math.min(resources?.memory?.usage_percent || 0, 100)}%` }}
            />
          </div>
          <div className="resource-value">
            {(resources?.memory?.usage_percent || 0).toFixed(1)}%
            <span className="resource-detail">
              ({formatBytes(resources?.memory?.used_bytes || 0)})
            </span>
          </div>
        </div>

        {resources?.disk?.slice(0, 2).map((disk, i) => (
          <div className="resource-bar" key={i}>
            <div className="resource-label">{disk.mount_point === '/' ? 'DISK' : disk.mount_point}</div>
            <div className="bar-container">
              <div
                className="bar-fill disk"
                style={{ width: `${Math.min(disk.usage_percent || 0, 100)}%` }}
              />
            </div>
            <div className="resource-value">
              {(disk.usage_percent || 0).toFixed(1)}%
            </div>
          </div>
        ))}
      </div>

      <div className="agent-footer">
        <div className="agent-info">
          <span>QuoxAgent v{agentInfo?.version || '?'}</span>
          <span className="separator">|</span>
          <span>Up {formatUptime(agentInfo?.uptime_seconds)}</span>
          <span className="separator">|</span>
          <span>{resources?.cpu?.cores || '?'} cores</span>
        </div>
        <div className="capabilities">
          {capabilities?.map((cap, i) => (
            <span key={i} className="capability-tag">{cap}</span>
          ))}
        </div>
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  // Custom comparison - only re-render if agent data actually changed
  const prev = prevProps.agent;
  const next = nextProps.agent;
  return (
    prev.host_id === next.host_id &&
    prev.status?.connection === next.status?.connection &&
    prev.status?.health === next.status?.health &&
    prev.status?.last_seen_seconds === next.status?.last_seen_seconds &&
    prev.resources?.cpu?.usage_percent === next.resources?.cpu?.usage_percent &&
    prev.resources?.memory?.usage_percent === next.resources?.memory?.usage_percent
  );
});

// Memoized FleetSummary to prevent re-renders when summary hasn't changed
const FleetSummary = memo(function FleetSummary({ summary }) {
  if (!summary) return null;

  const { total_agents, connection, health, resources } = summary;

  return (
    <div className="fleet-summary">
      <div className="summary-stat">
        <div className="stat-value">{total_agents}</div>
        <div className="stat-label">Total Agents</div>
      </div>
      <div className="summary-stat">
        <div className="stat-value" style={{ color: STATUS_COLORS.connected }}>
          {connection?.connected || 0}
        </div>
        <div className="stat-label">Connected</div>
      </div>
      <div className="summary-stat">
        <div className="stat-value" style={{ color: STATUS_COLORS.stale }}>
          {connection?.stale || 0}
        </div>
        <div className="stat-label">Stale</div>
      </div>
      <div className="summary-stat">
        <div className="stat-value" style={{ color: STATUS_COLORS.dead }}>
          {connection?.dead || 0}
        </div>
        <div className="stat-label">Dead</div>
      </div>
      <div className="summary-stat">
        <div className="stat-value">{(resources?.avg_cpu_percent || 0).toFixed(1)}%</div>
        <div className="stat-label">Avg CPU</div>
      </div>
      <div className="summary-stat">
        <div className="stat-value">{(resources?.avg_memory_percent || 0).toFixed(1)}%</div>
        <div className="stat-label">Avg Memory</div>
      </div>
    </div>
  );
});

export default function AgentFleetPanel({ onSelectAgent: onSelectAgentProp } = {}) {
  const [agents, setAgents] = useState([]);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const summaryFetchTimeoutRef = useRef(null);
  const lastUpdateTimeoutRef = useRef(null);
  // Use a connection ID to track which effect instance is valid
  const connectionIdRef = useRef(0);

  // Fetch initial data via HTTP
  const fetchAgents = useCallback(async (connId) => {
    try {
      const [agentsRes, summaryRes] = await Promise.all([
        fetch(`${COLLECTOR_URL}/api/v1/agents`),
        fetch(`${COLLECTOR_URL}/api/v1/fleet/summary`)
      ]);

      // Check if this connection is still valid
      if (connId !== connectionIdRef.current) return;

      if (agentsRes.ok) {
        const data = await agentsRes.json();
        setAgents(data.agents || []);
      }

      if (summaryRes.ok) {
        const data = await summaryRes.json();
        setSummary(data);
      }

      setLastUpdate(new Date());
      setError(null);
    } catch (err) {
      if (connId === connectionIdRef.current) {
        setError(`Failed to fetch: ${err.message}`);
      }
    }
  }, []);

  // Initialize - use polling for now (WebSocket has issues in this environment)
  useEffect(() => {
    connectionIdRef.current += 1;
    const myConnId = connectionIdRef.current;

    // Fetch initial data
    fetchAgents(myConnId);

    // Poll every 10 seconds for updates
    const pollInterval = setInterval(() => {
      if (myConnId === connectionIdRef.current) {
        fetchAgents(myConnId);
      }
    }, 10000);

    return () => {
      clearInterval(pollInterval);
      clearTimeout(summaryFetchTimeoutRef.current);
      clearTimeout(lastUpdateTimeoutRef.current);
      summaryFetchTimeoutRef.current = null;
      lastUpdateTimeoutRef.current = null;
    };
  }, [fetchAgents]);

  // Keep selected agent updated with latest data
  const currentSelectedAgent = selectedAgent
    ? agents.find(a => a.host_id === selectedAgent.host_id) || selectedAgent
    : null;

  // Filter agents by search and status
  const filteredAgents = useMemo(() => {
    return agents.filter(agent => {
      // Status filter
      if (statusFilter !== 'all') {
        const conn = agent.status?.connection || 'unknown';
        if (statusFilter === 'connected' && conn !== 'connected') return false;
        if (statusFilter === 'stale' && conn !== 'stale') return false;
        if (statusFilter === 'dead' && conn !== 'dead') return false;
      }
      // Search filter
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const hostId = (agent.host_id || '').toLowerCase();
        const ip = (agent.ip_address || agent.agent?.ip_address || '').toLowerCase();
        const os = (agent.system?.os || '').toLowerCase();
        if (!hostId.includes(q) && !ip.includes(q) && !os.includes(q)) return false;
      }
      return true;
    });
  }, [agents, searchQuery, statusFilter]);

  // Status counts for filter badges
  const statusCounts = useMemo(() => {
    const counts = { all: agents.length, connected: 0, stale: 0, dead: 0 };
    agents.forEach(a => {
      const conn = a.status?.connection || 'unknown';
      if (conn === 'connected') counts.connected++;
      else if (conn === 'stale') counts.stale++;
      else if (conn === 'dead') counts.dead++;
    });
    return counts;
  }, [agents]);

  return (
    <div className="agent-fleet-panel">
      <div className="panel-header">
        <h3>QuoxAgent Fleet</h3>
        <div className="header-status">
          {lastUpdate && (
            <span className="last-update">
              {lastUpdate.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="error-banner">
          {error}
        </div>
      )}

      <FleetSummary summary={summary} />

      {/* Search + Status Filter */}
      {agents.length > 0 && (
        <div className="fleet-search-bar">
          <div className="fleet-search">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255,255,255,0.3)' }} strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              type="text"
              className="fleet-search__input"
              placeholder="Search agents..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="fleet-search__clear" onClick={() => setSearchQuery('')}>{'\u2715'}</button>
            )}
          </div>
          <div className="fleet-status-filters">
            {['all', 'connected', 'stale', 'dead'].map(status => (
              <button
                key={status}
                className={`fleet-status-btn ${statusFilter === status ? 'fleet-status-btn--active' : ''} fleet-status-btn--${status}`}
                onClick={() => setStatusFilter(status)}
              >
                {status === 'all' ? 'All' : status.charAt(0).toUpperCase() + status.slice(1)}
                <span className="fleet-status-btn__count">{statusCounts[status]}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="agents-grid">
        {agents.length === 0 ? (
          <div className="no-agents">
            No QuoxAgent agents connected. Deploy QuoxAgent to your hosts to see them here.
          </div>
        ) : filteredAgents.length === 0 ? (
          <div className="no-agents">
            No agents match the current filter.
          </div>
        ) : (
          filteredAgents.map(agent => (
            <AgentCard
              key={agent.host_id}
              agent={agent}
              onClick={(a) => { setSelectedAgent(a); onSelectAgentProp?.(a); }}
            />
          ))
        )}
      </div>

      {currentSelectedAgent && (
        <AgentDetailModal
          agent={currentSelectedAgent}
          onClose={() => setSelectedAgent(null)}
        />
      )}
    </div>
  );
}
