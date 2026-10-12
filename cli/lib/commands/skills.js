/**
 * Skills commands.
 *
 * `list`/`show` are read-only queries against the quoxflow QSKL
 * (procedural-knowledge Skills / Crystals) library, via the collector's
 * quoxflow proxy — see the comment above each subcommand for the exact
 * route it calls.
 *
 * `run`, `review`, `library`, and the Crystal-lifecycle writes
 * (`from-execution`/`promote-draft`/`rollback-to-version`) added in WP2.3
 * go DIRECT to quoxflow (service: 'quoxflow', port 3200) — the collector
 * does NOT proxy these routes (only the three read-only proxy paths used
 * by `list`/`show` plus evidence/observations are hand-mounted; see
 * cli/lib/api/endpoints/skills.js header for the full route provenance).
 * `library` is the one exception: it's the auth service's per-user saved
 * workflow library (services/auth/routes/user-library.js), not quoxflow.
 *
 * NOTE (deviations from the upstream field names, see quoxflow
 * src/store/quox-skills-store.ts):
 *  - The real status field on a skill is `edition`, with values
 *    experimental | stable | deprecated | archived (there is no
 *    "canonical" value). `--edition` filters on this field directly.
 *  - There is no server-side full-text `search` query param on
 *    GET /api/quox-skills. `--search` is applied client-side (substring
 *    match against name + description) after fetching the (filtered)
 *    list from the proxy.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { formatOutput, formatDetail, printSuccess, printWarning, printInfo } from '../core/output.js';
import { resolveOrgId, parseJSON } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { shortLicenceLabel } from './skillRightsFormat.js';
import { loadOrBuildManifest, readSkillFrontmatter } from './skillManifest.js';

export function registerSkillsCommands(program, ctx) {
  const { client, auth } = ctx;

  const skills = program
    .command('skills')
    .description('Manage the quoxflow skill library (QSKL Crystals): query, run, review, promote, and your saved library');

  // ── skills list ──────────────────────────────────────────────────────────
  // GET /quoxflow/skills — collector proxy to quoxflow GET /api/quox-skills

  skills
    .command('list')
    .description('List skills in the library')
    .option('--edition <edition>', 'filter by edition (experimental|stable|deprecated|archived)')
    .option('--category <category>', 'filter by category')
    .option('--agent <agentId>', 'filter to skills best-suited for an agent')
    .option('--tag <tag>', 'filter by tag')
    .option('--search <q>', 'client-side filter: substring match on name/description')
    .option('--limit <n>', 'max results')
    .option('--order-by <field>', 'sort field (last_used_at|created_at)')
    .option('--order <dir>', 'sort direction (asc|desc)')
    .option('--org <id>', 'org ID (overrides active org)')
    .action(async (options) => {
      auth.requireAuth();
      const query = {};
      query.orgId = options.org || resolveOrgId(auth, program);
      if (options.edition) query.edition = options.edition;
      if (options.category) query.category = options.category;
      if (options.agent) query.agentId = options.agent;
      if (options.tag) query.tag = options.tag;
      if (options.limit) query.limit = options.limit;
      if (options.orderBy) query.orderBy = options.orderBy;
      if (options.order) query.order = options.order;

      const data = await client.get(resolveEndpoint('quoxflow.skills.list').path, { service: resolveEndpoint('quoxflow.skills.list').service, query });
      let rows = data.data || data.records || data;
      if (!Array.isArray(rows)) rows = [];

      if (options.search) {
        const needle = options.search.toLowerCase();
        rows = rows.filter((r) =>
          (r.name || '').toLowerCase().includes(needle) ||
          (r.description || '').toLowerCase().includes(needle)
        );
      }

      // SKILLRIGHTS-8: declarations travel with the skill; a missing one is
      // shown as undeclared, never defaulted to a licence.
      rows = rows.map((r) => ({ ...r, licence: shortLicenceLabel(r.license) }));
      formatOutput({
        columns: ['id', 'name', 'category', 'edition', 'version', 'licence', 'decayState', 'createdAt'],
        headers: ['ID', 'Name', 'Category', 'Edition', 'Version', 'Licence', 'Decay', 'Created'],
        rows,
      }, { format: program.opts().output, emptyMessage: 'No skills found.' });
    });

  // ── skills show ──────────────────────────────────────────────────────────
  // GET /quoxflow/skills/:id — collector proxy to quoxflow GET /api/quox-skills/:id

  skills
    .command('show')
    .description('Show skill details')
    .argument('<id>', 'skill ID')
    .option('--org <id>', 'org ID (overrides active org)')
    .action(async (id, options) => {
      auth.requireAuth();
      const query = { orgId: options.org || resolveOrgId(auth, program) };
      const data = await client.get(resolveEndpoint('quoxflow.skills.get', { id }).path, { service: resolveEndpoint('quoxflow.skills.get', { id }).service, query });
      formatDetail(data.data || data, { format: program.opts().output, title: `Skill: ${id}` });
    });

  // ── skills run ───────────────────────────────────────────────────────────
  // POST /api/workflows/:id/execute — quoxflow DIRECT (executions.ts:206).
  // Crystals ARE workflows: this runs a skill/crystal by its (source)
  // workflow id. Sync by default (waits for the result); --async fires and
  // returns immediately with an executionId.

  skills
    .command('run')
    .description('Execute a skill/crystal (its underlying workflow)')
    .argument('<id>', 'workflow ID (the skill\'s sourceWorkflowId)')
    .option('--data <json>', 'trigger data, as a JSON object string')
    .option('--async', 'fire-and-forget: return immediately with an executionId instead of waiting for the result')
    .option('--org <id>', 'org ID (overrides active org)')
    .action(async (id, options) => {
      auth.requireAuth();
      const orgId = options.org || resolveOrgId(auth, program);
      const body = { orgId };
      if (options.data) body.triggerData = parseJSON(options.data, 'trigger data');
      if (options.async) body.async = true;

      const ep = resolveEndpoint('skills.run', { id });
      const data = await client.post(ep.path, { service: ep.service, body });
      const result = data.data || data;

      if (options.async) {
        printSuccess(`Execution started (${result.executionId}).`);
      } else if (result.success === false) {
        printWarning('Execution finished with errors.');
      } else {
        printSuccess('Execution complete.');
      }
      formatDetail(result, { format: program.opts().output });
    });

  // ── skills review ────────────────────────────────────────────────────────
  // QSKL-SAFETY.F review queue — quox-skills.ts:392-553, quoxflow DIRECT.
  // Org-scoped server-side (JWT-primary orgId, 403 on cross-org row access).

  const review = skills
    .command('review')
    .description('Manage the QSKL-SAFETY skill review queue');

  review
    .command('list')
    .description('List review queue items (default: pending)')
    .option('--status <status>', 'pending|approved|rejected', 'pending')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('skills.reviewQueue.list');
      const data = await client.get(ep.path, {
        service: ep.service,
        query: { status: options.status, orgId },
      });
      const rows = data.data || data.records || [];

      formatOutput({
        // fleet #392: review queue rows carry queued_at.
        columns: ['id', 'skill_id', 'skill_name', 'status', 'reviewer_id', 'queued_at'],
        headers: ['ID', 'Skill ID', 'Skill Name', 'Status', 'Reviewer', 'Created'],
        rows: Array.isArray(rows) ? rows : [],
      }, { format: program.opts().output, emptyMessage: `No ${options.status} review queue items.` });
    });

  review
    .command('show')
    .description('Show a review queue item (with skill snapshot + latest firewall log)')
    .argument('<qid>', 'review queue item ID')
    .action(async (qid) => {
      auth.requireAuth();
      const ep = resolveEndpoint('skills.reviewQueue.get', { qid });
      const data = await client.get(ep.path, { service: ep.service });
      formatDetail(data.data || data, { format: program.opts().output, title: `Review Queue Item: ${qid}` });
    });

  review
    .command('approve')
    .description('Approve a review queue item')
    .argument('<qid>', 'review queue item ID')
    .option('--comment <text>', 'optional reviewer comment')
    .action(async (qid, options) => {
      auth.requireAuth();
      const body = {};
      if (options.comment) body.comment = options.comment;
      const ep = resolveEndpoint('skills.reviewQueue.approve', { qid });
      const data = await client.post(ep.path, { service: ep.service, body });
      printSuccess(`Review queue item ${qid} approved.`);
      formatDetail(data.data || data, { format: program.opts().output });
    });

  review
    .command('reject')
    .description('Reject a review queue item')
    .argument('<qid>', 'review queue item ID')
    .option('--comment <text>', 'optional reviewer comment')
    .action(async (qid, options) => {
      auth.requireAuth();
      const body = {};
      if (options.comment) body.comment = options.comment;
      const ep = resolveEndpoint('skills.reviewQueue.reject', { qid });
      const data = await client.post(ep.path, { service: ep.service, body });
      printSuccess(`Review queue item ${qid} rejected.`);
      formatDetail(data.data || data, { format: program.opts().output });
    });

  // ── skills library ───────────────────────────────────────────────────────
  // Per-org/per-user saved workflow library — auth service (NOT quoxflow),
  // services/auth/routes/user-library.js. Always scoped to the caller
  // (org_id + user_id); another user in the same org cannot see/delete
  // these entries.

  const library = skills
    .command('library')
    .description('Manage your saved workflow library');

  library
    .command('list')
    .description('List your saved library entries')
    .option('--source <source>', 'filter by source: curated|n8n-imported|mine')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const query = {};
      if (options.source) query.source = options.source;
      const ep = resolveEndpoint('user-library.list', { orgId });
      const data = await client.get(ep.path, { service: ep.service, query });
      const entries = data.entries || data || [];

      formatOutput({
        columns: ['id', 'name', 'source', 'source_workflow_id', 'updated_at'],
        headers: ['ID', 'Name', 'Source', 'Source Workflow', 'Updated'],
        rows: Array.isArray(entries) ? entries : [],
      }, { format: program.opts().output, emptyMessage: 'No saved library entries.' });
    });

  library
    .command('add')
    .description('Save a workflow definition to your library')
    .requiredOption('--name <name>', 'entry name')
    .option('--definition <json>', 'workflow definition, as a JSON object string')
    .option('--file <path>', 'read the workflow definition from a JSON file (overrides --definition)')
    .option('--description <text>', 'description')
    .option('--source <source>', 'curated|n8n-imported|mine', 'mine')
    .option('--source-workflow-id <id>', 'originating workflow ID')
    .option('--tags <tags>', 'comma-separated tags')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      let definitionJson;
      if (options.file) {
        definitionJson = parseJSON(readFileSync(options.file, 'utf-8'), 'workflow definition file');
      } else if (options.definition) {
        definitionJson = parseJSON(options.definition, 'workflow definition');
      } else {
        throw new Error('Workflow definition is required. Use --definition <json> or --file <path>.');
      }

      const body = { name: options.name, definition_json: definitionJson, source: options.source };
      if (options.description) body.description = options.description;
      if (options.sourceWorkflowId) body.source_workflow_id = options.sourceWorkflowId;
      if (options.tags) body.tags = options.tags.split(',').map(t => t.trim()).filter(Boolean);

      const ep = resolveEndpoint('user-library.create', { orgId });
      const data = await client.post(ep.path, { service: ep.service, body });
      printSuccess(`Library entry "${options.name}" saved.`);
      formatDetail(data.entry || data, { format: program.opts().output });
    });

  library
    .command('remove')
    .description('Remove a saved library entry')
    .argument('<id>', 'library entry ID')
    .option('--force', 'skip confirmation')
    .action(async (id, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      if (!options.force && !program.opts().yes) {
        const { default: inquirer } = await import('inquirer');
        const ans = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: `Remove library entry ${id}? This cannot be undone.`,
          default: false,
        }]);
        if (!ans.confirm) {
          printInfo('Cancelled.');
          return;
        }
      }

      const ep = resolveEndpoint('user-library.delete', { orgId, id });
      await client.delete(ep.path, { service: ep.service });
      printSuccess('Library entry removed.');
    });

  // ── skills from-execution / promote-draft / rollback-to-version ────────
  // Crystal Skill Library lifecycle writes — quoxflow DIRECT
  // (skills.ts, mounted at /api/skills, distinct from the QSKL
  // /api/quox-skills store used by `skills list`/`show`).

  skills
    .command('from-execution')
    .description('Crystallise a workflow into a skill (idempotent — returns the existing skill if one already exists)')
    .argument('<workflowId>', 'workflow ID to crystallise')
    .option('--name <name>', 'workflow display name (used for the generated skill name)')
    .action(async (workflowId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { workflowId };
      if (options.name) body.workflowName = options.name;

      const ep = resolveEndpoint('skills.fromExecution');
      const data = await client.post(ep.path, { service: ep.service, body, query: { orgId } });
      const record = data.data || data;
      printSuccess(`Skill "${record.name || workflowId}" crystallised.`);
      formatDetail(record, { format: program.opts().output });
    });

  skills
    .command('promote-draft')
    .description('Promote an in-flight task-time draft Crystal to the skill library (requires tier_b)')
    .argument('<executionId>', 'execution ID with an in-flight draft')
    .option('--tier <tier>', 'org tier: tier_a|tier_b (tier_b required to promote)', 'tier_a')
    .action(async (executionId, options) => {
      auth.requireAuth();
      const body = { executionId, orgTier: options.tier };

      const ep = resolveEndpoint('skills.promoteDraft');
      const data = await client.post(ep.path, { service: ep.service, body });
      const record = data.data || data;
      printSuccess(`Draft for execution ${executionId} promoted.`);
      formatDetail(record, { format: program.opts().output });
    });

  skills
    .command('rollback-to-version')
    .description('Roll a skill back to a prior version (writes a NEW version copying the target\'s content)')
    .argument('<sourceWorkflowId>', 'source workflow ID')
    .argument('<targetVersion>', 'version number to roll back to', (v) => parseInt(v, 10))
    .action(async (sourceWorkflowId, targetVersion) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { sourceWorkflowId, targetVersion };

      const ep = resolveEndpoint('skills.rollbackToVersion');
      const data = await client.post(ep.path, { service: ep.service, body, query: { orgId } });
      const record = data.data || data;
      printSuccess(`Skill rolled back to version ${targetVersion}.`);
      formatDetail(record, { format: program.opts().output });
    });

  // ── skills protect ───────────────────────────────────────────────────────
  // SKILLRIGHTS #478 Phase 10. POST /api/v1/skills/protect (collector).
  //
  // Hashes the skill LOCALLY (or reuses the manifest the open `skillrights`
  // CLI already wrote) and sends only that manifest. The collector has the
  // org sign a domain-separated digest, registers the hash in the open
  // SkillRights registry, verifies the receipt, and witnesses the whole
  // thing into the org's evidence chain.
  //
  // What it proves: this exact artefact existed by this time, and this org's
  // key claimed and signed it. NOT legal ownership.
  skills
    .command('protect')
    .description('Sign a skill with the org identity, register it in the open SkillRights registry, and keep the receipt in the org evidence chain')
    .argument('[dir]', 'skill directory', '.')
    .option('--public', 'list the skill publicly (sends name/description to the registry directory)')
    .option('--supersedes <sha256>', 'claimed earlier version this replaces')
    .option('--repository <url>', 'repository URL (public mode only)')
    .action(async (dir, options) => {
      auth.requireAuth();
      const resolvedDir = path.resolve(dir);
      const { manifest, source } = loadOrBuildManifest(resolvedDir);
      const front = readSkillFrontmatter(resolvedDir);

      const body = { manifest, mode: options.public ? 'public' : 'private' };
      if (options.supersedes) body.supersedes = options.supersedes;
      if (options.public) {
        const meta = {};
        if (front.name) meta.name = front.name;
        if (front.description) meta.description = front.description;
        if (options.repository) meta.repository = options.repository;
        if (Object.keys(meta).length) body.meta = meta;
      }

      if (!manifest.identifier) {
        printWarning('This skill declares no SkillRights licence (no `license:` in SKILL.md frontmatter). Protecting it anyway; the registration will record no licence.');
      }
      printInfo(`Manifest ${source === 'existing' ? 'read from' : 'computed for'} ${resolvedDir} (${Object.keys(manifest.files).length} files). File contents never leave this machine; the manifest sent carries relative file names and per-file hashes.`);

      const ep = resolveEndpoint('skills.protect');
      const data = await client.post(ep.path, { service: ep.service, body });
      const p = data.protection || data;
      if (data.created === false) {
        printInfo(`Already protected (identical content): ${p.srid}`);
      } else {
        printSuccess(`Protected. SRID ${p.srid}`);
      }
      printInfo('Proves the artefact existed by the registered time and that your org key claimed and signed it. It does not prove legal ownership.');
      formatDetail({
        srid: p.srid,
        manifest_sha256: p.manifestSha256,
        licence: p.license || '(none declared)',
        mode: p.mode,
        org_key_id: p.orgKeyId,
        registry: p.registryUrl,
        evidence_envelope: p.aeeEnvelopeId || '(not recorded)',
        registered_at: p.receipt?.receipt?.record?.ts,
      }, { format: program.opts().output });
    });

  // ── skills disclosures ───────────────────────────────────────────────────
  // SKILLRIGHTS #478 Phase 12. GET /api/v1/skills/rights-ledger (collector).
  // The org's rights disclosure ledger: what was distributed and protected,
  // under which declared rights, with the policy in force and evidence
  // counts. Read-only. `-o json` is the export format for handing the
  // disclosure to an auditor. What it does NOT claim: execution/usage
  // events (that ledger does not exist yet) or verified signatures.
  skills
    .command('disclosures')
    .description('Org rights disclosure ledger: distributions + protections under declared rights, policy in force, evidence counts')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('skills.rightsLedger');
      const ledger = await client.get(ep.path, { service: ep.service });

      if (program.opts().output === 'json') {
        formatDetail(ledger, { format: 'json' });
        return;
      }

      const s = ledger.summary || {};
      printInfo(`Rights disclosure for org ${ledger.orgId} (generated ${ledger.generatedAt}). Policy in force: ${ledger.policy || 'unknown'}${ledger.policyError ? ` (policy lookup failed: ${ledger.policyError})` : ''}.`);
      printInfo(`${s.hosts ?? 0} host(s), ${s.skillsDistributed ?? 0} skill(s) distributed (${s.skillsDeclared ?? 0} declared, ${s.skillsUndeclared ?? 0} undeclared), ${s.protections ?? 0} protection(s). Evidence: ${ledger.evidence?.syncEnvelopes ?? 0} sync + ${ledger.evidence?.protectEnvelopes ?? 0} protect envelope(s).`);

      formatOutput({
        columns: ['hostId', 'installedVersion', 'status', 'rightsSummary'],
        headers: ['Host', 'Pack ver', 'Status', 'Rights'],
        rows: (ledger.distributions || []).map((d) => ({
          hostId: d.hostId,
          installedVersion: d.installedVersion || '?',
          status: d.status,
          rightsSummary: d.rights
            ? `${d.rights.declared}/${d.rights.total} declared`
            : (d.rightsUnreadable ? 'UNREADABLE record' : 'no rights record'),
        })),
      }, { format: program.opts().output, emptyMessage: 'No distributions recorded.' });

      formatOutput({
        columns: ['srid', 'skillName', 'licence', 'mode', 'evidence'],
        headers: ['SRID', 'Skill', 'Licence', 'Mode', 'Evidence'],
        rows: (ledger.protections || []).map((p) => ({
          srid: p.srid,
          skillName: p.skillName || '',
          licence: shortLicenceLabel(p.license),
          mode: p.mode,
          evidence: p.aeeEnvelopeId || '',
        })),
      }, { format: program.opts().output, emptyMessage: 'No protections recorded.' });
    });

  // ── skills protections ───────────────────────────────────────────────────
  // GET /api/v1/skills/protections (collector).
  skills
    .command('protections')
    .description('List this org\'s protected skills (SRID, licence, org key, evidence envelope)')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('skills.protections');
      const data = await client.get(ep.path, { service: ep.service });
      const rows = (data.protections || []).map((p) => ({
        srid: p.srid,
        name: p.skillName || '',
        licence: p.license || '',
        mode: p.mode,
        registered: p.receipt?.receipt?.record?.ts || p.createdAt,
        evidence: p.aeeEnvelopeId || '',
      }));
      formatOutput(rows, {
        format: program.opts().output,
        columns: ['srid', 'name', 'licence', 'mode', 'registered', 'evidence'],
      });
    });

  // ── skills sealed ────────────────────────────────────────────────────────
  // SKILLRIGHTS #478 Phase 14, sealed execution pilot. Collector routes
  // (server.js /api/v1/skills/sealed[...]). See
  // docs/SEALED_EXECUTION_PILOT_DESIGN.md for the full design and the
  // binding claims language below (section G, verbatim).
  //
  // What sealed execution IS: the model invokes a capability (tool call);
  // the methodology runs on infrastructure the org controls; the caller
  // gets only inputs and outputs, never the skill text. The manifest read
  // back by list/show never contains the sealed content, only its hash.
  //
  // What it is NOT: a guarantee against cloning-by-behaviour, and NOT a
  // reliable filter on invocation output (the executor's overlap check is
  // partial at best). Every surface below says so; do not soften it.
  const sealed = skills
    .command('sealed')
    .description('Manage sealed-execution skills: methodology runs on org infrastructure, callers get inputs/outputs only (pilot)');

  // The binding sentence, verbatim. Printed on every `sealed add` success
  // (docs/SEALED_EXECUTION_PILOT_DESIGN.md).
  //
  // SUPERSEDED 2026-09-11 (external audit): the original section G wording
  // claimed the text stays out of "every model's context and every provider's
  // training pipeline". The executor sends the plaintext to the executing
  // model, so that half was contradicted on every successful invocation.
  const SEALED_SECTION_G_SENTENCE = "Sealed execution keeps the text of your methodology out of the calling model's context; the executing model and its provider do see it, under that provider's data terms, and nothing here prevents someone who can call the capability from learning what it does.";

  sealed
    .command('list')
    .description('List sealed skill manifests for this org (manifest only, never the sealed content)')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('skills.sealed.list');
      const data = await client.get(ep.path, { service: ep.service });
      const rows = data.sealed ?? data;

      formatOutput({
        columns: ['sealedId', 'name', 'contentSha256', 'createdAt'],
        headers: ['Sealed ID', 'Name', 'Content SHA256', 'Created'],
        rows: (Array.isArray(rows) ? rows : []).map((r) => ({
          sealedId: r.sealedId,
          name: r.name,
          contentSha256: (r.contentSha256 || '').slice(0, 12),
          createdAt: r.createdAt,
        })),
      }, { format: program.opts().output, emptyMessage: 'No sealed skills found.' });
    });

  sealed
    .command('show')
    .description('Show a sealed skill\'s manifest (name, description, input contract, content hash). Manifest only.')
    .argument('<sealedId>', 'sealed skill ID')
    .action(async (sealedId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('skills.sealed.get', { sealedId });
      const data = await client.get(ep.path, { service: ep.service });
      printInfo('Manifest only. The sealed content is never returned by the API.');
      formatDetail(data, { format: program.opts().output, title: `Sealed skill: ${sealedId}` });
    });

  sealed
    .command('add')
    .description('Seal a local skill: its content is uploaded once, executed on org infrastructure thereafter, and never returned to a caller')
    .argument('<path>', 'skill directory (its SKILL.md is read) or a single file')
    .requiredOption('--name <name>', 'sealed skill name')
    .option('--description <text>', 'description')
    .option('--contract <file>', 'JSON file describing the expected input contract')
    .action(async (target, options) => {
      auth.requireAuth();
      const resolved = path.resolve(target);
      if (!existsSync(resolved)) {
        throw new Error(`No such file or directory: ${resolved}`);
      }
      const isDir = statSync(resolved).isDirectory();
      const contentPath = isDir ? path.join(resolved, 'SKILL.md') : resolved;
      if (!existsSync(contentPath)) {
        throw new Error(`No SKILL.md found in ${resolved}.`);
      }
      const content = readFileSync(contentPath, 'utf8');

      let inputContract = {};
      if (options.contract) {
        inputContract = parseJSON(readFileSync(options.contract, 'utf8'), 'input contract file');
      }

      const body = { name: options.name, inputContract, content };
      if (options.description) body.description = options.description;

      try {
        const ep = resolveEndpoint('skills.sealed.create');
        const data = await client.post(ep.path, { service: ep.service, body });
        printSuccess(`Sealed. sealedId ${data.sealedId}`);
        formatDetail(data, { format: program.opts().output, title: 'Sealed skill' });
        printInfo(SEALED_SECTION_G_SENTENCE);
      } catch (err) {
        if (err.status === 503 && err.code === 'sealed_unavailable') {
          throw new Error(
            'sealed_unavailable: this server has no sealed-content encryption key configured. '
            + 'An org admin must register one before any skill can be sealed.'
          );
        }
        throw err;
      }
    });

  sealed
    .command('invoke')
    .description('Invoke a sealed skill: the model gets only the output, never the methodology text. Output filtering is partial, not guaranteed; the caller\'s input still transits the executing provider.')
    .argument('<sealedId>', 'sealed skill ID')
    .option('--input <text>', 'input text')
    .option('--input-file <path>', 'read the input from a file (overrides --input)')
    .action(async (sealedId, options) => {
      auth.requireAuth();
      let input;
      if (options.inputFile) {
        input = readFileSync(options.inputFile, 'utf8');
      } else if (options.input) {
        input = options.input;
      } else {
        throw new Error('Input is required. Use --input <text> or --input-file <path>.');
      }

      try {
        const ep = resolveEndpoint('skills.sealed.invoke', { sealedId });
        // A sealed invocation is a full LLM run: the collector allows the
        // executor 120s, so the default 30s client timeout hangs up on runs
        // that then complete (and are witnessed) server-side with nobody to
        // receive the output. Proven live on the first pilot drive 2026-09-11
        // (73s run, orphaned output). 150s = executor deadline + margin.
        const data = await client.post(ep.path, { service: ep.service, body: { input }, timeout: 150000 });

        if (data.refused) {
          printWarning(
            `Output withheld by the disclosure check (${data.error || 'sealed_output_withheld'}). `
            + `Evidence envelope: ${data.evidence?.envelopeId || '(none)'}.`
          );
          formatDetail(data.evidence || {}, { format: program.opts().output, title: 'Evidence' });
          return;
        }

        printSuccess('Invocation complete.');
        console.log(data.output);
        formatDetail(data.evidence || {}, { format: program.opts().output, title: 'Evidence' });
      } catch (err) {
        if (err.status === 429 || err.status === 502) {
          throw new Error(`Sealed invocation failed: ${err.code}`);
        }
        throw err;
      }
    });
}
