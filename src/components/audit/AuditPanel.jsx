/**
 * AuditPanel - QuoxFlow Audit Trail Viewer
 *
 * Shows recent tool executions that went through QuoxFlow's audit proxy.
 * Displays envelope chains (task -> result/error) for each operation.
 */

import { useState, useEffect, useCallback } from 'react';
import { quoxflowClient, getEnvelopeChain } from '../../services/quoxflowClient';

const STATUS_STYLES = {
  result: { color: 'var(--color-success)', label: 'Success' },
  error: { color: 'var(--color-danger)', label: 'Error' },
  task: { color: 'var(--color-warning)', label: 'Pending' }
};

function EnvelopeRow({ envelope, isExpanded, onToggle }) {
  const style = STATUS_STYLES[envelope.type] || { color: 'var(--text-secondary)', label: envelope.type };
  const payload = envelope.payload || {};
  const ts = new Date(envelope.ts);

  return (
    <div className="audit-envelope">
      <div className="audit-envelope__row" onClick={onToggle}>
        <span className="audit-envelope__type" style={{ color: style.color }}>
          {style.label}
        </span>
        <span className="audit-envelope__intent">{envelope.intent}</span>
        <span className="audit-envelope__time">{ts.toLocaleTimeString()}</span>
        <span className="audit-envelope__toggle">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }}><polyline points="6 9 12 15 18 9"/></svg>
        </span>
      </div>
      {isExpanded && (
        <div className="audit-envelope__details">
          <div className="audit-envelope__field">
            <span className="audit-envelope__key">ID:</span> {envelope.id}
          </div>
          <div className="audit-envelope__field">
            <span className="audit-envelope__key">From:</span> {envelope.from}
          </div>
          {envelope.reply_to && (
            <div className="audit-envelope__field">
              <span className="audit-envelope__key">Reply To:</span> {envelope.reply_to}
            </div>
          )}
          {Object.keys(payload).length > 0 && (
            <div className="audit-envelope__field">
              <span className="audit-envelope__key">Payload:</span>
              <pre className="audit-envelope__payload">
                {JSON.stringify(payload, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AuditExecution({ envelopes, onTraceChain }) {
  const [expanded, setExpanded] = useState(null);
  const taskEnvelope = envelopes.find(e => e.type === 'task');
  const resultEnvelope = envelopes.find(e => e.type === 'result' || e.type === 'error');

  if (!taskEnvelope) return null;

  const webhookPath = taskEnvelope.payload?.webhookPath || taskEnvelope.to || 'unknown';
  const status = resultEnvelope?.type || 'task';
  const style = STATUS_STYLES[status];
  const startTime = new Date(taskEnvelope.ts);
  const endTime = resultEnvelope ? new Date(resultEnvelope.ts) : null;
  const duration = endTime ? endTime - startTime : null;

  return (
    <div className="audit-execution">
      <div className="audit-execution__header">
        <div className="audit-execution__info">
          <span className="audit-execution__path">{webhookPath}</span>
          <span className="audit-execution__status" style={{ color: style.color }}>
            {style.label}
          </span>
        </div>
        <div className="audit-execution__meta">
          {duration !== null && (
            <span className="audit-execution__duration">{duration}ms</span>
          )}
          <span className="audit-execution__time">{startTime.toLocaleString()}</span>
          {onTraceChain && (
            <button
              className="btn btn--small audit-execution__trace"
              onClick={() => onTraceChain(taskEnvelope.id)}
              title="View full causality chain"
            >
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              Trace
            </button>
          )}
        </div>
      </div>
      <div className="audit-execution__chain">
        {envelopes.map((env) => (
          <EnvelopeRow
            key={env.id}
            envelope={env}
            isExpanded={expanded === env.id}
            onToggle={() => setExpanded(expanded === env.id ? null : env.id)}
          />
        ))}
      </div>
    </div>
  );
}

export function AuditPanel() {
  const [envelopes, setEnvelopes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(false);
  const [timeRange, setTimeRange] = useState('hour');
  const [searchCorr, setSearchCorr] = useState('');
  const [searchIntent, setSearchIntent] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [chainView, setChainView] = useState(null);
  const [chainLoading, setChainLoading] = useState(false);

  const traceChain = useCallback(async (envelopeId) => {
    setChainLoading(true);
    try {
      const result = await getEnvelopeChain(envelopeId);
      setChainView(Array.isArray(result) ? result : result?.data?.envelopes || result?.data || []);
    } catch (err) {
      setChainView(null);
      setError('Failed to load chain: ' + err.message);
    } finally {
      setChainLoading(false);
    }
  }, []);

  const loadAuditData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setChainView(null);

    try {
      // Check QuoxFlow connection first
      await quoxflowClient.testConnection();
      setConnected(true);

      // Calculate time range
      const now = new Date();
      const rangeMs = {
        hour: 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000
      };
      const since = new Date(now - rangeMs[timeRange]);

      // Build query with search filters
      const query = {
        since: since.toISOString(),
        limit: 200
      };
      if (searchCorr.trim()) {
        query.corr = searchCorr.trim();
      }
      if (searchIntent.trim()) {
        query.intent = searchIntent.trim();
      } else {
        query.intent = 'quox.flow.node.%';
      }

      // Fetch proxy audit envelopes
      const result = await quoxflowClient.queryEnvelopes(query);

      const items = Array.isArray(result) ? result
        : Array.isArray(result?.data?.envelopes) ? result.data.envelopes
        : Array.isArray(result?.data) ? result.data
        : Array.isArray(result?.envelopes) ? result.envelopes
        : [];
      setEnvelopes(items);
    } catch (err) {
      if (err.message.includes('Cannot connect')) {
        setConnected(false);
        setError('QuoxFlow is not running. Start it to see audit trails.');
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }, [timeRange, searchCorr, searchIntent]);

  useEffect(() => {
    loadAuditData();
  }, [loadAuditData]);

  // Group envelopes by correlation ID into execution chains
  const allExecutions = groupByCorrelation(envelopes);

  // Apply type filter
  const executions = typeFilter === 'all'
    ? allExecutions
    : allExecutions.filter(chain =>
        chain.some(env => env.type === typeFilter)
      );

  return (
    <div className="audit-panel">
      <div className="audit-panel__toolbar">
        <div className="filter-tabs">
          {['hour', 'day', 'week'].map(range => (
            <button
              key={range}
              className={`filter-tab ${timeRange === range ? 'filter-tab--active' : ''}`}
              onClick={() => setTimeRange(range)}
            >
              {range === 'hour' ? 'Last Hour' : range === 'day' ? 'Last 24h' : 'Last Week'}
            </button>
          ))}
        </div>
        <div className="audit-panel__status">
          <span
            className="audit-panel__dot"
            style={{ background: connected ? 'var(--color-success)' : 'var(--color-danger)' }}
          />
          {connected ? 'QuoxFlow Connected' : 'QuoxFlow Offline'}
          <button className="btn btn--small" onClick={loadAuditData}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Refresh
          </button>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className="audit-panel__search">
        <input
          type="text"
          className="audit-panel__search-input"
          placeholder="Search by correlation ID..."
          value={searchCorr}
          onChange={(e) => setSearchCorr(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && loadAuditData()}
        />
        <input
          type="text"
          className="audit-panel__search-input"
          placeholder="Filter by intent pattern..."
          value={searchIntent}
          onChange={(e) => setSearchIntent(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && loadAuditData()}
        />
        <select
          className="audit-panel__type-filter"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="all">All Types</option>
          <option value="task">Task</option>
          <option value="result">Result</option>
          <option value="error">Error</option>
          <option value="event">Event</option>
        </select>
        <button className="btn btn--small" onClick={loadAuditData}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          Search
        </button>
      </div>

      {/* Chain Trace View */}
      {chainView && (
        <div className="audit-panel__chain-view">
          <div className="audit-panel__chain-header">
            <strong>Causality Chain ({chainView.length} envelopes)</strong>
            <button className="btn btn--small" onClick={() => setChainView(null)}>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              Close
            </button>
          </div>
          <div className="audit-panel__chain-tree">
            {chainView.map((env, i) => (
              <div key={env.id} className="audit-chain-node" style={{ marginLeft: `${Math.min(i * 16, 96)}px` }}>
                <span className="audit-chain-node__connector">{i === 0 ? '' : '|--'}</span>
                <span className="audit-chain-node__type" style={{ color: (STATUS_STYLES[env.type] || {}).color || 'var(--text-secondary)' }}>
                  [{env.type}]
                </span>
                <span className="audit-chain-node__intent">{env.intent}</span>
                <span className="audit-chain-node__time">{new Date(env.ts).toLocaleTimeString()}</span>
                <span className="audit-chain-node__from">{env.from} &gt; {env.to}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {chainLoading && <div className="audit-panel__loading">Loading chain...</div>}

      {error && (
        <div className="audit-panel__error">
          {error}
        </div>
      )}

      {loading && (
        <div className="audit-panel__loading">Loading audit trail...</div>
      )}

      {!loading && !error && executions.length === 0 && (
        <div className="audit-panel__empty">
          <div className="audit-panel__empty-icon">{"{ }"}</div>
          <div className="audit-panel__empty-title">No audit records</div>
          <div className="audit-panel__empty-desc">
            {connected
              ? 'No tool executions have been audited through QuoxFlow in this time range. Enable QUOXFLOW_AUDIT_ENABLED=true in the collector .env.'
              : 'Start QuoxFlow to begin capturing audit trails for tool executions.'}
          </div>
        </div>
      )}

      {!loading && executions.length > 0 && (
        <div className="audit-panel__list">
          <div className="audit-panel__summary">
            {executions.length} execution{executions.length !== 1 ? 's' : ''} audited
            {' - '}
            {executions.filter(e => e.some(env => env.type === 'result')).length} succeeded,
            {' '}
            {executions.filter(e => e.some(env => env.type === 'error')).length} failed
          </div>
          {executions.map((chain, i) => (
            <AuditExecution
              key={chain[0]?.corr || i}
              envelopes={chain}
              onTraceChain={traceChain}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Group envelopes by correlation ID, sorted newest-first.
 */
function groupByCorrelation(envelopes) {
  const groups = {};
  for (const env of envelopes) {
    const key = env.corr || env.id;
    if (!groups[key]) groups[key] = [];
    groups[key].push(env);
  }

  // Sort each group by timestamp, then sort groups newest-first
  return Object.values(groups)
    .map(group => group.sort((a, b) => new Date(a.ts) - new Date(b.ts)))
    .sort((a, b) => new Date(b[0].ts) - new Date(a[0].ts));
}

export default AuditPanel;
