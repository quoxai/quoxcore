/**
 * NOCView - Network Operations Center — 3-Column Command Centre
 *
 * Infrastructure monitoring hub with popout support for multi-monitor NOC setups.
 * Left: Suite plugin cards. Centre: Fleet + Operations. Right: Agent chat sidebar.
 * No tabs — everything visible at once.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useOutletContext, useNavigate } from 'react-router-dom';
import { ProxmoxPanel, MetricsPanel, UptimePanel, GrafanaEmbed, GrafanaAlertBadge, ToolOutcomesPanel } from '../../components/core/monitoring';
import { NOCChatSidebar } from '../../components/core/monitoring/NOCChatSidebar';
import { ActionConfirmationModal } from '../../components/safety/ActionConfirmationModal';
import { ActionResultsPanel, useActionExecution } from '../../components/core/actions';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import * as bastionClient from '../../services/bastionClient';
import { isPluginLicensed } from '../../services/licenseValidator';
import { getPluginManifest } from '../../config/plugins';
import './noc.css';

const API_BASE = '/webhook';

// ── SVG Icons ────────────────────────────────────────────────────────────────

const ICONS = {
  globe: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#30ff90" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>,
  fleet: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1"/><circle cx="6" cy="18" r="1"/></svg>,
  popout: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>,
  refresh: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>,
  search: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  settings: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
  close: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  chevron: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>,
  lock: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
  // Action icons
  health: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>,
  disk: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/></svg>,
  cpu: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>,
  network: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><path d="M5 12.55a11 11 0 0114.08 0"/><path d="M1.42 9a16 16 0 0121.16 0"/><path d="M8.53 16.11a6 6 0 016.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>,
  backup: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
  services: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>,
  logs: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  docker: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
  ssl: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>,
  dns: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>,
  firewall: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  processes: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  uptime: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  security: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
};

// Category icons
const CAT_ICONS = {
  proxmox: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><rect x="2" y="2" width="20" height="20" rx="2"/><line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/></svg>,
  storage: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>,
  monitoring: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>,
  security: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  access: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
  docker: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>,
  control: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06"/></svg>,
  network: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><path d="M5 12.55a11 11 0 0114.08 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>,
  other: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><circle cx="12" cy="12" r="10"/></svg>,
};

// ── NOC Actions ──────────────────────────────────────────────────────────────

const BASE_NOC_ACTIONS = [
  { id: 'health', label: 'Health Check', icon: 'health', description: 'Comprehensive health check on all monitored infrastructure', severity: 'info', enabled: true, prompt: 'Run comprehensive health check on all infrastructure' },
  { id: 'disk', label: 'Disk Usage', icon: 'disk', description: 'Check disk usage across all systems, flag anything over 80%', severity: 'info', enabled: true, prompt: 'Check disk usage across all systems, flag anything over 80%' },
  { id: 'cpu', label: 'CPU / Memory', icon: 'cpu', description: 'Report CPU and memory utilisation across all systems', severity: 'info', enabled: true, prompt: 'Report CPU and memory usage across all systems' },
  { id: 'network', label: 'Network', icon: 'network', description: 'Check network connectivity and latency between systems', severity: 'info', enabled: true, prompt: 'Check network connectivity and latency between systems' },
  { id: 'services', label: 'Services', icon: 'services', description: 'List status of critical services across the infrastructure', severity: 'info', enabled: true, prompt: 'List status of critical services across infrastructure' },
  { id: 'logs', label: 'Error Logs', icon: 'logs', description: 'Show recent errors and warnings from system logs', severity: 'warning', enabled: true, prompt: 'Show recent errors and warnings from system logs' },
  { id: 'docker', label: 'Docker', icon: 'docker', description: 'Show status of all Docker containers across hosts', severity: 'info', enabled: true, tool: 'docker_fleet_containers', toolInput: { all: true }, prompt: 'Show status of all Docker containers' },
  { id: 'ssl', label: 'SSL Certificates', icon: 'ssl', description: 'Check SSL certificate expiry dates across all domains', severity: 'warning', enabled: true, tool: 'ssl_certificates', toolInput: {}, prompt: 'Check SSL certificate expiry dates for all domains' },
  { id: 'dns', label: 'DNS Check', icon: 'dns', description: 'Verify DNS resolution for all registered domains', severity: 'info', enabled: true, prompt: 'Verify DNS resolution for all registered domains' },
  { id: 'firewall', label: 'Firewall Rules', icon: 'firewall', description: 'Audit firewall rules across all hosts', severity: 'warning', enabled: true, prompt: 'Audit firewall rules across all hosts and flag issues' },
  { id: 'processes', label: 'Processes', icon: 'processes', description: 'Show top resource-consuming processes on each host', severity: 'info', enabled: true, prompt: 'Show top resource-consuming processes across all hosts' },
  { id: 'uptime', label: 'Uptime Summary', icon: 'uptime', description: 'Provide uptime statistics for all monitored services', severity: 'info', enabled: true, prompt: 'Provide uptime statistics for all monitored services' },
  { id: 'security', label: 'Security Scan', icon: 'security', description: 'Recent security/audit events across infrastructure', severity: 'warning', enabled: true, tool: 'security_audit', toolInput: { hours: 6 }, prompt: 'Run a quick security posture check across all infrastructure' },
  { id: 'backup', label: 'Backup Status', icon: 'backup', description: 'Verify backup status and report failed or missing backups', severity: 'warning', enabled: false, requiresBackend: 'backup-system', prompt: 'Check backup status and report any failed or missing backups' },
];

const NOC_PLUGIN_IDS = [
  'proxmox', 'prometheus', 'uptime-kuma', 'grafana',
  'wazuh', 'docker-fleet', 'bastion-fleet', 'quoxagent-fleet',
  'tailscale', 'mikrotik-routeros'
];

function getNocActions() {
  const actions = [...BASE_NOC_ACTIONS];
  for (const pluginId of NOC_PLUGIN_IDS) {
    if (!isPluginLicensed(pluginId)) continue;
    const manifest = getPluginManifest(pluginId);
    if (manifest?.nocIntegration?.quickActions) {
      for (const action of manifest.nocIntegration.quickActions) {
        actions.push({ ...action, enabled: true, pluginSource: pluginId });
      }
    }
  }
  return actions;
}

// ── Mock hosts ───────────────────────────────────────────────────────────────

const MOCK_HOSTS = [
  { id: 'hyp-01', address: '203.0.113.10', group: 'proxmox', user: 'root' },
  { id: 'hyp-02', address: '203.0.113.11', group: 'proxmox', user: 'root' },
  { id: 'edge-01', address: '203.0.113.20', group: 'docker', user: 'control' },
  { id: 'edge-02', address: '203.0.113.21', group: 'docker', user: 'control' },
  { id: 'prometheus01', address: '203.0.113.30', group: 'monitoring', user: 'control' },
  { id: 'grafana01', address: '203.0.113.31', group: 'monitoring', user: 'control' },
  { id: 'gw-01', address: '203.0.113.254', group: 'access', user: 'control' },
  { id: 'kuma01', address: '203.0.113.32', group: 'monitoring', user: 'control' },
];

// ── Host categories ──────────────────────────────────────────────────────────

const CATEGORIES = {
  proxmox: { label: 'Proxmox Cluster', color: '#e65100' },
  storage: { label: 'Storage', color: '#1565c0' },
  monitoring: { label: 'Monitoring', color: '#2e7d32' },
  security: { label: 'Security', color: '#c62828' },
  access: { label: 'Access / Bastion', color: '#7b1fa2' },
  docker: { label: 'Docker Hosts', color: '#00838f' },
  control: { label: 'Control Plane', color: '#ff5722' },
  network: { label: 'Network', color: '#546e7a' },
  other: { label: 'Other', color: '#424242' }
};

// ── Suite plugin definitions ─────────────────────────────────────────────────

const SUITE_PLUGINS = [
  {
    id: 'proxmox',
    label: 'Proxmox VE',
    route: '/proxmox',
    color: '#e65100',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e65100" strokeWidth="2"><rect x="2" y="2" width="20" height="20" rx="2"/><line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/></svg>,
  },
  {
    id: 'prometheus',
    label: 'Prometheus',
    route: '/prometheus',
    color: '#e6522c',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e6522c" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/></svg>,
  },
  {
    id: 'uptime-kuma',
    label: 'Uptime Kuma',
    route: '/uptime-kuma',
    color: '#10b981',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  },
  {
    id: 'grafana',
    label: 'Grafana',
    route: '/grafana',
    color: '#f46800',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f46800" strokeWidth="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
  },
];

// ── Subcomponents ────────────────────────────────────────────────────────────

function HostFilter({ value, onChange }) {
  return (
    <div className="noc-filter">
      <div className="noc-filter__icon">{ICONS.search}</div>
      <input
        className="noc-filter__input"
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="Filter hosts by name or IP..."
      />
      {value && (
        <button className="noc-filter__clear" onClick={() => onChange('')}>
          {ICONS.close}
        </button>
      )}
    </div>
  );
}

function HostGrid({ hosts, pingResults, onSelectHost, selectedHost, filter }) {
  const filteredGrouped = useMemo(() => {
    const lowerFilter = filter.toLowerCase();
    const filtered = filter
      ? hosts.filter(h =>
          (h.id || '').toLowerCase().includes(lowerFilter) ||
          (h.address || h.ip || '').includes(lowerFilter) ||
          (h.hostname || '').toLowerCase().includes(lowerFilter)
        )
      : hosts;

    return filtered.reduce((acc, host) => {
      const cat = host.group || host.category || 'other';
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(host);
      return acc;
    }, {});
  }, [hosts, filter]);

  return (
    <div className="noc-host-grid">
      {Object.entries(CATEGORIES).map(([key, cat]) => {
        const catHosts = filteredGrouped[key] || [];
        if (catHosts.length === 0) return null;

        const onlineCount = catHosts.filter(h => pingResults[h.id]?.reachable).length;

        return (
          <div key={key} className="noc-host-category">
            <div className="noc-host-category__header" style={{ '--cat-color': cat.color }}>
              <span className="noc-host-category__icon">{CAT_ICONS[key]}</span>
              <span className="noc-host-category__label">{cat.label}</span>
              <span className="noc-host-category__count">
                <span className="noc-host-category__online">{onlineCount}</span>/{catHosts.length}
              </span>
            </div>
            <div className="noc-host-category__items">
              {catHosts.map(host => {
                const ping = pingResults[host.id];
                const isOnline = ping?.reachable;
                const latency = ping?.latency_ms;
                const status = isOnline ? 'online' : (ping ? 'offline' : 'unknown');
                const isSelected = selectedHost?.id === host.id;
                const latencyColor = latency < 50 ? '#30ff90' : latency < 200 ? '#ffb030' : '#ff5555';

                return (
                  <button
                    key={host.id || host.hostname}
                    className={`noc-host ${isSelected ? 'noc-host--selected' : ''} noc-host--${status}`}
                    onClick={() => onSelectHost?.({ ...host, status, latency })}
                    style={{ '--status-color': status === 'online' ? '#30ff90' : status === 'offline' ? '#ff5555' : 'rgba(255,255,255,0.3)' }}
                  >
                    <div className="noc-host__indicator" />
                    <div className="noc-host__info">
                      <span className="noc-host__name">{host.id || host.hostname}</span>
                      <span className="noc-host__ip">{host.address || host.ip || host.ip_address}</span>
                    </div>
                    {latency != null && isOnline && (
                      <span className="noc-host__latency" style={{ color: latencyColor }}>
                        {latency}<span className="noc-host__latency-unit">ms</span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HostDetail({ host, onClose, onAction }) {
  if (!host) return null;

  const latencyColor = host.latency < 50 ? '#30ff90' : host.latency < 200 ? '#ffb030' : '#ff5555';

  return (
    <div className="noc-detail">
      <div className="noc-detail__header">
        <div className="noc-detail__title">
          <div className={`noc-detail__dot noc-detail__dot--${host.status || 'unknown'}`} />
          <span>{host.id || host.hostname}</span>
        </div>
        <button className="noc-detail__close" onClick={onClose}>{ICONS.close}</button>
      </div>
      <div className="noc-detail__body">
        <div className="noc-detail__row">
          <span>IP Address</span>
          <code>{host.address || host.ip || host.ip_address}</code>
        </div>
        <div className="noc-detail__row">
          <span>Group</span>
          <span>{host.group || host.category || 'other'}</span>
        </div>
        <div className="noc-detail__row">
          <span>Status</span>
          <span className={`noc-detail__status noc-detail__status--${host.status || 'unknown'}`}>
            {host.status || 'unknown'}
          </span>
        </div>
        {host.latency != null && (
          <div className="noc-detail__row">
            <span>Latency</span>
            <span style={{ color: latencyColor, fontFamily: "'SF Mono', 'Cascadia Code', monospace", fontVariantNumeric: 'tabular-nums' }}>{host.latency}ms</span>
          </div>
        )}
        <div className="noc-detail__row">
          <span>SSH User</span>
          <code>{host.user || host.ssh_user || 'control'}</code>
        </div>
        {host.description && (
          <div className="noc-detail__row">
            <span>Description</span>
            <span>{host.description}</span>
          </div>
        )}
      </div>
      <div className="noc-detail__actions">
        <button onClick={() => onAction(`Check health of ${host.id}`, host.id)}>
          {ICONS.health} Health
        </button>
        <button onClick={() => onAction(`Show disk usage on ${host.id}`, host.id)}>
          {ICONS.disk} Disk
        </button>
        <button onClick={() => onAction(`List services on ${host.id}`, host.id)}>
          {ICONS.services} Services
        </button>
        <button onClick={() => onAction(`Show Docker containers on ${host.id}`, host.id)}>
          {ICONS.docker} Docker
        </button>
      </div>
    </div>
  );
}

function FleetSummaryCard({ hosts, pingResults, bastionAvailable }) {
  const total = hosts.length;
  const online = Object.values(pingResults).filter(p => p.reachable).length;
  const offline = total - online;
  const healthPct = total > 0 ? Math.round((online / total) * 100) : 0;

  const categories = hosts.reduce((acc, h) => {
    const cat = h.group || h.category || 'other';
    acc[cat] = (acc[cat] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="noc-dash__fleet-card">
      <div className="noc-dash__fleet-header">
        <div className="noc-dash__fleet-title">
          {ICONS.fleet}
          <span>Fleet Health</span>
        </div>
        <div className="noc-dash__fleet-pct" style={{ color: healthPct >= 90 ? '#30ff90' : healthPct >= 70 ? '#ffb030' : '#ff5555' }}>
          {healthPct}%
        </div>
      </div>
      <div className="noc-dash__fleet-stats">
        <div className="noc-dash__fleet-stat">
          <span className="noc-dash__fleet-value" style={{ color: '#30ff90' }}>{online}</span>
          <span className="noc-dash__fleet-label">Online</span>
        </div>
        <div className="noc-dash__fleet-stat">
          <span className="noc-dash__fleet-value" style={{ color: offline > 0 ? '#ff5555' : 'rgba(255,255,255,0.35)' }}>{offline}</span>
          <span className="noc-dash__fleet-label">Offline</span>
        </div>
        <div className="noc-dash__fleet-stat">
          <span className="noc-dash__fleet-value">{total}</span>
          <span className="noc-dash__fleet-label">Total</span>
        </div>
      </div>
      {Object.keys(categories).length > 0 && (
        <div className="noc-dash__fleet-cats">
          {Object.entries(categories).sort((a, b) => b[1] - a[1]).map(([cat, count]) => (
            <span key={cat} className="noc-dash__fleet-cat">
              {CAT_ICONS[cat] || CAT_ICONS.other}
              <span>{CATEGORIES[cat]?.label || cat}</span>
              <span className="noc-dash__fleet-cat-count">{count}</span>
            </span>
          ))}
        </div>
      )}
      {!bastionAvailable && (
        <div className="noc-dash__fleet-offline-note">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ffb030" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
          Not connected to QuoxBastion — showing demo hosts, not your fleet. Configure Bastion to see live data.
        </div>
      )}
    </div>
  );
}

function ActionCard({ action, onAction, loading }) {
  const iconEl = ICONS[action.icon] || ICONS.health;
  return (
    <button
      className={`noc-action ${loading ? 'noc-action--loading' : ''} ${!action.enabled ? 'noc-action--disabled' : ''}`}
      onClick={() => action.enabled && onAction(action)}
      disabled={loading || !action.enabled}
    >
      <div className={`noc-action__icon noc-action__icon--${action.severity}`}>{iconEl}</div>
      <div className="noc-action__body">
        <span className="noc-action__label">{action.label}</span>
        <span className="noc-action__desc">{action.description}</span>
      </div>
      {!action.enabled && <span className="noc-action__badge">Soon</span>}
      {action.severity === 'warning' && action.enabled && (
        <span className="noc-action__severity">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#ffb030" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
        </span>
      )}
    </button>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

function NOCView() {
  const { halState, setHalState } = useOutletContext() || {};
  const navigate = useNavigate();

  // 3-column state
  const [showPlugins, setShowPlugins] = useState(true);
  const [showChat, setShowChat] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState('nova');

  // Fleet state
  const [hosts, setHosts] = useState([]);
  const [pingResults, setPingResults] = useState({});
  const [selectedHost, setSelectedHost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [usingMockData, setUsingMockData] = useState(false);
  const [bastionStatus, setBastionStatus] = useState({ available: false, lastCheck: null });
  const [hostFilter, setHostFilter] = useState('');
  const channelRef = useRef(null);

  // Action execution
  const {
    currentAction, actionHistory, executingActionId,
    executeAction, cancelAction, clearHistory
  } = useActionExecution({ source: 'noc', assistant: 'nova' });

  const [pendingAction, setPendingAction] = useState(null);

  // BroadcastChannel for popout sync
  useEffect(() => {
    channelRef.current = new BroadcastChannel('quox-noc-sync');
    channelRef.current.onmessage = (e) => {
      if (e.data.type === 'request-state') {
        channelRef.current?.postMessage({
          type: 'state-update',
          payload: { hosts, pingResults, bastionStatus, usingMockData }
        });
      }
    };
    return () => channelRef.current?.close();
  }, []);

  // Broadcast state changes to popouts
  useEffect(() => {
    channelRef.current?.postMessage({
      type: 'state-update',
      payload: { hosts, pingResults, bastionStatus, usingMockData }
    });
  }, [hosts, pingResults, bastionStatus, usingMockData]);

  // Fetch hosts
  useEffect(() => {
    fetchHostsFromBastion();
    const interval = setInterval(fetchHostsFromBastion, 30000);
    return () => clearInterval(interval);
  }, []);

  const fetchHostsFromBastion = async () => {
    try {
      const [hostList, pingData] = await Promise.all([
        bastionClient.listHosts(),
        bastionClient.pingHosts()
      ]);
      const pingMap = {};
      for (const result of pingData) {
        const key = result.host_id || result.host;
        if (key) {
          pingMap[key] = {
            reachable: result.reachable,
            latency_ms: result.latency_ms,
            error: result.error
          };
        }
      }
      setHosts(hostList);
      setPingResults(pingMap);
      setBastionStatus({ available: true, lastCheck: new Date() });
      setError(null);
      setNeedsAuth(false);
      setUsingMockData(false);
    } catch (err) {
      const isAuthError = err.message?.toLowerCase().includes('unauthorized') ||
                          err.message?.toLowerCase().includes('authentication') ||
                          err.message?.includes('HTTP 401') ||
                          err.message?.includes('HTTP 403');
      if (isAuthError) {
        setNeedsAuth(true);
        if (hosts.length === 0) {
          setHosts(MOCK_HOSTS);
          setPingResults({});
          setUsingMockData(true);
          setError('Bastion requires authentication');
        }
      } else {
        setNeedsAuth(false);
        try {
          const response = await fetch(`${API_BASE}/health`);
          if (response.ok) {
            const data = await response.json();
            setHosts((data.hosts || []).map(h => ({ id: h.hostname, address: h.ip_address, group: h.category, user: h.ssh_user || 'control' })));
            setPingResults({});
            setError('Using legacy API');
            setUsingMockData(false);
          } else throw new Error();
        } catch {
          if (hosts.length === 0) {
            setHosts(MOCK_HOSTS);
            setPingResults({});
            setUsingMockData(true);
            setError('APIs unavailable — showing placeholder data');
          }
        }
      }
      setBastionStatus({ available: false, lastCheck: new Date() });
    } finally {
      setLoading(false);
    }
  };

  const refreshPing = async () => {
    if (!bastionStatus.available) return;
    try {
      const pingData = await bastionClient.pingHosts();
      const pingMap = {};
      for (const result of pingData) {
        const key = result.host_id || result.host;
        if (key) {
          pingMap[key] = { reachable: result.reachable, latency_ms: result.latency_ms, error: result.error };
        }
      }
      setPingResults(pingMap);
    } catch {}
  };

  const handleActionClick = useCallback((action) => setPendingAction(action), []);
  const handleActionConfirm = useCallback((action) => { setPendingAction(null); executeAction(action); }, [executeAction]);
  const handleActionCancel = useCallback(() => setPendingAction(null), []);
  const handleHostAction = useCallback((prompt, hostName) => {
    setPendingAction({ id: `host-${hostName}-${Date.now()}`, label: `${hostName} Action`, description: prompt, severity: 'info', enabled: true, prompt });
  }, []);

  const openPopout = () => {
    window.open('/noc/popout', 'noc-popout', 'width=1400,height=900,menubar=no,toolbar=no');
  };

  const onlineCount = Object.values(pingResults).filter(p => p.reachable).length;
  const licensedPluginCount = NOC_PLUGIN_IDS.filter(id => isPluginLicensed(id)).length;

  // Compact panel lookup
  const CompactPanels = {
    'proxmox': ProxmoxPanel,
    'prometheus': MetricsPanel,
    'uptime-kuma': UptimePanel,
    'grafana': GrafanaEmbed,
  };

  // ── Render ──

  return (
    <div className="noc-view">
      {/* ── Header bar ── */}
      <div className="nv-header">
        <div className="nv-header__left">
          <span className="nv-title">
            {ICONS.globe}
            NOC
          </span>
          <span className={`nv-conn ${bastionStatus.available ? 'nv-conn--live' : ''}`}>
            <span className="nv-conn-dot" />
            {bastionStatus.available ? 'LIVE' : usingMockData ? 'DEMO DATA' : 'OFFLINE'}
          </span>
          {bastionStatus.available && (
            <span className="nv-host-count">
              <span className="nv-count-online">{onlineCount}</span>
              <span className="nv-count-sep">/</span>
              <span className="nv-count-total">{hosts.length}</span>
              <span className="nv-count-label">hosts</span>
            </span>
          )}
          <span className="nv-plugin-count">
            <span className="nv-count-online">{licensedPluginCount}</span>
            <span className="nv-count-sep">/</span>
            <span className="nv-count-total">{NOC_PLUGIN_IDS.length}</span>
            <span className="nv-count-label">plugins</span>
          </span>
        </div>
        <div className="nv-header__right">
          <GrafanaAlertBadge pollInterval={30000} />
          {bastionStatus.available && (
            <button className="nv-refresh-btn" onClick={refreshPing} title="Refresh ping data">
              {ICONS.refresh}
            </button>
          )}
          <button
            className={`nv-sidebar-toggle ${showPlugins ? 'nv-sidebar-toggle--active' : ''}`}
            onClick={() => setShowPlugins(v => !v)}
            title={showPlugins ? 'Hide plugins' : 'Show plugins'}
          >
            <span>◧</span>
          </button>
          <button
            className={`nv-sidebar-toggle ${showChat ? 'nv-sidebar-toggle--active' : ''}`}
            onClick={() => setShowChat(v => !v)}
            title={showChat ? 'Hide chat' : 'Show chat'}
          >
            <span>◨</span>
          </button>
          <button className="nv-popout-btn" onClick={() => navigate('/cli?screen=fleet')} title="Open the Quox CLI cockpit (fleet TUI, keyboard-driven)">
            <span style={{ fontFamily: "'SF Mono', 'Cascadia Code', monospace", fontWeight: 700 }}>❯_</span>
            <span>CLI</span>
          </button>
          <button className="nv-popout-btn" onClick={openPopout} title="Open in new window">
            {ICONS.popout}
            <span>Popout</span>
          </button>
        </div>
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className={`nv-banner ${needsAuth ? 'nv-banner--auth' : ''}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          {needsAuth ? 'Not authorized to reach QuoxBastion — showing placeholder data.' : error}
          {needsAuth && (
            <button onClick={fetchHostsFromBastion}>
              {ICONS.refresh} Retry
            </button>
          )}
        </div>
      )}

      {/* ── 3-column body ── */}
      <div className="nv-body">
        {/* ── Left: Plugin sidebar ── */}
        <div className={`nv-plugins ${showPlugins ? '' : 'nv-plugins--collapsed'}`}>
          <div className="nv-section-label">Suite</div>
          {SUITE_PLUGINS.map(plugin => {
            const licensed = isPluginLicensed(plugin.id);
            const Compact = CompactPanels[plugin.id];
            return (
              <div
                key={plugin.id}
                className={`nv-plugins-card ${licensed ? '' : 'nv-plugins-card--locked'}`}
                style={{ '--plugin-color': plugin.color }}
              >
                <div className="nv-plugins-card__header">
                  <div className="nv-plugins-card__icon">{plugin.icon}</div>
                  <span className="nv-plugins-card__name">{plugin.label}</span>
                  <span className={`nv-plugins-card__status ${licensed ? 'nv-plugins-card__status--active' : 'nv-plugins-card__status--inactive'}`} />
                </div>
                {licensed && Compact && (
                  <div className="nv-plugins-card__compact">
                    <Compact compact />
                  </div>
                )}
                {licensed && (
                  <div className="nv-plugins-card__footer" onClick={() => navigate(plugin.route)}>
                    <span className="nv-plugins-card__link">
                      Open {plugin.label} {ICONS.chevron}
                    </span>
                  </div>
                )}
                {!licensed && (
                  <div className="nv-plugins-card__locked">
                    {ICONS.lock}
                    <span>Not installed</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ── Centre: Fleet + Operations ── */}
        <div className="nv-centre">
          <FleetSummaryCard
            hosts={hosts}
            pingResults={pingResults}
            bastionAvailable={bastionStatus.available}
          />

          <HostFilter value={hostFilter} onChange={setHostFilter} />

          {loading ? (
            <div className="nv-loading">
              <div className="nv-spinner" />
              Loading fleet data from Bastion...
            </div>
          ) : (
            <div className="nv-fleet-layout">
              <div>
                <HostGrid
                  hosts={hosts}
                  pingResults={pingResults}
                  onSelectHost={setSelectedHost}
                  selectedHost={selectedHost}
                  filter={hostFilter}
                />
              </div>
              {selectedHost && (
                <HostDetail
                  host={selectedHost}
                  onClose={() => setSelectedHost(null)}
                  onAction={handleHostAction}
                />
              )}
            </div>
          )}

          <div className="nv-section-label nv-section-label--centre">Operations</div>
          <ActionResultsPanel
            currentAction={currentAction}
            history={actionHistory}
            onClearHistory={clearHistory}
            onCancelAction={cancelAction}
          />
          <div className="nv-actions-grid">
            {getNocActions().map(action => (
              <ActionCard
                key={action.id}
                action={action}
                onAction={handleActionClick}
                loading={executingActionId === action.id}
              />
            ))}
          </div>

          <div className="nv-section-label nv-section-label--centre">Tool Health</div>
          <ToolOutcomesPanel window="24h" />
        </div>

        {/* ── Right: Chat sidebar ── */}
        {/* #594: Save as Check / Schedule for NOC results render inside this
            sidebar's chat thread via RichObjectCard (NOCChatSidebar wires
            renderMessageAddon into AgentChatSidebar), not as a NOCView handler.
            The old NOCView onSaveCheck/onSchedule handlers removed in
            c3d11e85 were dead console.log stubs wired to nothing; this is the
            real capability. */}
        <div className={`nv-chat ${showChat ? '' : 'nv-chat--collapsed'}`}>
          <NOCChatSidebar
            hosts={hosts}
            pingResults={pingResults}
            bastionStatus={bastionStatus}
            selectedHost={selectedHost}
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

export default NOCView;
