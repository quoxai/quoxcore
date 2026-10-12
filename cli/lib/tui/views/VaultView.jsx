/**
 * VaultView — QuoxVault credentials, tabbed view
 *
 * Tabs: Credentials | Stats | Activity
 *
 * Each tab has its own DataTable sourced from vault API endpoints.
 * Tab key cycles through tabs. `t` tests the selected credential and
 * `s` sets it as default (Credentials tab only). Rotate is intentionally
 * omitted — it needs interactive value entry not available in the TUI.
 *
 * API (all service: auth, org-scoped):
 *   GET  /api/orgs/:orgId/vault                -> credentials list
 *   POST /api/orgs/:orgId/vault/:id/test       -> test result
 *   POST /api/orgs/:orgId/vault/:id/default    -> set default result
 *   GET  /api/orgs/:orgId/vault/vault-stats    -> health stats
 *   GET  /api/orgs/:orgId/vault/activity       -> audit trail
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { Layout } from '../components/Layout.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { DetailPanel } from '../components/DetailPanel.jsx';
import { usePolledApi } from '../hooks/usePolledApi.js';
import { useTui } from '../app.jsx';
import { matchKey } from '../keys.js';
import { colors } from '../theme.js';
import { resolveEndpoint } from '../../api/endpoints.js';

// ── Helpers ───────────────────────────────────────────────────────────

function getOrgId(ctx) {
  return ctx?.auth?.getUser?.()?.org_id || ctx?.config?.getActiveProfile?.()?.auth?.org_id || null;
}

const EXPIRY_WARNING_DAYS = 30;

/**
 * Determine whether a credential's expiry falls within the warning
 * window (30 days) or has already passed.
 */
function isExpiringSoon(expiresAt) {
  if (!expiresAt) return false;
  const d = new Date(expiresAt);
  if (isNaN(d.getTime())) return false;
  const diffDays = (d.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  return diffDays <= EXPIRY_WARNING_DAYS;
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

function truncate(str, max) {
  if (!str) return '';
  const s = String(str).replace(/\n/g, ' ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ── Tab definitions ───────────────────────────────────────────────────
const TABS = ['Credentials', 'Stats', 'Activity'];

// ── Column definitions per tab ────────────────────────────────────────
const CREDENTIALS_COLUMNS = [
  { key: 'label',   label: 'Label',   width: 20 },
  { key: 'type',    label: 'Type',    width: 16 },
  { key: 'kind',    label: 'Kind',    width: 16 },
  { key: 'expires', label: 'Expires', width: 18 },
];

const STATS_COLUMNS = [
  { key: 'key',   label: 'Key',   width: 22 },
  { key: 'value', label: 'Value', width: 24 },
];

const ACTIVITY_COLUMNS = [
  { key: 'when',   label: 'Time',   width: 20 },
  { key: 'action', label: 'Action', width: 16 },
  { key: 'actor',  label: 'Actor',  width: 14 },
  { key: 'target', label: 'Target', width: 16 },
];

// ── Row formatters ────────────────────────────────────────────────────

function unwrapCredentials(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  return res.credentials || res.items || [];
}

function formatCredentialRows(list) {
  if (!Array.isArray(list)) return [];
  return list.map((c) => {
    const expiresAt = c.expires_at || c.expiresAt;
    const warn = isExpiringSoon(expiresAt);
    const expiresText = expiresAt ? formatDate(expiresAt) : '--';
    return {
      label:   c.label || c.name || '--',
      type:    c.integration_type || c.type || '--',
      kind:    c.credential_kind || c.kind || '--',
      expires: warn ? `⚠ ${expiresText}` : expiresText,
      _warn:   warn,
      _raw:    c,
    };
  });
}

function unwrapStats(res) {
  if (!res) return {};
  return res.stats || res;
}

function formatStatsRows(stats) {
  if (!stats || typeof stats !== 'object') return [];
  return Object.entries(stats)
    .filter(([, v]) => typeof v !== 'object' || v === null)
    .map(([k, v]) => ({
      key:   k,
      value: String(v != null ? v : '--'),
      _raw:  { key: k, value: v },
    }));
}

function unwrapActivity(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  return res.events || res.activity || res.items || [];
}

function formatActivityRows(list) {
  if (!Array.isArray(list)) return [];
  return list.map((a) => ({
    when:   a.created_at || a.timestamp ? formatDate(a.created_at || a.timestamp) : '--',
    action: a.action || a.type || '--',
    actor:  a.actor_type || a.actor || a.user_email || '--',
    target: truncate(a.target_id || a.target || '', 14),
    _raw:   a,
  }));
}

// ── Detail builders ───────────────────────────────────────────────────

function buildCredentialDetail(raw) {
  if (!raw) return null;
  return {
    'ID':          raw.id,
    'Label':       raw.label || raw.name,
    'Type':        raw.integration_type || raw.type,
    'Kind':        raw.credential_kind || raw.kind,
    'Status':      raw.test_status || raw.status || '--',
    'Default':     raw.is_default,
    'Uses':        raw.use_count,
    'Last Used':   raw.last_used_at || '--',
    'Expires':     raw.expires_at || raw.expiresAt || '--',
    'Created':     raw.created_at || '--',
  };
}

function buildStatsDetail(raw) {
  if (!raw) return null;
  return {
    'Key':   raw.key,
    'Value': raw.value,
  };
}

function buildActivityDetail(raw) {
  if (!raw) return null;
  return {
    'Time':   raw.created_at || raw.timestamp,
    'Action': raw.action || raw.type,
    'Actor':  raw.actor_type || raw.actor || raw.user_email,
    'Status': raw.status || '--',
    'Target': raw.target_id || raw.target,
    'ID':     raw.id,
  };
}

// ── Component ─────────────────────────────────────────────────────────
export function VaultView() {
  const ctx = useTui();
  const { client, screen, showToast, orgVersion } = ctx;
  const isActive = screen === 'vault';
  const orgId = getOrgId(ctx);

  const [activeTab, setActiveTab] = useState(0);
  const [selected, setSelected] = useState(0);

  // ── Fetch credentials (fetch-once-on-activate) ───────────────────────
  const { data: credentialsData, loading: credentialsLoading, error: credentialsError, refresh: refreshCredentials } = usePolledApi(
    async () => {
      if (!orgId) return [];
      const res = await client.get(resolveEndpoint('vault.list', { orgId }).path, { service: resolveEndpoint('vault.list', { orgId }).service });
      return unwrapCredentials(res);
    },
    [client, orgId, orgVersion],
    { intervalMs: 0, active: isActive }
  );

  // ── Fetch stats ───────────────────────────────────────────────────────
  const { data: statsData, loading: statsLoading, error: statsError, refresh: refreshStats } = usePolledApi(
    async () => {
      if (!orgId) return {};
      const res = await client.get(resolveEndpoint('vault.vault-stats.list', { orgId }).path, { service: resolveEndpoint('vault.vault-stats.list', { orgId }).service });
      return unwrapStats(res);
    },
    [client, orgId, orgVersion],
    { intervalMs: 0, active: isActive }
  );

  // ── Fetch activity ────────────────────────────────────────────────────
  const { data: activityData, loading: activityLoading, error: activityError, refresh: refreshActivity } = usePolledApi(
    async () => {
      if (!orgId) return [];
      const res = await client.get(resolveEndpoint('vault.activity.list', { orgId }).path, { service: resolveEndpoint('vault.activity.list', { orgId }).service, query: { limit: 50 } });
      return unwrapActivity(res);
    },
    [client, orgId, orgVersion],
    { intervalMs: 0, active: isActive }
  );

  // ── Active tab data ─────────────────────────────────────────────────
  let columns, rows, detail, loading, error;

  switch (activeTab) {
    case 0: // Credentials
      columns = CREDENTIALS_COLUMNS;
      rows = formatCredentialRows(credentialsData);
      detail = rows[selected] ? buildCredentialDetail(rows[selected]._raw) : null;
      loading = credentialsLoading;
      error = credentialsError;
      break;
    case 1: // Stats
      columns = STATS_COLUMNS;
      rows = formatStatsRows(statsData);
      detail = rows[selected] ? buildStatsDetail(rows[selected]._raw) : null;
      loading = statsLoading;
      error = statsError;
      break;
    case 2: // Activity
      columns = ACTIVITY_COLUMNS;
      rows = formatActivityRows(activityData);
      detail = rows[selected] ? buildActivityDetail(rows[selected]._raw) : null;
      loading = activityLoading;
      error = activityError;
      break;
  }

  // ── Reset selection on tab change ───────────────────────────────────
  useEffect(() => {
    setSelected(0);
  }, [activeTab]);

  // ── Refresh current tab ─────────────────────────────────────────────
  const refreshCurrent = useCallback(() => {
    const refreshers = [refreshCredentials, refreshStats, refreshActivity];
    refreshers[activeTab]?.();
  }, [activeTab, refreshCredentials, refreshStats, refreshActivity]);

  // ── Test selected credential ─────────────────────────────────────────
  const testSelected = useCallback(async () => {
    if (activeTab !== 0 || !orgId) return;
    const row = rows[selected];
    if (!row) return;
    const id = row._raw.id;
    try {
      const result = await client.post(resolveEndpoint('vault.test', { orgId, id }).path, { service: resolveEndpoint('vault.test', { orgId, id }).service });
      const ok = result?.success || result?.ok;
      showToast?.(ok ? 'Test passed' : 'Test failed', ok ? 'success' : 'error');
      refreshCredentials();
    } catch (err) {
      showToast?.(`Test failed: ${err.message}`, 'error');
    }
  }, [activeTab, orgId, rows, selected, client, showToast, refreshCredentials]);

  // ── Set selected credential as default ────────────────────────────────
  const setDefaultSelected = useCallback(async () => {
    if (activeTab !== 0 || !orgId) return;
    const row = rows[selected];
    if (!row) return;
    const id = row._raw.id;
    try {
      await client.post(resolveEndpoint('vault.default', { orgId, id }).path, { service: resolveEndpoint('vault.default', { orgId, id }).service });
      showToast?.('Default credential set', 'success');
      refreshCredentials();
    } catch (err) {
      showToast?.(`Set default failed: ${err.message}`, 'error');
    }
  }, [activeTab, orgId, rows, selected, client, showToast, refreshCredentials]);

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

    // Test selected credential
    if (input === 't') {
      testSelected();
      return;
    }

    // Set selected credential as default
    if (input === 's') {
      setDefaultSelected();
      return;
    }
  }, { isActive });

  // ── No org guard ──────────────────────────────────────────────────
  if (!orgId) {
    return (
      <Layout
        title="Vault"
        subtitle="QuoxVault"
        footer="Esc Back"
        left={
          <Box>
            <Text color={colors.warning}>No active org</Text>
          </Box>
        }
        right={<DetailPanel data={null} />}
      />
    );
  }

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
      case 0: detailTitle = rows[selected]._raw.label || rows[selected]._raw.name || 'Credential'; break;
      case 1: detailTitle = rows[selected]._raw.key || 'Stat'; break;
      case 2: detailTitle = rows[selected]._raw.action || rows[selected]._raw.type || 'Activity'; break;
    }
  }

  // ── Footer hint ────────────────────────────────────────────────────
  const footer = [
    'Tab: switch',
    't: test',
    's: set default',
    'r: refresh',
    'Esc: back',
  ].join('  ');

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <Layout
      title="Vault"
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
            emptyMessage={activeTab === 0
              ? 'No credentials — add one via `quox vault create`'
              : `No ${TABS[activeTab].toLowerCase()} data found`}
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
