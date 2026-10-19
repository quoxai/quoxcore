/**
 * Engagement commands: QUOX-SECURITY Phase 0 engagement/scope object.
 *
 * quox engagement create <name> --environment-tier <tier> [--risk-ceiling <tier>]
 * quox engagement list
 * quox engagement show <id>
 * quox engagement add-target <id> <type> <value> [--verification-method <method>]
 * quox engagement verify-target <id> <targetId>
 *
 * Backend: services/collector/server.js's /api/v1/security/engagements
 * routes (collector-native, own security.db, not a proxy). No agent
 * capability exists yet, this is pure engagement/scope CRUD plus the
 * domain-verification challenge that every future security capability
 * call must pass. See lib/securityEngagement.js for the enforcement
 * itself (environment_tier/risk_ceiling validation, verification, and the
 * policy gate wired into approvalGate.js).
 */

import { writeFileSync } from 'node:fs';
import { formatOutput, formatDetail, printSuccess, printInfo } from '../core/output.js';
import { events, printEvent, line as glyphLine } from '../core/quoxglyph.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerEngagementCommands(program, ctx) {
  const { client, auth } = ctx;

  const engagement = program
    .command('engagement')
    .description('QUOX-SECURITY: engagements + scope targets, live capability scanners (run via scan/scan-async; see "engagement tools" for the list), and findings (report/verify/regrade/resolve)');

  engagement
    .command('create <name>')
    .description('Create a new security engagement')
    .requiredOption('--environment-tier <tier>', 'dev | staging | production')
    .option('--risk-ceiling <tier>', 'passive | discovery | safe_active | intrusive | credential_sensitive | exploit_emulation (production caps at discovery in Phase 0)')
    .option('--time-window-start <iso>', 'ISO 8601 timestamp')
    .option('--time-window-end <iso>', 'ISO 8601 timestamp')
    .option('--responsible-project <name>', 'the project/team this engagement belongs to')
    .action(async (name, options) => {
      auth.requireAuth();
      const body = { name, environment_tier: options.environmentTier };
      if (options.riskCeiling) body.risk_ceiling = options.riskCeiling;
      if (options.timeWindowStart || options.timeWindowEnd) {
        body.time_window = { start: options.timeWindowStart || null, end: options.timeWindowEnd || null };
      }
      if (options.responsibleProject) body.responsible_project = options.responsibleProject;

      const ep = resolveEndpoint('engagement.create');
      const data = await client.post(ep.path, { service: ep.service, body });
      printEvent(events.created('quox', 'engagement', data.engagement.id));
      formatDetail(data.engagement, { format: program.opts().output, title: 'Engagement' });
    });

  engagement
    .command('list')
    .description('List engagements for the current org')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.list');
      const data = await client.get(ep.path, { service: ep.service });
      formatOutput({
        columns: ['id', 'name', 'status', 'environment_tier', 'risk_ceiling', 'created_at'],
        headers: ['ID', 'Name', 'Status', 'Environment', 'Risk Ceiling', 'Created'],
        rows: data.engagements || [],
      }, { format: program.opts().output, emptyMessage: 'No engagements yet.' });
    });

  engagement
    .command('show <id>')
    .description('Show an engagement and its targets')
    .action(async (id) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.get', { id });
      const data = await client.get(ep.path, { service: ep.service });
      formatDetail(data.engagement, { format: program.opts().output, title: 'Engagement' });
      formatOutput({
        columns: ['id', 'type', 'value', 'verification_status', 'verified_at'],
        headers: ['ID', 'Type', 'Value', 'Verification', 'Verified At'],
        rows: data.targets || [],
      }, { format: program.opts().output, emptyMessage: 'No targets added yet.' });
    });

  engagement
    .command('set-gripe-target <id>')
    .description('Set which repo a finding filed from this engagement goes to, and which org GitHub connector token files it. Lets a customer-site engagement file into the customer repo with the customer org token. Pass --clear (or --repo "") to fall back to the platform default (quoxai/quox) and the engagement own org.')
    .option('--repo <owner/name>', 'GitHub repo for findings from this engagement (owner/name). Pass an empty value to clear.')
    .option('--connector-org <orgId>', 'org whose GitHub connector token files the issue')
    .option('--clear', 'clear both overrides back to the platform default')
    .action(async (id, options) => {
      auth.requireAuth();
      if (!options.clear && options.repo === undefined && options.connectorOrg === undefined) {
        throw new Error('nothing to set: pass --repo <owner/name>, --connector-org <orgId>, or --clear');
      }
      let gripeRepo = null;
      let connectorOrg = null;
      if (!options.clear) {
        gripeRepo = options.repo ? options.repo : null;
        connectorOrg = options.connectorOrg ? options.connectorOrg : null;
      }
      const ep = resolveEndpoint('engagement.gripe_target.set', { id });
      const data = await client.patch(ep.path, {
        service: ep.service,
        body: { gripe_repo: gripeRepo, gripe_connector_org_id: connectorOrg },
      });
      const eng = data.engagement;
      printSuccess(`Gripe target updated for engagement ${eng.id}.`);
      console.log(`  Repo: ${eng.gripe_repo || 'platform default (quoxai/quox)'}`);
      console.log(`  Connector org: ${eng.gripe_connector_org_id || 'engagement own org'}`);
    });

  engagement
    .command('add-target <id> <type> <value>')
    .description('Add a target (type: domain | cidr | repo | cloud_account | url) to an engagement')
    .option('--verification-method <method>', 'dns_txt | well_known_file | quoxagent_install (private-network targets, proven via real fleet membership; signed_attestation not implemented in Phase 0)')
    .action(async (id, type, value, options) => {
      auth.requireAuth();
      const body = { type, value };
      if (options.verificationMethod) body.verification_method = options.verificationMethod;

      const ep = resolveEndpoint('engagement.target.create', { id });
      const data = await client.post(ep.path, { service: ep.service, body });
      printSuccess(`Target "${value}" added to engagement ${id}.`);
      if (data.target.verification_token) {
        // #1007: a url target is challenged on its hostname (dns_txt) or at its own origin (well_known_file)
        const stored = data.target.value || value;
        const url = data.target.type === 'url' ? (() => { try { return new URL(stored); } catch { return null; } })() : null;
        if (data.target.verification_method === 'dns_txt') {
          console.log(`  Add a DNS TXT record on ${url ? url.hostname : stored}: quox-verify=${data.target.verification_token}`);
        } else if (data.target.verification_method === 'well_known_file') {
          console.log(`  Serve this content at ${url ? url.origin : `https://${stored}`}/.well-known/quox-verification: ${data.target.verification_token}`);
        }
        console.log(`  Then run: quox engagement verify-target ${id} ${data.target.id}`);
      }
      formatDetail(data.target, { format: program.opts().output, title: 'Target' });
    });

  engagement
    .command('verify-target <id> <targetId>')
    .description('Run the domain-verification challenge for a target')
    .action(async (id, targetId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.target.verify', { id, targetId });
      const data = await client.post(ep.path, { service: ep.service, body: {} });
      if (data.target.verification_status === 'verified') {
        printEvent(glyphLine('quox', 'target verified', { result: data.target.value, status: 'ok' }));
      } else {
        console.log(`  Verification status: ${data.target.verification_status} (challenge did not match yet).`);
      }
      formatDetail(data.target, { format: program.opts().output, title: 'Target' });
    });

  engagement
    .command('check-policy <id> <targetValue> <capabilityRisk>')
    .description('Check whether a capability of the given risk tier is currently allowed against a target (passive|discovery|safe_active|intrusive|credential_sensitive|exploit_emulation)')
    .action(async (id, targetValue, capabilityRisk) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.check_policy', { id });
      const data = await client.post(ep.path, { service: ep.service, body: { target_value: targetValue, capability_risk: capabilityRisk } });
      if (data.allowed) {
        printEvent(glyphLine('quox', 'policy check', { result: data.requiresApproval ? 'allowed · requires approval' : 'allowed', status: data.requiresApproval ? 'warn' : 'ok' }));
      } else {
        console.log(`  Denied: ${data.reason}`);
      }
    });

  engagement
    .command('scan <id> <target> <tool>')
    .description('Attempt a Phase 1 capability tool against a verified, in-scope target (tool: discover_hosts | probe_http | discover_app_ports | vuln_scan). Policy-gated; honestly fails if no scan host is configured.')
    .action(async (id, target, tool) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.capability', { id, tool });
      const data = await client.post(ep.path, { service: ep.service, body: { target } });
      if (data.success) {
        printEvent(glyphLine('quox', `${tool}`, { result: 'completed', status: 'ok' }));
        console.log(JSON.stringify(data.output, null, 2));
      } else {
        console.log(`  Failed (allowed: ${data.allowed}): ${data.error}`);
        process.exitCode = 1; // #1007: a refusal is not success, for scripts as much as people
      }
    });

  engagement
    .command('discover-ports <id> <hostTarget>')
    .description('Discover which app ports on a verified, in-scope host actually serve HTTP(S) (httpx over a curated port set), so a scan hits the real surface instead of only :80/:443. With --add, register each discovered endpoint as a verified url target (control re-proven via fleet membership).')
    .option('--add', 'Add each discovered endpoint as a url target and verify it')
    .action(async (id, hostTarget, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.discover_app_ports', { id });
      const data = await client.post(ep.path, { service: ep.service, body: { target: hostTarget, add: options.add === true } });
      if (!data.success) {
        console.log(`  Failed (allowed: ${data.allowed}): ${data.error}`);
        process.exitCode = 1; // #1007: a refusal is not success, for scripts as much as people
        return;
      }
      const discovered = data.discovered || [];
      printSuccess(`Discovered ${discovered.length} serving endpoint(s) on ${hostTarget}.`);
      formatOutput({
        columns: ['url', 'status_code', 'title'],
        headers: ['URL', 'Status', 'Title'],
        rows: discovered,
      }, { format: program.opts().output, emptyMessage: 'No serving app ports found.' });
      if (options.add) {
        const added = data.added || [];
        const skipped = data.skipped || [];
        printSuccess(`Added ${added.length} url target(s); skipped ${skipped.length} already in scope.`);
        if (added.length) {
          formatOutput({
            columns: ['url', 'targetId', 'verified'],
            headers: ['URL', 'Target', 'Verified'],
            rows: added,
          }, { format: program.opts().output, emptyMessage: 'None added.' });
        }
      }
    });

  engagement
    .command('tools')
    .description('List the real capability tools (name, risk tier, binary). Quoxcli-parity fix: this catalog backed the dashboard Tools tab but had no CLI verb.')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.capability_tools');
      const data = await client.get(ep.path, { service: ep.service });
      formatOutput({
        columns: ['tool', 'capabilityRisk', 'binary', 'description'],
        headers: ['Tool', 'Risk', 'Binary', 'Description'],
        rows: data.tools || [],
      }, { format: program.opts().output, emptyMessage: 'No capability tools registered.' });
    });

  engagement
    .command('scan-async <id> <target> <tool>')
    .description('Start a capability tool as a background job and return immediately (job_id). Use for tools that can outrun a single request, e.g. vuln_scan/nuclei or discover_app_ports over a wide host set. Poll with `quox engagement job <jobId>`.')
    .action(async (id, target, tool) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.capability.start', { id, tool });
      const data = await client.post(ep.path, { service: ep.service, body: { target } });
      if (data.success && data.job_id) {
        printSuccess(`${tool} started as job ${data.job_id} (status: ${data.status}).`);
        console.log(`  Poll: quox engagement job ${data.job_id}`);
      } else {
        console.log(`  Failed (allowed: ${data.allowed}): ${data.error}`);
        process.exitCode = 1; // #1007: a refusal is not success, for scripts as much as people
      }
    });

  engagement
    .command('job <jobId>')
    .description('Check the status/result of an async scan job (queued | running | succeeded | failed)')
    .action(async (jobId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.job.get', { jobId });
      const data = await client.get(ep.path, { service: ep.service });
      formatDetail(data.job, { format: program.opts().output, title: 'Scan job' });
    });

  engagement
    .command('jobs <id>')
    .description('List async scan jobs for an engagement')
    .action(async (id) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.jobs.list', { id });
      const data = await client.get(ep.path, { service: ep.service });
      formatOutput({
        columns: ['id', 'tool', 'target', 'status', 'created_at', 'finished_at'],
        headers: ['ID', 'Tool', 'Target', 'Status', 'Created', 'Finished'],
        rows: data.jobs || [],
      }, { format: program.opts().output, emptyMessage: 'No scan jobs yet.' });
    });

  engagement
    .command('report-finding <id> <targetValue> <title> <description>')
    .description('Report a candidate finding against a target within an engagement. Always starts as status "candidate"')
    .option('--severity <level>', 'info | low | medium | high | critical', 'info')
    .action(async (id, targetValue, title, description, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.findings.report', { id });
      const data = await client.post(ep.path, {
        service: ep.service,
        body: { target_value: targetValue, title, description, severity: options.severity },
      });
      printSuccess(`Finding "${data.finding.id}" reported (status: candidate).`);
      formatDetail(data.finding, { format: program.opts().output, title: 'Finding' });
      // quox#601 report-time reminder: severity defaults to 'info', and a batch
      // left there ships understated on the published /security projection
      // (that is exactly what bit trust-proof cycle 3). Nudge, don't block: a
      // genuinely-info finding is fine, but the default should be a choice.
      if (data.finding?.severity === 'info') {
        printInfo(`Severity is 'info' (the default). If that understates it, re-grade with a reason: quox engagement regrade-finding ${data.finding.id} <severity> --reason "<why>"`);
      }
    });

  engagement
    .command('findings <id>')
    .description('List findings for an engagement')
    .action(async (id) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.findings.list', { id });
      const data = await client.get(ep.path, { service: ep.service });
      const findings = data.findings || [];
      // Surface gripe_url/quoxplan_ref columns only when at least one
      // finding actually has a value — an all-empty column is just noise.
      const hasGripe = findings.some((f) => f.gripe_url);
      const hasQuoxplan = findings.some((f) => f.quoxplan_ref);
      const columns = ['id', 'title', 'severity', 'status', 'target_value', 'created_at'];
      const headers = ['ID', 'Title', 'Severity', 'Status', 'Target', 'Created'];
      if (hasGripe) { columns.push('gripe_url'); headers.push('Issue'); }
      if (hasQuoxplan) { columns.push('quoxplan_ref'); headers.push('QuoxPlan'); }
      formatOutput({
        columns,
        headers,
        rows: findings,
      }, { format: program.opts().output, emptyMessage: 'No findings yet.' });
    });

  engagement
    .command('verify-finding <findingId> <verdict>')
    .description('Confirm or refute a candidate finding (verdict: confirmed | refuted). A reason is required, a bare verdict is refused')
    .requiredOption('--reason <text>', 'why this verdict was reached')
    .action(async (findingId, verdict, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.findings.verify', { findingId });
      const data = await client.post(ep.path, { service: ep.service, body: { verdict, reason: options.reason } });
      printSuccess(`Finding "${data.finding.id}" ${data.finding.status}.`);
      formatDetail(data.finding, { format: program.opts().output, title: 'Finding' });
    });

  engagement
    .command('resolve-finding <findingId>')
    .description('Mark a finding remediated (status: resolved). Refuses a refuted finding')
    .action(async (findingId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.findings.resolve', { findingId });
      const data = await client.post(ep.path, { service: ep.service, body: {} });
      printSuccess(`Finding "${data.finding.id}" ${data.finding.status}.`);
      formatDetail(data.finding, { format: program.opts().output, title: 'Finding' });
    });

  engagement
    .command('regrade-finding <findingId> <severity>')
    .description('Re-grade a reported finding\'s severity (info | low | medium | high | critical). A reason is required, the same discipline as verify-finding, because severity is a published field')
    .requiredOption('--reason <text>', 'why the severity is being changed')
    .action(async (findingId, severity, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.findings.regrade', { findingId });
      const data = await client.post(ep.path, { service: ep.service, body: { severity, reason: options.reason } });
      const f = data.finding;
      printSuccess(`Finding "${f.id}" re-graded ${f.severity_from} -> ${f.severity}.`);
      formatDetail(f, { format: program.opts().output, title: 'Finding' });
    });

  // Finding -> next-steps pipeline: lib/securityReportActions.js. Raise
  // issue (GitHub issue) / Propose as QuoxPlan / Download PDF, mirroring the
  // dashboard Findings tab's action bar so nothing ships dashboard-only
  // (quoxcli-parity gate).

  // Known output-format values understood by the global -o/--output flag
  // (bin/quox.js). The `report` command below reuses -o/--output for a
  // different purpose (destination file path), which collides with that
  // global flag at the root parser — a real path passed after `report <id>`
  // lands in `program.opts().output` rather than this command's own
  // `options.output`. Anything that isn't a recognized format name is
  // treated as the destination file rather than silently dropped.
  const KNOWN_OUTPUT_FORMATS = new Set(['table', 'json', 'csv', 'quiet']);

  engagement
    .command('report <id>')
    .description('Download the engagement report (targets, tools run, findings) as a PDF')
    .option('--pdf', 'Format flag — PDF is the only format currently shipped, kept for forward compatibility')
    .option('--output <file>', 'Output file path (default: quox-security-<id>.pdf)')
    .action(async (id, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.report.pdf', { id });
      const res = await client.get(ep.path, { service: ep.service, raw: true });
      if (!res.ok) {
        let data;
        try { data = await res.json(); } catch { data = { error: res.statusText }; }
        throw new Error(data.error || `Request failed with status ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const rootOutput = program.opts().output;
      // quox#919: the global --json reaches options.output as 'json' via
      // mergeShadowedGlobals; an output-format name is never a file path.
      const asPath = (v) => (v && !KNOWN_OUTPUT_FORMATS.has(v) ? v : null);
      const outFile = asPath(options.output) || asPath(rootOutput) || `quox-security-${id}.pdf`;
      writeFileSync(outFile, buf);
      if (rootOutput === 'json') {
        console.log(JSON.stringify({ success: true, file: outFile, bytes: buf.length }));
      } else {
        printSuccess(`Report saved to ${outFile} (${buf.length} bytes).`);
      }
    });

  async function raiseIssue(findingId) {
    auth.requireAuth();
    const ep = resolveEndpoint('engagement.findings.gripe', { findingId });
    const data = await client.post(ep.path, { service: ep.service, body: {} });
    if (data.configured === false) {
      console.log(`  ${data.message || 'GitHub not configured.'}`);
      return;
    }
    if (data.ok === false) {
      console.log(`  ${data.message || 'GitHub connection rejected.'}`);
      return;
    }
    if (data.alreadyFiled) {
      console.log(`  Already filed: ${data.url}`);
      return;
    }
    printSuccess(`Filed ${data.url} (repo: ${data.repo}).`);
  }

  engagement
    .command('issue <findingId>')
    .description('Raise a finding as a GitHub issue. Honest no-op if GitHub is not configured or the stored token is rejected, never a fake success. Skips re-filing if already raised.')
    .action(raiseIssue);

  // Deprecated alias, kept working (not advertised) so nothing that
  // already scripted `quox engagement gripe` breaks.
  engagement
    .command('gripe <findingId>', { hidden: true })
    .description('Deprecated alias for "quox engagement issue"')
    .action(raiseIssue);

  engagement
    .command('propose <findingId>')
    .description('Propose a finding as a QuoxPlan note (default stream: QUOX-SECURITY, #438)')
    .option('--stream-id <id>', 'QuoxPlan stream id to append the note to (default QUOX-SECURITY)')
    .action(async (findingId, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.findings.propose', { findingId });
      const body = options.streamId ? { stream_id: options.streamId } : {};
      const data = await client.post(ep.path, { service: ep.service, body });
      printSuccess(`Proposed on ${data.streamId} (note ${data.note?.id ?? '—'}).`);
    });

  // QUOX-SECURITY-SCHED Phase 4: recurring scan schedules — a standing
  // instruction to re-run a tool against a target on a fixed cadence,
  // owned by an engagement. Backend: lib/securityEngagementSchedules.js
  // (storage) + lib/securityScanScheduler.js (the server-side loop that
  // actually fires due schedules). MIN_INTERVAL_SECONDS=300 is enforced
  // server-side; a too-short --interval fails at create, not silently.
  const schedule = engagement
    .command('schedule')
    .description('Recurring scan schedules (re-run a tool on a fixed cadence)');

  schedule
    .command('create <engagementId> <target> <tool>')
    .description('Create a recurring schedule (tool: bare capability name, e.g. vuln_scan)')
    .option('--interval <seconds>', 'interval cadence in seconds (minimum 300)')
    .option('--cron <expr>', 'cron cadence, a 5-field UTC expression e.g. "0 3 * * 3" for weekly Wed 03:00')
    .action(async (engagementId, target, tool, options) => {
      auth.requireAuth();
      if (options.interval && options.cron) {
        throw new Error('--interval and --cron are mutually exclusive; pass exactly one cadence');
      }
      if (!options.interval && !options.cron) {
        throw new Error('a cadence is required: pass --interval <seconds> or --cron "<expr>"');
      }
      const body = { target_value: target, tool };
      if (options.cron) {
        body.schedule_kind = 'cron';
        body.cron_expression = options.cron;
      } else {
        const intervalSeconds = parseInt(options.interval, 10);
        if (!Number.isInteger(intervalSeconds) || String(intervalSeconds) !== String(options.interval).trim()) {
          throw new Error(`--interval must be an integer number of seconds, got "${options.interval}"`);
        }
        body.interval_seconds = intervalSeconds;
      }
      const ep = resolveEndpoint('engagement.schedule.create', { id: engagementId });
      const data = await client.post(ep.path, {
        service: ep.service,
        body,
      });
      printSuccess(`Schedule "${data.schedule.id}" created (next run: ${data.schedule.next_run_at}).`);
      formatDetail(data.schedule, { format: program.opts().output, title: 'Schedule' });
    });

  schedule
    .command('list <engagementId>')
    .description('List schedules for an engagement')
    .action(async (engagementId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.schedule.list', { id: engagementId });
      const data = await client.get(ep.path, { service: ep.service });
      formatOutput({
        columns: ['id', 'target_value', 'tool', 'interval_seconds', 'enabled', 'next_run_at', 'last_status'],
        headers: ['ID', 'Target', 'Tool', 'Interval (s)', 'Enabled', 'Next Run', 'Last Status'],
        rows: data.schedules || [],
      }, { format: program.opts().output, emptyMessage: 'No schedules yet.' });
    });

  schedule
    .command('show <scheduleId>')
    .description('Show a schedule, including its last diff summary')
    .action(async (scheduleId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.schedule.get', { scheduleId });
      const data = await client.get(ep.path, { service: ep.service });
      formatDetail(data.schedule, { format: program.opts().output, title: 'Schedule' });
      if (data.schedule?.last_diff) {
        console.log(`  Last diff: +${data.schedule.last_diff.addedCount ?? 0} -${data.schedule.last_diff.removedCount ?? 0} (${data.schedule.last_diff.newHighSeverity?.length ?? 0} new high-severity)`);
      }
    });

  schedule
    .command('update <scheduleId>')
    .description('Edit a schedule: change its cadence (--interval or --cron), target, tool, or enabled state')
    .option('--interval <seconds>', 'switch to interval cadence in seconds (minimum 300)')
    .option('--cron <expr>', 'switch to cron cadence, a 5-field UTC expression e.g. "0 3 * * 3"')
    .option('--target <value>', 'change the target value (must be a verified, in-scope target)')
    .option('--tool <name>', 'change the tool (bare capability name, e.g. vuln_scan)')
    .option('--enable', 'enable the schedule')
    .option('--disable', 'disable the schedule')
    .action(async (scheduleId, options) => {
      auth.requireAuth();
      if (options.interval && options.cron) {
        throw new Error('--interval and --cron are mutually exclusive; pass at most one cadence');
      }
      if (options.enable && options.disable) {
        throw new Error('--enable and --disable are mutually exclusive');
      }
      const body = {};
      if (options.cron) {
        body.schedule_kind = 'cron';
        body.cron_expression = options.cron;
      } else if (options.interval) {
        const intervalSeconds = parseInt(options.interval, 10);
        if (!Number.isInteger(intervalSeconds) || String(intervalSeconds) !== String(options.interval).trim()) {
          throw new Error(`--interval must be an integer number of seconds, got "${options.interval}"`);
        }
        body.schedule_kind = 'interval';
        body.interval_seconds = intervalSeconds;
      }
      if (options.target) body.target_value = options.target;
      if (options.tool) body.tool = options.tool;
      if (options.enable) body.enabled = true;
      if (options.disable) body.enabled = false;
      if (Object.keys(body).length === 0) {
        throw new Error('nothing to update: pass at least one of --interval, --cron, --target, --tool, --enable, --disable');
      }
      const ep = resolveEndpoint('engagement.schedule.update', { scheduleId });
      const data = await client.patch(ep.path, { service: ep.service, body });
      printSuccess(`Schedule "${data.schedule.id}" updated (next run: ${data.schedule.next_run_at}).`);
      formatDetail(data.schedule, { format: program.opts().output, title: 'Schedule' });
    });

  schedule
    .command('enable <scheduleId>')
    .description('Re-enable a schedule')
    .action(async (scheduleId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.schedule.enable', { scheduleId });
      const data = await client.post(ep.path, { service: ep.service, body: {} });
      printSuccess(`Schedule "${data.schedule.id}" enabled (next run: ${data.schedule.next_run_at}).`);
    });

  schedule
    .command('disable <scheduleId>')
    .description('Disable a schedule (stops firing; existing history kept)')
    .action(async (scheduleId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.schedule.disable', { scheduleId });
      const data = await client.post(ep.path, { service: ep.service, body: {} });
      printSuccess(`Schedule "${data.schedule.id}" disabled.`);
    });

  schedule
    .command('delete <scheduleId>')
    .description('Delete a schedule')
    .action(async (scheduleId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.schedule.delete', { scheduleId });
      await client.delete(ep.path, { service: ep.service });
      printSuccess(`Schedule "${scheduleId}" deleted.`);
    });

  engagement
    .command('sync-issues <id>')
    .description('Reconcile this engagement\'s filed findings against their GitHub issue state. A closed issue auto-resolves its finding. Honest no-op if GitHub is not configured')
    .action(async (id) => {
      auth.requireAuth();
      const ep = resolveEndpoint('engagement.sync_issue_states', { id });
      const data = await client.post(ep.path, { service: ep.service, body: {} });
      if (data.configured === false) {
        console.log(`  ${data.message || 'GitHub not configured.'}`);
        return;
      }
      printSuccess(`Checked ${data.checked ?? 0}, resolved ${data.resolved?.length ?? 0}.`);
      if (data.resolved?.length) {
        console.log(`  Resolved: ${data.resolved.join(', ')}`);
      }
      if (data.errors?.length) {
        console.log(`  Errors: ${data.errors.map((e) => `${e.findingId} (${e.reason})`).join(', ')}`);
      }
    });
}
