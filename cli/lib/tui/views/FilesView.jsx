/**
 * FilesView — File management view
 *
 * Left panel:  DataTable of files (name, size, type, created)
 * Right panel: DetailPanel with file detail
 *
 * Features:
 *   - `d` key deletes selected file (with y/n confirmation)
 *   - `r` key refreshes file list
 *
 * API:
 *   GET /list  (service: files) -> data.files
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { Layout } from '../components/Layout.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { DetailPanel } from '../components/DetailPanel.jsx';
import { Confirm } from '../components/Confirm.jsx';
import { useApi } from '../hooks/useApi.js';
import { useTui } from '../app.jsx';
import { matchKey } from '../keys.js';
import { colors } from '../theme.js';
import { resolveEndpoint } from '../../api/endpoints.js';

// ── Helpers ───────────────────────────────────────────────────────────

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
  { key: 'name',    label: 'Name',    width: 24 },
  { key: 'size',    label: 'Size',    width: 10 },
  { key: 'type',    label: 'Type',    width: 12 },
  { key: 'created', label: 'Created', width: 14 },
];

/**
 * Format raw file data into table rows.
 */
function formatRows(files) {
  if (!Array.isArray(files)) return [];
  return files.map((f) => ({
    name:    f.name || f.filename || f.id,
    size:    formatFileSize(f.size || f.file_size),
    type:    f.type || f.mime_type || f.content_type || '--',
    created: formatDate(f.created_at || f.uploaded_at),
    _raw: f,
  }));
}

/**
 * Build a detail object for the right panel.
 */
function buildDetail(raw) {
  if (!raw) return null;
  return {
    'Name':      raw.name || raw.filename,
    'ID':        raw.id,
    'Size':      formatFileSize(raw.size || raw.file_size),
    'Type':      raw.type || raw.mime_type || raw.content_type,
    'Path':      raw.path || raw.file_path || '--',
    'Created':   raw.created_at || raw.uploaded_at,
    'Modified':  raw.updated_at || raw.modified_at || '--',
    'Owner':     raw.owner || raw.uploaded_by || '--',
    'Tags':      Array.isArray(raw.tags) ? raw.tags.join(', ') : '--',
  };
}

// ── Component ─────────────────────────────────────────────────────────
export function FilesView() {
  const ctx = useTui();
  const { client, screen, orgVersion } = ctx;
  const isActive = screen === 'files';

  const [selected, setSelected] = useState(0);
  const [actionMsg, setActionMsg] = useState(null);
  const [confirming, setConfirming] = useState(false);

  // ── Data fetching (refetches when the active org changes) ───────────
  const { data, loading, error, refresh } = useApi(
    async () => {
      const res = await client.get(resolveEndpoint('files.list').path, { service: resolveEndpoint('files.list').service });
      return res?.files || [];
    },
    [client, orgVersion]
  );

  const rows = formatRows(data);
  const selectedRow = rows[selected];
  const detail = selectedRow ? buildDetail(selectedRow._raw) : null;

  // ── Delete file ─────────────────────────────────────────────────────
  const deleteFile = useCallback(async () => {
    if (!selectedRow) return;
    const raw = selectedRow._raw;
    const fileId = raw.id;

    try {
      setActionMsg('Deleting...');
      await client.delete(resolveEndpoint('file.delete', { fileId }).path, { service: resolveEndpoint('file.delete', { fileId }).service });
      setActionMsg(`Deleted "${raw.name || raw.filename || fileId}"`);
      refresh();
    } catch (err) {
      setActionMsg(`Delete failed: ${err.message}`);
    }

    setTimeout(() => setActionMsg(null), 3000);
  }, [selectedRow, client, refresh]);

  // ── Keyboard handling ──────────────────────────────────────────────
  useInput((input, key) => {
    if (!isActive || confirming) return;

    // Manual refresh
    if (matchKey('refresh', input, key)) {
      refresh();
      return;
    }

    // Delete file
    if (matchKey('delete', input, key) && selectedRow) {
      setConfirming(true);
      return;
    }
  }, { isActive: isActive && !confirming });

  // ── Confirmation handlers ─────────────────────────────────────────
  const handleConfirm = useCallback(() => {
    setConfirming(false);
    deleteFile();
  }, [deleteFile]);

  const handleCancel = useCallback(() => {
    setConfirming(false);
  }, []);

  // ── Footer hint ────────────────────────────────────────────────────
  const footer = [
    '\u2191/k \u2193/j Navigate',
    'd Delete',
    'r Refresh',
    'Esc Back',
  ].join('  ');

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <Layout
      title="Files"
      subtitle={`${rows.length} files`}
      footer={footer}
      left={
        <Box flexDirection="column">
          {error && (
            <Box marginBottom={1}>
              <Text color={colors.error}>Error: {error.message}</Text>
            </Box>
          )}
          {actionMsg && (
            <Box marginBottom={1}>
              <Text color={colors.info}>{actionMsg}</Text>
            </Box>
          )}
          {confirming && (
            <Box marginBottom={1}>
              <Confirm
                message={`Delete "${selectedRow?._raw?.name || selectedRow?._raw?.filename || 'file'}"?`}
                onConfirm={handleConfirm}
                onCancel={handleCancel}
                active={confirming}
              />
            </Box>
          )}
          <DataTable
            columns={COLUMNS}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            loading={loading}
            emptyMessage="No files — upload via `quox file upload <path>`"
            active={isActive && !confirming}
          />
        </Box>
      }
      right={
        <DetailPanel
          title={selectedRow ? (selectedRow._raw.name || selectedRow._raw.filename || 'File') : undefined}
          data={detail}
        />
      }
    />
  );
}
