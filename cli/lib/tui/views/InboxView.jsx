/**
 * InboxView — HITL approvals inbox
 *
 * Left panel:  DataTable of inbox items (title, type, status, created)
 * Right panel: DetailPanel with inbox item detail
 *
 * Features:
 *   - `a` key approves the selected item
 *   - `d` key denies the selected item
 *   - Auto-refreshes every 10 seconds via usePolledApi (only while active —
 *     never polls in the background when another screen is showing)
 *   - Stats header (pending/total etc) fetched separately
 *
 * API (org-scoped):
 *   GET  /api/orgs/:orgId/inbox/stats          (service: auth) -> stats
 *   GET  /api/orgs/:orgId/inbox                (service: auth) -> data.items
 *   GET  /api/orgs/:orgId/inbox/:id            (service: auth) -> item detail
 *   POST /api/orgs/:orgId/inbox/:id/respond    (service: auth) -> { action, comment }
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { Layout } from '../components/Layout.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { DetailPanel } from '../components/DetailPanel.jsx';
import { usePolledApi } from '../hooks/usePolledApi.js';
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
  { key: 'title',    label: 'Title',   width: 28 },
  { key: 'type',     label: 'Type',    width: 12 },
  { key: 'status',   label: 'Status',  width: 12 },
  { key: 'created',  label: 'Created', width: 12 },
];

// ── Auto-refresh interval (ms) ───────────────────────────────────────
const REFRESH_INTERVAL = 10_000;

/**
 * Format raw inbox data into table rows.
 */
function formatRows(items) {
  if (!Array.isArray(items)) return [];
  return items.map((i) => ({
    ...i,
    title:   i.title || i.subject || i.id,
    type:    i.type || i.kind || '--',
    status:  `${styles.statusDot(i.status || 'unknown')} ${i.status || 'unknown'}`,
    created: i.created_at ? String(i.created_at).slice(0, 10) : '--',
    _raw: i,
  }));
}

/**
 * Build a detail object for the right panel.
 */
function buildDetail(raw) {
  if (!raw) return null;
  return {
    'Title':      raw.title || raw.subject,
    'ID':         raw.id,
    'Type':       raw.type || raw.kind,
    'Status':     raw.status,
    'Priority':   raw.priority,
    'Description':raw.description || raw.body,
    'Requested By': raw.requested_by || raw.requester,
    'Created':    raw.created_at,
    'Updated':    raw.updated_at,
  };
}

// ── Component ─────────────────────────────────────────────────────────
export function InboxView() {
  const ctx = useTui();
  const { client, screen, showToast, orgVersion } = ctx;
  const isActive = screen === 'inbox';
  const orgId = getOrgId(ctx);

  const [selected, setSelected] = useState(0);

  // ── Data fetching (auto-refreshes every 10s, only while active) ─────
  const { data, loading, error, refresh } = usePolledApi(
    async () => {
      if (!orgId) return [];
      const res = await client.get(resolveEndpoint('inbox.list', { orgId }).path, { service: resolveEndpoint('inbox.list', { orgId }).service, query: { status: 'all' } });
      return res?.items || res?.inbox || (Array.isArray(res) ? res : []);
    },
    [client, orgId, orgVersion],
    { intervalMs: REFRESH_INTERVAL, active: isActive }
  );

  // ── Stats header ──────────────────────────────────────────────────
  const { data: stats } = usePolledApi(
    async () => {
      if (!orgId) return null;
      return client.get(resolveEndpoint('inbox.stats.list', { orgId }).path, { service: resolveEndpoint('inbox.stats.list', { orgId }).service });
    },
    [client, orgId, orgVersion],
    { intervalMs: REFRESH_INTERVAL, active: isActive }
  );

  // ── Formatted rows ─────────────────────────────────────────────────
  const rows = formatRows(data);
  const selectedRow = rows[selected];
  const detail = selectedRow ? buildDetail(selectedRow._raw) : null;
  const isEmptyInbox = !!orgId && !loading && !error && rows.length === 0;

  // ── Respond to selected item (approve/deny) ──────────────────────────
  const respond = useCallback(async (action) => {
    if (!selectedRow || !orgId) return;
    const itemId = selectedRow._raw.id;

    try {
      await client.post(resolveEndpoint('inbox.respond', { orgId, itemId }).path, {
        service: resolveEndpoint('inbox.respond', { orgId, itemId }).service,
        body: { action },
      });
      showToast(action === 'approve' ? 'Approved' : 'Denied', 'success');
      refresh();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [selectedRow, orgId, client, showToast, refresh]);

  // ── Keyboard handling ──────────────────────────────────────────────
  useInput((input, key) => {
    if (!isActive) return;

    // Manual refresh
    if (matchKey('refresh', input, key)) {
      refresh();
      return;
    }

    // Approve
    if (input === 'a') {
      respond('approve');
      return;
    }

    // Deny
    if (input === 'd') {
      respond('reject');
      return;
    }
  }, { isActive });

  // ── Stats summary line ────────────────────────────────────────────
  const statsLine = stats
    ? Object.entries(stats)
      .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
      .map(([k, v]) => `${k}: ${v}`)
      .join('  ')
    : null;

  // ── Footer hint ────────────────────────────────────────────────────
  const footer = [
    '↑/k ↓/j Navigate',
    'a: approve',
    'd: deny',
    'r: refresh',
    'Esc: back',
  ].join('  ');

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <Layout
      title="Inbox"
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
              <Text color={colors.warning}>No active org. Switch orgs first.</Text>
            </Box>
          )}
          {statsLine && (
            <Box marginBottom={1}>
              <Text color={colors.info}>{statsLine}</Text>
            </Box>
          )}
          {isEmptyInbox ? (
            <Box paddingY={1}>
              <Text color={colors.success}>Inbox zero — nothing awaiting approval ✓</Text>
            </Box>
          ) : (
            <DataTable
              columns={COLUMNS}
              rows={rows}
              selected={selected}
              onSelectionChange={setSelected}
              loading={loading}
              emptyMessage={orgId ? 'No inbox items found' : 'No active org'}
              active={isActive}
            />
          )}
        </Box>
      }
      right={
        <DetailPanel
          title={selectedRow ? (selectedRow._raw.title || selectedRow._raw.id) : undefined}
          data={detail}
        />
      }
    />
  );
}
