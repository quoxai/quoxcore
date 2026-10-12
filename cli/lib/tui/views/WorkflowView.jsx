/**
 * WorkflowView — Workflow management with run capability
 *
 * Left panel:  DataTable of workflows (name, status, steps count, updated)
 * Right panel: DetailPanel with workflow detail (description, steps, triggers, last run)
 *
 * Features:
 *   - `r` key refreshes
 *   - Enter on a workflow shows detail
 *   - `x` key executes the selected workflow (with y/n confirmation)
 *   - After execute, the returned run id is polled for live status
 *     (queued/running/waiting_on_human/completed/failed/cancelled/expired)
 *     until it reaches a terminal state; the last known run status is
 *     persisted on that workflow's detail panel.
 *
 * API (org-scoped):
 *   GET  /api/orgs/:orgId/workflows          (service: auth) -> data.workflows
 *   POST /api/orgs/:orgId/runs               (service: auth) -> { run: { id, status, ... } }
 *   GET  /api/orgs/:orgId/runs/:runId        (service: auth) -> { run: { id, status, ... } }
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Layout } from '../components/Layout.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { DetailPanel } from '../components/DetailPanel.jsx';
import { Confirm } from '../components/Confirm.jsx';
import { useApi } from '../hooks/useApi.js';
import { usePolledApi } from '../hooks/usePolledApi.js';
import { useTui } from '../app.jsx';
import { matchKey } from '../keys.js';
import { colors, styles } from '../theme.js';
import { resolveEndpoint } from '../../api/endpoints.js';

// Run statuses that stop polling (see services/auth/routes/runs.js RUN_STATUSES).
const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled', 'expired'];

/**
 * Color for a run status indicator.
 */
function runStatusColor(status) {
  if (status === 'completed') return colors.success;
  if (TERMINAL_RUN_STATUSES.includes(status)) return colors.error;
  if (status === 'waiting_on_human') return colors.warning;
  return colors.info; // pending / running
}

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
  { key: 'name',    label: 'Name',    width: 22 },
  { key: 'status',  label: 'Status',  width: 12 },
  { key: 'steps',   label: 'Steps',   width: 8 },
  { key: 'updated', label: 'Updated', width: 14 },
];

/**
 * Format raw workflow data into table rows.
 */
function formatRows(workflows) {
  if (!Array.isArray(workflows)) return [];
  return workflows.map((w) => ({
    name:    w.name || w.display_name || w.id,
    status:  `${styles.statusDot(w.status || 'unknown')} ${w.status || 'unknown'}`,
    steps:   w.steps != null
      ? String(Array.isArray(w.steps) ? w.steps.length : w.steps)
      : (w.step_count != null ? String(w.step_count) : '--'),
    updated: formatDate(w.updated_at),
    _raw: w,
  }));
}

/**
 * Build a detail object for the right panel.
 * `lastRun` (if present) is the most recent execute result/poll for this
 * workflow, kept alive after the transient banner clears.
 */
function buildDetail(raw, lastRun) {
  if (!raw) return null;
  const detail = {
    'Name':        raw.name || raw.display_name,
    'ID':          raw.id,
    'Status':      raw.status,
    'Description': raw.description,
    'Steps':       Array.isArray(raw.steps)
      ? raw.steps.map((s) => (typeof s === 'string' ? s : s.name || s.type || s.id)).join(', ')
      : (raw.step_count != null ? String(raw.step_count) : '--'),
    'Triggers':    Array.isArray(raw.triggers)
      ? raw.triggers.map((t) => (typeof t === 'string' ? t : t.type || t.name)).join(', ')
      : (raw.trigger || '--'),
    'Last Run':    raw.last_run_at ? formatDate(raw.last_run_at) : (raw.last_run ? formatDate(raw.last_run) : '--'),
    'Created':     raw.created_at,
    'Updated':     raw.updated_at,
  };

  // Add tags if present
  if (Array.isArray(raw.tags) && raw.tags.length > 0) {
    detail['Tags'] = raw.tags.join(', ');
  }

  // Persist the last execute/poll result for this workflow (survives the
  // transient banner clearing once the run reaches a terminal status).
  if (lastRun) {
    detail['Run ID'] = lastRun.id;
    detail['Run Status'] = lastRun.status;
  }

  return detail;
}

// ── Component ─────────────────────────────────────────────────────────
export function WorkflowView() {
  const ctx = useTui();
  const { client, screen, orgVersion } = ctx;
  const isActive = screen === 'workflows';
  const orgId = getOrgId(ctx);

  const [selected, setSelected] = useState(0);
  const [actionMsg, setActionMsg] = useState(null);
  const [confirming, setConfirming] = useState(false);
  // Active run banner: { id, workflowId, workflowName, status }. Cleared a
  // few seconds after the run reaches a terminal status.
  const [activeRun, setActiveRun] = useState(null);
  // Last known run per workflow id, kept so the detail panel still shows
  // "what happened" after the transient banner above has cleared.
  const [lastRunByWorkflow, setLastRunByWorkflow] = useState({});

  // ── Data fetching (refetches when the active org changes) ───────────
  const { data, loading, error, refresh } = useApi(
    async () => {
      if (!orgId) return [];
      const res = await client.get(resolveEndpoint('workflows.list', { orgId }).path, { service: resolveEndpoint('workflows.list', { orgId }).service });
      return res?.workflows || [];
    },
    [client, orgId, orgVersion]
  );

  const rows = formatRows(data);
  const selectedRow = rows[selected];
  const lastRun = selectedRow ? lastRunByWorkflow[selectedRow._raw.id] : null;
  const detail = selectedRow ? buildDetail(selectedRow._raw, lastRun) : null;

  // ── Poll run status while a run is active and non-terminal ─────────
  const pollRunId = activeRun && !TERMINAL_RUN_STATUSES.includes(activeRun.status) ? activeRun.id : null;

  const { data: runStatusData } = usePolledApi(
    async () => {
      if (!pollRunId || !orgId) return null;
      const res = await client.get(resolveEndpoint('runs.get', { orgId, pollRunId }).path, { service: resolveEndpoint('runs.get', { orgId, pollRunId }).service });
      return res?.run || res;
    },
    [client, orgId, pollRunId],
    { intervalMs: 2000, active: isActive && !!pollRunId }
  );

  useEffect(() => {
    if (!runStatusData || !activeRun || runStatusData.id !== activeRun.id) return;
    const status = runStatusData.status || activeRun.status;
    setActiveRun((prev) => (prev && prev.id === runStatusData.id ? { ...prev, status } : prev));
    setLastRunByWorkflow((prev) => ({
      ...prev,
      [activeRun.workflowId]: { id: runStatusData.id, status },
    }));
    if (TERMINAL_RUN_STATUSES.includes(status)) {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runStatusData]);

  // ── Clear the transient run banner once the run is terminal ────────
  useEffect(() => {
    if (activeRun && TERMINAL_RUN_STATUSES.includes(activeRun.status)) {
      const t = setTimeout(() => setActiveRun(null), 4000);
      return () => clearTimeout(t);
    }
  }, [activeRun]);

  // ── Execute workflow ────────────────────────────────────────────────
  const executeWorkflow = useCallback(async () => {
    if (!selectedRow || !orgId) return;
    const raw = selectedRow._raw;
    const wfId = raw.id;

    try {
      setActionMsg('Executing...');
      const res = await client.post(resolveEndpoint('runs.create', { orgId }).path, {
        service: resolveEndpoint('runs.create', { orgId }).service,
        body: { workflow_id: wfId },
      });
      const run = res?.run || res || {};
      const runId = run.id || run.run_id;
      const status = run.status || 'running';

      if (runId) {
        setActiveRun({ id: runId, workflowId: wfId, workflowName: raw.name || wfId, status });
        setLastRunByWorkflow((prev) => ({ ...prev, [wfId]: { id: runId, status } }));
        setActionMsg(`Run started: ${runId}`);
      } else {
        setActionMsg(`Workflow "${raw.name || wfId}" executed — no run id returned`);
      }
      refresh();
    } catch (err) {
      setActionMsg(`Execute failed: ${err.message}`);
    }

    setTimeout(() => setActionMsg(null), 3000);
  }, [selectedRow, orgId, client, refresh]);

  // ── Keyboard handling ──────────────────────────────────────────────
  useInput((input, key) => {
    if (!isActive || confirming) return;

    // Manual refresh
    if (matchKey('refresh', input, key)) {
      refresh();
      return;
    }

    // Execute workflow
    if (input === 'x' && selectedRow) {
      setConfirming(true);
      return;
    }
  }, { isActive: isActive && !confirming });

  // ── Confirmation handlers ─────────────────────────────────────────
  const handleConfirm = useCallback(() => {
    setConfirming(false);
    executeWorkflow();
  }, [executeWorkflow]);

  const handleCancel = useCallback(() => {
    setConfirming(false);
  }, []);

  // ── Footer hint ────────────────────────────────────────────────────
  const footer = [
    '\u2191/k \u2193/j Navigate',
    'x Execute',
    'r Refresh',
    'Esc Back',
  ].join('  ');

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <Layout
      title="Workflows"
      subtitle={orgId ? `${rows.length} workflows` : '(no org)'}
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
          {activeRun && (
            <Box marginBottom={1}>
              <Text>
                <Text color={runStatusColor(activeRun.status)}>{'●'}</Text>
                {' '}
                Run {activeRun.id}: {activeRun.status}
                {!TERMINAL_RUN_STATUSES.includes(activeRun.status) ? ' (polling…)' : ''}
              </Text>
            </Box>
          )}
          {confirming && (
            <Box marginBottom={1}>
              <Confirm
                message={`Execute "${selectedRow?._raw?.name || 'workflow'}"?`}
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
            emptyMessage={orgId ? 'No workflows found' : 'Select an organization first'}
            active={isActive && !confirming}
          />
        </Box>
      }
      right={
        <DetailPanel
          title={selectedRow ? (selectedRow._raw.name || 'Workflow') : undefined}
          data={detail}
        />
      }
    />
  );
}
