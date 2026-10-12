/**
 * BackupView — Backup management view
 *
 * Left panel:  DataTable of backups (id, label, type, size, status, created_at)
 * Right panel: DetailPanel with backup detail
 *
 * Features:
 *   - `v` key verifies the selected backup
 *   - `r` key refreshes backup list
 *   - Action messages auto-clear after 3s
 *
 * API (org-scoped):
 *   GET  /api/orgs/:orgId/backups                (service: auth) -> data.backups
 *   POST /api/orgs/:orgId/backups/:id/verify     (service: auth) -> verify result
 *   POST /api/orgs/:orgId/backups/:id/restore    (service: auth) -> restore result
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
  try {
    return ctx?.auth?.getUser?.()?.org_id || ctx?.config?.getActiveProfile?.()?.auth?.org_id || '';
  } catch { return ''; }
}

/**
 * Format bytes into a human-readable file size.
 */
function formatFileSize(bytes) {
  if (bytes == null || isNaN(bytes)) return '--';
  const num = Number(bytes);
  if (num === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(num) / Math.log(1024));
  const size = (num / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0);
  return `${size} ${units[i]}`;
}

/**
 * Format a date string for display.
 */
function formatDate(iso) {
  if (!iso) return '--';
  try {
    const d = new Date(iso);
    return d.toISOString().slice(0, 10);
  } catch {
    return String(iso).slice(0, 10);
  }
}

// ── Column definitions ────────────────────────────────────────────────
const COLUMNS = [
  { key: 'id',      label: 'ID',      width: 10 },
  { key: 'label',   label: 'Label',   width: 18 },
  { key: 'type',    label: 'Type',    width: 10 },
  { key: 'size',    label: 'Size',    width: 10 },
  { key: 'status',  label: 'Status',  width: 12 },
  { key: 'created', label: 'Created', width: 12 },
];

/**
 * Format raw backup data into table rows.
 */
function formatRows(backups) {
  if (!Array.isArray(backups)) return [];
  return backups.map((b) => ({
    id:      b.id ? String(b.id).slice(0, 8) : '--',
    label:   b.label || b.name || b.description || '--',
    type:    b.type || b.backup_type || '--',
    size:    formatFileSize(b.size || b.file_size),
    status:  `${styles.statusDot(b.status || 'unknown')} ${b.status || 'unknown'}`,
    created: formatDate(b.created_at),
    _raw: b,
  }));
}

/**
 * Build a detail object for the right panel.
 */
function buildDetail(raw) {
  if (!raw) return null;
  return {
    'ID':          raw.id,
    'Label':       raw.label || raw.name,
    'Type':        raw.type || raw.backup_type,
    'Status':      raw.status,
    'Size':        formatFileSize(raw.size || raw.file_size),
    'Description': raw.description || '--',
    'Created':     raw.created_at,
    'Completed':   raw.completed_at || '--',
    'Verified':    raw.verified_at || (raw.verified ? 'Yes' : '--'),
    'Checksum':    raw.checksum || raw.hash || '--',
    'Path':        raw.path || raw.file_path || '--',
  };
}

// ── Component ─────────────────────────────────────────────────────────
export function BackupView() {
  const ctx = useTui();
  const { client, screen, orgVersion } = ctx;
  const isActive = screen === 'backups';
  const orgId = getOrgId(ctx);

  const [selected, setSelected] = useState(0);
  const [actionMsg, setActionMsg] = useState(null);

  // ── Data fetching (refetches when the active org changes) ───────────
  const { data, loading, error, refresh } = useApi(
    async () => {
      if (!orgId) return [];
      const res = await client.get(resolveEndpoint('backups.list', { orgId }).path, { service: resolveEndpoint('backups.list', { orgId }).service });
      return res?.backups || [];
    },
    [client, orgId, orgVersion]
  );

  const rows = formatRows(data);
  const selectedRow = rows[selected];
  const detail = selectedRow ? buildDetail(selectedRow._raw) : null;

  // ── Verify backup ──────────────────────────────────────────────────
  const verifyBackup = useCallback(async () => {
    if (!selectedRow || !orgId) return;
    const raw = selectedRow._raw;
    const backupId = raw.id;

    try {
      setActionMsg('Verifying...');
      const res = await client.post(resolveEndpoint('backups.verify', { orgId, backupId }).path, {
        service: resolveEndpoint('backups.verify', { orgId, backupId }).service,
        body: {},
      });
      const result = res?.status || res?.verified ? 'verified' : 'complete';
      setActionMsg(`Backup "${raw.label || raw.name || backupId}" ${result}`);
      refresh();
    } catch (err) {
      setActionMsg(`Verify failed: ${err.message}`);
    }

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

    // Verify backup
    if (input === 'v' && selectedRow) {
      verifyBackup();
      return;
    }
  }, { isActive });

  // ── Footer hint ────────────────────────────────────────────────────
  const footer = [
    '\u2191/k \u2193/j Navigate',
    'v Verify',
    'r Refresh',
    'Esc Back',
  ].join('  ');

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <Layout
      title="Backups"
      subtitle={orgId ? `${rows.length} backups` : '(no org)'}
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
              <Text color={colors.warning}>No organization selected.</Text>
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
            emptyMessage={orgId ? 'No backups — create one via `quox backup create`' : 'Select an organization first'}
            active={isActive}
          />
        </Box>
      }
      right={
        <DetailPanel
          title={selectedRow ? (selectedRow._raw.label || selectedRow._raw.name || 'Backup') : undefined}
          data={detail}
        />
      }
    />
  );
}
