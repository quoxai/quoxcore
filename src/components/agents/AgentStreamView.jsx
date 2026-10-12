/**
 * AgentStreamView - Real-time AI Agent Activity Stream
 *
 * Shows all AI agent sessions and their events in real-time via WebSocket.
 * Features:
 * - Split view: Active sessions (left) + Live event stream (right)
 * - Filter by agent type, host, provider
 * - Click session to focus its events
 * - Auto-scroll with pause on hover
 * - Visual event icons and color coding
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import './agent-stream.css';

// Map agent stream session ID to AEE correlation ID
function sessionIdToCorr(sessionId) {
  if (!sessionId) return null;
  if (sessionId.startsWith('term-')) return `SHELL_${sessionId.slice(5)}`;
  return sessionId; // chat session IDs match AEE corr directly
}

// QuoxAgent WebSocket endpoint (through nginx proxy)
const getWsUrl = () => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/mha-agent/ws/agents/events`;
};

// Event type icons and colors
const EVENT_CONFIG = {
  'session.start': { icon: '🚀', color: '#22c55e', label: 'Session Started' },
  'session.end': { icon: '✅', color: '#6b7280', label: 'Session Ended' },
  'session.status': { icon: '🔄', color: '#f59e0b', label: 'Status Change' },
  'activity.tool_call': { icon: '⚡', color: '#eab308', label: 'Tool Call' },
  'activity.tool_result': { icon: '📤', color: '#84cc16', label: 'Tool Result' },
  'delegation.accepted': { icon: '🤝', color: '#818cf8', label: 'Delegating' },
  'delegation.completed': { icon: '↩️', color: '#6366f1', label: 'Delegation Result' },
  'activity.file_change': { icon: '📝', color: '#a855f7', label: 'File Change' },
  'activity.message': { icon: '💬', color: '#06b6d4', label: 'Message' },
  'activity.thinking': { icon: '🤔', color: '#3b82f6', label: 'Thinking' },
  'activity.code_exec': { icon: '▶️', color: '#f97316', label: 'Code Execution' },
  'output.stdout': { icon: '📤', color: '#6b7280', label: 'Output' },
  'output.stderr': { icon: '❌', color: '#ef4444', label: 'Error Output' },
  'metrics.tokens': { icon: '🔢', color: '#8b5cf6', label: 'Token Usage' },
  'metrics.cost': { icon: '💰', color: '#10b981', label: 'Cost Update' },
};

// Agent type colors
const AGENT_TYPE_COLORS = {
  cli: '#3b82f6',
  api: '#8b5cf6',
  local: '#22c55e',
  custom: '#f59e0b',
};

// Provider colors
const PROVIDER_COLORS = {
  anthropic: '#d97706',
  openai: '#10b981',
  google: '#4285f4',
  local: '#6b7280',
  custom: '#ec4899',
};

// Status colors
const STATUS_COLORS = {
  starting: '#f59e0b',
  running: '#22c55e',
  idle: '#6b7280',
  waiting: '#3b82f6',
  finished: '#6b7280',
  failed: '#ef4444',
  cancelled: '#f97316',
};

// Format duration nicely
function formatDuration(ms) {
  if (!ms) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

// Format timestamp
function formatTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Truncate text
function truncate(str, max = 60) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.substring(0, max - 3) + '...';
}

// Session Card Component
function SessionCard({ session, isSelected, onClick, isActive, onViewActivity }) {
  const duration = session.status === 'running' || session.status === 'starting'
    ? Date.now() - new Date(session.started_at).getTime()
    : session.duration_ms || 0;

  const statusColor = STATUS_COLORS[session.status] || '#6b7280';
  const providerColor = PROVIDER_COLORS[session.provider] || '#6b7280';

  return (
    <div
      className={`session-card ${isSelected ? 'selected' : ''} ${isActive ? 'active' : 'inactive'}`}
      onClick={onClick}
      style={{ borderLeftColor: statusColor }}
    >
      <div className="session-header">
        <div className="session-identity">
          <span className="session-host">{session.host_id}</span>
          <span className="session-separator">/</span>
          <span className="session-agent" style={{ color: providerColor }}>
            {session.agent_name}
          </span>
        </div>
        <div className="session-header-actions">
          {onViewActivity && (
            <button
              className="session-activity-btn"
              onClick={(e) => { e.stopPropagation(); onViewActivity(session.id); }}
              title="View in Activity Log"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg>
            </button>
          )}
          <div className="session-status" style={{ color: statusColor }}>
            {session.status === 'running' && <span className="status-dot running" />}
            {session.status === 'idle' && <span className="status-dot idle" />}
            {session.status}
          </div>
        </div>
      </div>

      {session.model && (
        <div className="session-model">
          {session.model}
        </div>
      )}

      <div className="session-project">
        {session.project || session.work_dir || 'Unknown project'}
      </div>

      <div className="session-stats">
        <span className="stat">
          <span className="stat-icon">⏱</span>
          {formatDuration(duration)}
        </span>
        <span className="stat">
          <span className="stat-icon">⚡</span>
          {session.tool_call_count || 0} tools
        </span>
        <span className="stat">
          <span className="stat-icon">📝</span>
          {session.files_modified || 0} files
        </span>
      </div>

      {session.summary && (
        <div className="session-summary">
          "{truncate(session.summary, 50)}"
        </div>
      )}
    </div>
  );
}

// Event Item Component
function EventItem({ event, isHighlighted, onViewActivity }) {
  const config = EVENT_CONFIG[event.type] || { icon: '•', color: '#6b7280', label: event.type };
  const time = formatTime(event.timestamp);

  return (
    <div
      className={`event-item ${isHighlighted ? 'highlighted' : ''} ${onViewActivity ? 'clickable' : ''}`}
      onClick={onViewActivity ? () => onViewActivity(event.session_id) : undefined}
      title={onViewActivity ? 'Click to view in Activity Log' : undefined}
    >
      <span className="event-time">{time}</span>
      <span className="event-icon" style={{ color: config.color }}>{config.icon}</span>
      <span className="event-source">
        [{event.host_id || 'local'}/{event.agent_name || 'agent'}]
      </span>
      <span className="event-summary">
        {event.summary || config.label}
      </span>
      {onViewActivity && (
        <span className="event-activity-link" title="View in Activity Log">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </span>
      )}
    </div>
  );
}

// Stream Filters Component
function StreamFilters({ filters, onFilterChange, agentTypes, providers, hosts }) {
  return (
    <div className="stream-filters">
      <select
        value={filters.agentType || ''}
        onChange={e => onFilterChange({ ...filters, agentType: e.target.value || null })}
        className="filter-select"
      >
        <option value="">All Types</option>
        {agentTypes.map(t => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>

      <select
        value={filters.provider || ''}
        onChange={e => onFilterChange({ ...filters, provider: e.target.value || null })}
        className="filter-select"
      >
        <option value="">All Providers</option>
        {providers.map(p => (
          <option key={p} value={p}>{p}</option>
        ))}
      </select>

      <select
        value={filters.hostId || ''}
        onChange={e => onFilterChange({ ...filters, hostId: e.target.value || null })}
        className="filter-select"
      >
        <option value="">All Hosts</option>
        {hosts.map(h => (
          <option key={h} value={h}>{h}</option>
        ))}
      </select>

      <input
        type="text"
        placeholder="Search events..."
        value={filters.search || ''}
        onChange={e => onFilterChange({ ...filters, search: e.target.value || null })}
        className="filter-search"
      />
    </div>
  );
}

// Fleet Summary Bar
function FleetSummaryBar({ sessions }) {
  const active = sessions.filter(s => ['running', 'starting', 'idle', 'waiting'].includes(s.status)).length;
  const total = sessions.length;

  const byProvider = useMemo(() => {
    const counts = {};
    sessions.forEach(s => {
      if (['running', 'starting', 'idle', 'waiting'].includes(s.status)) {
        counts[s.provider] = (counts[s.provider] || 0) + 1;
      }
    });
    return counts;
  }, [sessions]);

  return (
    <div className="fleet-summary-bar">
      <div className="summary-item">
        <span className="summary-value live">{active}</span>
        <span className="summary-label">Active</span>
      </div>
      <div className="summary-item">
        <span className="summary-value">{total}</span>
        <span className="summary-label">Total</span>
      </div>
      <div className="summary-divider" />
      {Object.entries(byProvider).map(([provider, count]) => (
        <div key={provider} className="summary-item">
          <span className="summary-value" style={{ color: PROVIDER_COLORS[provider] }}>
            {count}
          </span>
          <span className="summary-label">{provider}</span>
        </div>
      ))}
    </div>
  );
}

// Main AgentStreamView Component
export default function AgentStreamView() {
  const navigate = useNavigate();
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [events, setEvents] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [filters, setFilters] = useState({});
  const [isPaused, setIsPaused] = useState(false);
  const [error, setError] = useState(null);

  const wsRef = useRef(null);
  const eventListRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  // Navigate to Activity log for a session
  const viewActivity = useCallback((sessionId) => {
    const corr = sessionIdToCorr(sessionId);
    if (corr) navigate(`/activity?corr=${encodeURIComponent(corr)}`);
  }, [navigate]);

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const wsUrl = getWsUrl();
    console.log('Connecting to agent stream:', wsUrl);

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('Agent stream connected');
        setConnected(true);
        setError(null);
      };

      ws.onmessage = (event) => {
        try {
          // Handle multiple messages in one frame (newline separated)
          const messages = event.data.split('\n').filter(Boolean);
          messages.forEach(msg => {
            const data = JSON.parse(msg);
            handleMessage(data);
          });
        } catch (err) {
          console.error('Failed to parse message:', err);
        }
      };

      ws.onclose = (event) => {
        console.log('Agent stream disconnected:', event.code);
        setConnected(false);
        wsRef.current = null;

        // Reconnect after 5 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, 5000);
      };

      ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        setError('Connection failed. Retrying...');
      };

      wsRef.current = ws;
    } catch (err) {
      console.error('Failed to create WebSocket:', err);
      setError('Failed to connect. Retrying...');
      reconnectTimeoutRef.current = setTimeout(connect, 5000);
    }
  }, []);

  // Handle incoming messages
  const handleMessage = useCallback((data) => {
    if (data.type === 'session_start' && data.session) {
      setSessions(prev => {
        const existing = prev.findIndex(s => s.id === data.session.id);
        if (existing >= 0) {
          const updated = [...prev];
          updated[existing] = data.session;
          return updated;
        }
        return [data.session, ...prev];
      });
    } else if (data.type === 'session_end' && data.session) {
      setSessions(prev =>
        prev.map(s => s.id === data.session.id ? data.session : s)
      );
    } else if (data.type === 'event' && data.event) {
      setEvents(prev => {
        // Keep last 500 events
        const newEvents = [data.event, ...prev];
        return newEvents.slice(0, 500);
      });

      // Update session metrics if we have a session
      if (data.event.session_id) {
        setSessions(prev => prev.map(s => {
          if (s.id !== data.event.session_id) return s;
          const updates = { ...s, last_active: data.event.timestamp };

          // Update counters based on event type
          if (data.event.type === 'activity.tool_call') {
            updates.tool_call_count = (s.tool_call_count || 0) + 1;
          } else if (data.event.type === 'activity.file_change') {
            updates.files_modified = (s.files_modified || 0) + 1;
          } else if (data.event.type === 'activity.message') {
            updates.message_count = (s.message_count || 0) + 1;
          }

          return updates;
        }));
      }
    }
  }, []);

  // Auto-scroll to latest event
  useEffect(() => {
    if (!isPaused && eventListRef.current) {
      eventListRef.current.scrollTop = 0;
    }
  }, [events, isPaused]);

  // Connect on mount
  useEffect(() => {
    connect();

    // Also fetch initial data via HTTP
    fetchInitialData();

    return () => {
      clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  // Fetch initial sessions via HTTP
  const fetchInitialData = async () => {
    try {
      const baseUrl = window.location.origin;
      const res = await fetch(`${baseUrl}/mha-agent/api/v1/agents/sessions`);
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
      }
    } catch (err) {
      console.error('Failed to fetch initial sessions:', err);
    }
  };

  // Filter sessions
  const filteredSessions = useMemo(() => {
    return sessions.filter(s => {
      if (filters.agentType && s.agent_type !== filters.agentType) return false;
      if (filters.provider && s.provider !== filters.provider) return false;
      if (filters.hostId && s.host_id !== filters.hostId) return false;
      if (filters.search) {
        const search = filters.search.toLowerCase();
        if (!s.agent_name?.toLowerCase().includes(search) &&
            !s.project?.toLowerCase().includes(search) &&
            !s.host_id?.toLowerCase().includes(search)) {
          return false;
        }
      }
      return true;
    });
  }, [sessions, filters]);

  // Filter events
  const filteredEvents = useMemo(() => {
    return events.filter(e => {
      if (selectedSessionId && e.session_id !== selectedSessionId) return false;
      if (filters.agentType && e.agent_type !== filters.agentType) return false;
      if (filters.hostId && e.host_id !== filters.hostId) return false;
      if (filters.search) {
        const search = filters.search.toLowerCase();
        if (!e.summary?.toLowerCase().includes(search) &&
            !e.agent_name?.toLowerCase().includes(search)) {
          return false;
        }
      }
      return true;
    });
  }, [events, selectedSessionId, filters]);

  // Get unique values for filters
  const agentTypes = useMemo(() => [...new Set(sessions.map(s => s.agent_type).filter(Boolean))], [sessions]);
  const providers = useMemo(() => [...new Set(sessions.map(s => s.provider).filter(Boolean))], [sessions]);
  const hosts = useMemo(() => [...new Set(sessions.map(s => s.host_id).filter(Boolean))], [sessions]);

  // Split sessions into active and recent
  const activeSessions = filteredSessions.filter(s =>
    ['running', 'starting', 'idle', 'waiting'].includes(s.status)
  );
  const recentSessions = filteredSessions.filter(s =>
    !['running', 'starting', 'idle', 'waiting'].includes(s.status)
  ).slice(0, 5);

  return (
    <div className="agent-stream-view">
      <div className="stream-header">
        <div className="stream-title">
          <h2>Agent Stream</h2>
          <span className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
            {connected ? '● Live' : '○ Connecting...'}
          </span>
        </div>
        <FleetSummaryBar sessions={sessions} />
      </div>

      {error && (
        <div className="stream-error">
          {error}
        </div>
      )}

      <StreamFilters
        filters={filters}
        onFilterChange={setFilters}
        agentTypes={agentTypes}
        providers={providers}
        hosts={hosts}
      />

      <div className="stream-content">
        {/* Sessions Panel */}
        <div className="sessions-panel">
          <div className="sessions-section">
            <h3 className="section-title">
              Active Sessions
              <span className="section-count">{activeSessions.length}</span>
            </h3>
            <div className="sessions-list">
              {activeSessions.length === 0 ? (
                <div className="no-sessions">No active sessions</div>
              ) : (
                activeSessions.map(session => (
                  <SessionCard
                    key={session.id}
                    session={session}
                    isSelected={selectedSessionId === session.id}
                    isActive={true}
                    onClick={() => setSelectedSessionId(
                      selectedSessionId === session.id ? null : session.id
                    )}
                    onViewActivity={viewActivity}
                  />
                ))
              )}
            </div>
          </div>

          {recentSessions.length > 0 && (
            <div className="sessions-section">
              <h3 className="section-title">
                Recent
                <span className="section-count">{recentSessions.length}</span>
              </h3>
              <div className="sessions-list">
                {recentSessions.map(session => (
                  <SessionCard
                    key={session.id}
                    session={session}
                    isSelected={selectedSessionId === session.id}
                    isActive={false}
                    onClick={() => setSelectedSessionId(
                      selectedSessionId === session.id ? null : session.id
                    )}
                    onViewActivity={viewActivity}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Events Panel */}
        <div className="events-panel">
          <div className="events-header">
            <h3 className="section-title">
              Live Event Stream
              {selectedSessionId && (
                <span className="filter-badge" onClick={() => setSelectedSessionId(null)}>
                  Filtered ×
                </span>
              )}
            </h3>
            <button
              className={`pause-btn ${isPaused ? 'paused' : ''}`}
              onClick={() => setIsPaused(!isPaused)}
            >
              {isPaused ? '▶ Resume' : '⏸ Pause'}
            </button>
          </div>

          <div
            className="events-list"
            ref={eventListRef}
            onMouseEnter={() => setIsPaused(true)}
            onMouseLeave={() => setIsPaused(false)}
          >
            {filteredEvents.length === 0 ? (
              <div className="no-events">
                {connected ? 'Waiting for events...' : 'Connecting...'}
              </div>
            ) : (
              filteredEvents.map(event => (
                <EventItem
                  key={event.id}
                  event={event}
                  isHighlighted={selectedSessionId && event.session_id === selectedSessionId}
                  onViewActivity={viewActivity}
                />
              ))
            )}
          </div>

          {isPaused && (
            <div className="paused-banner">
              Paused - Hover off to resume
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
