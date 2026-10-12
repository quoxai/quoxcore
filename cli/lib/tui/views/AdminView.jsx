/**
 * AdminView — Admin panel with tabbed navigation
 *
 * Tabs: Config | Keys | Services | Logs | Retention
 *
 * Each tab has its own DataTable sourced from admin API endpoints.
 * Tab key cycles through tabs.
 *
 * API (all service: auth):
 *   GET /api/admin/config           -> key-value pairs
 *   GET /api/admin/keys             -> table (id, name, prefix, role, last_used)
 *   GET /api/admin/services         -> table (id, name, status, url)
 *   GET /api/admin/logs             -> table (timestamp, user_email, action, detail)
 *   GET /api/admin/retention/config -> key-value pairs
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { Layout } from '../components/Layout.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { DetailPanel } from '../components/DetailPanel.jsx';
import { useApi } from '../hooks/useApi.js';
import { useTui } from '../app.jsx';
import { matchKey } from '../keys.js';
import { colors, styles } from '../theme.js';
import { resolveEndpoint } from '../../api/endpoints.js';

// ── Tab definitions ───────────────────────────────────────────────────
const TABS = ['Config', 'Keys', 'Services', 'Logs', 'Retention'];

// ── Column definitions per tab ────────────────────────────────────────
const CONFIG_COLUMNS = [
  { key: 'key',   label: 'Key',   width: 28 },
  { key: 'value', label: 'Value', width: 36 },
];

const KEYS_COLUMNS = [
  { key: 'id',        label: 'ID',        width: 10 },
  { key: 'name',      label: 'Name',      width: 18 },
  { key: 'prefix',    label: 'Prefix',    width: 12 },
  { key: 'role',      label: 'Role',      width: 12 },
  { key: 'last_used', label: 'Last Used', width: 14 },
];

const SERVICES_COLUMNS = [
  { key: 'id',     label: 'ID',     width: 10 },
  { key: 'name',   label: 'Name',   width: 18 },
  { key: 'status', label: 'Status', width: 12 },
  { key: 'url',    label: 'URL',    width: 28 },
];

const LOGS_COLUMNS = [
  { key: 'timestamp',  label: 'Time',   width: 20 },
  { key: 'user_email', label: 'User',   width: 20 },
  { key: 'action',     label: 'Action', width: 14 },
  { key: 'detail',     label: 'Detail', width: 20 },
];

const RETENTION_COLUMNS = [
  { key: 'key',   label: 'Key',   width: 28 },
  { key: 'value', label: 'Value', width: 36 },
];

// ── Row formatters ────────────────────────────────────────────────────

function formatConfigRows(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data)) {
    return data.map((item) => ({
      key:   item.key || item.name || '',
      value: String(item.value != null ? item.value : ''),
      _raw:  item,
    }));
  }
  // Object key-value pairs
  return Object.entries(data).map(([k, v]) => ({
    key:   k,
    value: String(v != null ? v : ''),
    _raw:  { key: k, value: v },
  }));
}

function formatKeysRows(keys) {
  if (!Array.isArray(keys)) return [];
  return keys.map((k) => ({
    id:        k.id || '--',
    name:      k.name || k.display_name || '--',
    prefix:    k.prefix || '--',
    role:      k.role || '--',
    last_used: k.last_used ? formatDate(k.last_used) : '--',
    _raw: k,
  }));
}

function formatServicesRows(services) {
  if (!Array.isArray(services)) return [];
  return services.map((s) => ({
    id:     s.id || '--',
    name:   s.name || s.display_name || '--',
    status: `${styles.statusDot(s.status || 'unknown')} ${s.status || 'unknown'}`,
    url:    s.url || s.endpoint || '--',
    _raw: s,
  }));
}

function formatLogsRows(logs) {
  if (!Array.isArray(logs)) return [];
  return logs.map((l) => ({
    timestamp:  l.timestamp ? formatDate(l.timestamp) : '--',
    user_email: l.user_email || l.email || l.user || '--',
    action:     l.action || l.type || '--',
    detail:     truncate(l.detail || l.message || l.description || '', 18),
    _raw: l,
  }));
}

// ── Detail builders ───────────────────────────────────────────────────

function buildConfigDetail(raw) {
  if (!raw) return null;
  return {
    'Key':   raw.key || raw.name,
    'Value': raw.value,
  };
}

function buildKeyDetail(raw) {
  if (!raw) return null;
  return {
    'ID':         raw.id,
    'Name':       raw.name || raw.display_name,
    'Prefix':     raw.prefix,
    'Role':       raw.role,
    'Last Used':  raw.last_used,
    'Created':    raw.created_at,
    'Expires':    raw.expires_at || '--',
  };
}

function buildServiceDetail(raw) {
  if (!raw) return null;
  return {
    'ID':       raw.id,
    'Name':     raw.name || raw.display_name,
    'Status':   raw.status,
    'URL':      raw.url || raw.endpoint,
    'Version':  raw.version || '--',
    'Uptime':   raw.uptime || '--',
    'Last Check': raw.last_check || raw.checked_at || '--',
  };
}

function buildLogDetail(raw) {
  if (!raw) return null;
  return {
    'Timestamp': raw.timestamp,
    'User':      raw.user_email || raw.email || raw.user,
    'Action':    raw.action || raw.type,
    'Detail':    raw.detail || raw.message || raw.description,
    'IP':        raw.ip || raw.ip_address || '--',
    'ID':        raw.id,
  };
}

function buildRetentionDetail(raw) {
  if (!raw) return null;
  return {
    'Key':   raw.key || raw.name,
    'Value': raw.value,
  };
}

// ── Utility ───────────────────────────────────────────────────────────

function truncate(str, max) {
  if (!str) return '';
  const s = String(str).replace(/\n/g, ' ');
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

function formatDate(iso) {
  if (!iso) return '--';
  try {
    const d = new Date(iso);
    return d.toISOString().slice(0, 16).replace('T', ' ');
  } catch {
    return String(iso).slice(0, 16);
  }
}

// ── Component ─────────────────────────────────────────────────────────
export function AdminView() {
  const ctx = useTui();
  const { client, screen, orgVersion } = ctx;
  const isActive = screen === 'admin';

  const [activeTab, setActiveTab] = useState(0);
  const [selected, setSelected] = useState(0);

  // ── Fetch config (refetches when the active org changes) ────────────
  const { data: configData, loading: configLoading, error: configError, refresh: refreshConfig } = useApi(
    async () => {
      const res = await client.get(resolveEndpoint('admin.config.list').path, { service: resolveEndpoint('admin.config.list').service });
      return res?.config || res || {};
    },
    [client, orgVersion]
  );

  // ── Fetch keys ────────────────────────────────────────────────────
  const { data: keysData, loading: keysLoading, error: keysError, refresh: refreshKeys } = useApi(
    async () => {
      const res = await client.get(resolveEndpoint('admin.keys.list').path, { service: resolveEndpoint('admin.keys.list').service });
      return res?.keys || [];
    },
    [client, orgVersion]
  );

  // ── Fetch services ────────────────────────────────────────────────
  const { data: servicesData, loading: servicesLoading, error: servicesError, refresh: refreshServices } = useApi(
    async () => {
      const res = await client.get(resolveEndpoint('admin.services.list').path, { service: resolveEndpoint('admin.services.list').service });
      return res?.services || [];
    },
    [client, orgVersion]
  );

  // ── Fetch logs ────────────────────────────────────────────────────
  const { data: logsData, loading: logsLoading, error: logsError, refresh: refreshLogs } = useApi(
    async () => {
      const res = await client.get(resolveEndpoint('admin.logs.list').path, { service: resolveEndpoint('admin.logs.list').service });
      return res?.logs || [];
    },
    [client, orgVersion]
  );

  // ── Fetch retention ───────────────────────────────────────────────
  const { data: retentionData, loading: retentionLoading, error: retentionError, refresh: refreshRetention } = useApi(
    async () => {
      const res = await client.get(resolveEndpoint('admin.retention.config.list').path, { service: resolveEndpoint('admin.retention.config.list').service });
      return res?.config || res || {};
    },
    [client, orgVersion]
  );

  // ── Active tab data ─────────────────────────────────────────────────
  let columns, rows, detail, loading, error;

  switch (activeTab) {
    case 0: // Config
      columns = CONFIG_COLUMNS;
      rows = formatConfigRows(configData);
      detail = rows[selected] ? buildConfigDetail(rows[selected]._raw) : null;
      loading = configLoading;
      error = configError;
      break;
    case 1: // Keys
      columns = KEYS_COLUMNS;
      rows = formatKeysRows(keysData);
      detail = rows[selected] ? buildKeyDetail(rows[selected]._raw) : null;
      loading = keysLoading;
      error = keysError;
      break;
    case 2: // Services
      columns = SERVICES_COLUMNS;
      rows = formatServicesRows(servicesData);
      detail = rows[selected] ? buildServiceDetail(rows[selected]._raw) : null;
      loading = servicesLoading;
      error = servicesError;
      break;
    case 3: // Logs
      columns = LOGS_COLUMNS;
      rows = formatLogsRows(logsData);
      detail = rows[selected] ? buildLogDetail(rows[selected]._raw) : null;
      loading = logsLoading;
      error = logsError;
      break;
    case 4: // Retention
      columns = RETENTION_COLUMNS;
      rows = formatConfigRows(retentionData);
      detail = rows[selected] ? buildRetentionDetail(rows[selected]._raw) : null;
      loading = retentionLoading;
      error = retentionError;
      break;
  }

  // ── Reset selection on tab change ───────────────────────────────────
  useEffect(() => {
    setSelected(0);
  }, [activeTab]);

  // ── Refresh current tab ─────────────────────────────────────────────
  const refreshCurrent = useCallback(() => {
    const refreshers = [refreshConfig, refreshKeys, refreshServices, refreshLogs, refreshRetention];
    refreshers[activeTab]?.();
  }, [activeTab, refreshConfig, refreshKeys, refreshServices, refreshLogs, refreshRetention]);

  // ── Keyboard handling ──────────────────────────────────────────────
  useInput((input, key) => {
    if (!isActive) return;

    // Tab to switch sub-tabs
    if (matchKey('tab', input, key)) {
      setActiveTab((t) => (t + 1) % TABS.length);
      return;
    }

    // Manual refresh
    if (matchKey('refresh', input, key)) {
      refreshCurrent();
      return;
    }
  }, { isActive });

  // ── Tab bar rendering ──────────────────────────────────────────────
  const tabBar = (
    <Box marginBottom={1}>
      {TABS.map((tab, i) => {
        const isSel = i === activeTab;
        return (
          <React.Fragment key={tab}>
            {i > 0 && <Text color={colors.subtle}> | </Text>}
            <Text
              color={isSel ? colors.cyberBlue : colors.dim}
              bold={isSel}
              underline={isSel}
            >
              {tab}
            </Text>
          </React.Fragment>
        );
      })}
      <Text color={colors.dim}>  (Tab to switch)</Text>
    </Box>
  );

  // ── Detail title ───────────────────────────────────────────────────
  let detailTitle;
  if (rows[selected]) {
    switch (activeTab) {
      case 0: detailTitle = rows[selected]._raw.key || rows[selected]._raw.name || 'Config'; break;
      case 1: detailTitle = rows[selected]._raw.name || rows[selected]._raw.display_name || 'Key'; break;
      case 2: detailTitle = rows[selected]._raw.name || rows[selected]._raw.display_name || 'Service'; break;
      case 3: detailTitle = rows[selected]._raw.action || rows[selected]._raw.type || 'Log Entry'; break;
      case 4: detailTitle = rows[selected]._raw.key || rows[selected]._raw.name || 'Retention'; break;
    }
  }

  // ── Footer hint ────────────────────────────────────────────────────
  const footer = [
    '\u2191/k \u2193/j Navigate',
    'Tab Switch tab',
    'r Refresh',
    'Esc Back',
  ].join('  ');

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <Layout
      title="Admin"
      subtitle={TABS[activeTab]}
      footer={footer}
      left={
        <Box flexDirection="column">
          {/* Tab bar */}
          {tabBar}

          {error && (
            <Box marginBottom={1}>
              <Text color={colors.error}>Error: {error.message}</Text>
            </Box>
          )}

          <DataTable
            columns={columns}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            loading={loading}
            emptyMessage={[
              'No config values set',
              'No API keys — create one via `quox admin key create`',
              'No services registered',
              'No audit events yet',
              'No retention settings configured',
            ][activeTab]}
            active={isActive}
          />
        </Box>
      }
      right={
        <DetailPanel
          title={detailTitle}
          data={detail}
        />
      }
    />
  );
}
