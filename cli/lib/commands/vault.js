/**
 * Vault commands: credential management, health, export, migration
 *
 * quox vault <subcommand> [options]
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import { formatOutput, formatDetail, printSuccess, printWarning, printInfo } from '../core/output.js';
import { events, printEvent, line as glyphLine } from '../core/quoxglyph.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

/**
 * Read a credential's declared repository scope (quoxai/quox#481).
 * Tolerant of absent or malformed metadata: a credential that cannot state its
 * scope simply has none, rather than breaking a listing.
 */
export function readRepoScope(credential) {
  const raw = credential?.metadata_json ?? credential?.metadata;
  if (!raw) return [];
  let meta;
  try {
    meta = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_err) {
    return [];
  }
  return Array.isArray(meta?.repos) ? meta.repos.filter((r) => typeof r === 'string' && r.trim()) : [];
}

/**
 * Validate one repository pattern (quoxai/quox#481).
 *
 * Validation matters more here than it looks: a typo'd pattern matches
 * nothing, so resolution degrades silently to the org default and files the
 * issue with the wrong token. That is the exact bug repo scoping exists to
 * fix, only now with a config file that looks correct. Refuse at the point
 * the human can still see what they typed.
 */
export function validateRepoPattern(pattern) {
  if (pattern === '*' || pattern === '*/*') return pattern;
  // owner/name, or owner/* — the wildcard is only ever the whole name segment.
  if (/^[A-Za-z0-9._-]+\/([A-Za-z0-9._-]+|\*)$/.test(pattern)) return pattern;
  throw new Error(
    `Invalid repository pattern "${pattern}". Use owner/name, owner/* for every repo under an owner, `
    + 'or * for everything.'
  );
}

/**
 * fleet #391 — resolve credential field values for a headless
 * `vault create`, from a JSON object supplied via --credentials-file or
 * --credentials-stdin.
 *
 * Secret hygiene is the whole point of this shape:
 *   - no `--value` flag, so nothing lands in argv, the process list, or
 *     shell history;
 *   - a file can be 0600 and shredded afterwards;
 *   - stdin never touches disk;
 *   - an "env:VAR_NAME" value is dereferenced here at runtime, so the
 *     secret itself need not be written down anywhere.
 *
 * VAULT-INTEG P6: also the pre-save `vault test-new` path, and any future
 * headless credential-field entry point, share this exact routine so there
 * is one place that decides how a secret gets off disk/stdin/env and never
 * onto argv.
 *
 * @returns {Promise<Record<string,string>>} field -> value ({} if none supplied)
 */
export async function loadSuppliedCredentials(options) {
  let raw = null;

  if (options.credentialsStdin) {
    raw = await new Promise((resolve, reject) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', c => { buf += c; });
      process.stdin.on('end', () => resolve(buf));
      process.stdin.on('error', reject);
    });
  } else if (options.credentialsFile) {
    const { readFile } = await import('node:fs/promises');
    raw = await readFile(options.credentialsFile, 'utf8');
  } else {
    return {};
  }

  const source = options.credentialsStdin ? 'stdin' : options.credentialsFile;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Could not parse credentials JSON from ${source}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Credentials from ${source} must be a JSON object of {field: value}.`);
  }

  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') { out[k] = v; continue; }
    if (v.startsWith('env:')) {
      const varName = v.slice(4);
      const fromEnv = process.env[varName];
      if (fromEnv === undefined) {
        throw new Error(`Credential field "${k}" references env:${varName}, which is not set.`);
      }
      out[k] = fromEnv;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── Shared action factories ───────────────────────────────────────────────
//
// VAULT-INTEG P6: `quox integration ...` is a deprecated alias of `quox
// vault ...` (see lib/commands/integration.js). Rather than two copies of
// the same request/response handling, the six overlapping verbs (list, get,
// create, update, delete, test) live here as factories that both
// registerVaultCommands() below AND registerIntegrationCommands() wire up.
// One implementation, two command trees.

export function makeVaultListAction({ client, auth }, program) {
  return async (options) => {
    auth.requireAuth();
    const orgId = resolveOrgId(auth, program);
    const query = {};
    if (options.type) query.type = options.type;

    const data = await client.get(resolveEndpoint('vault.list', { orgId }).path, { service: resolveEndpoint('vault.list', { orgId }).service, query });
    let rows = data.credentials || data;

    // Client-side status filter (API only supports type filter)
    if (options.status) {
      rows = rows.filter(r => r.test_status === options.status);
    }

    // #481: repository scope decides WHICH credential a tool call gets, so
    // leaving it out of the listing hides the thing most likely to explain a
    // "wrong token" surprise. Shown only when at least one credential
    // declares a scope, so orgs that never use it keep the narrower table.
    const withRepos = rows.map((r) => ({ ...r, repos: readRepoScope(r).join(', ') || '' }));
    const anyScoped = withRepos.some((r) => r.repos);

    formatOutput({
      columns: anyScoped
        ? ['id', 'integration_type', 'label', 'repos', 'test_status', 'is_default', 'use_count', 'last_used_at']
        : ['id', 'integration_type', 'label', 'test_status', 'is_default', 'use_count', 'last_used_at'],
      headers: anyScoped
        ? ['ID', 'Type', 'Label', 'Repos', 'Status', 'Default', 'Uses', 'Last Used']
        : ['ID', 'Type', 'Label', 'Status', 'Default', 'Uses', 'Last Used'],
      rows: withRepos,
    }, { format: program.opts().output, emptyMessage: 'No credentials found.' });
  };
}

export function makeVaultGetAction({ client, auth }, program) {
  return async (id) => {
    auth.requireAuth();
    const orgId = resolveOrgId(auth, program);
    const data = await client.get(resolveEndpoint('vault.get', { orgId, id }).path, { service: resolveEndpoint('vault.get', { orgId, id }).service });
    const cred = data.integration || data;
    formatDetail(cred, {
      format: program.opts().output,
      title: `Credential: ${cred.label || id}`,
      fields: ['id', 'integration_type', 'label', 'test_status', 'is_default', 'use_count', 'last_used_at', 'created_at', 'endpoint_url', 'description'],
      labels: {
        id: 'ID', integration_type: 'Type', label: 'Label', test_status: 'Status',
        is_default: 'Default', use_count: 'Uses', last_used_at: 'Last Used',
        created_at: 'Created', endpoint_url: 'Endpoint', description: 'Description',
      },
    });
  };
}

export function makeVaultCreateAction({ client, auth }, program) {
  return async (options) => {
    auth.requireAuth();
    const orgId = resolveOrgId(auth, program);

    // Fetch available types
    const typesData = await client.get(resolveEndpoint('vault.types.list', { orgId }).path, { service: resolveEndpoint('vault.types.list', { orgId }).service });
    const types = typesData.types || typesData;

    let integrationType = options.type;
    let label = options.label;

    // fleet #391: load any headless field values BEFORE prompting, so a
    // fully-specified invocation never blocks on a TTY.
    const supplied = await loadSuppliedCredentials(options);
    const noInput = options.input === false || options.credentialsStdin;

    if ((!integrationType || !label) && noInput) {
      throw new Error(
        `Missing required option${!integrationType ? ' --type' : ''}${!label ? ' --label' : ''} `
        + '(running non-interactively, so it cannot be prompted for).'
      );
    }

    // Interactive prompts if needed
    if (!integrationType || !label) {
      const { default: inquirer } = await import('inquirer');

      if (!integrationType) {
        const choices = types.map(t => ({ name: `${t.name} — ${t.description}`, value: t.id }));
        const ans = await inquirer.prompt([{
          type: 'list',
          name: 'type',
          message: 'Integration type:',
          choices,
        }]);
        integrationType = ans.type;
      }

      if (!label) {
        const ans = await inquirer.prompt([{
          type: 'input',
          name: 'label',
          message: 'Label:',
          validate: v => v.trim().length >= 2 || 'Label must be at least 2 characters',
        }]);
        label = ans.label;
      }
    }

    // Get type definition for fields
    const typeDef = types.find(t => t.id === integrationType);
    if (!typeDef) throw new Error(`Unknown integration type: ${integrationType}`);

    // Collect credential field values. fleet #391: anything already
    // supplied via --credentials-file/--credentials-stdin is used as-is;
    // only genuinely missing fields are prompted for, and under --no-input
    // a missing required field is a clear error rather than a hang.
    const credentials = {};
    const missing = [];
    // quox#564: `inquirer` used to be a `let ... = null` populated only
    // inside this loop's missing-field branch. Any code path below that
    // used `inquirer.prompt(...)` without that branch having run first
    // (headless --no-input skipping this branch entirely, or an
    // interactive run where --credentials-file already supplied every
    // field so the branch never fired) crashed with "Cannot read
    // properties of null (reading 'prompt')" instead of a clear error.
    // A lazy per-use loader means inquirer is never accessed before it
    // is loaded, on any path.
    let inquirer = null;
    async function getInquirer() {
      if (!inquirer) ({ default: inquirer } = await import('inquirer'));
      return inquirer;
    }
    for (const field of typeDef.fields) {
      if (Object.prototype.hasOwnProperty.call(supplied, field.key)) {
        credentials[field.key] = supplied[field.key];
        continue;
      }
      if (!(field.required || !field.default)) continue;

      if (noInput) {
        if (field.required) missing.push(field.key);
        else if (field.default !== undefined) credentials[field.key] = field.default;
        continue;
      }

      const inq = await getInquirer();
      const ans = await inq.prompt([{
        type: field.type === 'password' ? 'password' : 'input',
        name: field.key,
        message: `${field.label}:`,
        default: field.default,
        validate: v => field.required ? (v.trim().length > 0 || `${field.label} is required`) : true,
      }]);
      credentials[field.key] = ans[field.key];
    }

    // quox#577: `supplied` can carry keys the type definition never declared
    // (e.g. an "smtp" type's fields miss imap_host/imap_port on an email
    // credential that needs both). The loop above only ever copies declared
    // fields across, so anything extra was silently dropped even though
    // create still reported success. Union the leftovers in rather than
    // discard them, and say so — a silent drop here is the exact bug.
    const extraKeys = Object.keys(supplied).filter(
      (k) => !Object.prototype.hasOwnProperty.call(credentials, k)
    );
    if (extraKeys.length > 0) {
      for (const k of extraKeys) credentials[k] = supplied[k];
      printInfo(
        `note: including ${extraKeys.length} field(s) not declared by type "${integrationType}": `
        + extraKeys.join(', ')
      );
    }

    if (missing.length > 0) {
      throw new Error(
        `Missing required field(s) for type "${integrationType}": ${missing.join(', ')}. `
        + 'Provide them via --credentials-file <path> or --credentials-stdin as a JSON object, '
        + `e.g. {"${missing[0]}": "..."} (or "env:MY_VAR" to read from the environment).`
      );
    }

    // Ask about default
    let isDefault = options.setDefault || false;
    // fleet #391: `--yes` (and any non-interactive invocation) must not
    // stop here either — the field prompts above used to run first, so
    // this gate was never reached in a headless run anyway.
    if (!options.setDefault && !program.opts().yes && !noInput) {
      const inq = await getInquirer();
      const ans = await inq.prompt([{
        type: 'confirm',
        name: 'isDefault',
        message: 'Set as default for this type?',
        default: false,
      }]);
      isDefault = ans.isDefault;
    }

    // Optional non-secret metadata tags (e.g. {"purpose":"bootstrap"}).
    let metadata;
    if (options.metadata) {
      try {
        metadata = JSON.parse(options.metadata);
      } catch (err) {
        throw new Error(`--metadata must be a JSON object: ${err.message}`);
      }
      if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('--metadata must be a JSON object, e.g. \'{"purpose":"bootstrap"}\'');
      }
    }

    // #481: --repos folds into the same metadata object, so the two flags
    // compose rather than one silently winning.
    if (options.repos) {
      const patterns = options.repos.split(',').map((p) => p.trim()).filter(Boolean);
      if (patterns.length === 0) throw new Error('--repos needs at least one pattern.');
      for (const p of patterns) validateRepoPattern(p);
      metadata = { ...(metadata || {}), repos: patterns };
    }

    // Create
    const spinner = ora('Creating credential...').start();
    const result = await client.post(resolveEndpoint('vault.create', { orgId }).path, {
      service: resolveEndpoint('vault.create', { orgId }).service,
      body: {
        integration_type: integrationType,
        label,
        credentials,
        is_default: isDefault,
        ...(metadata ? { metadata } : {}),
        ...(options.kind ? { credential_kind: options.kind } : {}),
      },
    });
    spinner.succeed('Credential created.');

    // Optional test. quox#564: this confirm was missing the `!noInput`
    // guard its sibling above (the "set as default?" confirm) already had,
    // so a headless `--no-input` run (or `--yes`-less) fell through to
    // `inquirer.prompt(...)` on whatever `inquirer` happened to be at that
    // point -- null whenever no field prompt had run first. Headless has no
    // TTY to prompt on, so it never runs the test unless asked explicitly
    // via `--yes`.
    if (options.test !== false) {
      let runTest = program.opts().yes || false;
      if (!runTest && !noInput) {
        const inq = await getInquirer();
        const ans = await inq.prompt([{
          type: 'confirm',
          name: 'test',
          message: 'Test connection now?',
          default: true,
        }]);
        runTest = ans.test;
      }

      if (runTest) {
        const testSpinner = ora('Testing connection...').start();
        try {
          const testResult = await client.post(resolveEndpoint('vault.test', { orgId, id: result.id }).path, { service: resolveEndpoint('vault.test', { orgId, id: result.id }).service });
          if (testResult.success) {
            testSpinner.succeed('Connection test passed.');
          } else {
            testSpinner.fail(`Connection test failed: ${testResult.error || testResult.message || 'unknown error'}`);
          }
        } catch (err) {
          testSpinner.fail(`Connection test failed: ${err.message}`);
        }
      }
    }

    // fleet #397: creating the FIRST credential of a type gave no signal
    // that it silently isn't used until it's also made default (a caller
    // resolving by type only ever sees the default). Print-only, never
    // auto-set-default — that would swap which credential live traffic
    // uses as a side effect of a create. printInfo already no-ops for
    // -o json / -q, so this can't pollute headless output.
    if (!result.is_default) {
      printInfo(`note: not set as default — run "quox vault set-default ${result.id}" to make it the active ${result.integration_type || integrationType} credential`);
    }

    formatDetail(result, { format: program.opts().output });
    return result;
  };
}

export function makeVaultUpdateAction({ client, auth }, program) {
  return async (id, options) => {
    auth.requireAuth();
    const orgId = resolveOrgId(auth, program);
    const body = {};
    if (options.label) body.label = options.label;
    if (options.description) body.description = options.description;
    if (options.kind) body.credential_kind = options.kind;

    // quox#580: `vault update` could only ever touch --label/--description —
    // there was no way to change a credential's field VALUES (e.g. rotate an
    // email credential's imap_host) short of `vault rotate`'s interactive
    // prompt flow, and no way to send credential_kind at all. Reuses the
    // same headless load path as `vault create` (loadSuppliedCredentials),
    // so the same secret-hygiene rules apply: no --value flag, file/stdin/
    // env:VAR only.
    const supplied = await loadSuppliedCredentials(options);
    if (Object.keys(supplied).length > 0) body.credentials = supplied;

    if (Object.keys(body).length === 0) {
      throw new Error(
        'Specify at least one field to update (--label, --description, --kind, '
        + '--credentials-file, or --credentials-stdin).'
      );
    }

    await client.put(resolveEndpoint('vault.update', { orgId, id }).path, { service: resolveEndpoint('vault.update', { orgId, id }).service, body });
    printEvent(events.updated('quox', 'vault credential', id));
  };
}

export function makeVaultDeleteAction({ client, auth }, program) {
  return async (id, options) => {
    auth.requireAuth();
    const orgId = resolveOrgId(auth, program);

    if (!options.force && !program.opts().yes) {
      const { default: inquirer } = await import('inquirer');
      const ans = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: `Delete credential ${id}? This cannot be undone.`,
        default: false,
      }]);
      if (!ans.confirm) {
        printInfo('Cancelled.');
        return;
      }
    }

    await client.delete(resolveEndpoint('vault.delete', { orgId, id }).path, { service: resolveEndpoint('vault.delete', { orgId, id }).service });
    printEvent(glyphLine('quox', 'vault credential deleted', { result: id, status: 'ok' }));
  };
}

export function makeVaultTestAction({ client, auth }, program) {
  return async (id) => {
    auth.requireAuth();
    const orgId = resolveOrgId(auth, program);

    const spinner = ora('Testing connection...').start();
    const start = Date.now();

    try {
      const result = await client.post(resolveEndpoint('vault.test', { orgId, id }).path, { service: resolveEndpoint('vault.test', { orgId, id }).service });
      const elapsed = Date.now() - start;

      if (result.success) {
        spinner.succeed(`Connection test passed (${elapsed}ms)`);
      } else {
        spinner.fail(`Connection test failed: ${result.error || result.message || 'unknown error'}`);
      }
    } catch (err) {
      const elapsed = Date.now() - start;
      spinner.fail(`Connection test failed (${elapsed}ms): ${err.message}`);
    }
  };
}

export function registerVaultCommands(program, ctx) {
  const { client, auth } = ctx;

  const vault = program
    .command('vault')
    .description('Manage QuoxVault credentials');

  // ── vault list ──────────────────────────────────────────────────────────────

  vault
    .command('list')
    .description('List credentials (masked)')
    .option('--type <type>', 'filter by integration type')
    .option('--status <status>', 'filter by test status (success|failed|untested)')
    .action(makeVaultListAction(ctx, program));

  // ── vault get ───────────────────────────────────────────────────────────────

  vault
    .command('get')
    .description('Show credential details')
    .argument('<id>', 'credential ID')
    .action(makeVaultGetAction(ctx, program));

  // ── vault create ────────────────────────────────────────────────────────────

  vault
    .command('create')
    .description('Create a credential (interactive, or headless via --credentials-file/--credentials-stdin)')
    .option('--type <type>', 'integration type (skip prompt)')
    .option('--label <label>', 'display label (skip prompt)')
    .option('--set-default', 'set as default for this type')
    .option('--no-test', 'skip connection test after creation')
    // fleet #391: there was no non-interactive path for the field VALUES —
    // including the secret — so a headless operator (CI, an agent, this
    // very box) could not add so much as an LLM key. Deliberately NOT
    // adding `--value <secret>`: that leaks the secret into argv, the
    // process list and shell history. File and stdin both keep it out of
    // all three. `env:VAR` is resolved at runtime so a value can also come
    // from the environment without ever being written down.
    .option('--credentials-file <path>', 'JSON object of {field: value} for the credential fields (use 0600; supports "env:VAR_NAME" values)')
    .option('--credentials-stdin', 'read that same JSON object from stdin (never touches argv or disk)')
    // BASTION-CRED: free-form metadata tags on the credential, e.g. a bootstrap
    // SSH credential is tagged {"purpose":"bootstrap"} so the collector's
    // auto-revoke path (DELETE /internal/integrations/:id) will accept it.
    // Metadata is NOT secret and never contains field values.
    .option('--metadata <json>', 'JSON object of non-secret metadata tags (e.g. \'{"purpose":"bootstrap"}\')')
    // #481: sugar for the one metadata key that changes which credential gets
    // used. Spelling it out as a flag is the difference between a scope people
    // set and one they never discover inside a --metadata JSON blob.
    .option('--repos <patterns>', 'repositories this credential covers: comma-separated owner/name, owner/*, or *')
    .option('--kind <kind>', 'credential_kind to record on the credential, if the type distinguishes one')
    .option('--no-input', 'never prompt; fail with a clear error if a required field is missing')
    .action(makeVaultCreateAction(ctx, program));

  // ── vault update ────────────────────────────────────────────────────────────

  vault
    .command('update')
    .description('Update a credential (interactive label/description fields, or headless credential field values via --credentials-file/--credentials-stdin)')
    .argument('<id>', 'credential ID')
    .option('--label <label>', 'new label')
    .option('--description <desc>', 'new description')
    .option('--kind <kind>', 'credential_kind to record on the credential, if the type distinguishes one')
    // quox#580: same secret-hygiene shape as `vault create` — no --value
    // flag, so a field value never lands in argv, the process list, or
    // shell history.
    .option('--credentials-file <path>', 'JSON object of {field: value} for the credential fields to change (use 0600; supports "env:VAR_NAME" values)')
    .option('--credentials-stdin', 'read that same JSON object from stdin (never touches argv or disk)')
    .action(makeVaultUpdateAction(ctx, program));

  // ── vault repos ─────────────────────────────────────────────────────────────

  vault
    .command('repos')
    .description('Show or set which repositories a credential covers (GitHub and similar)')
    .argument('<id>', 'credential ID')
    .option('--set <patterns>', 'comma-separated patterns: owner/name, owner/*, or * for everything')
    .option('--clear', 'remove the repository scope, so only the org default reaches this credential')
    .action(async (id, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      if (options.set && options.clear) {
        throw new Error('Pass --set or --clear, not both.');
      }

      const getEp = resolveEndpoint('vault.get', { orgId, id });
      const data = await client.get(getEp.path, { service: getEp.service });
      const cred = data.integration || data.credential || data;

      // Metadata is MERGED, never replaced. A credential can already carry
      // {"purpose":"bootstrap"}, which the collector's auto-revoke path reads,
      // and clobbering it would silently disarm that.
      let metadata = {};
      const raw = cred.metadata_json ?? cred.metadata;
      if (raw) {
        try { metadata = typeof raw === 'string' ? JSON.parse(raw) : { ...raw }; } catch (_err) { metadata = {}; }
      }
      if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {};

      if (!options.set && !options.clear) {
        const current = Array.isArray(metadata.repos) ? metadata.repos : [];
        if (current.length === 0) {
          // Say what the absence MEANS. "No scope" reads as "fine"; what it
          // actually means is that only the org default ever reaches this
          // credential, which is the confusion behind quoxai/quox#481.
          printInfo(`${cred.label || id} declares no repositories, so it is only reachable as the org default.`);
        } else {
          console.log(`${cred.label || id} covers:`);
          for (const p of current) console.log(`  ${p}`);
        }
        return;
      }

      if (options.clear) {
        delete metadata.repos;
      } else {
        const patterns = options.set.split(',').map((p) => p.trim()).filter(Boolean);
        if (patterns.length === 0) throw new Error('--set needs at least one pattern.');
        for (const p of patterns) validateRepoPattern(p);
        metadata.repos = patterns;
      }

      const ep = resolveEndpoint('vault.update', { orgId, id });
      await client.put(ep.path, { service: ep.service, body: { metadata } });

      if (options.clear) printEvent(events.updated('quox', 'vault credential repos', id, 'cleared'));
      else printEvent(events.updated('quox', 'vault credential repos', id, metadata.repos.join(', ')));
    });

  // ── vault delete ────────────────────────────────────────────────────────────

  vault
    .command('delete')
    .description('Delete a credential')
    .argument('<id>', 'credential ID')
    .option('--force', 'skip confirmation')
    .action(makeVaultDeleteAction(ctx, program));

  // ── vault set-default ───────────────────────────────────────────────────────

  vault
    .command('set-default')
    .description('Set a credential as the default for its type')
    .argument('<id>', 'credential ID')
    .action(async (id) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const result = await client.post(resolveEndpoint('vault.default', { orgId, id }).path, { service: resolveEndpoint('vault.default', { orgId, id }).service });
      printEvent(glyphLine('quox', 'vault credential default set', { result: `${id} · ${result.integration_type || 'its type'}`, status: 'ok' }));
    });

  // ── vault test ──────────────────────────────────────────────────────────────

  vault
    .command('test')
    .description('Test a credential connection')
    .argument('<id>', 'credential ID')
    .action(makeVaultTestAction(ctx, program));

  // ── vault test-new ──────────────────────────────────────────────────────────
  //
  // VAULT-INTEG P6: pre-save test — verify a set of credential field values
  // BEFORE creating anything, mirroring the auth service's
  // POST /integrations/test-credentials. Nothing is persisted either way.
  // Same secret-hygiene shape as `vault create`: no --value flag, field
  // values only ever arrive via --credentials-file/--credentials-stdin.

  vault
    .command('test-new')
    .description('Test credential field values before saving (nothing is persisted)')
    .requiredOption('--type <type>', 'integration type to test')
    .option('--endpoint-url <url>', 'endpoint URL to test against (custom/self-hosted types)')
    .option('--credentials-file <path>', 'JSON object of {field: value} for the credential fields (use 0600; supports "env:VAR_NAME" values)')
    .option('--credentials-stdin', 'read that same JSON object from stdin (never touches argv or disk)')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      const credentials = await loadSuppliedCredentials(options);
      if (Object.keys(credentials).length === 0) {
        throw new Error(
          'Provide the credential field values to test via --credentials-file <path> or '
          + '--credentials-stdin (a JSON object of {field: value}).'
        );
      }

      const spinner = ora('Testing credentials (nothing will be saved)...').start();
      try {
        const ep = resolveEndpoint('vault.test-credentials', { orgId });
        const result = await client.post(ep.path, {
          service: ep.service,
          body: {
            integration_type: options.type,
            credentials,
            ...(options.endpointUrl ? { endpoint_url: options.endpointUrl } : {}),
          },
        });
        if (result.success) {
          spinner.succeed('Connection test passed. Nothing was saved.');
        } else {
          spinner.fail(`Connection test failed: ${result.error || result.message || 'unknown error'}`);
        }
      } catch (err) {
        spinner.fail(`Connection test failed: ${err.message}`);
      }
    });

  // ── vault test-all ──────────────────────────────────────────────────────────

  vault
    .command('test-all')
    .description('Test all credentials sequentially')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      const data = await client.get(resolveEndpoint('vault.list', { orgId }).path, { service: resolveEndpoint('vault.list', { orgId }).service });
      const creds = data.credentials || data;

      if (!creds.length) {
        printInfo('No credentials to test.');
        return;
      }

      const results = [];
      for (const cred of creds) {
        const spinner = ora(`Testing ${cred.label} (${cred.integration_type})...`).start();
        const start = Date.now();
        try {
          const result = await client.post(resolveEndpoint('vault.test', { orgId, id: cred.id }).path, { service: resolveEndpoint('vault.test', { orgId, id: cred.id }).service });
          const elapsed = Date.now() - start;
          if (result.success) {
            spinner.succeed(`${cred.label}: passed (${elapsed}ms)`);
            results.push({ id: cred.id, label: cred.label, type: cred.integration_type, result: 'pass', time: `${elapsed}ms` });
          } else {
            spinner.fail(`${cred.label}: failed — ${result.error || result.message || 'unknown'}`);
            results.push({ id: cred.id, label: cred.label, type: cred.integration_type, result: 'fail', time: `${elapsed}ms` });
          }
        } catch (err) {
          const elapsed = Date.now() - start;
          spinner.fail(`${cred.label}: error — ${err.message}`);
          results.push({ id: cred.id, label: cred.label, type: cred.integration_type, result: 'error', time: `${elapsed}ms` });
        }
      }

      const passed = results.filter(r => r.result === 'pass').length;
      const failed = results.length - passed;
      console.log('');
      printInfo(`Results: ${passed} passed, ${failed} failed out of ${results.length} credentials`);

      if (program.opts().output === 'json') {
        console.log(JSON.stringify(results, null, 2));
      }
    });

  // ── vault stats ─────────────────────────────────────────────────────────────

  vault
    .command('stats')
    .description('Show vault health dashboard')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const stats = await client.get(resolveEndpoint('vault.vault-stats.list', { orgId }).path, { service: resolveEndpoint('vault.vault-stats.list', { orgId }).service });

      const format = program.opts().output;
      if (format === 'json') {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      // Render health dashboard
      const table = new Table({
        chars: {
          'top': '═', 'top-mid': '╤', 'top-left': '╔', 'top-right': '╗',
          'bottom': '═', 'bottom-mid': '╧', 'bottom-left': '╚', 'bottom-right': '╝',
          'left': '║', 'left-mid': '╟', 'mid': '─', 'mid-mid': '┼',
          'right': '║', 'right-mid': '╢', 'middle': '│',
        },
        style: { head: [], border: [] },
      });

      table.push(
        [{ colSpan: 2, content: chalk.bold('QuoxVault Health'), hAlign: 'center' }],
        ['Credentials', String(stats.total || 0)],
        [chalk.green('● Healthy'), String(stats.healthy || 0)],
        [chalk.red('● Failed'), String(stats.failed || 0)],
        [chalk.dim('○ Untested'), String(stats.untested || 0)],
        [chalk.yellow('◐ Stale'), String(stats.stale || 0)],
        ['Total Uses', String(stats.totalUseCount || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')],
        ['Encryption', stats.encryption || 'AES-256-GCM'],
      );

      console.log(table.toString());

      // Type breakdown if available
      if (stats.typeBreakdown && stats.typeBreakdown.length > 0) {
        console.log('');
        formatOutput({
          columns: ['integration_type', 'count', 'healthy', 'failed'],
          headers: ['Type', 'Count', 'Healthy', 'Failed'],
          rows: stats.typeBreakdown,
        }, { format });
      }
    });

  // ── vault scan ──────────────────────────────────────────────────────────────

  vault
    .command('scan')
    .description('Run a health scan and show issues')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      const spinner = ora('Running health scan...').start();
      const result = await client.post(resolveEndpoint('vault.health-scan', { orgId }).path, { service: resolveEndpoint('vault.health-scan', { orgId }).service });
      spinner.stop();

      const format = program.opts().output;
      if (format === 'json') {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (!result.issues || result.issues.length === 0) {
        printSuccess('No issues found. All credentials are healthy.');
        return;
      }

      console.log(chalk.bold(`Found ${result.issueCount || result.issues.length} issue(s):\n`));

      formatOutput({
        columns: ['severity', 'type', 'label', 'issue', 'message'],
        headers: ['Severity', 'Type', 'Label', 'Issue', 'Message'],
        rows: result.issues,
      }, { format });
    });

  // ── vault activity ──────────────────────────────────────────────────────────

  vault
    .command('activity')
    .description('Show vault audit trail')
    .option('--limit <n>', 'number of events', '20')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const limit = parseInt(options.limit) || 20;

      const data = await client.get(resolveEndpoint('vault.activity.list', { orgId }).path, {
        service: resolveEndpoint('vault.activity.list', { orgId }).service,
        query: { limit },
      });
      const events = data.events || data;

      formatOutput({
        columns: ['created_at', 'action', 'actor_type', 'status', 'target_id'],
        headers: ['Time', 'Action', 'Actor', 'Status', 'Target'],
        rows: events,
      }, { format: program.opts().output, emptyMessage: 'No activity found.' });
    });

  // ── vault types ─────────────────────────────────────────────────────────────

  vault
    .command('types')
    .description('List available integration types')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('vault.types.list', { orgId }).path, { service: resolveEndpoint('vault.types.list', { orgId }).service });
      const types = data.types || data;

      formatOutput({
        columns: ['id', 'name', 'description'],
        headers: ['ID', 'Name', 'Description'],
        rows: types,
      }, { format: program.opts().output });
    });

  // ── vault rotate ────────────────────────────────────────────────────────────

  vault
    .command('rotate')
    .description('Rotate a credential with new values')
    .argument('<id>', 'credential ID')
    .option('--no-test', 'skip connection test after rotation')
    .option('--expires <date>', 'set expiration date (ISO 8601)')
    .action(async (id, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      // Get current credential info
      const data = await client.get(resolveEndpoint('vault.get', { orgId, id }).path, { service: resolveEndpoint('vault.get', { orgId, id }).service });
      const cred = data.integration || data;

      console.log(chalk.bold(`Rotating: ${cred.label} (${cred.integration_type})`));
      console.log(chalk.dim(`Current key: ${cred.key_preview || '****'}`));

      // Get type definition for fields
      const typesData = await client.get(resolveEndpoint('vault.types.list', { orgId }).path, { service: resolveEndpoint('vault.types.list', { orgId }).service });
      const types = typesData.types || typesData;
      const typeDef = types.find(t => t.id === cred.integration_type);

      if (!typeDef) throw new Error(`Unknown integration type: ${cred.integration_type}`);

      // Prompt for new credential fields
      const { default: inquirer } = await import('inquirer');
      const credentials = {};
      for (const field of typeDef.fields) {
        if (field.required || !field.default) {
          const ans = await inquirer.prompt([{
            type: field.type === 'password' ? 'password' : 'input',
            name: field.key,
            message: `New ${field.label}:`,
            validate: v => field.required ? (v.trim().length > 0 || `${field.label} is required`) : true,
          }]);
          credentials[field.key] = ans[field.key];
        }
      }

      const body = { credentials };
      if (options.expires) body.expires_at = options.expires;

      const testQuery = options.test !== false ? '?test=true' : '';
      const spinner = ora('Rotating credential...').start();

      const result = await client.post(resolveEndpoint('vault.rotate', { orgId, id, testQuery }).path, { service: resolveEndpoint('vault.rotate', { orgId, id, testQuery }).service, body });

      spinner.succeed('Credential rotated.');
      console.log(chalk.dim(`New key: ${result.key_preview || '****'}`));

      if (result.test_status === 'success') {
        printSuccess('Connection test passed.');
      } else if (result.test_status === 'failed') {
        printWarning('Connection test failed — credential was still rotated.');
      }

      formatDetail(result, { format: program.opts().output });
    });

  // ── vault expiring ─────────────────────────────────────────────────────────

  vault
    .command('expiring')
    .description('List credentials expiring soon')
    .option('--days <n>', 'expiration window in days', '7')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const days = parseInt(options.days) || 7;

      const data = await client.get(resolveEndpoint('vault.expiring.list', { orgId }).path, {
        service: resolveEndpoint('vault.expiring.list', { orgId }).service,
        query: { days },
      });
      const credentials = data.credentials || data;

      if (credentials.length === 0) {
        printInfo(`No credentials expiring within ${days} days.`);
        return;
      }

      console.log(chalk.bold(`Credentials expiring within ${days} days:\n`));

      formatOutput({
        columns: ['id', 'integration_type', 'label', 'expires_at', 'rotated_at', 'test_status'],
        headers: ['ID', 'Type', 'Label', 'Expires At', 'Last Rotated', 'Status'],
        rows: credentials,
      }, { format: program.opts().output });
    });

  // ── vault folder ────────────────────────────────────────────────────────────
  //
  // VAULT-INTEG P6: credential folders (organize vault entries into a tree,
  // max nesting depth 3 — see services/auth/db/integrations.js createFolder).

  const folder = vault
    .command('folder')
    .description('Organize credentials into folders');

  folder
    .command('list')
    .description('List credential folders')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('vault.folders.list', { orgId });
      const data = await client.get(ep.path, { service: ep.service });
      const folders = data.folders || data;

      formatOutput({
        columns: ['id', 'name', 'parent_id', 'color', 'icon', 'credential_count'],
        headers: ['ID', 'Name', 'Parent', 'Color', 'Icon', 'Credentials'],
        rows: folders,
      }, { format: program.opts().output, emptyMessage: 'No credential folders found.' });
    });

  folder
    .command('create')
    .description('Create a credential folder')
    .requiredOption('--name <name>', 'folder name')
    .option('--parent <folderId>', 'parent folder ID (max nesting depth 3)')
    .option('--color <color>', 'folder color tag')
    .option('--icon <icon>', 'folder icon tag')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('vault.folders.create', { orgId });
      const result = await client.post(ep.path, {
        service: ep.service,
        body: { name: options.name, parent_id: options.parent || null, color: options.color, icon: options.icon },
      });
      printEvent(events.created('quox', 'credential folder', result.id));
      formatDetail(result, { format: program.opts().output });
    });

  folder
    .command('rename')
    .description('Rename a credential folder')
    .argument('<folderId>', 'folder ID')
    .requiredOption('--name <name>', 'new folder name')
    .action(async (folderId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('vault.folders.update', { orgId, folderId });
      const result = await client.put(ep.path, { service: ep.service, body: { name: options.name } });
      printEvent(events.updated('quox', 'credential folder', folderId, `renamed to "${options.name}"`));
      formatDetail(result, { format: program.opts().output });
    });

  folder
    .command('delete')
    .description('Delete a credential folder (its credentials move to no-folder)')
    .argument('<folderId>', 'folder ID')
    .option('--force', 'skip confirmation')
    .action(async (folderId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      if (!options.force && !program.opts().yes) {
        const { default: inquirer } = await import('inquirer');
        const ans = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: `Delete folder ${folderId}? Its credentials move to no-folder.`,
          default: false,
        }]);
        if (!ans.confirm) {
          printInfo('Cancelled.');
          return;
        }
      }

      const ep = resolveEndpoint('vault.folders.delete', { orgId, folderId });
      await client.delete(ep.path, { service: ep.service });
      printEvent(glyphLine('quox', 'credential folder deleted', { result: folderId, status: 'ok' }));
    });

  // ── vault assign / unassign / assignments ──────────────────────────────────
  //
  // VAULT-INTEG P6: agent credential assignments (services/auth/routes/
  // agent-credentials.js) — which credential an agent uses for a given tool
  // type, ranked by priority. Not under the /vault/ namespace alias
  // server-side; these routes already live at their own path.

  const isJsonOutput = () => program.opts().output === 'json' || program.opts().json === true;

  /**
   * BLAST-RADIUS-P5: grant-time reach delta. Every vault assign/unassign
   * names an agent, so once the grant/revoke has landed, re-fetch that
   * agent's reach — the exact GET .../reach call `quox reach agent` uses —
   * and surface the one line that just changed.
   *
   * A failed reach fetch must never fail the assign/unassign: it downgrades
   * to one plain warning line (never rendered as data — an error body is
   * not a reach result) and the command still exits 0. In --json mode no
   * glyph line is printed either way; on success the caller folds the
   * returned object into the JSON payload as `reach_delta`, on failure it's
   * simply absent.
   */
  async function reachGrantDelta({ agentId, credentialRef, direction, unavailableReason }) {
    const json = isJsonOutput();

    if (unavailableReason) {
      if (!json) {
        process.stdout.write(`\u{1F4A5} REACH │ grant delta unavailable (${unavailableReason})\n`);
      }
      return null;
    }

    let result;
    try {
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('reach.agent.get', { orgId, agentId });
      result = await client.get(ep.path, { service: ep.service });
    } catch (err) {
      if (!json) {
        process.stdout.write(
          `\u{1F4A5} REACH │ grant delta unavailable (${err?.message || 'reach fetch failed'})\n`
        );
      }
      return null;
    }

    const sources = result.sources || {};
    const badge = result.badge || { level: 'R0' };
    const credentials = sources.credentials?.count ?? 0;
    const matched = (result.may?.credentials || []).find((c) => c && c.id === credentialRef);
    const credRef = matched?.name || credentialRef;
    const verb = direction === 'assign' ? 'now in reach' : 'no longer in reach';

    if (!json) {
      process.stdout.write(
        `\u{1F4A5} REACH │ grant delta ${agentId} │ credentials ${credentials} · ${badge.level} · ${credRef} ${verb}\n`
      );
    }

    return { agent_id: agentId, credentials, level: badge.level, credential: credRef, direction };
  }

  vault
    .command('assign')
    .description('Assign a credential to an agent for a tool type')
    .requiredOption('--agent <agentId>', 'agent ID')
    .requiredOption('--credential <credentialId>', 'credential ID')
    .requiredOption('--tool-type <toolType>', 'tool type this assignment covers')
    .option('--priority <n>', 'priority when multiple assignments match (higher wins)', '0')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const priority = parseInt(options.priority, 10);
      const ep = resolveEndpoint('vault.agent-assignments.create', { orgId });
      const result = await client.post(ep.path, {
        service: ep.service,
        body: {
          agent_id: options.agent,
          credential_id: options.credential,
          tool_type: options.toolType,
          priority: Number.isFinite(priority) ? priority : 0,
        },
      });
      printEvent(events.assigned('quox', 'vault credential', `${options.agent} · ${options.toolType}`));

      // BLAST-RADIUS-P5: assign always names an agent (--agent is required),
      // so the delta fires unconditionally here.
      const reachDelta = await reachGrantDelta({
        agentId: options.agent,
        credentialRef: options.credential,
        direction: 'assign',
      });

      const detail = isJsonOutput() && reachDelta ? { ...result, reach_delta: reachDelta } : result;
      formatDetail(detail, { format: program.opts().output });
    });

  vault
    .command('unassign')
    .description('Remove an agent credential assignment')
    .argument('<assignmentId>', 'assignment ID')
    .action(async (assignmentId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      // BLAST-RADIUS-P5: unassign only takes the assignment ID, but the
      // reach delta needs to know WHICH agent lost the credential. Look the
      // assignment up (best effort, before it's deleted) via the same list
      // endpoint `quox vault assignments` already uses — no new endpoint.
      let targetAgentId = null;
      let credentialRef = assignmentId;
      let lookupFailure = null;
      try {
        const listEp = resolveEndpoint('vault.agent-assignments.list', { orgId });
        const data = await client.get(listEp.path, { service: listEp.service });
        const assignments = data.assignments || data;
        const match = Array.isArray(assignments) ? assignments.find((a) => a && a.id === assignmentId) : null;
        if (match) {
          targetAgentId = match.agent_id;
          credentialRef = match.label || match.credential_id || assignmentId;
        } else {
          lookupFailure = `could not resolve the agent for assignment ${assignmentId}`;
        }
      } catch (err) {
        lookupFailure = err?.message || `could not resolve the agent for assignment ${assignmentId}`;
      }

      const ep = resolveEndpoint('vault.agent-assignments.delete', { orgId, id: assignmentId });
      await client.delete(ep.path, { service: ep.service });
      printEvent(glyphLine('quox', 'agent credential assignment removed', { result: assignmentId, status: 'ok' }));

      const reachDelta = await reachGrantDelta({
        agentId: targetAgentId,
        credentialRef,
        direction: 'unassign',
        unavailableReason: targetAgentId ? null : lookupFailure,
      });

      if (isJsonOutput() && reachDelta) {
        formatDetail({ deleted: true, id: assignmentId, reach_delta: reachDelta }, { format: program.opts().output });
      }
    });

  vault
    .command('assignments')
    .description('List agent credential assignments')
    .option('--agent <agentId>', 'filter by agent ID')
    .option('--tool-type <toolType>', 'filter by tool type')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('vault.agent-assignments.list', { orgId });
      const query = {};
      if (options.agent) query.agent_id = options.agent;
      if (options.toolType) query.tool_type = options.toolType;
      const data = await client.get(ep.path, { service: ep.service, query });
      const assignments = data.assignments || data;

      formatOutput({
        columns: ['id', 'agent_id', 'label', 'integration_type', 'tool_type', 'priority'],
        headers: ['ID', 'Agent', 'Credential', 'Type', 'Tool Type', 'Priority'],
        rows: assignments,
      }, { format: program.opts().output, emptyMessage: 'No agent credential assignments found.' });
    });

  // ── vault lease ─────────────────────────────────────────────────────────────
  //
  // VAULT-INTEG P6: just-in-time credential leases (services/auth/routes/
  // credential-leases.js) — an agent requests time-boxed access to a
  // lease-required credential; a human approves/denies via HITL inbox or
  // directly here.

  const lease = vault
    .command('lease')
    .description('Just-in-time credential leases for agent access');

  lease
    .command('request')
    .description('Request a lease on a credential (creates a pending HITL approval)')
    .requiredOption('--credential <credentialId>', 'credential ID')
    .requiredOption('--agent <agentId>', 'requesting agent ID')
    .option('--task <taskId>', 'associated task ID')
    .option('--justification <text>', 'why this lease is needed (plaintext, max 500 chars)')
    .option('--context <json>', 'JSON object of extra context (max 10KB)')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      let context;
      if (options.context) {
        try {
          context = JSON.parse(options.context);
        } catch (err) {
          throw new Error(`--context must be a JSON object: ${err.message}`);
        }
      }

      const ep = resolveEndpoint('vault.leases.request', { orgId });
      const result = await client.post(ep.path, {
        service: ep.service,
        body: {
          credential_id: options.credential,
          agent_id: options.agent,
          task_id: options.task,
          justification: options.justification,
          context,
        },
      });
      printEvent(events.created('quox', 'credential lease request', result.id));
      formatDetail(result, { format: program.opts().output });
    });

  lease
    .command('list')
    .description('List credential leases')
    .option('--status <status>', 'filter by status (pending|active|denied|revoked|expired)')
    .option('--agent <agentId>', 'filter by agent ID')
    .option('--credential <credentialId>', 'filter by credential ID')
    .option('--limit <n>', 'max results', '50')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('vault.leases.list', { orgId });
      const data = await client.get(ep.path, {
        service: ep.service,
        query: {
          status: options.status,
          agent_id: options.agent,
          credential_id: options.credential,
          limit: options.limit,
        },
      });
      const leases = data.leases || data;

      // VAULT-P5.M parity: surface the org's actual enforcement mode rather
      // than implying the backend gates every lease-required credential.
      if (data.enforcement_mode && program.opts().output !== 'json') {
        printInfo(`lease enforcement mode: ${data.enforcement_mode}`);
      }

      formatOutput({
        columns: ['id', 'credential_label', 'requested_by_agent_id', 'status', 'expires_at'],
        headers: ['ID', 'Credential', 'Agent', 'Status', 'Expires'],
        rows: leases,
      }, { format: program.opts().output, emptyMessage: 'No leases found.' });
    });

  lease
    .command('approve')
    .description('Approve a pending lease with a duration')
    .argument('<leaseId>', 'lease ID')
    .requiredOption('--duration <minutes>', 'lease duration in minutes')
    .action(async (leaseId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const duration = parseInt(options.duration, 10);
      if (!Number.isFinite(duration) || duration < 1) {
        throw new Error('--duration must be a positive number of minutes.');
      }
      const ep = resolveEndpoint('vault.leases.approve', { orgId, leaseId });
      const result = await client.post(ep.path, { service: ep.service, body: { duration_minutes: duration } });
      printEvent(events.updated('quox', 'credential lease', leaseId, `approved for ${duration}m`));
      formatDetail(result, { format: program.opts().output });
    });

  lease
    .command('deny')
    .description('Deny a pending lease')
    .argument('<leaseId>', 'lease ID')
    .action(async (leaseId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('vault.leases.deny', { orgId, leaseId });
      const result = await client.post(ep.path, { service: ep.service });
      printEvent(events.updated('quox', 'credential lease', leaseId, 'denied'));
      formatDetail(result, { format: program.opts().output });
    });

  lease
    .command('revoke')
    .description('Revoke an active lease immediately')
    .argument('<leaseId>', 'lease ID')
    .action(async (leaseId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('vault.leases.revoke', { orgId, leaseId });
      const result = await client.post(ep.path, { service: ep.service });
      if (result?.revoked === false) {
        printWarning(`Lease ${leaseId} was not revoked (already inactive?).`);
      } else {
        printEvent(glyphLine('quox', 'credential lease revoked', { result: leaseId, status: 'ok' }));
      }
    });

  // ── vault cross-org ─────────────────────────────────────────────────────────
  //
  // VAULT-INTEG P6: GET /me/cross-org-credentials — find credentials of a
  // type across every org the caller belongs to. Metadata only, no secrets.

  vault
    .command('cross-org')
    .description('Find credentials of a type across every org you belong to (no secrets returned)')
    .requiredOption('--type <type>', 'integration type to look up')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('vault.cross-org.list', {});
      const data = await client.get(ep.path, { service: ep.service, query: { type: options.type } });
      const availableIn = data.available_in || [];

      formatOutput({
        columns: ['org_id', 'org_name', 'credential_id', 'label', 'is_default', 'test_status'],
        headers: ['Org ID', 'Org Name', 'Credential ID', 'Label', 'Default', 'Status'],
        rows: availableIn,
      }, { format: program.opts().output, emptyMessage: `No ${options.type} credentials found in any of your orgs.` });
    });

  // ── vault health ────────────────────────────────────────────────────────────
  //
  // VAULT-INTEG P6: GET /internal/vault-health. This is a SERVICE-KEY-gated
  // route (checks the raw `x-service-key` header against INTERNAL_SERVICE_KEY,
  // not a user Bearer JWT) — unlike the removed `vault export` decrypt route,
  // the CLI client already has a legitimate service-key path (QUOX_SERVICE_KEY
  // env var, see lib/core/client.js), so this is wired rather than removed.
  // A normal logged-in user session sends a Bearer token instead and this
  // route will 401 it — that is not a bug, it is the route's design; run
  // with QUOX_SERVICE_KEY set to the instance's INTERNAL_SERVICE_KEY (or
  // QUOX_FORCE_SERVICE_KEY=1 if a user session is also stored) to use it.

  vault
    .command('health')
    .description('Lightweight vault health summary (requires QUOX_SERVICE_KEY, not a user session)')
    .option('--org-id <orgId>', 'org ID to scope the summary to (server default: "default")')
    .action(async (options) => {
      const ep = resolveEndpoint('vault.health', {});
      const data = await client.get(ep.path, {
        service: ep.service,
        query: options.orgId ? { org_id: options.orgId } : undefined,
      });
      formatDetail(data, { format: program.opts().output, title: 'QuoxVault Health' });
    });

  // ── vault export (removed — WP0.2) ──────────────────────────────────────────
  //
  // REMOVED (WP0.2): this command decrypted credentials via
  // POST /internal/vault/:id/decrypt, which aliases to
  // /internal/integrations/:id/decrypt — a SERVICE-KEY-gated route
  // (authenticateApiKey(), expects `x-api-key: msk_...`). The CLI only
  // ever sends a user Bearer JWT, so this call would 401 in production.
  // There is no legitimate service-key mode wired into the CLI client,
  // so the command is removed rather than silently broken.

  // ── vault migrate ───────────────────────────────────────────────────────────

  vault
    .command('migrate')
    .description('Migrate legacy instance_config keys to QuoxVault')
    .option('--dry-run', 'show what would be migrated without making changes')
    .action(async (options) => {
      auth.requireAuth();

      const spinner = ora('Running key migration...').start();

      try {
        // Shell out to the migration script
        const { execSync } = await import('child_process');
        const scriptPath = new URL('../../../services/auth/scripts/migrate-keys-to-vault.js', import.meta.url).pathname;
        const args = options.dryRun ? '--dry-run' : '';
        const output = execSync(`node ${scriptPath} ${args}`, {
          encoding: 'utf-8',
          timeout: 30000,
        });
        spinner.stop();
        console.log(output);
      } catch (err) {
        spinner.fail('Migration failed.');
        throw new Error(err.stderr || err.message);
      }
    });
}
