/**
 * GovernanceView — WARD chain / VOLT evidence / policies / approvals
 *
 * Tabs: Ward | Evidence | Policies | Approvals
 *
 * Each tab has its own DataTable sourced from governance-related collector
 * endpoints. Tab key cycles through tabs.
 *
 * Features:
 *   - `v` key verifies the selected WARD chain's integrity (Ward tab only)
 *
 * API (all service: collector):
 *   GET  /ward/stats                          -> summary line (chains, entries, witness)
 *   GET  /ward/chains                         -> table (id, entries, last tip)
 *   POST /ward/verify { chain_id }            -> verify result (INTACT/TAMPERED)
 *   GET  /quoxflow/evidence?orgId=&limit=      -> evidence table
 *   GET  /api/v1/policies?org_id=&limit=       -> policies table
 *   GET  /api/v1/policies/approvals/pending?org_id= -> pending approvals table
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

// ── Tab definitions ───────────────────────────────────────────────────
const TABS = ['Ward', 'Evidence', 'Policies', 'Approvals'];

// ── Column definitions per tab ────────────────────────────────────────
const WARD_COLUMNS = [
  { key: 'id',       label: 'Chain ID',  width: 20 },
  { key: 'entries',  label: 'Entries',   width: 10 },
  { key: 'lastTip',  label: 'Last Tip',  width: 24 },
];

const EVIDENCE_COLUMNS = [
  { key: 'id',            label: 'ID',          width: 14 },
  { key: 'type',          label: 'Type',        width: 14 },
  { key: 'correlationId', label: 'Correlation', width: 18 },
  { key: 'workflowId',    label: 'Workflow',    width: 14 },
  { key: 'created',       label: 'Created',     width: 16 },
];

const POLICIES_COLUMNS = [
  { key: 'name',    label: 'Name',    width: 24 },
  { key: 'status',  label: 'Status',  width: 12 },
  { key: 'updated', label: 'Updated', width: 16 },
];

const APPROVALS_COLUMNS = [
  { key: 'id',       label: 'ID',           width: 10 },
  { key: 'policyId', label: 'Policy',       width: 20 },
  { key: 'operation', label: 'Operation',   width: 12 },
  { key: 'actor',    label: 'Requested By', width: 16 },
  { key: 'created',  label: 'Requested',    width: 16 },
];

// ── Unwrap helpers ────────────────────────────────────────────────────

function unwrapList(data, keys) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  for (const k of keys) {
    if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

// ── Row formatters ────────────────────────────────────────────────────

function formatWardRows(chains) {
  if (!Array.isArray(chains)) return [];
  return chains.map((c) => ({
    id:      c.id || c.chain_id || '--',
    entries: c.entries != null ? String(c.entries) : '--',
    lastTip: c.last_tip || c.lastTip || c.tip || c.latest_hash || '--',
    _raw: c,
  }));
}

function formatEvidenceRows(evidence) {
  if (!Array.isArray(evidence)) return [];
  return evidence.map((e) => ({
    id:            e.id ? String(e.id).slice(0, 12) : '--',
    type:          e.type || '--',
    correlationId: e.correlationId || e.corr || '--',
    workflowId:    e.workflowId || '--',
    created:       formatDate(e.created_at || e.createdAt),
    _raw: e,
  }));
}

function formatPoliciesRows(policies) {
  if (!Array.isArray(policies)) return [];
  return policies.map((p) => ({
    name:    p.name || p.id || '--',
    status:  p.enabled != null ? (p.enabled ? 'enabled' : 'disabled') : (p.status || '--'),
    updated: formatDate(p.updated_at || p.updatedAt),
    _raw: p,
  }));
}

function formatApprovalsRows(approvals) {
  if (!Array.isArray(approvals)) return [];
  return approvals.map((a) => ({
    id:        a.id ? String(a.id).slice(0, 8) : '--',
    policyId:  a.policy_id || a.policyId || '--',
    operation: a.operation || a.type || '--',
    actor:     a.actor_id || a.actor || a.requested_by || '--',
    created:   formatDate(a.created_at || a.createdAt),
    _raw: a,
  }));
}

// ── Detail builders ───────────────────────────────────────────────────

function buildWardDetail(raw) {
  if (!raw) return null;
  return {
    'Chain ID':  raw.id || raw.chain_id,
    'Entries':   raw.entries,
    'Last Tip':  raw.last_tip || raw.lastTip || raw.tip || raw.latest_hash,
    'Created':   raw.created_at,
  };
}

function buildEvidenceDetail(raw) {
  if (!raw) return null;
  return {
    'ID':          raw.id,
    'Type':        raw.type,
    'Correlation': raw.correlationId || raw.corr,
    'Envelope':    raw.envelopeId,
    'Workflow':    raw.workflowId,
    'Execution':   raw.executionId,
    'Created':     raw.created_at || raw.createdAt,
  };
}

function buildPolicyDetail(raw) {
  if (!raw) return null;
  return {
    'Name':     raw.name || raw.id,
    'Category': raw.category,
    'Effect':   raw.effect,
    'Enabled':  raw.enabled,
    'Status':   raw.status,
    'Updated':  raw.updated_at || raw.updatedAt,
  };
}

function buildApprovalDetail(raw) {
  if (!raw) return null;
  return {
    'ID':           raw.id,
    'Policy':       raw.policy_id || raw.policyId,
    'Operation':    raw.operation || raw.type,
    'Requested By': raw.actor_id || raw.actor || raw.requested_by,
    'Requested':    raw.created_at || raw.createdAt,
  };
}

// ── Utility ───────────────────────────────────────────────────────────

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
// ── Per-tab empty-state messages ────────────────────────────────────────
const EMPTY_MESSAGES = [
  'No chains yet',
  'No evidence records',
  'No policies defined',
  'No approvals pending ✓',
];

export function GovernanceView() {
  const ctx = useTui();
  const { client, screen, showToast, orgVersion } = ctx;
  const isActive = screen === 'governance';
  const orgId = getOrgId(ctx);

  const [activeTab, setActiveTab] = useState(0);
  const [selected, setSelected] = useState(0);

  // ── Fetch ward stats (summary) ───────────────────────────────────────
  const { data: wardStats } = usePolledApi(
    async () => {
      const res = await client.get(resolveEndpoint('ward.stats.list').path, { service: resolveEndpoint('ward.stats.list').service });
      return res || {};
    },
    [client, orgId, orgVersion],
    { intervalMs: 0, active: isActive }
  );

  // ── Fetch ward chains ────────────────────────────────────────────────
  const { data: wardChains, loading: wardLoading, error: wardError, refresh: refreshWard } = usePolledApi(
    async () => {
      const res = await client.get(resolveEndpoint('ward.chains.list').path, { service: resolveEndpoint('ward.chains.list').service });
      return unwrapList(res, ['chains', 'items']);
    },
    [client, orgId, orgVersion],
    { intervalMs: 0, active: isActive }
  );

  // ── Fetch evidence ────────────────────────────────────────────────────
  const { data: evidenceData, loading: evidenceLoading, error: evidenceError, refresh: refreshEvidence } = usePolledApi(
    async () => {
      const res = await client.get(resolveEndpoint('quoxflow.evidence.list').path, {
        service: resolveEndpoint('quoxflow.evidence.list').service,
        query: { orgId, limit: 50 },
      });
      return unwrapList(res, ['evidence', 'data', 'items']);
    },
    [client, orgId, orgVersion],
    { intervalMs: 0, active: isActive }
  );

  // ── Fetch policies ────────────────────────────────────────────────────
  const { data: policiesData, loading: policiesLoading, error: policiesError, refresh: refreshPolicies } = usePolledApi(
    async () => {
      const res = await client.get(resolveEndpoint('v1.policies.list').path, {
        service: resolveEndpoint('v1.policies.list').service,
        query: { org_id: orgId, limit: 50 },
      });
      return unwrapList(res, ['policies', 'items']);
    },
    [client, orgId, orgVersion],
    { intervalMs: 0, active: isActive }
  );

  // ── Fetch pending approvals ───────────────────────────────────────────
  const { data: approvalsData, loading: approvalsLoading, error: approvalsError, refresh: refreshApprovals } = usePolledApi(
    async () => {
      const res = await client.get(resolveEndpoint('v1.policies.approvals.pending.list').path, {
        service: resolveEndpoint('v1.policies.approvals.pending.list').service,
        query: { org_id: orgId },
      });
      return unwrapList(res, ['approvals', 'data', 'items']);
    },
    [client, orgId, orgVersion],
    { intervalMs: 0, active: isActive }
  );

  // ── Active tab data ─────────────────────────────────────────────────
  let columns, rows, detail, loading, error;

  switch (activeTab) {
    case 0: // Ward
      columns = WARD_COLUMNS;
      rows = formatWardRows(wardChains);
      detail = rows[selected] ? buildWardDetail(rows[selected]._raw) : null;
      loading = wardLoading;
      error = wardError;
      break;
    case 1: // Evidence
      columns = EVIDENCE_COLUMNS;
      rows = formatEvidenceRows(evidenceData);
      detail = rows[selected] ? buildEvidenceDetail(rows[selected]._raw) : null;
      loading = evidenceLoading;
      error = evidenceError;
      break;
    case 2: // Policies
      columns = POLICIES_COLUMNS;
      rows = formatPoliciesRows(policiesData);
      detail = rows[selected] ? buildPolicyDetail(rows[selected]._raw) : null;
      loading = policiesLoading;
      error = policiesError;
      break;
    case 3: // Approvals
      columns = APPROVALS_COLUMNS;
      rows = formatApprovalsRows(approvalsData);
      detail = rows[selected] ? buildApprovalDetail(rows[selected]._raw) : null;
      loading = approvalsLoading;
      error = approvalsError;
      break;
  }

  // ── Reset selection on tab change ───────────────────────────────────
  useEffect(() => {
    setSelected(0);
  }, [activeTab]);

  // ── Refresh current tab ─────────────────────────────────────────────
  const refreshCurrent = useCallback(() => {
    const refreshers = [refreshWard, refreshEvidence, refreshPolicies, refreshApprovals];
    refreshers[activeTab]?.();
  }, [activeTab, refreshWard, refreshEvidence, refreshPolicies, refreshApprovals]);

  // ── Verify selected WARD chain ───────────────────────────────────────
  const verifySelected = useCallback(async () => {
    if (activeTab !== 0) return;
    const row = rows[selected];
    if (!row) return;
    const chainId = row._raw.id || row._raw.chain_id;
    if (!chainId) return;
    try {
      const data = await client.post(resolveEndpoint('ward.verify').path, {
        service: resolveEndpoint('ward.verify').service,
        body: { chain_id: chainId },
      });
      const result = data?.result || data;
      const status = result?.status || 'unknown';
      const ok = status === 'INTACT';
      showToast?.(`Chain ${chainId}: ${status}`, ok ? 'success' : 'error');
      refreshWard();
    } catch (err) {
      showToast?.(err.message, 'error');
    }
  }, [activeTab, rows, selected, client, showToast, refreshWard]);

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

    // Verify selected WARD chain
    if (input === 'v') {
      verifySelected();
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

  // ── Ward summary line ────────────────────────────────────────────────
  const wardSummary = wardStats
    ? `chains: ${wardStats.stats?.chains ?? wardStats.chains ?? '--'}  entries: ${wardStats.stats?.entries ?? wardStats.entries ?? '--'}`
    : null;

  // ── Detail title ───────────────────────────────────────────────────
  let detailTitle;
  if (rows[selected]) {
    switch (activeTab) {
      case 0: detailTitle = rows[selected]._raw.id || rows[selected]._raw.chain_id || 'Chain'; break;
      case 1: detailTitle = rows[selected]._raw.id || 'Evidence'; break;
      case 2: detailTitle = rows[selected]._raw.name || rows[selected]._raw.id || 'Policy'; break;
      case 3: detailTitle = rows[selected]._raw.id || 'Approval'; break;
    }
  }

  // ── Footer hint ────────────────────────────────────────────────────
  const footer = [
    'Tab: switch',
    'v: verify chain',
    'r: refresh',
    'Esc: back',
  ].join('  ');

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <Layout
      title="Governance"
      subtitle={TABS[activeTab]}
      footer={footer}
      left={
        <Box flexDirection="column">
          {/* Tab bar */}
          {tabBar}

          {activeTab === 0 && wardSummary && (
            <Box marginBottom={1}>
              <Text color={colors.dim}>{wardSummary}</Text>
            </Box>
          )}

          {error && (
            <Box marginBottom={1}>
              <Text color={colors.error}>Error: {error.message}</Text>
            </Box>
          )}

          {!orgId && !loading && activeTab !== 0 && (
            <Box marginBottom={1}>
              <Text color={colors.warning}>No organization selected.</Text>
            </Box>
          )}

          {activeTab === 3 && !loading && !error && rows.length === 0 ? (
            <Box paddingY={1}>
              <Text color={colors.success}>{EMPTY_MESSAGES[3]}</Text>
            </Box>
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              selected={selected}
              onSelectionChange={setSelected}
              loading={loading}
              emptyMessage={EMPTY_MESSAGES[activeTab]}
              active={isActive}
            />
          )}
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
