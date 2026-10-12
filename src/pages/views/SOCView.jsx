/**
 * SOCView - Security Operations Center — 3-Column Command Centre
 *
 * Security monitoring hub matching NOC's layout parity:
 * Left: SOC suite plugin cards. Centre: Posture + Agents + Threats + Actions. Right: Agent chat sidebar.
 * Real Wazuh data, no crossover with NOC (infra ops).
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useOutletContext, useNavigate } from 'react-router-dom';
import { SOCChatSidebar } from '../../components/core/monitoring/SOCChatSidebar';
import { ActionConfirmationModal } from '../../components/safety/ActionConfirmationModal';
import { ActionResultsPanel, useActionExecution } from '../../components/core/actions';
import { isPluginLicensed } from '../../services/licenseValidator';
import * as wazuhClient from '../../services/wazuhClient';
import './soc.css';

const CHECKLIST_KEY = 'quox_soc_checklist';

// ── SVG Icons ────────────────────────────────────────────────────────────────

const ICONS = {
  shield: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ff4444" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  refresh: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>,
  chevron: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>,
  lock: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
  warning: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
};

// ── SOC Actions ──────────────────────────────────────────────────────────────

const SOC_ACTIONS = [
  { id: 'threat', label: 'Threat Scan', icon: 'T', description: 'Comprehensive threat scan across all monitored systems', severity: 'warning', enabled: true, prompt: 'Run a comprehensive threat scan and report any suspicious activity' },
  { id: 'firewall', label: 'Firewall Status', icon: 'F', description: 'Check firewall rules and report anomalies', severity: 'info', enabled: true, prompt: 'Check firewall rules and report any anomalies' },
  { id: 'auth', label: 'Auth Logs', icon: 'A', description: 'Analyze recent authentication failures', severity: 'info', enabled: true, prompt: 'Show recent authentication failures and suspicious login attempts' },
  { id: 'incident', label: 'Incidents', icon: '!', description: 'List open security incidents and active alerts', severity: 'info', enabled: true, prompt: 'List any open security incidents or alerts' },
  { id: 'cve', label: 'CVE Search', icon: 'C', description: 'Search for recent critical CVEs', severity: 'info', enabled: true, prompt: 'Search for recent critical CVEs affecting our infrastructure' },
  { id: 'ids', label: 'IDS Alerts', icon: 'I', description: 'Query intrusion detection system', severity: 'info', enabled: false, requiresBackend: 'suricata/snort', prompt: 'Check intrusion detection system for recent alerts' },
  { id: 'vuln', label: 'Vuln Scan', icon: 'V', description: 'Run vulnerability assessment on key systems', severity: 'warning', enabled: false, requiresBackend: 'vulnerability-scanner', prompt: 'Run a quick vulnerability assessment on key systems' },
  { id: 'baseline', label: 'Baseline Check', icon: 'B', description: 'Compare against established security baseline', severity: 'info', enabled: false, requiresBackend: 'baseline-config', prompt: 'Compare current system state against security baseline' },
];

// ── SOC Suite Plugins ────────────────────────────────────────────────────────

const SOC_PLUGINS = [
  {
    id: 'wazuh',
    label: 'Wazuh SIEM',
    route: '/wazuh',
    color: '#00a9e5',
    description: 'Log analysis, threat detection, agent management',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00a9e5" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4M12 16h.01" strokeLinecap="round"/></svg>,
  },
  {
    id: 'ids-plugin',
    label: 'IDS / Suricata',
    route: null,
    color: '#e6522c',
    description: 'Intrusion detection and network traffic analysis',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e6522c" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>,
  },
  {
    id: 'vuln-scanner',
    label: 'Vulnerability Scanner',
    route: null,
    color: '#f59e0b',
    description: 'OpenVAS / Nessus vulnerability scanning',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  },
  {
    id: 'soar-plugin',
    label: 'SOAR',
    route: null,
    color: '#8b5cf6',
    description: 'Security orchestration and automated response',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  },
];

// ── Severity colours ─────────────────────────────────────────────────────────

const SEVERITY_COLORS = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#ca8a04',
  low: '#65a30d',
  info: '#0891b2',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function getTimeAgo(date) {
  const diff = Date.now() - date;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Subcomponents ────────────────────────────────────────────────────────────

function PostureCard({ wazuhOverview, wazuhError, threats }) {
  const agentStats = wazuhOverview?.agents || {};
  const managerHealthy = wazuhOverview?.manager?.healthy;
  const total = agentStats.total || 0;
  const active = agentStats.active || 0;
  const disconnected = agentStats.disconnected || 0;
  const healthPct = total > 0 ? Math.round((active / total) * 100) : 0;
  const threatCount = threats.filter(t => t.severity === 'critical' || t.severity === 'high').length;
  const noData = !wazuhOverview && !wazuhError;
  const emptyResult = wazuhOverview && total === 0 && !wazuhError;

  return (
    <div className="sv-posture">
      <div className="sv-posture__header">
        <div className="sv-posture__title">
          {ICONS.shield}
          <span>Security Posture</span>
        </div>
        <div className="sv-posture__score" style={{
          color: wazuhError ? '#ff4444' : noData ? '#666' : healthPct >= 90 ? '#4ade80' : healthPct >= 70 ? '#ffb030' : '#ff5555'
        }}>
          {wazuhError ? '—' : noData ? '...' : `${healthPct}%`}
        </div>
      </div>
      {(noData || emptyResult) && !wazuhError && (
        <div className="sv-posture__offline-note" style={{ borderColor: 'rgba(255, 176, 48, 0.2)', background: 'rgba(255, 176, 48, 0.05)', color: '#ffb030' }}>
          {ICONS.warning}
          {noData ? 'Connecting to Wazuh...' : 'No Wazuh agents enrolled. Activate the Wazuh plugin and enrol agents to see security data.'}
        </div>
      )}
      {!noData && (
      <div className="sv-posture__stats">
        <div className="sv-posture__stat">
          <span className="sv-posture__stat-value" style={{ color: '#4ade80' }}>{active}</span>
          <span className="sv-posture__stat-label">Active</span>
        </div>
        <div className="sv-posture__stat">
          <span className="sv-posture__stat-value" style={{ color: disconnected > 0 ? '#ff5555' : '#666' }}>{disconnected}</span>
          <span className="sv-posture__stat-label">Disconnected</span>
        </div>
        <div className="sv-posture__stat">
          <span className="sv-posture__stat-value">{total}</span>
          <span className="sv-posture__stat-label">Total</span>
        </div>
        <div className="sv-posture__stat">
          <span className="sv-posture__stat-value" style={{ color: threatCount > 0 ? '#ff5555' : '#666' }}>{threatCount}</span>
          <span className="sv-posture__stat-label">Hi/Crit Alerts</span>
        </div>
      </div>
      )}
      {total > 0 && (
        <div className="sv-posture__agents">
          {['active', 'disconnected', 'never_connected'].map(status => {
            const count = agentStats[status === 'never_connected' ? 'neverConnected' : status] || 0;
            if (count === 0) return null;
            return (
              <span key={status} className="sv-posture__agent-chip">
                <span className={`sv-posture__agent-dot sv-posture__agent-dot--${status}`} />
                <span>{count} {status.replace('_', ' ')}</span>
              </span>
            );
          })}
        </div>
      )}
      {wazuhError && (
        <div className="sv-posture__offline-note">
          {ICONS.warning}
          Wazuh unreachable — {wazuhError}
        </div>
      )}
    </div>
  );
}

function WazuhAgentGrid({ agents }) {
  const grouped = useMemo(() => {
    const groups = { active: [], disconnected: [], never_connected: [] };
    for (const agent of agents) {
      const status = agent.status || 'never_connected';
      if (groups[status]) groups[status].push(agent);
      else groups.never_connected.push(agent);
    }
    return groups;
  }, [agents]);

  const statusConfig = {
    active: { label: 'Active Agents', color: '#4ade80' },
    disconnected: { label: 'Disconnected', color: '#ff4444' },
    never_connected: { label: 'Never Connected', color: '#666' },
  };

  return (
    <div className="sv-agent-grid">
      {Object.entries(statusConfig).map(([status, config]) => {
        const list = grouped[status] || [];
        if (list.length === 0) return null;
        return (
          <div key={status}>
            <div className="sv-agent-category__header" style={{ '--cat-color': config.color }}>
              <span className="sv-agent-category__label" style={{ color: config.color }}>{config.label}</span>
              <span className="sv-agent-category__count">{list.length}</span>
            </div>
            <div className="sv-agent-category__items">
              {list.map(agent => (
                <div key={agent.id} className="sv-agent-card">
                  <div className={`sv-agent-card__dot sv-agent-card__dot--${status}`} />
                  <div className="sv-agent-card__info">
                    <span className="sv-agent-card__name">{agent.name || agent.id}</span>
                    <span className="sv-agent-card__ip">{agent.ip || '—'}</span>
                    {agent.os?.name && <span className="sv-agent-card__os">{agent.os.name}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ThreatFeed({ threats }) {
  if (threats.length === 0) return null;
  return (
    <div className="sv-threat-feed">
      {threats.map(threat => (
        <div key={threat.id} className="sv-threat" style={{ '--threat-color': SEVERITY_COLORS[threat.severity] || '#555' }}>
          <span className="sv-threat__severity" style={{ background: SEVERITY_COLORS[threat.severity] || '#555' }}>
            {threat.severity}
          </span>
          <div className="sv-threat__body">
            <div className="sv-threat__title">{threat.title}</div>
            <div className="sv-threat__meta">
              <span>{threat.source}</span>
              <span>{threat.time}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ActionCard({ action, onAction, loading }) {
  return (
    <button
      className={`sv-action ${loading ? 'sv-action--loading' : ''} ${!action.enabled ? 'sv-action--disabled' : ''}`}
      onClick={() => action.enabled && onAction(action)}
      disabled={loading || !action.enabled}
    >
      <div className={`sv-action__icon sv-action__icon--${action.severity}`}>{action.icon}</div>
      <div className="sv-action__body">
        <span className="sv-action__label">{action.label}</span>
        <span className="sv-action__desc">{action.description}</span>
      </div>
      {!action.enabled && <span className="sv-action__badge">Soon</span>}
    </button>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

function SOCView() {
  const { halState, setHalState } = useOutletContext() || {};
  const navigate = useNavigate();

  // 3-column state
  const [showPlugins, setShowPlugins] = useState(true);
  const [showChat, setShowChat] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState('sentinel');

  // Wazuh data
  const [wazuhOverview, setWazuhOverview] = useState(null);
  const [wazuhError, setWazuhError] = useState(null);
  const [wazuhAgentList, setWazuhAgentList] = useState([]);
  const [threats, setThreats] = useState([]);
  const [loading, setLoading] = useState(true);
  const refreshTimerRef = useRef(null);

  // Action execution
  const {
    currentAction, actionHistory, executingActionId,
    executeAction, cancelAction, clearHistory
  } = useActionExecution({ source: 'soc', assistant: 'sentinel' });

  const [pendingAction, setPendingAction] = useState(null);

  // Checklist — persisted to localStorage
  const [checklist, setChecklist] = useState(() => {
    try {
      const saved = localStorage.getItem(CHECKLIST_KEY);
      if (saved) return JSON.parse(saved);
    } catch { /* ignore */ }
    return { firewallReviewed: false, authLogsAnalyzed: false, vulnScan: false, backupVerification: false };
  });

  useEffect(() => {
    try { localStorage.setItem(CHECKLIST_KEY, JSON.stringify(checklist)); } catch { /* */ }
  }, [checklist]);

  // Fetch Wazuh data
  const fetchData = useCallback(async () => {
    try {
      const overview = await wazuhClient.getOverview();
      setWazuhOverview(overview);
      setWazuhAgentList(overview.agents?.list || []);
      setWazuhError(null);
    } catch (err) {
      setWazuhError(err.message);
    }

    try {
      const alertData = await wazuhClient.getAlerts({ limit: '10' });
      // Collector returns { success, data: [...alerts], total } where each alert is
      // already the unwrapped _source object (server.js maps hits.hits -> h._source).
      const alerts = Array.isArray(alertData?.data) ? alertData.data : [];
      if (alerts.length) {
        const mapped = alerts.slice(0, 8).map((alert, i) => {
          const level = alert.rule?.level || 0;
          let severity = 'info';
          if (level >= 12) severity = 'critical';
          else if (level >= 10) severity = 'high';
          else if (level >= 7) severity = 'medium';
          else if (level >= 4) severity = 'low';
          const ts = alert.timestamp;
          return {
            id: alert.id || i,
            severity,
            title: alert.rule?.description || 'Unknown alert',
            source: alert.agent?.name || 'Unknown',
            time: ts ? getTimeAgo(new Date(ts)) : '—',
          };
        });
        setThreats(mapped);
      }
    } catch { /* keep existing */ }

    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    refreshTimerRef.current = setInterval(fetchData, 60000);
    return () => { if (refreshTimerRef.current) clearInterval(refreshTimerRef.current); };
  }, [fetchData]);

  const handleActionClick = useCallback((action) => setPendingAction(action), []);
  const handleActionConfirm = useCallback((action) => { setPendingAction(null); executeAction(action); }, [executeAction]);
  const handleActionCancel = useCallback(() => setPendingAction(null), []);
  const handleChecklistChange = useCallback((key) => {
    setChecklist(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const agentStats = wazuhOverview?.agents || {};
  const managerHealthy = wazuhOverview?.manager?.healthy;

  return (
    <div className="soc-view">
      {/* ── Header bar ── */}
      <div className="sv-header">
        <div className="sv-header__left">
          <span className="sv-title">
            {ICONS.shield}
            SOC
          </span>
          <span className={`sv-conn ${managerHealthy === true ? 'sv-conn--live' : wazuhError ? 'sv-conn--error' : ''}`}>
            <span className="sv-conn-dot" />
            {managerHealthy === true ? 'WAZUH LIVE' : wazuhError ? 'OFFLINE' : loading ? 'CHECKING' : 'NO DATA'}
          </span>
          {managerHealthy === true && (
            <span className="sv-agent-count">
              <span className="sv-count-value sv-count-value--green">{agentStats.active || 0}</span>
              <span className="sv-count-sep">/</span>
              <span className="sv-count-total">{agentStats.total || 0}</span>
              <span className="sv-count-label">agents</span>
            </span>
          )}
          {threats.length > 0 && (
            <span className="sv-alert-count">
              <span className={`sv-count-value ${threats.some(t => t.severity === 'critical' || t.severity === 'high') ? 'sv-count-value--red' : 'sv-count-value--amber'}`}>
                {threats.length}
              </span>
              <span className="sv-count-label">alerts</span>
            </span>
          )}
        </div>
        <div className="sv-header__right">
          <button className="sv-refresh-btn" onClick={fetchData} title="Refresh data">
            {ICONS.refresh}
          </button>
          <button
            className={`sv-sidebar-toggle ${showPlugins ? 'sv-sidebar-toggle--active' : ''}`}
            onClick={() => setShowPlugins(v => !v)}
            title={showPlugins ? 'Hide plugins' : 'Show plugins'}
          >
            <span>◧</span>
          </button>
          <button
            className={`sv-sidebar-toggle ${showChat ? 'sv-sidebar-toggle--active' : ''}`}
            onClick={() => setShowChat(v => !v)}
            title={showChat ? 'Hide chat' : 'Show chat'}
          >
            <span>◨</span>
          </button>
        </div>
      </div>

      {/* ── 3-column body ── */}
      <div className="sv-body">
        {/* ── Left: Plugin sidebar ── */}
        <div className={`sv-plugins ${showPlugins ? '' : 'sv-plugins--collapsed'}`}>
          <div className="sv-section-label">Security Suite</div>
          {SOC_PLUGINS.map(plugin => {
            const licensed = isPluginLicensed(plugin.id);
            const isBuilt = plugin.id === 'wazuh'; // Only Wazuh is currently implemented
            const isAvailable = isBuilt && licensed;
            // Status dot reflects real reachability, not just "is this plugin built"
            const pluginHealthy = isBuilt && licensed && managerHealthy === true;
            return (
              <div
                key={plugin.id}
                className={`sv-plugin-card ${!isAvailable ? 'sv-plugin-card--locked' : ''}`}
                style={{ '--plugin-color': plugin.color }}
              >
                <div className="sv-plugin-card__header">
                  <div className="sv-plugin-card__icon">{plugin.icon}</div>
                  <span className="sv-plugin-card__name">{plugin.label}</span>
                  <span className={`sv-plugin-card__status ${pluginHealthy ? 'sv-plugin-card__status--active' : 'sv-plugin-card__status--inactive'}`} />
                </div>
                <div className="sv-plugin-card__body">{plugin.description}</div>
                {isAvailable && plugin.route && (
                  <div className="sv-plugin-card__footer" onClick={() => navigate(plugin.route)}>
                    <span className="sv-plugin-card__link">
                      Open {plugin.label} {ICONS.chevron}
                    </span>
                  </div>
                )}
                {!isAvailable && (
                  <div className="sv-plugin-card__locked">
                    {ICONS.lock}
                    <span>Coming soon</span>
                  </div>
                )}
              </div>
            );
          })}

          {/* Security Checklist */}
          <div className="sv-section-label" style={{ marginTop: 20 }}>Daily Checklist</div>
          <div className="sv-checklist">
            {[
              { key: 'firewallReviewed', label: 'Firewall rules reviewed' },
              { key: 'authLogsAnalyzed', label: 'Auth logs analyzed' },
              { key: 'vulnScan', label: 'Vulnerability scan' },
              { key: 'backupVerification', label: 'Backup verification' },
            ].map(item => (
              <label key={item.key} className="sv-checklist__item" onClick={() => handleChecklistChange(item.key)}>
                <input type="checkbox" checked={checklist[item.key]} onChange={() => {}} />
                <span>{item.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* ── Centre: Posture + Agents + Threats + Actions ── */}
        <div className="sv-centre">
          <PostureCard
            wazuhOverview={wazuhOverview}
            wazuhError={wazuhError}
            threats={threats}
          />

          {/* Wazuh Agent Grid */}
          {wazuhAgentList.length > 0 && (
            <>
              <div className="sv-section-label">Wazuh Agents</div>
              <WazuhAgentGrid agents={wazuhAgentList} />
            </>
          )}

          {/* Threat Feed */}
          {threats.length > 0 && (
            <>
              <div className="sv-section-label sv-section-label--centre">Threat Feed</div>
              <ThreatFeed threats={threats} />
            </>
          )}

          {/* Operations */}
          <div className="sv-section-label sv-section-label--centre">Security Actions</div>
          <ActionResultsPanel
            currentAction={currentAction}
            history={actionHistory}
            onClearHistory={clearHistory}
            onCancelAction={cancelAction}
          />
          <div className="sv-actions-grid">
            {SOC_ACTIONS.map(action => (
              <ActionCard
                key={action.id}
                action={action}
                onAction={handleActionClick}
                loading={executingActionId === action.id}
              />
            ))}
          </div>
        </div>

        {/* ── Right: Chat sidebar ── */}
        <div className={`sv-chat ${showChat ? '' : 'sv-chat--collapsed'}`}>
          <SOCChatSidebar
            wazuhOverview={wazuhOverview}
            wazuhError={wazuhError}
            threats={threats}
            selectedAgent={selectedAgent}
            onAgentChange={setSelectedAgent}
          />
        </div>
      </div>

      <ActionConfirmationModal
        isOpen={pendingAction !== null}
        onClose={handleActionCancel}
        onConfirm={handleActionConfirm}
        action={pendingAction}
        loading={executingActionId === pendingAction?.id}
      />
    </div>
  );
}

export default SOCView;
