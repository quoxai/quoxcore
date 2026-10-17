/**
 * `quox onboard <host>`: guided, idempotent, resumable tenant-onboarding
 * wizard.
 *
 * This is NET-NEW GLUE over verbs that already exist (dev doctor, org create,
 * plan roadmap create, engagement create/target/verify/gripe-target/schedule,
 * vault list). It does NOT reimplement any of their logic: every REST call
 * goes through ctx.client + resolveEndpoint, exactly as the individual verbs
 * do. The wizard's only job is to run the mechanical steps in the right order,
 * skip anything already done, and STOP cleanly at the two human-auth gates
 * (dev-enable + profile-verify, and the GitHub PAT) with the exact copy-paste
 * command the operator must run before re-running the wizard.
 *
 * Design rules baked in here:
 *   - Idempotent: every step CHECKs before it acts, so a second run creates no
 *     duplicates and simply resumes at the first incomplete step.
 *   - Honest gates: a gated step is never reported as done. It prints a WAITING
 *     banner and the wizard returns (exit 0, since a gate is a pause, not an error).
 *   - Secret-free: the GitHub PAT is instruct-and-stop in v1. The token never
 *     enters this process; the operator adds it with `quox vault create
 *     --credentials-stdin` and re-runs.
 */

import { resolveEndpoint } from '../api/endpoints.js';
import { line as glyphLine, printEvent } from '../core/quoxglyph.js';

// ── status line markers ────────────────────────────────────────────────────
// One line per step. [ok] already there, [+] created/changed, [wait] a human
// gate blocks progress. Kept as plain console.log (not the chalk helpers) so
// the markers are trivially assertable in tests and scannable in a wall of
// tool output.
function ok(msg) { console.log(`  [ok] ${msg}`); }
function created(msg) { console.log(`  [+] ${msg}`); }
function waiting(msg) { console.log(`  [wait] needs you: ${msg}`); }

// ── small pure helpers (exported for unit tests) ───────────────────────────

/** Slug for a display name: lowercase, non-alphanumeric collapsed to '-'. */
export function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'tenant';
}

/**
 * Infer an engagement target type from its value.
 *   - an ipv4 or ipv4/cidr        -> 'cidr'
 *   - a scheme://... or host:port -> 'url'
 *   - a bare hostname             -> 'domain'
 * Default for a bare IP is 'cidr' (the engagement scope model treats a single
 * host as a /32 cidr target).
 */
export function inferTargetType(value) {
  const v = String(value || '').trim();
  // ipv4 with optional /nn suffix
  if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(v)) return 'cidr';
  // explicit scheme, or a host:port pair
  if (/:\/\//.test(v) || /^[^\s/]+:\d+$/.test(v)) return 'url';
  return 'domain';
}

/** curl install command for a host that is not yet a fleet-enrolled dev server. */
export function buildOnboardInstallCommand(collectorBase, host) {
  const base = String(collectorBase || '').replace(/\/+$/, '');
  // REL-423: fail loud, never `curl | sudo bash` (that pipe reports success when the download fails).
  return `( f=$(mktemp) && trap 'rm -f "$f"' EXIT && curl -fsSL ${base}/install -o "$f" && sudo bash "$f" --host-id ${host} )`;
}

// ── the wizard ──────────────────────────────────────────────────────────────

/**
 * Run the onboarding orchestration. Returns { status: 'COMPLETE' | 'WAITING' }.
 * Exported so it can be unit-tested directly with an injected fake client, and
 * so a caller can branch on the outcome.
 */
export async function runOnboard(host, options, ctx) {
  const { client, auth, config } = ctx;
  auth.requireAuth();

  const name = options.name;
  const targetValue = options.target || host;
  const envTier = options.environmentTier || 'dev';
  const cron = options.scheduleCron || '0 2 * * 3';
  const tool = options.tool || 'vuln_scan';
  const slug = slugify(name);

  printEvent(glyphLine('quox', `onboarding ${host}`));

  // ── Step 1: AGENT + DEV-ENABLE gate ──────────────────────────────────────
  // Read real registry state; never infer readiness from an enable having
  // returned 200. Not enrolled -> install. Enrolled but not dev-enabled or not
  // profile_verified -> the enable/seam-key gate.
  const orgIdForDev = auth.getOrgId(ctx.program?.opts?.().org);
  const serversEp = resolveEndpoint('v1.dev.servers.list');
  const serversResp = await client.get(serversEp.path, {
    service: serversEp.service,
    query: orgIdForDev ? { org_id: orgIdForDev } : {},
  });
  const servers = Array.isArray(serversResp?.servers) ? serversResp.servers : [];
  const server = servers.find((s) => s.host_id === host);

  if (!server) {
    const collectorBase = config?.getServiceUrl ? config.getServiceUrl('collector') : '<collector-url>';
    waiting(`${host} is not a fleet-enrolled dev server. Install the agent, then re-run:`);
    console.log(`      ${buildOnboardInstallCommand(collectorBase, host)}`);
    return stop(host);
  }

  const enabledCaps = Array.isArray(server.enabled_capabilities) ? server.enabled_capabilities : [];
  if (!server.profile_verified || enabledCaps.length === 0) {
    const why = !server.profile_verified ? 'profile not verified' : 'no capabilities enabled';
    waiting(`${host} is enrolled but not ready (${why}). Run (as an owner/admin):`);
    console.log(`      quox dev enable ${host}`);
    console.log('      profile_verified needs the seam key plus an agent restart.');
    console.log(`      Confirm with: quox dev doctor ${host}`);
    return stop(host);
  }
  ok(`${host} is a dev-enabled, profile-verified dev server`);

  // ── Step 2: ORG ──────────────────────────────────────────────────────────
  const orgsEp = resolveEndpoint('orgs.list');
  const orgsResp = await client.get(orgsEp.path, { service: orgsEp.service });
  const orgs = orgsResp?.orgs || orgsResp?.organizations || orgsResp || [];
  let org = (Array.isArray(orgs) ? orgs : []).find(
    (o) => o.name === name || o.slug === slug || o.id === name,
  );
  let orgId;
  if (org) {
    orgId = org.id;
    ok(`org "${name}" exists (${orgId})`);
  } else {
    const createEp = resolveEndpoint('orgs.create');
    const createResp = await client.post(createEp.path, {
      service: createEp.service,
      body: { name, slug },
    });
    org = createResp?.organization || createResp?.org || createResp;
    orgId = org.id;
    created(`org "${name}" (${orgId})`);
  }

  // ── Step 3: ROADMAP ───────────────────────────────────────────────────────
  const roadmapId = slug;
  const roadmapsEp = resolveEndpoint('quoxplan.roadmaps.list');
  const roadmapsResp = await client.get(roadmapsEp.path, { service: roadmapsEp.service });
  const roadmaps = roadmapsResp?.roadmaps || [];
  const existingRoadmap = roadmaps.find((r) => r.id === roadmapId || r.org_id === orgId);
  if (existingRoadmap) {
    ok(`roadmap "${existingRoadmap.id}" exists for this tenant`);
  } else {
    const rmCreateEp = resolveEndpoint('quoxplan.roadmaps.create');
    await client.post(rmCreateEp.path, {
      service: rmCreateEp.service,
      body: { org_id: orgId, id: roadmapId, name: `${name} delivery`, actor: 'quox-cli' },
    });
    created(`roadmap "${roadmapId}" for org ${orgId}`);
  }

  // ── Step 4: ENGAGEMENT ────────────────────────────────────────────────────
  const engagementName = `${name} security`;
  const engListEp = resolveEndpoint('engagement.list');
  const engListResp = await client.get(engListEp.path, { service: engListEp.service });
  const engagements = engListResp?.engagements || [];
  let engagement = engagements.find((e) => e.name === engagementName);
  let engagementId;
  if (engagement) {
    engagementId = engagement.id;
    ok(`engagement "${engagementName}" exists (${engagementId})`);
  } else {
    const engCreateEp = resolveEndpoint('engagement.create');
    const engResp = await client.post(engCreateEp.path, {
      service: engCreateEp.service,
      body: { name: engagementName, environment_tier: envTier, risk_ceiling: 'safe_active' },
    });
    engagement = engResp.engagement;
    engagementId = engagement.id;
    created(`engagement "${engagementName}" (${engagementId})`);
  }

  // ── Step 5: TARGET ────────────────────────────────────────────────────────
  const engGetEp = resolveEndpoint('engagement.get', { id: engagementId });
  const engDetail = await client.get(engGetEp.path, { service: engGetEp.service });
  const currentEngagement = engDetail?.engagement || engagement;
  const targets = Array.isArray(engDetail?.targets) ? engDetail.targets : [];
  let target = targets.find((t) => t.value === targetValue);
  let targetVerified = false;

  if (!target) {
    const type = inferTargetType(targetValue);
    const addEp = resolveEndpoint('engagement.target.create', { id: engagementId });
    const addResp = await client.post(addEp.path, {
      service: addEp.service,
      body: { type, value: targetValue, verification_method: 'quoxagent_install' },
    });
    target = addResp.target;
    created(`target ${targetValue} (${type}) added`);
    const verEp = resolveEndpoint('engagement.target.verify', { id: engagementId, targetId: target.id });
    const verResp = await client.post(verEp.path, { service: verEp.service, body: {} });
    targetVerified = verResp?.target?.verification_status === 'verified';
    if (targetVerified) created(`target ${targetValue} verified`);
    else waiting(`target ${targetValue} did not verify (status: ${verResp?.target?.verification_status || 'unknown'})`);
  } else if (target.verification_status === 'verified') {
    targetVerified = true;
    ok(`target ${targetValue} already verified`);
  } else {
    const verEp = resolveEndpoint('engagement.target.verify', { id: engagementId, targetId: target.id });
    const verResp = await client.post(verEp.path, { service: verEp.service, body: {} });
    targetVerified = verResp?.target?.verification_status === 'verified';
    if (targetVerified) created(`target ${targetValue} verified`);
    else waiting(`target ${targetValue} did not verify (status: ${verResp?.target?.verification_status || 'unknown'})`);
  }

  // ── Step 6: GITHUB PAT gate ───────────────────────────────────────────────
  // The repo is only meaningful if a customer GitHub connector token exists to
  // file into it. Check the org vault for a github credential; if absent, STOP
  // with the exact instruct-and-stop command (secret via --credentials-stdin,
  // NEVER argv), and do NOT touch gripe target or schedule.
  const repo = options.repo;
  if (repo) {
    const vaultEp = resolveEndpoint('vault.list', { orgId });
    const vaultResp = await client.get(vaultEp.path, {
      service: vaultEp.service,
      query: { type: 'github' },
    });
    const creds = vaultResp?.credentials || vaultResp || [];
    const githubCred = (Array.isArray(creds) ? creds : []).find((c) => c.integration_type === 'github');
    if (!githubCred) {
      waiting(`no GitHub connector credential in org ${orgId}. Add the fine-grained PAT, then re-run:`);
      console.log(`      printf '%s' '<PAT>' | quox vault create --org ${orgId} --type github --label "${name} github" --credentials-stdin`);
      console.log(`      (the JSON on stdin is {"token":"<PAT>"}; scope the PAT to ${repo} with Issues read/write)`);
      return stop(host, { orgId, roadmapId, engagementId, targetValue, targetVerified });
    }
    ok(`GitHub connector credential present in org ${orgId}`);

    // ── Step 7: GRIPE TARGET ────────────────────────────────────────────────
    const wantRepo = repo;
    const wantConnector = orgId;
    if (currentEngagement.gripe_repo === wantRepo && currentEngagement.gripe_connector_org_id === wantConnector) {
      ok(`gripe target already ${wantRepo} via org ${wantConnector}`);
    } else {
      const gtEp = resolveEndpoint('engagement.gripe_target.set', { id: engagementId });
      await client.patch(gtEp.path, {
        service: gtEp.service,
        body: { gripe_repo: wantRepo, gripe_connector_org_id: wantConnector },
      });
      created(`gripe target -> ${wantRepo} via org ${wantConnector}`);
    }
  } else {
    ok('no --repo given; skipping GitHub connector and gripe target');
  }

  // ── Step 8: SCHEDULE ──────────────────────────────────────────────────────
  const schedListEp = resolveEndpoint('engagement.schedule.list', { id: engagementId });
  const schedResp = await client.get(schedListEp.path, { service: schedListEp.service });
  const schedules = Array.isArray(schedResp?.schedules) ? schedResp.schedules : [];
  let schedule = schedules.find((s) => s.target_value === targetValue && s.tool === tool);
  if (schedule) {
    ok(`schedule for ${tool} on ${targetValue} exists (next: ${schedule.next_run_at || 'n/a'})`);
  } else {
    const schedCreateEp = resolveEndpoint('engagement.schedule.create', { id: engagementId });
    const createResp = await client.post(schedCreateEp.path, {
      service: schedCreateEp.service,
      body: { target_value: targetValue, tool, schedule_kind: 'cron', cron_expression: cron },
    });
    schedule = createResp.schedule;
    created(`schedule ${tool} on ${targetValue} @ "${cron}" (next: ${schedule?.next_run_at || 'n/a'})`);
  }

  // ── Step 9: SUMMARY ───────────────────────────────────────────────────────
  // Every human gate that could stop the wizard has already returned by here,
  // so the only thing left that can hold onboarding open is an unverified
  // target (verification is best-effort and can legitimately not land yet).
  const complete = targetVerified;
  printSummary({
    status: complete ? 'COMPLETE' : 'WAITING',
    host,
    orgId,
    roadmapId,
    engagementId,
    targetValue,
    targetVerified,
    gripeRepo: repo || null,
    schedule: schedule ? { cron, next: schedule.next_run_at } : null,
    remainingGate: targetVerified ? null : 'target not verified',
  });
  return { status: complete ? 'COMPLETE' : 'WAITING' };
}

/** Shared gate-stop: print the WAITING banner + resume hint, return WAITING. */
function stop(host, partial) {
  console.log('');
  console.log('  ===== WAITING on a human gate =====');
  console.log(`  Do the step above, then re-run: quox onboard ${host} ... to continue.`);
  if (partial) {
    console.log(`  Progress so far: org ${partial.orgId}, roadmap ${partial.roadmapId}, engagement ${partial.engagementId}, target ${partial.targetValue} (verified: ${partial.targetVerified}).`);
  }
  return { status: 'WAITING' };
}

function printSummary(s) {
  console.log('');
  console.log(`  ===== onboarding ${s.status} =====`);
  console.log(`  host:        ${s.host}`);
  console.log(`  org:         ${s.orgId}`);
  console.log(`  roadmap:     ${s.roadmapId}`);
  console.log(`  engagement:  ${s.engagementId}`);
  console.log(`  target:      ${s.targetValue} (verified: ${s.targetVerified})`);
  console.log(`  gripe repo:  ${s.gripeRepo || '(none)'}`);
  if (s.schedule) console.log(`  schedule:    "${s.schedule.cron}" (next: ${s.schedule.next || 'n/a'})`);
  if (s.remainingGate) console.log(`  remaining:   ${s.remainingGate}`);
}

export function registerOnboardCommands(program, ctx) {
  program
    .command('onboard <host>')
    .description('Guided, idempotent, resumable wizard to onboard a customer site as a governed Quox tenant')
    .requiredOption('--name <customerName>', 'the org display name')
    .option('--repo <owner/name>', 'the customer GitHub repo for auto-filed security issues')
    .option('--target <hostOrIp>', 'the scan target (defaults to <host>)')
    .option('--environment-tier <tier>', 'dev | staging | production', 'dev')
    .option('--schedule-cron <expr>', 'cron cadence for the recurring scan', '0 2 * * 3')
    .option('--tool <name>', 'capability tool to schedule', 'vuln_scan')
    .option('--yes', 'run non-interactively: do every automatable step and print gate instructions without pausing')
    .action(async (host, options) => {
      await runOnboard(host, options, ctx);
    });
}
