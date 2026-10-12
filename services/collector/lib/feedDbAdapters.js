/**
 * feedDbAdapters.js — The Feed's generic db-source adapter registry (L1,
 * docs/STREAM_QUOXBRAIN2_SOURCE_UNIVERSE.md "Wave 2: the generic db-source
 * adapter framework + the EXCLUDE registry → then registering the rest of
 * Tier-1/2 as small adapters").
 *
 * Each entry here is a declarative SPEC — not code — describing one
 * collector-local SQLite table (or filtered view of one) as a Qortex Feed
 * source: which db it lives in, which column scopes it to an org, which
 * columns render into the pushed doc's text, which column redacts. The
 * generic reader (feedDbSource.js's ingestDbSource) does the actual query
 * + render + push; this file only declares WHAT to read, never HOW.
 *
 * COLLECTOR-LOCAL ONLY: every spec below points at a db file this same
 * collector process owns and already opens itself (aee.db, volt.db) — no
 * cross-service HTTP calls, no new plumbing. A store owned by a DIFFERENT
 * service (auth.db, memory.db, tasks.db) is explicitly OUT of scope here;
 * those need an API-mode adapter (L2), not a raw sqlite open from this
 * process (this collector has no read access to those files' paths in
 * every deployment topology, and reaching into another service's db file
 * directly would violate the service boundary even where the file happens
 * to be co-located on disk).
 *
 * GOVERNANCE GATE: every spec is run through
 * feedExcludeRegistry.assertAdapterSafe() at module load — a spec naming
 * an excluded table/column throws immediately (fails collector boot)
 * rather than silently registering. This is deliberate fail-fast, not a
 * runtime check on the ingest path.
 */

'use strict';

const { assertAdapterSafe } = require('./feedExcludeRegistry.js');

// Same defaults server.js uses for these two dbs (AEE_DB_PATH / VOLT_DB_PATH)
// — this module never opens a connection itself (feedDbSource.js does,
// per-call), it only resolves the path the same way server.js already does
// so the adapter reads the SAME file the collector's own aeeDb/voltDb
// handles are backed by.
const AEE_DB_PATH = process.env.AEE_DB_PATH || '/var/lib/quox/aee.db';
const VOLT_DB_PATH = process.env.VOLT_DB_PATH || '/var/lib/quox/volt.db';

/**
 * `noc_tool_outcomes` (migrations/aee/000-baseline.sql) — every infra tool
 * call (docker/ssh/proxmox/...) with success/latency/error, in aee.db.
 * The densest "what ops happened" ledger already documented as the
 * lowest-effort Wave-1 pick. `error` is redacted — tool error strings can
 * carry command output, stack traces, or paths that shouldn't be copied
 * verbatim into a user-facing brain vault.
 */
const NOC_TOOL_OUTCOMES_SPEC = {
  sourceType: 'noc_tool_outcomes',
  dbPath: AEE_DB_PATH,
  table: 'noc_tool_outcomes',
  orgCol: 'org_id',
  userCol: 'user_id',
  textCols: ['tool_name', 'success', 'duration_ms', 'agent_id', 'error'],
  titleCol: 'tool_name',
  updatedCol: 'created_at',
  idCol: 'id',
  where: null,
  redactCols: ['error'],
  // Signal gate: only outcomes worth recalling are pushed, i.e. failures
  // (success = 0). Pure success/duration rows ("ssh_exec success 1 duration
  // 1480") are 51k near-identical notes with no recall value (2026-10-05
  // audit). Note `error` is redacted so the failure row's signal is the
  // tool name + agent + duration + the fact it failed.
  rowFilter: (row) => row.success === 0 || row.success === false || row.success === '0',
  piiFlag: false,
  scope: 'org',
  vaultName: 'Tool Outcomes',
};

/**
 * `governance_incidents` (migrations/volt/000-baseline.sql) — resolved
 * governance decisions, WARD-witnessed where applicable, in volt.db. The
 * on-brand "evidence layer" differentiator — tamper-evident record of
 * what the platform's governance decided and why.
 */
const GOVERNANCE_INCIDENTS_SPEC = {
  sourceType: 'governance_incidents',
  dbPath: VOLT_DB_PATH,
  table: 'governance_incidents',
  orgCol: 'org_id',
  userCol: 'user_id',
  textCols: ['incident_type', 'policy_name', 'title', 'description', 'resolution'],
  titleCol: 'policy_name',
  updatedCol: 'updated_at',
  idCol: 'id',
  where: null,
  redactCols: [],
  piiFlag: false,
  scope: 'org',
  vaultName: 'Governance Decisions',
};

/**
 * `aocl_policy` — NOT a whole table: a filtered VIEW over aee.db's own
 * `envelopes` table, scoped to `intent LIKE 'aocl.policy.%'` so only
 * governed allow/enforce/reject decisions are ever read — every other
 * envelope (chat turns, job submissions, etc.) is invisible to this
 * adapter regardless of org scoping. Mirrors the plan's "the brain
 * remembers governed decisions" framing.
 */
const AOCL_POLICY_SPEC = {
  sourceType: 'aocl_policy',
  dbPath: AEE_DB_PATH,
  table: 'envelopes',
  orgCol: 'org_id',
  userCol: null,
  textCols: ['intent', 'payload'],
  titleCol: 'intent',
  updatedCol: 'ts',
  idCol: 'id',
  where: "intent LIKE 'aocl.policy.%'",
  // payload is field-encrypted (enc:v1:) so feedDbSource drops it; a doc
  // with only the intent has no information, so require payload text.
  signalCols: ['payload'],
  redactCols: [],
  piiFlag: false,
  scope: 'org',
  vaultName: 'Policy Decisions',
};

const DB_ADAPTER_SPECS = [
  NOC_TOOL_OUTCOMES_SPEC,
  GOVERNANCE_INCIDENTS_SPEC,
  AOCL_POLICY_SPEC,
];

// Fail fast at boot: a misconfigured spec (excluded table/column) must
// never make it to a running scheduler tick.
for (const spec of DB_ADAPTER_SPECS) {
  assertAdapterSafe(spec);
}

module.exports = {
  NOC_TOOL_OUTCOMES_SPEC,
  GOVERNANCE_INCIDENTS_SPEC,
  AOCL_POLICY_SPEC,
  DB_ADAPTER_SPECS,
  AEE_DB_PATH,
  VOLT_DB_PATH,
};
