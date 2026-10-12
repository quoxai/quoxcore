/**
 * Governance commands: policies, WARD tamper-evident chain, VOLT evidence
 * bundles / certification, evidence + trace queries.
 *
 * All endpoints below are wired to real, existing collector routes — see
 * the comment above each subcommand for the exact route it calls.
 *
 * Read-only operations (list/get/status/verify/query) are first-class.
 *
 * Policy WRITE operations (create/update/delete/validate, template packs,
 * approval resolution) were added in WP4.2 (STREAM_CLI_PARITY_PLAN.md §2.3
 * #9) — see the `governance policy`, `governance template`, and
 * `governance approval` subcommands below. `governance certify` remains
 * the one action gated behind an explicit --confirm flag (it creates a
 * permanent VOLT certification record, matching the pattern used by
 * `vault export` and `vault delete`); the policy mutations below do not
 * require --confirm because the backend already enforces its own
 * second-approver (4-eyes) workflow for sensitive changes (a 202 response
 * with `pending_approval` instead of applying immediately).
 */

import { formatOutput, formatDetail, printSuccess, printWarning } from '../core/output.js';
import { resolveOrgId, parseJSON } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerGovernanceCommands(program, ctx) {
  const { client, auth } = ctx;

  const governance = program
    .command('governance')
    .description('Governance: policies, WARD chain, VOLT evidence + certification');

  // ── governance policy ───────────────────────────────────────────────────────
  // GET /api/v1/policies?org_id=...  (services/collector/server.js)

  const policy = governance
    .command('policy')
    .description('Manage governance policies');

  policy
    .command('list')
    .description('List governance policies')
    .option('--category <category>', 'filter by category')
    .option('--enabled <bool>', 'filter by enabled state (true|false)')
    .option('--effect <effect>', 'filter by effect')
    .option('--limit <n>', 'max results', '100')
    .option('--offset <n>', 'result offset', '0')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const query = { org_id: orgId, limit: options.limit, offset: options.offset };
      if (options.category) query.category = options.category;
      if (options.enabled !== undefined) query.enabled = options.enabled;
      if (options.effect) query.effect = options.effect;

      const data = await client.get(resolveEndpoint('v1.policies.list').path, { service: resolveEndpoint('v1.policies.list').service, query });
      formatOutput({
        columns: ['id', 'name', 'category', 'effect', 'enabled', 'updated_at'],
        headers: ['ID', 'Name', 'Category', 'Effect', 'Enabled', 'Updated'],
        rows: data.policies || data.data || data,
      }, { format: program.opts().output, emptyMessage: 'No policies found.' });
    });

  // GET /api/v1/policies/:id
  policy
    .command('get')
    .description('Show policy details')
    .argument('<id>', 'policy ID')
    .action(async (id) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('v1.policies.get', { id }).path, { service: resolveEndpoint('v1.policies.get', { id }).service });
      formatDetail(data.policy || data, { format: program.opts().output, title: `Policy: ${id}` });
    });

  // GET /api/v1/policies/approvals/pending?org_id=...
  policy
    .command('pending-approvals')
    .description('List policy changes awaiting second-approver sign-off')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('v1.policies.approvals.pending.list').path, {
        service: resolveEndpoint('v1.policies.approvals.pending.list').service,
        query: { org_id: orgId },
      });
      formatOutput({
        columns: ['id', 'policy_id', 'operation', 'actor_id', 'created_at'],
        headers: ['ID', 'Policy', 'Operation', 'Requested By', 'Requested'],
        rows: data.data || data,
      }, { format: program.opts().output, emptyMessage: 'No pending approvals.' });
    });

  // POST /api/v1/policies — create a new policy (WRITE, WP4.2)
  policy
    .command('create')
    .description('Create a new governance policy')
    .requiredOption('--name <name>', 'policy name')
    .requiredOption('--category <category>', 'policy category')
    .option('--effect <effect>', 'allow | deny | require_approval | redact | log_only', 'deny')
    .option('--priority <n>', 'priority (lower runs first)')
    .option('--scope <json>', 'scope as JSON, e.g. \'{"agents":["*"]}\'')
    .option('--conditions <json>', 'conditions as JSON')
    .option('--enabled <bool>', 'enabled state (true|false)', 'true')
    .option('--reason <text>', 'reason for the policy')
    .option('--framework-mapping <json>', 'framework mapping as a JSON array')
    .option('--audit-required', 'flag this policy as requiring audit')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = {
        org_id: orgId,
        name: options.name,
        category: options.category,
        effect: options.effect,
        enabled: options.enabled === undefined ? true : options.enabled === 'true',
      };
      if (options.priority !== undefined) body.priority = parseInt(options.priority, 10);
      if (options.scope) body.scope = parseJSON(options.scope, '--scope');
      if (options.conditions) body.conditions = parseJSON(options.conditions, '--conditions');
      if (options.reason) body.reason = options.reason;
      if (options.frameworkMapping) body.framework_mapping = parseJSON(options.frameworkMapping, '--framework-mapping');
      if (options.auditRequired) body.audit_required = true;

      const data = await client.post(resolveEndpoint('v1.policies.create').path, { service: resolveEndpoint('v1.policies.create').service, body });
      printSuccess(`Policy "${options.name}" created (id: ${data.policy?.id}).`);
      formatDetail(data.policy || data, { format: program.opts().output });
    });

  // PATCH /api/v1/policies/:id — update a policy (WRITE, WP4.2)
  // May return 202 { pending_approval } if the org has opted into 4-eyes
  // review for this change (--enforce-4eyes, or org-level policy).
  policy
    .command('update')
    .description('Update a governance policy (may require second-approver sign-off)')
    .argument('<id>', 'policy ID')
    .option('--name <name>', 'new name')
    .option('--category <category>', 'new category')
    .option('--effect <effect>', 'new effect: allow | deny | require_approval | redact | log_only')
    .option('--priority <n>', 'new priority')
    .option('--scope <json>', 'new scope as JSON')
    .option('--conditions <json>', 'new conditions as JSON')
    .option('--enabled <bool>', 'new enabled state (true|false)')
    .option('--reason <text>', 'reason for the change')
    .option('--enforce-4eyes', 'require second-approver sign-off for this change')
    .action(async (id, options) => {
      auth.requireAuth();
      const body = {};
      if (options.name) body.name = options.name;
      if (options.category) body.category = options.category;
      if (options.effect) body.effect = options.effect;
      if (options.priority !== undefined) body.priority = parseInt(options.priority, 10);
      if (options.scope) body.scope = parseJSON(options.scope, '--scope');
      if (options.conditions) body.conditions = parseJSON(options.conditions, '--conditions');
      if (options.enabled !== undefined) body.enabled = options.enabled === 'true';
      if (options.reason) body.reason_for_change = options.reason;
      if (options.enforce4eyes) body.enforce_4eyes = true;

      const data = await client.patch(resolveEndpoint('v1.policies.update', { id }).path, { service: resolveEndpoint('v1.policies.update', { id }).service, body });
      if (data.pending_approval) {
        printWarning('Change staged; awaiting second-approver review.');
        formatDetail(data.pending_approval, { format: program.opts().output, title: 'Pending Approval' });
        return;
      }
      printSuccess('Policy updated.');
      formatDetail(data.policy || data, { format: program.opts().output });
    });

  // DELETE /api/v1/policies/:id — delete a policy (WRITE, WP4.2)
  // May also return 202 { pending_approval } under 4-eyes review.
  policy
    .command('delete')
    .description('Delete a governance policy')
    .argument('<id>', 'policy ID')
    .action(async (id) => {
      auth.requireAuth();
      const data = await client.delete(resolveEndpoint('v1.policies.delete', { id }).path, { service: resolveEndpoint('v1.policies.delete', { id }).service });
      if (data.pending_approval) {
        printWarning('Delete staged; awaiting second-approver review.');
        formatDetail(data.pending_approval, { format: program.opts().output, title: 'Pending Approval' });
        return;
      }
      printSuccess(`Policy ${id} deleted.`);
    });

  // POST /api/v1/policies/validate — dry-run validation, does not persist (WP4.2)
  policy
    .command('validate')
    .description('Validate a policy definition without saving (dry run)')
    .requiredOption('--name <name>', 'policy name')
    .requiredOption('--category <category>', 'policy category')
    .option('--effect <effect>', 'allow | deny | require_approval | redact | log_only', 'deny')
    .option('--priority <n>', 'priority')
    .option('--scope <json>', 'scope as JSON')
    .option('--conditions <json>', 'conditions as JSON')
    .option('--enabled <bool>', 'enabled state (true|false)', 'true')
    .action(async (options) => {
      auth.requireAuth();
      const body = {
        name: options.name,
        category: options.category,
        effect: options.effect,
        enabled: options.enabled === undefined ? true : options.enabled === 'true',
      };
      if (options.priority !== undefined) body.priority = parseInt(options.priority, 10);
      if (options.scope) body.scope = parseJSON(options.scope, '--scope');
      if (options.conditions) body.conditions = parseJSON(options.conditions, '--conditions');

      const data = await client.post(resolveEndpoint('v1.policies.validate').path, { service: resolveEndpoint('v1.policies.validate').service, body });
      formatDetail(data, { format: program.opts().output, title: 'Validation Result' });
      if (data.valid === false && program.opts().output !== 'json') {
        printWarning('Validation failed.');
      }
    });

  // GET /api/v1/policies/history and GET /api/v1/policies/:id/history (WP4.2)
  policy
    .command('history')
    .description('Show policy change history (org-wide, or a single policy with --policy)')
    .option('--policy <id>', 'show history for a single policy ID instead of the whole org')
    .option('--operation <op>', 'filter by operation: created | updated | deleted')
    .option('--actor <id>', 'filter by actor ID')
    .option('--since <iso>', 'filter: since ISO timestamp')
    .option('--until <iso>', 'filter: until ISO timestamp')
    .option('--limit <n>', 'max results')
    .option('--offset <n>', 'result offset')
    .action(async (options) => {
      auth.requireAuth();
      const columns = ['id', 'policy_id', 'operation', 'actor_id', 'created_at'];
      const headers = ['ID', 'Policy', 'Operation', 'Actor', 'Changed'];

      if (options.policy) {
        const ep = resolveEndpoint('v1.policies.history.get', { id: options.policy });
        const query = {};
        if (options.limit) query.limit = options.limit;
        if (options.offset) query.offset = options.offset;
        const data = await client.get(ep.path, { service: ep.service, query });
        formatOutput({ columns, headers, rows: data.data || data }, { format: program.opts().output, emptyMessage: 'No history found for this policy.' });
        return;
      }

      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('v1.policies.history.list');
      const query = { org_id: orgId };
      if (options.operation) query.operation = options.operation;
      if (options.actor) query.actor_id = options.actor;
      if (options.since) query.since = options.since;
      if (options.until) query.until = options.until;
      if (options.limit) query.limit = options.limit;
      if (options.offset) query.offset = options.offset;
      const data = await client.get(ep.path, { service: ep.service, query });
      formatOutput({ columns, headers, rows: data.data || data }, { format: program.opts().output, emptyMessage: 'No policy history found.' });
    });

  // ── governance template ─────────────────────────────────────────────────────
  // Template packs: pre-built bundles of policies that can be previewed for
  // conflicts and enabled onto an org in one shot. GOV-7 (server.js ~12375).

  const template = governance
    .command('template')
    .description('Governance policy template packs');

  // GET /api/v1/policies/templates
  template
    .command('list')
    .description('List available template packs')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.policies.templates.list');
      const data = await client.get(ep.path, { service: ep.service });
      formatOutput({
        columns: ['id', 'name', 'description', 'policyCount'],
        headers: ['ID', 'Name', 'Description', 'Policies'],
        rows: data.data || data,
      }, { format: program.opts().output, emptyMessage: 'No template packs found.' });
    });

  // GET /api/v1/policies/templates/:packId
  template
    .command('show')
    .description('Show a template pack with its full policy set')
    .argument('<packId>', 'template pack ID')
    .action(async (packId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.policies.templates.get', { packId });
      const data = await client.get(ep.path, { service: ep.service });
      formatDetail(data.pack || data, { format: program.opts().output, title: `Template Pack: ${packId}` });
    });

  // POST /api/v1/policies/templates/:packId/conflicts — non-destructive preview (WRITE, WP4.2)
  template
    .command('conflicts')
    .description('Check a template pack for conflicts with existing policies before enabling')
    .argument('<packId>', 'template pack ID')
    .action(async (packId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('v1.policies.templates.conflicts', { packId });
      const data = await client.post(ep.path, { service: ep.service, body: { org_id: orgId } });
      formatOutput({
        // fleet #392: conflicts return templateName/existingId; `reason` has no counterpart.
        columns: ['templateName', 'existingId'],
        headers: ['Template Policy', 'Conflicts With'],
        rows: data.conflicts || [],
      }, { format: program.opts().output, emptyMessage: 'No conflicts detected.' });
      if (data.hasConflicts && program.opts().output !== 'json') {
        printWarning(`${data.conflicts.length} conflict(s) detected — review before enabling.`);
      }
    });

  // POST /api/v1/policies/templates/:packId/enable — WRITE, creates policies (WP4.2)
  template
    .command('enable')
    .description('Enable a template pack for the active org (creates its policies)')
    .argument('<packId>', 'template pack ID')
    .option('--created-by <id>', 'attribute the created policies to this actor')
    .action(async (packId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { org_id: orgId };
      if (options.createdBy) body.created_by = options.createdBy;
      const ep = resolveEndpoint('v1.policies.templates.enable', { packId });
      const data = await client.post(ep.path, { service: ep.service, body });
      printSuccess(`Template pack "${packId}" enabled.`);
      formatDetail(data, { format: program.opts().output });
    });

  // ── governance approval ─────────────────────────────────────────────────────
  // Second-approver (4-eyes) sign-off on staged policy changes.

  const approval = governance
    .command('approval')
    .description('Second-approver sign-off on staged policy changes');

  // POST /api/v1/policies/approvals/:entryId/resolve — WRITE, WP4.2
  approval
    .command('resolve')
    .description('Approve or reject a pending policy change')
    .argument('<entryId>', 'policy history entry ID')
    .requiredOption('--outcome <outcome>', 'approved | rejected')
    .option('--reason <text>', 'reason / comment for the decision')
    .option('--approved-by <id>', 'approver identity (defaults to the logged-in user)')
    .action(async (entryId, options) => {
      auth.requireAuth();
      if (!['approved', 'rejected'].includes(options.outcome)) {
        throw new Error("--outcome must be 'approved' or 'rejected'");
      }
      const tokens = auth.getTokens ? auth.getTokens() : null;
      const approvedBy = options.approvedBy || tokens?.email || tokens?.user_id;
      if (!approvedBy) {
        throw new Error('--approved-by required (no stored user identity found; run `quox login` or pass --approved-by).');
      }
      const body = { outcome: options.outcome, approved_by: approvedBy };
      if (options.reason) body.reason = options.reason;

      const ep = resolveEndpoint('v1.policies.approvals.resolve', { entryId });
      const data = await client.post(ep.path, { service: ep.service, body });
      printSuccess(`Approval ${entryId} ${options.outcome}.`);
      formatDetail(data.entry || data, { format: program.opts().output });
    });

  // ── governance ward ─────────────────────────────────────────────────────────
  // Mounted via services/ward/api-cjs.cjs mountWardRoutes(app) directly on
  // the collector app (no org-scoped path prefix).

  const ward = governance
    .command('ward')
    .description('WARD tamper-evident chain');

  // GET /ward/stats
  ward
    .command('status')
    .description('Show WARD chain + witness statistics')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('ward.stats.list').path, { service: resolveEndpoint('ward.stats.list').service });
      formatDetail({ ...data.stats, ...data.witness }, { format: program.opts().output, title: 'WARD Status' });
    });

  // GET /ward/chains
  ward
    .command('chains')
    .description('List WARD chains')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('ward.chains.list').path, { service: resolveEndpoint('ward.chains.list').service });
      formatOutput({
        columns: ['chain_id', 'created_at'],
        headers: ['Chain ID', 'Created'],
        rows: data.chains || data,
      }, { format: program.opts().output, emptyMessage: 'No chains found.' });
    });

  // GET /ward/entries?chain=...
  ward
    .command('entries')
    .description('List entries in a WARD chain')
    .option('--chain <chainId>', 'chain ID (default: production chain)')
    .option('--limit <n>', 'max results', '50')
    .action(async (options) => {
      auth.requireAuth();
      const query = { limit: options.limit };
      if (options.chain) query.chain = options.chain;
      const data = await client.get(resolveEndpoint('ward.entries.list').path, { service: resolveEndpoint('ward.entries.list').service, query });
      formatOutput({
        // fleet #392: WARD entries carry witnessed_at, not created_at.
        columns: ['seq', 'source_kind', 'chain_id', 'witnessed_at'],
        headers: ['Seq', 'Source', 'Chain', 'Created'],
        rows: data.entries || data,
      }, { format: program.opts().output, emptyMessage: 'No entries found.' });
    });

  // POST /ward/verify — non-mutating integrity check, safe to run without --confirm
  ward
    .command('verify')
    .description('Verify a WARD chain\'s integrity')
    // #622: --chain is no longer REQUIRED. An auditor who ran `ward verify`
    // with nothing hit "error: required option --chain" with no way to discover
    // a chain id from here, so verify dead-ended. Now bare `verify` LISTS the
    // discoverable chains + how to pick one, instead of erroring.
    //
    // A `--all` that verified every chain is still NOT kept, but the underlying
    // hazard is now fixed (GTM-G3d, 2026-09-28): server-side verify is BOUNDED, so
    // verifying the production chain (millions of entries) no longer pegs the
    // collector — it returns PARTIAL/BOUNDED_LARGE_CHAIN over the head window in
    // seconds. For full coverage of a very large chain, page with
    // --from-seq/--up-to-seq (bounded per call). Still one explicit chain at a time.
    .option('--chain <chainId>', 'chain ID to verify (see `quox governance ward chains`)')
    .option('--from-seq <n>', 'verify from this seq (page a large chain; bounded per call)', (v) => parseInt(v, 10))
    .option('--up-to-seq <n>', 'verify up to this seq (page a large chain; bounded per call)', (v) => parseInt(v, 10))
    // #622: prove ONE action end-to-end. An auditor asked "prove this agent
    // action is in your tamper-evident log" had no CLI path; now they take the
    // envelope id from `quox aee get <ENV_...>` and verify its receipt. Bounded
    // (entry → covering signed tip), so it is safe on the production chain that
    // a full --chain verify is not. --source/--source-kind generalise it to
    // AOCL/VOLT/EXTERNAL source events.
    .option('--envelope <envelopeId>', 'verify one AEE envelope\'s inclusion receipt (alias for --source <id> --source-kind AEE)')
    .option('--source <sourceId>', 'verify one source event\'s inclusion receipt')
    .option('--source-kind <kind>', 'source kind for --source (AEE|AOCL|VOLT|WARD|EXTERNAL)', 'AEE')
    .action(async (options) => {
      auth.requireAuth();
      const isJson = program.opts().output === 'json';

      // #622: single-action receipt path — takes precedence over chain verify.
      const sourceId = options.envelope || options.source;
      if (sourceId) {
        const sourceKind = options.envelope ? 'AEE' : options.sourceKind;
        const data = await client.post(resolveEndpoint('ward.verify_receipt').path, {
          service: resolveEndpoint('ward.verify_receipt').service,
          body: { source_id: sourceId, source_kind: sourceKind, chain_id: options.chain || undefined },
        });
        const result = data.result || data;
        formatDetail(result, { format: program.opts().output, title: `WARD Receipt: ${sourceKind} ${sourceId}` });
        if (result.status !== 'WITNESSED' && !isJson) {
          printWarning(`Receipt status: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
        }
        if (result.status !== 'WITNESSED') process.exitCode = 1;
        return;
      }

      if (!options.chain) {
        // Kill the dead-end: instead of erroring, show what CAN be verified.
        const chainsData = await client.get(resolveEndpoint('ward.chains.list').path, { service: resolveEndpoint('ward.chains.list').service });
        const chains = chainsData.chains || chainsData || [];
        if (isJson) { console.log(JSON.stringify({ error: 'chain_required', hint: 'pass --chain <id>', chains }, null, 2)); process.exitCode = 1; return; }
        printWarning('Specify --chain <id> to verify a chain. Discoverable chains:');
        formatOutput({
          columns: ['chain_id', 'created_at'],
          headers: ['Chain ID', 'Created'],
          rows: chains,
        }, { format: program.opts().output, emptyMessage: 'No chains found.' });
        process.exitCode = 1;
        return;
      }

      const verifyBody = { chain_id: options.chain };
      if (Number.isFinite(options.fromSeq)) verifyBody.from_seq = options.fromSeq;
      if (Number.isFinite(options.upToSeq)) verifyBody.up_to_seq = options.upToSeq;
      const data = await client.post(resolveEndpoint('ward.verify').path, {
        service: resolveEndpoint('ward.verify').service,
        body: verifyBody,
      });
      const result = data.result || data;
      formatDetail(result, { format: program.opts().output, title: `WARD Verify: ${options.chain}` });
      // G3d: a bounded verify of a large chain returns PARTIAL/BOUNDED_LARGE_CHAIN
      // (or PARTIAL/WINDOWED when paging) — that is a HEALTHY result, not a failure.
      // Treat those as success (exit 0); only a genuine problem (BROKEN, or PARTIAL
      // for INCOMPLETE_CHAIN / WINDOW_TOO_LARGE / a real gap) is exit 1.
      const boundedOk = result.status === 'PARTIAL'
        && (result.reason === 'BOUNDED_LARGE_CHAIN' || result.reason === 'WINDOWED');
      const healthy = result.status === 'INTACT' || boundedOk;
      if (result.status && !healthy && !isJson) {
        printWarning(`Chain status: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
      } else if (boundedOk && !isJson) {
        printWarning(`Chain status: verified bounded (${result.verified_range ? `seq ${result.verified_range.from}..${result.verified_range.to} of ${result.entry_count}` : 'head window'}); page with --from-seq/--up-to-seq for full coverage.`);
      }
      if (result.status && !healthy) process.exitCode = 1;
    });

  // ── governance evidence ──────────────────────────────────────────────────────
  // GET /quoxflow/evidence — collector proxy to quoxflow GET /api/evidence

  governance
    .command('evidence')
    .description('Query VOLT/quoxflow evidence records')
    .option('--corr <id>', 'correlation ID')
    .option('--envelope <id>', 'envelope ID')
    .option('--workflow <id>', 'workflow ID')
    .option('--execution <id>', 'execution ID')
    .option('--type <type>', 'evidence type')
    .option('--limit <n>', 'max results')
    .option('--offset <n>', 'result offset')
    .action(async (options) => {
      auth.requireAuth();
      const query = {};
      if (options.corr) query.corr = options.corr;
      if (options.envelope) query.envelopeId = options.envelope;
      if (options.workflow) query.workflowId = options.workflow;
      if (options.execution) query.executionId = options.execution;
      if (options.type) query.type = options.type;
      if (options.limit) query.limit = options.limit;
      if (options.offset) query.offset = options.offset;

      const data = await client.get(resolveEndpoint('quoxflow.evidence.list').path, { service: resolveEndpoint('quoxflow.evidence.list').service, query });
      formatOutput({
        // fleet #392: quoxflow evidence is camelCase (createdAt).
        columns: ['id', 'type', 'correlationId', 'workflowId', 'createdAt'],
        headers: ['ID', 'Type', 'Correlation', 'Workflow', 'Created'],
        rows: data.evidence || data.data || data,
      }, { format: program.opts().output, emptyMessage: 'No evidence records found.' });
    });

  // ── governance traces ─────────────────────────────────────────────────────────
  // GET /quoxflow/observations — collector proxy to quoxflow GET /api/observations

  governance
    .command('traces')
    .description('Query quoxflow execution traces (observations)')
    .option('--task <id>', 'task ID')
    .option('--correlation <id>', 'correlation ID')
    .option('--workflow <id>', 'workflow ID')
    .option('--org <id>', 'org ID (overrides active org)')
    .action(async (options) => {
      auth.requireAuth();
      const query = {};
      if (options.task) query.taskId = options.task;
      if (options.correlation) query.correlationId = options.correlation;
      if (options.workflow) query.workflowId = options.workflow;
      query.orgId = options.org || resolveOrgId(auth, program);

      const data = await client.get(resolveEndpoint('quoxflow.observations.list').path, { service: resolveEndpoint('quoxflow.observations.list').service, query });
      formatOutput({
        // fleet #392: observations carry ts, not created_at.
        columns: ['id', 'taskId', 'correlationId', 'ts'],
        headers: ['ID', 'Task', 'Correlation', 'Created'],
        rows: data.observations || data.data || data,
      }, { format: program.opts().output, emptyMessage: 'No traces found.' });
    });

  // ── governance certify ───────────────────────────────────────────────────────
  // POST /volt/certify — the one write. Requires --confirm.

  governance
    .command('certify')
    .description('Run VOLT certification against a run (WRITE — creates a certification record)')
    .argument('<runId>', 'VOLT run ID')
    .option('--retention-days <n>', 'retention period in days')
    .option('--audit-info <json>', 'audit info as JSON')
    .option('--compliance-info <json>', 'compliance info as JSON')
    .option('--confirm', 'confirm you want to run certification')
    .action(async (runId, options) => {
      auth.requireAuth();
      if (!options.confirm) {
        throw new Error('Certification creates a permanent record. Add --confirm to proceed.');
      }
      const body = { run_id: runId };
      if (options.retentionDays) body.retention_days = parseInt(options.retentionDays, 10);
      if (options.auditInfo) body.audit_info = parseJSON(options.auditInfo, '--audit-info');
      if (options.complianceInfo) body.compliance_info = parseJSON(options.complianceInfo, '--compliance-info');

      const data = await client.post(resolveEndpoint('volt.certify').path, { service: resolveEndpoint('volt.certify').service, body });
      printSuccess(`Certification created: ${data.cert_id} (tier: ${data.tier_name || data.tier})`);
      formatDetail(data, { format: program.opts().output });
    });

  // ── governance cert ──────────────────────────────────────────────────────────
  // GET /volt/cert/:certId, /volt/cert/run/:runId, /volt/certs, /volt/certs/stats

  const cert = governance
    .command('cert')
    .description('Inspect VOLT certifications');

  cert
    .command('get')
    .description('Get a certification by ID')
    .argument('<certId>', 'certification ID')
    .action(async (certId) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('volt.cert.get', { certId }).path, { service: resolveEndpoint('volt.cert.get', { certId }).service });
      formatDetail(data.cert || data, { format: program.opts().output, title: `Certification: ${certId}` });
    });

  cert
    .command('for-run')
    .description('Get the latest certification for a run')
    .argument('<runId>', 'VOLT run ID')
    .action(async (runId) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('volt.cert.run.get', { runId }).path, { service: resolveEndpoint('volt.cert.run.get', { runId }).service });
      formatDetail(data.cert || data, { format: program.opts().output, title: `Certification for run: ${runId}` });
    });

  cert
    .command('list')
    .description('List certifications')
    .option('--limit <n>', 'max results', '30')
    .option('--offset <n>', 'result offset', '0')
    .action(async (options) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('volt.certs.list').path, {
        service: resolveEndpoint('volt.certs.list').service,
        query: { limit: options.limit, offset: options.offset },
      });
      formatOutput({
        columns: ['cert_id', 'run_id', 'tier', 'tier_name', 'certified_at', 'expires_at'],
        headers: ['Cert ID', 'Run', 'Tier', 'Tier Name', 'Certified', 'Expires'],
        rows: data.certs || data,
      }, { format: program.opts().output, emptyMessage: 'No certifications found.' });
    });

  cert
    .command('stats')
    .description('Certification statistics')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('volt.certs.stats.list').path, { service: resolveEndpoint('volt.certs.stats.list').service });
      formatDetail(data, { format: program.opts().output, title: 'Certification Stats' });
    });
}
