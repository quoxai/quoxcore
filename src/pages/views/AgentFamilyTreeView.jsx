/**
 * AgentFamilyTreeView - Agent Hierarchy Visualization
 *
 * A prominent "Family Tree" showing the hierarchy of all agents with
 * delegation paths, supporting future org/division assistants.
 *
 * Part of Mission 1: Agent Family Tree Visualization
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import {
  getHierarchyTree,
  getAssistant,
  listAssistants,
  getManagedAssistants,
  generateIdentityCard
} from '../../services/entityRegistry';
import {
  selectAgent,
  shouldDelegate,
  DELEGATION_CONFIG,
  generateAgentDirectory
} from '../../services/agentDelegator';
import { getRouterConfig, updateRouterConfig } from '../../services/routerConfig';
import { PageSection } from '../../components/layout';
import './AgentFamilyTreeView.css';

// Role colors matching the existing system
const ROLE_COLORS = {
  orchestrator: '#38bdf8',
  manager: '#30ff90',
  analyst: '#4285f4',
  specialist: '#ffcc00'
};

// View mode icons
const ViewIcon = ({ type }) => {
  switch (type) {
    case 'hierarchy':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="18" height="18">
          <circle cx="12" cy="4" r="2"/>
          <line x1="12" y1="6" x2="12" y2="10"/>
          <line x1="6" y1="10" x2="18" y2="10"/>
          <line x1="6" y1="10" x2="6" y2="14"/>
          <line x1="18" y1="10" x2="18" y2="14"/>
          <circle cx="6" cy="16" r="2"/>
          <circle cx="18" cy="16" r="2"/>
        </svg>
      );
    case 'delegation':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="18" height="18">
          <circle cx="5" cy="12" r="3"/>
          <circle cx="19" cy="12" r="3"/>
          <path d="M8 12h8" strokeLinecap="round"/>
          <path d="M13 9l3 3-3 3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      );
    case 'context':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="18" height="18">
          <rect x="3" y="3" width="6" height="6" rx="1"/>
          <rect x="15" y="3" width="6" height="6" rx="1"/>
          <rect x="9" y="15" width="6" height="6" rx="1"/>
          <line x1="9" y1="6" x2="15" y2="6"/>
          <line x1="12" y1="9" x2="12" y2="15"/>
        </svg>
      );
    default:
      return null;
  }
};

// Tree node component
function TreeNode({ node, level = 0, onSelect, selectedId, expandedNodes, onToggle }) {
  const isExpanded = expandedNodes.has(node.id);
  const isSelected = selectedId === node.id;
  const hasChildren = node.children && node.children.length > 0;
  const roleColor = ROLE_COLORS[node.hierarchy?.role] || '#888';
  const isPremium = !!node.requiresPlugin;

  return (
    <div className="family-tree-node" data-level={level}>
      <div
        className={`tree-node-card ${isSelected ? 'selected' : ''}`}
        style={{ '--node-color': node.identity?.color?.primary || '#666', '--role-color': roleColor }}
        onClick={() => onSelect(node.id)}
      >
        {/* Connection line */}
        {level > 0 && <div className="tree-node-connector" />}

        {/* Expand toggle */}
        {hasChildren && (
          <button
            className="tree-node-toggle"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.id);
            }}
          >
            <svg viewBox="0 0 12 12" width="12" height="12">
              <path
                d={isExpanded ? 'M2 4l4 4 4-4' : 'M4 2l4 4-4 4'}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}

        {/* Avatar */}
        <div
          className="tree-node-avatar"
          style={{ backgroundColor: `${node.identity?.color?.primary || '#666'}20` }}
        >
          <span style={{ color: node.identity?.color?.primary }}>{node.identity?.shortName || '?'}</span>
        </div>

        {/* Info */}
        <div className="tree-node-info">
          <div className="tree-node-name">{node.identity?.name || node.id}</div>
          <div className="tree-node-role" style={{ color: roleColor }}>
            {node.hierarchy?.role || 'unknown'} · L{node.hierarchy?.level ?? '?'}
          </div>
        </div>

        {/* Domains */}
        <div className="tree-node-domains">
          {(node.capabilities?.domains || []).slice(0, 2).map(d => (
            <span key={d} className="domain-chip">{d}</span>
          ))}
        </div>

        {/* DEFCON indicator */}
        <div className={`tree-node-defcon defcon-${(node.safety?.defconLevel || 'GREEN').toLowerCase()}`}>
          {node.safety?.defconLevel || 'GREEN'}
        </div>

        {/* Premium indicator */}
        {isPremium && (
          <div className="tree-node-premium" title={`Requires: ${node.requiresPlugin}`}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
          </div>
        )}
      </div>

      {/* Children */}
      {hasChildren && isExpanded && (
        <div className="tree-node-children">
          {node.children.map(child => (
            <TreeNode
              key={child.id}
              node={child}
              level={level + 1}
              onSelect={onSelect}
              selectedId={selectedId}
              expandedNodes={expandedNodes}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Detail panel for selected agent
function AgentDetailPanel({ agent, onClose, onEdit }) {
  const navigate = useNavigate();

  if (!agent) {
    return (
      <div className="agent-detail-panel empty">
        <div className="detail-empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="48" height="48">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 16v-4M12 8h.01"/>
          </svg>
          <p>Select an agent to view details</p>
        </div>
      </div>
    );
  }

  const roleColor = ROLE_COLORS[agent.hierarchy?.role] || '#888';
  const managed = getManagedAssistants(agent.id);

  const handleEdit = () => {
    navigate('/assistants', { state: { editAssistant: agent.id } });
  };

  return (
    <div className="agent-detail-panel">
      <div className="detail-header">
        <div
          className="detail-avatar"
          style={{ backgroundColor: `${agent.identity?.color?.primary || '#666'}20` }}
        >
          <span style={{ color: agent.identity?.color?.primary, fontSize: '24px' }}>
            {agent.identity?.shortName || '?'}
          </span>
        </div>
        <div className="detail-title">
          <h2>{agent.identity?.name}</h2>
          <p>{agent.identity?.tagline}</p>
        </div>
        <button className="detail-close" onClick={onClose}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 6l12 12M6 18L18 6"/>
          </svg>
        </button>
      </div>

      <div className="detail-body">
        {/* Premium Plugin Indicator */}
        {agent.requiresPlugin && (
          <div className="detail-section detail-premium-banner">
            <div className="premium-banner-content">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
              <span>Premium Agent</span>
            </div>
            <p className="premium-plugin-name">Requires: {agent.requiresPlugin}</p>
          </div>
        )}

        {/* Role & Level */}
        <div className="detail-section">
          <h4>Role</h4>
          <div className="detail-badges">
            <span className="detail-badge" style={{ borderColor: roleColor, color: roleColor }}>
              {agent.hierarchy?.role}
            </span>
            <span className="detail-badge">Level {agent.hierarchy?.level}</span>
            <span className={`detail-badge defcon-${(agent.safety?.defconLevel || 'GREEN').toLowerCase()}`}>
              DEFCON: {agent.safety?.defconLevel || 'GREEN'}
            </span>
          </div>
        </div>

        {/* Description */}
        <div className="detail-section">
          <h4>Description</h4>
          <p className="detail-text">{agent.identity?.description}</p>
        </div>

        {/* Hierarchy */}
        <div className="detail-section">
          <h4>Hierarchy</h4>
          <div className="detail-hierarchy">
            {agent.hierarchy?.reportsTo && (
              <div className="hierarchy-item">
                <span className="hierarchy-label">Reports to:</span>
                <span className="hierarchy-value">{getAssistant(agent.hierarchy.reportsTo)?.identity?.name || agent.hierarchy.reportsTo}</span>
              </div>
            )}
            {managed.length > 0 && (
              <div className="hierarchy-item">
                <span className="hierarchy-label">Manages:</span>
                <span className="hierarchy-value">{managed.map(m => m.identity?.name).join(', ')}</span>
              </div>
            )}
            {agent.hierarchy?.canDelegateTo?.length > 0 && (
              <div className="hierarchy-item">
                <span className="hierarchy-label">Can delegate to:</span>
                <span className="hierarchy-value">
                  {agent.hierarchy.canDelegateTo.map(id => getAssistant(id)?.identity?.name || id).join(', ')}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Capabilities */}
        <div className="detail-section">
          <h4>Capabilities</h4>
          <div className="detail-chips">
            {(agent.capabilities?.domains || []).map(d => (
              <span key={d} className="detail-chip">{d}</span>
            ))}
          </div>
          {agent.capabilities?.toolAccess && (
            <p className="detail-subtext">Tool Access: {agent.capabilities.toolAccess}</p>
          )}
        </div>

        {/* Rules Preview */}
        {agent.rules && (
          <div className="detail-section">
            <h4>Key Rules</h4>
            <div className="detail-rules">
              {(agent.rules.always || []).slice(0, 2).map((rule, i) => (
                <div key={i} className="rule-item rule-always">
                  <span className="rule-icon">✓</span>
                  <span>{rule}</span>
                </div>
              ))}
              {(agent.rules.never || []).slice(0, 2).map((rule, i) => (
                <div key={i} className="rule-item rule-never">
                  <span className="rule-icon">✗</span>
                  <span>{rule}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="detail-footer">
        <button className="detail-btn secondary" onClick={handleEdit}>
          Edit Persona
        </button>
        <button className="detail-btn secondary" onClick={() => navigate(`/agents/${agent.id}`)}>
          Configure Tools
        </button>
        <button
          className="detail-btn primary"
          onClick={() => navigate('/', { state: { assistant: agent.id } })}
        >
          Chat with {agent.identity?.shortName}
        </button>
      </div>
    </div>
  );
}

// Delegation Flow Panel - Shows how delegation works
function DelegationFlowPanel({ agents, onSelectAgent }) {
  const [testQuery, setTestQuery] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [config, setConfig] = useState(() => getRouterConfig());
  const [showConfig, setShowConfig] = useState(false);

  // Test delegation for a query
  const handleTestQuery = useCallback(() => {
    if (!testQuery.trim()) return;
    const result = selectAgent(testQuery);
    setTestResult(result);
  }, [testQuery]);

  // Real-time test as user types
  useEffect(() => {
    if (testQuery.length > 3) {
      const timer = setTimeout(() => {
        const result = selectAgent(testQuery);
        setTestResult(result);
      }, 300);
      return () => clearTimeout(timer);
    } else {
      setTestResult(null);
    }
  }, [testQuery]);

  // Toggle delegation enabled
  const toggleDelegation = useCallback(() => {
    const newEnabled = !config.agentDelegation?.enabled;
    updateRouterConfig({
      agentDelegation: { ...config.agentDelegation, enabled: newEnabled }
    });
    setConfig(getRouterConfig());
  }, [config]);

  // Get agent directory with capabilities
  const agentDirectory = useMemo(() => generateAgentDirectory(), []);

  // Sort by score if we have test result
  const sortedAgents = useMemo(() => {
    if (!testResult?.scores) return agentDirectory.filter(a => a.id !== 'quox');
    return [...agentDirectory]
      .filter(a => a.id !== 'quox')
      .sort((a, b) => (testResult.scores[b.id] || 0) - (testResult.scores[a.id] || 0));
  }, [agentDirectory, testResult]);

  return (
    <div className="delegation-flow-panel">
      {/* Query Tester */}
      <div className="delegation-tester">
        <h3>Test Delegation</h3>
        <p className="delegation-tester-desc">
          Type a query to see which agent would handle it and why.
        </p>
        <div className="delegation-tester-input">
          <input
            type="text"
            value={testQuery}
            onChange={(e) => setTestQuery(e.target.value)}
            placeholder="e.g., Check for security vulnerabilities"
            onKeyDown={(e) => e.key === 'Enter' && handleTestQuery()}
          />
          <button onClick={handleTestQuery}>Test</button>
        </div>

        {/* Test Result */}
        {testResult && (
          <div className={`delegation-result ${testResult.shouldDelegate ? 'will-delegate' : 'no-delegate'}`}>
            <div className="delegation-result-header">
              {testResult.shouldDelegate ? (
                <>
                  <span className="delegation-arrow">→</span>
                  <span className="delegation-target">{testResult.agentId.toUpperCase()}</span>
                  <span className="delegation-score">Score: {testResult.score}</span>
                </>
              ) : (
                <>
                  <span className="delegation-stay">QUOX handles this</span>
                  <span className="delegation-reason">No agent scored above {DELEGATION_CONFIG.minimumScore}</span>
                </>
              )}
            </div>
            <div className="delegation-scores">
              <span className="scores-label">All scores:</span>
              {Object.entries(testResult.scores || {})
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([id, score]) => (
                  <span key={id} className={`score-item ${id === testResult.agentId ? 'winner' : ''}`}>
                    {id}: {score}
                  </span>
                ))}
            </div>
          </div>
        )}
      </div>

      {/* Configuration Toggle */}
      <div className="delegation-config-section">
        <button
          className="config-toggle-btn"
          onClick={() => setShowConfig(!showConfig)}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
          Delegation Settings
        </button>

        {showConfig && (
          <div className="delegation-config">
            <div className="config-item">
              <label>
                <input
                  type="checkbox"
                  checked={config.agentDelegation?.enabled ?? true}
                  onChange={toggleDelegation}
                />
                Enable Agent Delegation
              </label>
              <span className="config-desc">When enabled, queries route to specialized agents</span>
            </div>
            <div className="config-item">
              <label>Minimum Score: {DELEGATION_CONFIG.minimumScore}</label>
              <span className="config-desc">Queries scoring below this stay with QUOX</span>
            </div>
            <div className="config-item">
              <label>Attribution: {DELEGATION_CONFIG.attributeResponses ? 'ON' : 'OFF'}</label>
              <span className="config-desc">Prefix responses with [AGENT_NAME]</span>
            </div>
          </div>
        )}
      </div>

      {/* Agent Capability Cards */}
      <div className="delegation-agents">
        <h3>Agent Capabilities</h3>
        <p className="delegation-agents-desc">
          Each agent handles queries matching their domain. Click to view details.
        </p>

        <div className="agent-capability-grid">
          {sortedAgents.map(agent => {
            const score = testResult?.scores?.[agent.id] || 0;
            const isWinner = testResult?.agentId === agent.id && testResult?.shouldDelegate;
            const roleColor = ROLE_COLORS[agent.role] || '#888';

            return (
              <div
                key={agent.id}
                className={`agent-capability-card ${isWinner ? 'winner' : ''} ${score > 0 ? 'has-score' : ''}`}
                onClick={() => onSelectAgent(agent.id)}
              >
                <div className="capability-header">
                  <span className="capability-name" style={{ color: roleColor }}>
                    {agent.name}
                  </span>
                  {score > 0 && (
                    <span className={`capability-score ${isWinner ? 'winner' : ''}`}>
                      {score}
                    </span>
                  )}
                </div>
                <div className="capability-domain">{agent.domain}</div>
                <div className="capability-desc">{agent.description?.slice(0, 80)}...</div>
                <div className="capability-tags">
                  {agent.capabilities?.slice(0, 3).map(cap => (
                    <span key={cap} className="capability-tag">{cap}</span>
                  ))}
                </div>
                {agent.suggestions?.length > 0 && (
                  <div className="capability-examples">
                    <span className="examples-label">Handles:</span>
                    <span className="example-query">"{agent.suggestions[0]?.slice(0, 35)}..."</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* How it Works */}
      <div className="delegation-explainer">
        <h3>How Delegation Works</h3>
        <div className="explainer-steps">
          <div className="explainer-step">
            <span className="step-number">1</span>
            <span className="step-text">Query enters router, patterns are checked first</span>
          </div>
          <div className="explainer-step">
            <span className="step-number">2</span>
            <span className="step-text">If no pattern matches, agent scoring begins</span>
          </div>
          <div className="explainer-step">
            <span className="step-number">3</span>
            <span className="step-text">Each agent scored by capability, tool, and keyword match</span>
          </div>
          <div className="explainer-step">
            <span className="step-number">4</span>
            <span className="step-text">Highest scoring agent (above threshold) handles the query</span>
          </div>
          <div className="explainer-step">
            <span className="step-number">5</span>
            <span className="step-text">Agent's persona and context injected into LLM call</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Legend component
function TreeLegend() {
  return (
    <div className="tree-legend">
      <div className="legend-section">
        <span className="legend-title">Roles</span>
        <div className="legend-items">
          {Object.entries(ROLE_COLORS).map(([role, color]) => (
            <div key={role} className="legend-item">
              <span className="legend-dot" style={{ background: color }} />
              <span className="legend-label">{role}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="legend-section">
        <span className="legend-title">DEFCON</span>
        <div className="legend-items">
          <div className="legend-item">
            <span className="legend-dot defcon-green" />
            <span className="legend-label">Safe</span>
          </div>
          <div className="legend-item">
            <span className="legend-dot defcon-amber" />
            <span className="legend-label">Caution</span>
          </div>
          <div className="legend-item">
            <span className="legend-dot defcon-red" />
            <span className="legend-label">Critical</span>
          </div>
        </div>
      </div>
      <div className="legend-section">
        <span className="legend-title">Type</span>
        <div className="legend-items">
          <div className="legend-item">
            <span className="legend-icon legend-icon--core">C</span>
            <span className="legend-label">Core</span>
          </div>
          <div className="legend-item">
            <span className="legend-icon legend-icon--premium">
              <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
            </span>
            <span className="legend-label">Premium</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Main view component
export default function AgentFamilyTreeView() {
  const navigate = useNavigate();
  const { setPageActions } = useOutletContext() || {};
  const [viewMode, setViewMode] = useState('hierarchy');
  const [selectedAgentId, setSelectedAgentId] = useState(null);
  const [expandedNodes, setExpandedNodes] = useState(new Set(['quox'])); // Start with root expanded

  // Select agent and navigate to detail page on double-click or direct navigation
  const handleSelectAgent = useCallback((agentId) => {
    setSelectedAgentId(agentId);
  }, []);

  const handleNavigateToAgent = useCallback((agentId) => {
    if (agentId) navigate(`/agents/${agentId}`);
  }, [navigate]);

  // Get hierarchy tree
  const tree = useMemo(() => getHierarchyTree(), []);

  // Get all assistants for stats
  const allAssistants = useMemo(() => listAssistants(), []);

  // Selected agent
  const selectedAgent = useMemo(() =>
    selectedAgentId ? getAssistant(selectedAgentId) : null,
    [selectedAgentId]
  );

  // Expand all nodes
  const expandAll = useCallback(() => {
    const allIds = new Set(allAssistants.map(a => a.id));
    setExpandedNodes(allIds);
  }, [allAssistants]);

  // Collapse all nodes
  const collapseAll = useCallback(() => {
    setExpandedNodes(new Set(['quox']));
  }, []);

  // Toggle node expansion
  const toggleNode = useCallback((id) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Stats for header
  const stats = useMemo(() => {
    const byRole = {};
    const byLevel = {};
    for (const a of allAssistants) {
      const role = a.hierarchy?.role || 'unknown';
      const level = a.hierarchy?.level ?? -1;
      byRole[role] = (byRole[role] || 0) + 1;
      byLevel[level] = (byLevel[level] || 0) + 1;
    }
    return { total: allAssistants.length, byRole, byLevel };
  }, [allAssistants]);

  useEffect(() => {
    setPageActions?.(
      <div className="family-tree-actions">
        <button className="tree-action-btn" onClick={expandAll} title="Expand all">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>
          </svg>
        </button>
        <button className="tree-action-btn" onClick={collapseAll} title="Collapse all">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="4" y="4" width="16" height="16" rx="2"/>
          </svg>
        </button>
      </div>
    );
    return () => setPageActions?.(null);
  }, [setPageActions]);

  return (
    <div className="agent-family-tree-view view-page">
      {/* View Mode Tabs */}
      <div className="family-tree-tabs">
        <button
          className={`tree-tab ${viewMode === 'hierarchy' ? 'active' : ''}`}
          onClick={() => setViewMode('hierarchy')}
        >
          <ViewIcon type="hierarchy" />
          <span>Hierarchy</span>
        </button>
        <button
          className={`tree-tab ${viewMode === 'delegation' ? 'active' : ''}`}
          onClick={() => setViewMode('delegation')}
        >
          <ViewIcon type="delegation" />
          <span>Delegation Flow</span>
        </button>
        <button
          className={`tree-tab ${viewMode === 'context' ? 'active' : ''}`}
          onClick={() => setViewMode('context')}
        >
          <ViewIcon type="context" />
          <span>Context Flow</span>
        </button>
      </div>

      {/* Main Content */}
      <div className="family-tree-content">
        {/* Tree Panel */}
        <div className="family-tree-main">
          <TreeLegend />

          {viewMode === 'hierarchy' && tree && (
            <div className="family-tree-canvas">
              <TreeNode
                node={tree}
                onSelect={setSelectedAgentId}
                selectedId={selectedAgentId}
                expandedNodes={expandedNodes}
                onToggle={toggleNode}
              />
            </div>
          )}

          {viewMode === 'delegation' && (
            <DelegationFlowPanel
              agents={allAssistants}
              onSelectAgent={setSelectedAgentId}
            />
          )}

          {viewMode === 'context' && (
            <div className="family-tree-placeholder">
              <div className="placeholder-icon">
                <ViewIcon type="context" />
              </div>
              <h3>Context Flow View</h3>
              <p>See how context is passed between agents (link vs embed).</p>
              <p className="placeholder-hint">Coming in Phase 2</p>
            </div>
          )}

          {!tree && (
            <div className="family-tree-empty">
              <p>No agent hierarchy available.</p>
            </div>
          )}
        </div>

        {/* Detail Panel */}
        <AgentDetailPanel
          agent={selectedAgent}
          onClose={() => setSelectedAgentId(null)}
        />
      </div>
    </div>
  );
}
