/**
 * InfraView — QuoxAgents Management Console
 *
 * Left: Quick actions, fleet stats, license.
 * Centre: Agent fleet panel (hero), live event stream, playbooks, jobs.
 * Right: Multi-agent chat sidebar (DAEDALUS, WARDEN, CIPHER).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  AgentFleetPanel,
  GPUFleetPanel,
} from '../../components/core/monitoring';
import DevServersHubPanel from '../../components/core/devsuite/DevServersHubPanel';
import LiveEventStream from '../../components/core/monitoring/LiveEventStream';
import PlaybooksPanel from '../../components/core/monitoring/PlaybooksPanel';
import JobsPanel from '../../components/core/monitoring/JobsPanel';
import { InfraChatSidebar } from '../../components/core/monitoring/InfraChatSidebar';
import { InfraActionsSidebar } from '../../components/core/monitoring/InfraActionsSidebar';
import './infra.css';

// LocalStorage persistence keys
const LS_SHOW_ACTIONS = 'infra-show-actions';
const LS_SHOW_CHAT = 'infra-show-chat';

function InfraView() {
  const { halState } = useOutletContext() || {};

  // Agent fleet data
  const [agents, setAgents] = useState([]);
  const [fleetSummary, setFleetSummary] = useState(null);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [isLive, setIsLive] = useState(false);

  // Chat agent selection
  const [chatAgent, setChatAgent] = useState('nova');

  // Sidebar toggles (persisted)
  const [showActions, setShowActions] = useState(() => {
    const saved = localStorage.getItem(LS_SHOW_ACTIONS);
    return saved !== null ? saved === 'true' : true;
  });
  const [showChat, setShowChat] = useState(() => {
    const saved = localStorage.getItem(LS_SHOW_CHAT);
    return saved !== null ? saved === 'true' : true;
  });

  // Ref to chat sendMessage for quick actions
  const chatSendRef = useRef(null);

  // Persist sidebar state
  useEffect(() => { localStorage.setItem(LS_SHOW_ACTIONS, showActions); }, [showActions]);
  useEffect(() => { localStorage.setItem(LS_SHOW_CHAT, showChat); }, [showChat]);

  // Fetch fleet data
  const fetchFleetData = useCallback(async () => {
    try {
      const res = await fetch(`${window.location.origin}/collector/api/v1/agents`);
      if (res.ok) {
        const data = await res.json();
        setAgents(data.agents || []);
        setIsLive(true);
      } else {
        setIsLive(false);
      }
    } catch {
      setIsLive(false);
    }

    try {
      const res = await fetch(`${window.location.origin}/collector/api/v1/fleet/summary`);
      if (res.ok) {
        const data = await res.json();
        setFleetSummary(data);
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchFleetData();
    const interval = setInterval(fetchFleetData, 10000);
    return () => clearInterval(interval);
  }, [fetchFleetData]);

  const connectedCount = agents.filter(a => a.status?.connection === 'connected').length;

  const handleQuickAction = useCallback((action) => {
    if (chatSendRef.current) chatSendRef.current(action.prompt);
    setShowChat(true);
  }, []);

  const handleAskChat = useCallback((prompt) => {
    if (chatSendRef.current) chatSendRef.current(prompt);
    setShowChat(true);
  }, []);

  return (
    <div className="infra-view">
      {/* ── Header bar ── */}
      <div className="iv-header">
        <div className="iv-header__left">
          <span className="iv-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255,255,255,0.7)' }} strokeWidth="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1" fill="rgba(255,255,255,0.7)"/><circle cx="6" cy="18" r="1" fill="rgba(255,255,255,0.7)"/></svg>
            QuoxAgents
          </span>
          <span className={`iv-conn ${isLive ? 'iv-conn--live' : 'iv-conn--offline'}`}>
            <span className="iv-conn-dot" />
            {isLive ? 'LIVE' : 'OFFLINE'}
          </span>
          {agents.length > 0 && (
            <span className="iv-agent-count">
              <span className="iv-count-online">{connectedCount}</span>
              <span className="iv-count-sep">/</span>
              <span className="iv-count-total">{agents.length}</span>
              <span className="iv-count-label">agents</span>
            </span>
          )}
        </div>
        <div className="iv-header__right">
          <button
            className={`iv-sidebar-toggle ${showActions ? 'iv-sidebar-toggle--active' : ''}`}
            onClick={() => setShowActions(v => !v)}
            title={showActions ? 'Hide actions' : 'Show actions'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'currentColor' }} strokeWidth="2"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1" opacity="0.3"/></svg>
          </button>
          <button
            className={`iv-sidebar-toggle ${showChat ? 'iv-sidebar-toggle--active' : ''}`}
            onClick={() => setShowChat(v => !v)}
            title={showChat ? 'Hide chat' : 'Show chat'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'currentColor' }} strokeWidth="2"><rect x="3" y="3" width="7" height="18" rx="1" opacity="0.3"/><rect x="14" y="3" width="7" height="18" rx="1"/></svg>
          </button>
        </div>
      </div>

      {/* ── 3-column body ── */}
      <div className="iv-body">
        {/* Left: Actions sidebar */}
        <div className={`iv-actions ${showActions ? '' : 'iv-actions--collapsed'}`}>
          <InfraActionsSidebar
            agents={agents}
            onAction={handleQuickAction}
          />
        </div>

        {/* Centre: Main content */}
        <div className="iv-centre">
          <LiveEventStream />
          <AgentFleetPanel onSelectAgent={setSelectedAgent} />
          <GPUFleetPanel />
          <DevServersHubPanel />
          {/* DocsPanel removed 2026-10-08: it listed Quox's own repo maps and STATUS docs to every org. Customer replacement is an owner call (DEVSUITE phase 25). */}
          <PlaybooksPanel onAskChat={handleAskChat} />
          <JobsPanel />
        </div>

        {/* Right: Chat sidebar */}
        <div className={`iv-chat ${showChat ? '' : 'iv-chat--collapsed'}`}>
          <InfraChatSidebar
            agents={agents}
            fleetSummary={fleetSummary}
            selectedAgent={selectedAgent}
            selectedChatAgent={chatAgent}
            onChatAgentChange={setChatAgent}
            sendRef={chatSendRef}
          />
        </div>
      </div>
    </div>
  );
}

export default InfraView;
