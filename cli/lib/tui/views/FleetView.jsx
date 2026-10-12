/**
 * FleetView — Fleet agent status overview
 *
 * Left panel:  DataTable of fleet agents (host, status, cpu, mem, version)
 * Right panel: DetailPanel for the selected agent
 *
 * Features:
 *   - Auto-refreshes every 10 seconds via usePolledApi (only while active —
 *     never polls in the background when another screen is showing)
 *   - `r` key triggers manual refresh
 *   - Status dots (green/red/yellow) for agent health
 *
 * API:
 *   GET /api/v1/fleet/status  (service: collector) -> data.agents or data.hosts
 *   GET /api/v1/agents        (service: collector) -> data.agents
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { Layout } from '../components/Layout.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { DetailPanel } from '../components/DetailPanel.jsx';
import { SearchInput } from '../components/SearchInput.jsx';
import { usePolledApi } from '../hooks/usePolledApi.js';
import { useTui } from '../app.jsx';
import { matchKey } from '../keys.js';
import { colors, styles } from '../theme.js';
import { resolveEndpoint } from '../../api/endpoints.js';

// ── Column definitions ────────────────────────────────────────────────
const COLUMNS = [
  { key: 'host_id',  label: 'Host',    width: 16 },
  { key: 'status',   label: 'Status',  width: 12 },
  { key: 'cpu',      label: 'CPU%',    width: 8 },
  { key: 'mem',      label: 'MEM%',    width: 8 },
  { key: 'version',  label: 'Version', width: 12 },
];

// ── Auto-refresh interval (ms) ───────────────────────────────────────
const REFRESH_INTERVAL = 10_000;

/**
 * Format raw fleet data into table rows with status dots.
 */
function formatRows(agents) {
  if (!Array.isArray(agents)) return [];
  return agents.map((a) => ({
    ...a,
    host_id: a.host_id || a.hostname || a.name || 'unknown',
    status:  `${styles.statusDot(a.status || 'unknown')} ${a.status || 'unknown'}`,
    cpu:     a.cpu != null ? `${Number(a.cpu).toFixed(1)}%` : '--',
    mem:     a.mem != null ? `${Number(a.mem).toFixed(1)}%` : '--',
    version: a.version || '--',
    // Preserve raw for detail panel
    _raw: a,
  }));
}

/**
 * Build a detail object for the right panel from a raw agent record.
 */
function buildDetail(raw) {
  if (!raw) return null;
  return {
    'Host ID':    raw.host_id || raw.hostname || raw.name,
    'Status':     raw.status,
    'IP Address': raw.ip || raw.address || raw.ip_address,
    'CPU':        raw.cpu != null ? `${Number(raw.cpu).toFixed(1)}%` : '--',
    'Memory':     raw.mem != null ? `${Number(raw.mem).toFixed(1)}%` : '--',
    'Disk':       raw.disk != null ? `${Number(raw.disk).toFixed(1)}%` : '--',
    'Version':    raw.version,
    'Uptime':     raw.uptime,
    'OS':         raw.os || raw.platform,
    'Last Seen':  raw.last_seen || raw.updated_at,
    'Tags':       raw.tags,
  };
}

/**
 * Build the POST v1.tools.execute request body for a fleet exec — the shared
 * contract with `quox fleet exec` (collector reads req.body.tool_name; host_id
 * is optional and omitted for an unknown/placeholder host). Exported for tests.
 */
export function buildFleetExecBody(toolName, hostId) {
  const body = { tool_name: (toolName || '').trim() };
  if (hostId && hostId !== 'unknown') body.host_id = hostId;
  return body;
}

// ── Component ─────────────────────────────────────────────────────────
export function FleetView() {
  const { client, screen, orgVersion, showToast, setInputMode } = useTui();
  const [selected, setSelected] = useState(0);
  const [execMode, setExecMode] = useState(false);
  const [execTool, setExecTool] = useState('');
  const [execBusy, setExecBusy] = useState(false);
  const isActive = screen === 'fleet';

  // ── Data fetching (auto-refreshes every 10s, only while active) ─────
  const { data, loading, error, refresh } = usePolledApi(
    async () => {
      try {
        const res = await client.get(resolveEndpoint('v1.fleet.status.list').path, { service: resolveEndpoint('v1.fleet.status.list').service });
        const agents = res?.agents || res?.hosts || [];
        return agents;
      } catch {
        // Fallback to /agents endpoint
        const res = await client.get(resolveEndpoint('v1.agents.list').path, { service: resolveEndpoint('v1.agents.list').service });
        return res?.agents || [];
      }
    },
    [client, orgVersion],
    { intervalMs: REFRESH_INTERVAL, active: isActive }
  );

  // ── Formatted rows ─────────────────────────────────────────────────
  const rows = formatRows(data);
  const selectedRow = rows[selected];
  const detail = selectedRow ? buildDetail(selectedRow._raw) : null;

  // While typing a tool name, mark input mode so global hotkeys (jump,
  // palette, single-letter nav) don't fire on the characters being typed.
  useEffect(() => {
    if (isActive) setInputMode?.(execMode ? 'input' : 'nav');
  }, [execMode, isActive, setInputMode]);

  // Execute a fleet tool on the selected host — the TUI equivalent of
  // `quox fleet exec --tool <name> --host <id>` (POST v1.tools.execute).
  const runExec = useCallback(async (toolName) => {
    const tool = (toolName || '').trim();
    setExecMode(false);
    setExecTool('');
    if (!tool) return;
    setExecBusy(true);
    try {
      const ep = resolveEndpoint('v1.tools.execute');
      const body = buildFleetExecBody(tool, selectedRow?.host_id);
      const res = await client.post(ep.path, { service: ep.service, body, timeout: 120000 });
      const out = res?.result != null ? String(res.result) : 'ok';
      showToast?.(`${tool}: ${out.replace(/\s+/g, ' ').slice(0, 80)}`, 'success');
    } catch (err) {
      showToast?.(`${tool} failed: ${err.message}`, 'error');
    } finally {
      setExecBusy(false);
      refresh();
    }
  }, [client, selectedRow, showToast, refresh]);

  // ── Keyboard handling ──────────────────────────────────────────────
  useInput((input, key) => {
    if (!isActive) return;

    // While the tool-name prompt is open, only handle Esc (cancel);
    // SearchInput owns character/Enter input.
    if (execMode) {
      if (key.escape) { setExecMode(false); setExecTool(''); }
      return;
    }

    // `x` opens the exec prompt for the selected host
    if (input === 'x' && !execBusy && selectedRow) {
      setExecTool('');
      setExecMode(true);
      return;
    }

    // Manual refresh
    if (matchKey('refresh', input, key)) {
      refresh();
      return;
    }
  }, { isActive });

  // ── Footer hint ────────────────────────────────────────────────────
  const footer = execMode
    ? `Tool name  \u00b7  Enter Run on ${selectedRow?.host_id || 'fleet'}  \u00b7  Esc Cancel`
    : [
        '\u2191/k \u2193/j Navigate',
        'Enter Select',
        'x Exec tool',
        'r Refresh',
        'n/p Page',
        'Esc Back',
      ].join('  ');

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <Layout
      title="Fleet Status"
      subtitle={loading ? '(refreshing...)' : `${rows.length} agents`}
      footer={footer}
      left={
        <Box flexDirection="column">
          {error && (
            <Box marginBottom={1}>
              <Text color={colors.error}>Error: {error.message}</Text>
            </Box>
          )}
          {execMode && (
            <Box marginBottom={1}>
              <SearchInput
                placeholder={`tool to run on ${selectedRow?.host_id || 'fleet'}…`}
                value={execTool}
                onChange={setExecTool}
                onSubmit={runExec}
                active={execMode}
              />
            </Box>
          )}
          {execBusy && (
            <Box marginBottom={1}>
              <Text color={colors.warning}>Executing…</Text>
            </Box>
          )}
          <DataTable
            columns={COLUMNS}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            loading={loading && rows.length === 0}
            emptyMessage="No fleet agents online — deploy via `quox agent create` or check the collector connection"
            active={isActive && !execMode}
          />
        </Box>
      }
      right={
        <DetailPanel
          title={selectedRow ? selectedRow.host_id : undefined}
          data={detail}
        />
      }
    />
  );
}
