/**
 * AgentView — Agent management view
 *
 * Left panel:  DataTable of agents (name, level, status, tools count)
 * Right panel: DetailPanel with agent detail + tool list
 *
 * Features:
 *   - `a` key toggles activate/deactivate on the selected agent
 *   - Shows tool assignments in detail panel
 *
 * API (org-scoped):
 *   GET /api/orgs/:orgId/agents         (service: auth) -> data.agents
 *   GET /api/orgs/:orgId/agents/:id     (service: auth) -> agent detail
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { Layout } from '../components/Layout.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { DetailPanel } from '../components/DetailPanel.jsx';
import { useApi } from '../hooks/useApi.js';
import { useTui } from '../app.jsx';
import { matchKey } from '../keys.js';
import { colors, styles } from '../theme.js';
import { resolveEndpoint } from '../../api/endpoints.js';

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Safely extract the org ID from TUI context.
 */
function getOrgId(ctx) {
  return ctx?.auth?.getUser?.()?.org_id
    || ctx?.config?.getActiveProfile?.()?.auth?.org_id
    || null;
}

// ── Column definitions ────────────────────────────────────────────────
const COLUMNS = [
  { key: 'name',       label: 'Name',    width: 18 },
  { key: 'level',      label: 'Level',   width: 8 },
  { key: 'status',     label: 'Status',  width: 12 },
  { key: 'toolCount',  label: 'Tools',   width: 8 },
];

/**
 * Format raw agent data into table rows.
 */
function formatRows(agents) {
  if (!Array.isArray(agents)) return [];
  return agents.map((a) => ({
    ...a,
    name:      a.name || a.display_name || a.id,
    level:     a.level != null ? String(a.level) : '--',
    status:    `${styles.statusDot(a.status || a.state || 'unknown')} ${a.status || a.state || 'unknown'}`,
    toolCount: Array.isArray(a.tools) ? String(a.tools.length) : (a.tool_count != null ? String(a.tool_count) : '--'),
    _raw: a,
  }));
}

/**
 * Build a detail object for the right panel.
 */
function buildDetail(raw) {
  if (!raw) return null;
  const detail = {
    'Name':        raw.name || raw.display_name,
    'ID':          raw.id,
    'Level':       raw.level,
    'Status':      raw.status || raw.state,
    'Description': raw.description,
    'Category':    raw.category,
    'Created':     raw.created_at,
    'Updated':     raw.updated_at,
  };

  // Add tools as a list
  if (Array.isArray(raw.tools) && raw.tools.length > 0) {
    detail['Tools'] = raw.tools.map((t) => (typeof t === 'string' ? t : t.name || t.id)).join(', ');
  }

  // Add capabilities
  if (Array.isArray(raw.capabilities) && raw.capabilities.length > 0) {
    detail['Capabilities'] = raw.capabilities.join(', ');
  }

  return detail;
}

// ── Component ─────────────────────────────────────────────────────────
export function AgentView() {
  const ctx = useTui();
  const { client, screen, orgVersion } = ctx;
  const isActive = screen === 'agents';
  const orgId = getOrgId(ctx);

  const [selected, setSelected] = useState(0);
  const [actionMsg, setActionMsg] = useState(null);

  // ── Data fetching (refetches when the active org changes) ───────────
  const { data, loading, error, refresh } = useApi(
    async () => {
      if (!orgId) return [];
      const res = await client.get(resolveEndpoint('agents.list', { orgId }).path, { service: resolveEndpoint('agents.list', { orgId }).service });
      return res?.agents || [];
    },
    [client, orgId, orgVersion]
  );

  const rows = formatRows(data);
  const selectedRow = rows[selected];
  const detail = selectedRow ? buildDetail(selectedRow._raw) : null;

  // ── Toggle activate/deactivate ──────────────────────────────────────
  const toggleAgent = useCallback(async () => {
    if (!selectedRow || !orgId) return;
    const raw = selectedRow._raw;
    const agentId = raw.id;
    const currentStatus = raw.status || raw.state;
    const newStatus = currentStatus === 'active' ? 'inactive' : 'active';

    try {
      await client.patch(resolveEndpoint('agents.update', { orgId, agentId }).path, {
        service: resolveEndpoint('agents.update', { orgId, agentId }).service,
        body: { status: newStatus },
      });
      setActionMsg(`Agent ${raw.name || agentId} set to ${newStatus}`);
      refresh();
    } catch (err) {
      setActionMsg(`Failed: ${err.message}`);
    }

    // Clear message after 3 seconds
    setTimeout(() => setActionMsg(null), 3000);
  }, [selectedRow, orgId, client, refresh]);

  // ── Keyboard handling ──────────────────────────────────────────────
  useInput((input, key) => {
    if (!isActive) return;

    // Manual refresh
    if (matchKey('refresh', input, key)) {
      refresh();
      return;
    }

    // Toggle activate/deactivate
    if (input === 'a') {
      toggleAgent();
      return;
    }
  }, { isActive });

  // ── Footer hint ────────────────────────────────────────────────────
  const footer = [
    '\u2191/k \u2193/j Navigate',
    'a Activate/Deactivate',
    'r Refresh',
    'Esc Back',
  ].join('  ');

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <Layout
      title="Agents"
      subtitle={orgId ? `org: ${orgId}` : '(no org)'}
      footer={footer}
      left={
        <Box flexDirection="column">
          {error && (
            <Box marginBottom={1}>
              <Text color={colors.error}>Error: {error.message}</Text>
            </Box>
          )}
          {!orgId && !loading && (
            <Box marginBottom={1}>
              <Text color={colors.warning}>No organization selected. Switch orgs first.</Text>
            </Box>
          )}
          {actionMsg && (
            <Box marginBottom={1}>
              <Text color={colors.info}>{actionMsg}</Text>
            </Box>
          )}
          <DataTable
            columns={COLUMNS}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            loading={loading}
            emptyMessage={orgId ? 'No agents — create one via `quox agent create`' : 'Select an organization first'}
            active={isActive}
          />
        </Box>
      }
      right={
        <DetailPanel
          title={selectedRow ? (selectedRow._raw.name || selectedRow._raw.id) : undefined}
          data={detail}
        />
      }
    />
  );
}
