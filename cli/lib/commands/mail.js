/**
 * InboxQ commands: connected mail accounts, triaged messages, zones,
 * sync, reports, watches and proposals. Governed proxy to the InboxQ
 * plugin (collector: /api/v1/inboxq/*, org resolved server-side from auth).
 *
 * `quox inbox` is the separate HITL approvals command group; this is
 * `quox mail`, InboxQ's own command group.
 */

import { readFileSync, statSync } from 'fs';
import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { parseJSON, resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

// --- minimal CSV parsing (quoted fields + escaped quotes, no deps) ----------
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else { cur += c; }
    } else if (c === '"') { inQuotes = true; }
    else if (c === ',') { out.push(cur); cur = ''; }
    else { cur += c; }
  }
  out.push(cur);
  return out;
}

function parseCsvFile(path) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { header: [], rows: [] };
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = (cells[i] ?? '').trim(); });
    return row;
  });
  return { header, rows };
}

const VALID_ZONES = ['focus', 'fyi', 'auto', 'screened'];
const VALID_KINDS = ['file', 'block', 'draft'];
const VALID_DECISIONS = ['approve', 'deny'];

// Small CLI-local copy of src/config/emailProviders.js's EMAIL_PROVIDERS.
// The cli/ package can't import from src/, so the host/port defaults for
// each named provider are duplicated here; keep the two in sync by hand
// when a provider's IMAP/SMTP settings change.
const PROVIDER_PRESETS = {
  gmail: { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true },
  icloud: { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecure: true },
  outlook: { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: true },
};

function isJsonOutput(program) {
  return program.opts().output === 'json';
}

function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

export function registerMailCommands(program, ctx) {
  const { client, auth } = ctx;

  const mail = program
    .command('mail')
    .description('InboxQ: connected mail accounts, triaged messages, zones, sync, reports, watches, proposals');

  // ── accounts ─────────────────────────────────────────────────────────

  mail
    .command('accounts')
    .description('List connected mail accounts')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('inboxq.accounts.list');
      const data = await client.get(ep.path, { service: ep.service });
      if (isJsonOutput(program)) return printJson(data);
      formatOutput({
        columns: ['id', 'emailAddress', 'displayName', 'pollEnabled', 'createdAt'],
        headers: ['ID', 'Email', 'Name', 'Polling', 'Connected'],
        rows: data.accounts || [],
      }, { format: program.opts().output });
    });

  mail
    .command('connect')
    .description('Connect a mailbox. Reuse a stored credential (--credential), or create one inline from IMAP settings (--imap-host with --password-env, or --provider gmail|icloud|outlook to pre-fill host/port). Creating a credential needs a human/admin profile, e.g. quox -p moo mail connect ...')
    .option('--credential <id>', 'reuse a stored email_account credential ID')
    .requiredOption('--email <address>', 'mailbox address (also the IMAP username unless --username is given)')
    .option('--username <user>', 'IMAP username, if different from --email')
    .option('--provider <name>', 'named email provider (gmail, icloud, outlook): pre-fills IMAP/SMTP host and port')
    .option('--imap-host <host>', 'IMAP host (creating a new credential; not required with --provider)')
    .option('--imap-port <n>', 'IMAP port', '993')
    .option('--smtp-host <host>', 'SMTP host (defaults to --imap-host)')
    .option('--smtp-port <n>', 'SMTP port', '465')
    .option('--password-env <VAR>', 'name of an env var holding the IMAP password (the password is read from it, never passed on the command line)')
    .option('--label <label>', 'vault label for the new credential')
    .option('--name <name>', 'display name for the account')
    .option('--folders <csv>', 'comma-separated folder list to watch')
    .action(async (options) => {
      auth.requireAuth();

      // Wrong-tenant guard. The InboxQ account is created in the caller's ACTIVE
      // org (the collector resolves org server-side from the token, ignoring
      // flags), while a --org would only retarget the vault credential path, so
      // a divergent --org splits the credential and account across tenants.
      // Refuse it and point at the one mechanism that moves both: org switch.
      const requestedOrg = program.opts && program.opts().org;
      const sessionOrg = typeof auth.getOrgId === 'function' ? auth.getOrgId() : null;
      if (requestedOrg && sessionOrg && requestedOrg !== sessionOrg) {
        throw new Error(
          `--org ${requestedOrg} differs from your active org ${sessionOrg}. `
          + `The mailbox account is created in your ACTIVE org (server-resolved from your token), `
          + `so --org would put the credential and the account in different tenants. `
          + `Run:  quox org switch ${requestedOrg}   then re-run connect.`,
        );
      }

      let credentialId = options.credential;

      // Inline credential creation: turns the ugly `vault create --credentials-stdin`
      // JSON one-liner into `quox mail connect --imap-host ... --password-env ...`.
      // Requires a profile with SECRETS_WRITE (a human/admin, e.g. -p moo); the
      // resident agent is denied by design.
      if (!credentialId) {
        let preset = null;
        if (options.provider) {
          preset = PROVIDER_PRESETS[options.provider];
          if (!preset) {
            throw new Error(`Unknown --provider "${options.provider}". Supported: ${Object.keys(PROVIDER_PRESETS).join(', ')}`);
          }
        }
        if (!options.imapHost && !preset) {
          throw new Error('Provide --credential <id> to reuse a stored credential, or --imap-host (with --password-env) or --provider gmail|icloud|outlook to create one.');
        }
        if (!options.passwordEnv) {
          throw new Error('--password-env <VAR> is required when creating a credential (the password is read from that env var, never from the command line).');
        }
        const password = process.env[options.passwordEnv];
        if (!password) {
          throw new Error(`Env var ${options.passwordEnv} is empty or unset.`);
        }
        const imapHost = options.imapHost || preset?.imapHost;
        const imapPort = options.imapHost ? (Number(options.imapPort) || 993) : (preset?.imapPort ?? 993);
        const smtpHost = options.smtpHost || (options.imapHost ? options.imapHost : preset?.smtpHost);
        const smtpPort = options.smtpHost ? (Number(options.smtpPort) || 465) : (preset?.smtpPort ?? 465);
        const smtpSecure = preset ? preset.smtpSecure !== false : true;
        // When a named provider is given, label the credential's integration_type
        // by provider (e.g. 'gmail') so it shows up as that provider in the vault
        // UI; credential_kind stays 'email_account' either way.
        const orgId = resolveOrgId(auth, program);
        const vep = resolveEndpoint('vault.create', { orgId });
        const created = await client.post(vep.path, {
          service: vep.service,
          body: {
            integration_type: options.provider || 'smtp',
            credential_kind: 'email_account',
            label: options.label || `Mailbox ${options.email}`,
            credentials: {
              imap_host: imapHost,
              imap_port: imapPort,
              username: options.username || options.email,
              password,
              smtp_host: smtpHost,
              smtp_port: smtpPort,
              smtp_secure: smtpSecure,
              from: options.email,
            },
          },
        });
        credentialId = created.id || created.credential?.id || created.credentialId;
        if (!credentialId) throw new Error('Credential created but no id was returned; cannot connect the account.');
        if (!isJsonOutput(program)) printSuccess(`Vault credential created (${credentialId}).`);
      }

      const body = { credentialId, emailAddress: options.email };
      if (options.name) body.displayName = options.name;
      if (options.folders) body.folders = options.folders.split(',').map((f) => f.trim()).filter(Boolean);
      const ep = resolveEndpoint('inboxq.accounts.create');
      const data = await client.post(ep.path, { service: ep.service, body });
      if (isJsonOutput(program)) return printJson(data);
      const account = data.account || data;
      printSuccess(`Connected ${account.emailAddress || options.email} (${account.id}) in org ${sessionOrg || '(active)'}`);
    });

  mail
    .command('import')
    .description('Batch-import mailboxes from a CSV. Header columns (case-insensitive): email (required), imap_host (required), imap_port, smtp_host, smtp_port, username, password_env OR password, label, name, folders (semicolon-separated). One credential + account is created per row. Needs a SECRETS_WRITE profile, e.g. quox -p moo mail import boxes.csv. A file with a password column is a secret: chmod 600 it.')
    .argument('<csvFile>', 'path to the CSV file')
    .option('--dry-run', 'parse and validate every row without creating anything')
    .option('--continue-on-error', 'keep going after a failed row (default: stop on first failure)')
    .action(async (csvFile, options) => {
      auth.requireAuth();
      const { header, rows } = parseCsvFile(csvFile);
      if (!rows.length) throw new Error('CSV has a header but no data rows.');
      if (!header.includes('email') || !header.includes('imap_host')) {
        throw new Error('CSV must have at least "email" and "imap_host" columns.');
      }

      // Secret hygiene: an inline password column makes the file a secret. Warn
      // loudly if it is group/other-readable. Never print the password itself.
      if (header.includes('password')) {
        try {
          const mode = statSync(csvFile).mode & 0o077;
          if (mode !== 0) console.error(`⚠ ${csvFile} has a plaintext password column and is group/other-readable. chmod 600 it, or use a password_env column instead.`);
        } catch { /* stat failure is non-fatal */ }
      }

      const orgId = resolveOrgId(auth, program);
      const results = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const where = `row ${i + 2} <${row.email || '?'}>`;
        try {
          if (!row.email) throw new Error('missing email');
          if (!row.imap_host) throw new Error('missing imap_host');
          const password = row.password_env ? process.env[row.password_env] : row.password;
          if (!password) throw new Error(row.password_env ? `env ${row.password_env} is empty/unset` : 'missing password or password_env');
          if (options.dryRun) { results.push({ row: where, status: 'ok (dry-run)' }); continue; }

          const vep = resolveEndpoint('vault.create', { orgId });
          const created = await client.post(vep.path, {
            service: vep.service,
            body: {
              integration_type: 'smtp',
              credential_kind: 'email_account',
              label: row.label || `Mailbox ${row.email}`,
              credentials: {
                imap_host: row.imap_host,
                imap_port: Number(row.imap_port) || 993,
                username: row.username || row.email,
                password,
                smtp_host: row.smtp_host || row.imap_host,
                smtp_port: Number(row.smtp_port) || 465,
                smtp_secure: true,
                from: row.email,
              },
            },
          });
          const credentialId = created.id || created.credential?.id || created.credentialId;
          if (!credentialId) throw new Error('credential created but no id returned');

          const body = { credentialId, emailAddress: row.email };
          if (row.name) body.displayName = row.name;
          // folders use ';' inside a cell so they do not collide with the CSV comma.
          if (row.folders) body.folders = row.folders.split(';').map((f) => f.trim()).filter(Boolean);
          const ep = resolveEndpoint('inboxq.accounts.create');
          await client.post(ep.path, { service: ep.service, body });
          results.push({ row: where, status: 'connected', credential: credentialId });
        } catch (e) {
          results.push({ row: where, status: `FAILED: ${e.message}` });
          if (!options.continueOnError && !options.dryRun) {
            if (isJsonOutput(program)) return printJson({ results, stoppedAt: where });
            formatOutput({ columns: ['row', 'status'], headers: ['Row', 'Status'], rows: results }, { format: program.opts().output });
            throw new Error(`Stopped at ${where}: ${e.message}. Re-run with --continue-on-error to skip failing rows.`);
          }
        }
      }

      if (isJsonOutput(program)) return printJson({ results });
      formatOutput({ columns: ['row', 'status'], headers: ['Row', 'Status'], rows: results }, { format: program.opts().output });
      const ok = results.filter((r) => r.status === 'connected' || r.status === 'ok (dry-run)').length;
      printSuccess(`${ok}/${results.length} rows ${options.dryRun ? 'valid' : 'imported'}.`);
    });

  mail
    .command('disconnect')
    .description('Disconnect a mail account')
    .argument('<accountId>', 'account ID')
    .action(async (accountId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('inboxq.accounts.delete', { accountId });
      const data = await client.delete(ep.path, { service: ep.service });
      if (isJsonOutput(program)) return printJson(data);
      printSuccess(`Disconnected account ${accountId}.`);
    });

  // ── sync ─────────────────────────────────────────────────────────────

  mail
    .command('sync')
    .description('Sync a mail account now (fetch new messages, run triage)')
    .argument('<accountId>', 'account ID')
    .action(async (accountId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('inboxq.sync');
      // A first full-mailbox pull runs the whole IMAP fetch + classify in one
      // synchronous request and routinely exceeds the default 30s client timeout
      // (the sync still completes server-side, but the CLI showed a false
      // "timed out"). Give sync a generous 4-minute ceiling (nginx allows 300s).
      const data = await client.post(ep.path, { service: ep.service, body: { accountId }, timeout: 240000 });
      if (isJsonOutput(program)) return printJson(data);
      const summary = data.summary || {};
      const folders = summary.folders || [];
      if (folders.length === 0) {
        printSuccess(`Synced ${accountId}. No folders reported.`);
        return;
      }
      formatOutput({
        columns: ['folder', 'new', 'failed'],
        headers: ['Folder', 'New', 'Failed'],
        rows: folders,
      }, { format: program.opts().output });
      printSuccess(`Synced ${accountId}. LLM calls: ${summary.llmCalls ?? 0}`);
    });

  // ── messages ─────────────────────────────────────────────────────────

  mail
    .command('list')
    .description('List triaged messages')
    .option('--account <id>', 'filter by account ID')
    .option('--zone <zone>', 'filter by zone: focus, fyi, auto, screened')
    .option('--limit <n>', 'max results', '50')
    .option('--offset <n>', 'result offset', '0')
    .action(async (options) => {
      auth.requireAuth();
      if (options.zone && !VALID_ZONES.includes(options.zone)) {
        throw new Error(`invalid --zone "${options.zone}" (expected one of ${VALID_ZONES.join(', ')})`);
      }
      const query = { limit: options.limit, offset: options.offset };
      if (options.account) query.accountId = options.account;
      if (options.zone) query.zone = options.zone;
      const ep = resolveEndpoint('inboxq.messages.list');
      const data = await client.get(ep.path, { service: ep.service, query });
      if (isJsonOutput(program)) return printJson(data);
      formatOutput({
        columns: ['from', 'subject', 'zone', 'flags'],
        headers: ['From', 'Subject', 'Zone', 'Flags'],
        rows: data.messages || [],
      }, { format: program.opts().output });
    });

  // ── zones ────────────────────────────────────────────────────────────

  mail
    .command('zones')
    .description('Show zone counts (focus, fyi, auto, screened)')
    .option('--account <id>', 'filter by account ID')
    .action(async (options) => {
      auth.requireAuth();
      const query = {};
      if (options.account) query.accountId = options.account;
      const ep = resolveEndpoint('inboxq.zones.get');
      const data = await client.get(ep.path, { service: ep.service, query });
      if (isJsonOutput(program)) return printJson(data);
      formatDetail(data.zones || {}, { format: program.opts().output, title: 'InboxQ Zones' });
    });

  // ── report ───────────────────────────────────────────────────────────

  mail
    .command('report')
    .description('Show the latest triage report, or generate a fresh one')
    .argument('<accountId>', 'account ID')
    .option('--generate', 'generate a new report instead of reading the latest')
    .action(async (accountId, options) => {
      auth.requireAuth();
      let data;
      if (options.generate) {
        const ep = resolveEndpoint('inboxq.report.generate');
        data = await client.post(ep.path, { service: ep.service, body: { accountId } });
      } else {
        const ep = resolveEndpoint('inboxq.report.latest');
        data = await client.get(ep.path, { service: ep.service, query: { accountId } });
      }
      if (isJsonOutput(program)) return printJson(data);
      const report = data.report;
      if (!report) {
        console.log('No report available yet. Use --generate to create one.');
        return;
      }
      console.log(report.bodyMd || '(empty report)');
    });

  // ── watches ──────────────────────────────────────────────────────────

  const watch = mail
    .command('watch')
    .description('Manage standing watches (label + match rules)');

  watch
    .command('list')
    .description('List watches')
    .option('--active-only', 'only show active watches')
    .action(async (options) => {
      auth.requireAuth();
      const query = {};
      if (options.activeOnly) query.activeOnly = 1;
      const ep = resolveEndpoint('inboxq.watches.list');
      const data = await client.get(ep.path, { service: ep.service, query });
      if (isJsonOutput(program)) return printJson(data);
      formatOutput({
        columns: ['id', 'label', 'accountId', 'active'],
        headers: ['ID', 'Label', 'Account', 'Active'],
        rows: data.watches || [],
      }, { format: program.opts().output });
    });

  watch
    .command('add')
    .description('Add a watch')
    .requiredOption('--label <label>', 'watch label')
    .requiredOption('--match <json>', 'match rule as a JSON object')
    .option('--account <id>', 'restrict the watch to one account')
    .action(async (options) => {
      auth.requireAuth();
      const match = parseJSON(options.match, '--match');
      const body = { label: options.label, match };
      if (options.account) body.accountId = options.account;
      const ep = resolveEndpoint('inboxq.watches.create');
      const data = await client.post(ep.path, { service: ep.service, body });
      if (isJsonOutput(program)) return printJson(data);
      const created = data.watch || data;
      printSuccess(`Added watch "${options.label}" (${created.id})`);
    });

  watch
    .command('active')
    .description('Enable or disable a watch')
    .argument('<watchId>', 'watch ID')
    .requiredOption('--set <bool>', 'true or false')
    .action(async (watchId, options) => {
      auth.requireAuth();
      const active = String(options.set).toLowerCase() === 'true';
      const ep = resolveEndpoint('inboxq.watches.active', { watchId });
      const data = await client.post(ep.path, { service: ep.service, body: { active } });
      if (isJsonOutput(program)) return printJson(data);
      printSuccess(`Watch ${watchId} is now ${active ? 'active' : 'inactive'}.`);
    });

  // ── proposals ────────────────────────────────────────────────────────

  mail
    .command('propose')
    .description('Create a proposal (file, block or draft) for an account')
    .requiredOption('--account <id>', 'account ID')
    .requiredOption('--kind <kind>', 'proposal kind: file, block, draft')
    .requiredOption('--payload <json>', 'proposal payload as a JSON object')
    .action(async (options) => {
      auth.requireAuth();
      if (!VALID_KINDS.includes(options.kind)) {
        throw new Error(`invalid --kind "${options.kind}" (expected one of ${VALID_KINDS.join(', ')})`);
      }
      const payload = parseJSON(options.payload, '--payload');
      const body = { accountId: options.account, kind: options.kind, payload };
      const ep = resolveEndpoint('inboxq.proposals.create');
      const data = await client.post(ep.path, { service: ep.service, body });
      if (isJsonOutput(program)) return printJson(data);
      const proposal = data.proposal || data;
      printSuccess(`Created ${options.kind} proposal ${proposal.id} for account ${options.account}`);
    });

  mail
    .command('proposals')
    .description('List proposals')
    .option('--status <status>', 'filter by status')
    .option('--account <id>', 'filter by account ID')
    .action(async (options) => {
      auth.requireAuth();
      const query = {};
      if (options.status) query.status = options.status;
      if (options.account) query.accountId = options.account;
      const ep = resolveEndpoint('inboxq.proposals.list');
      const data = await client.get(ep.path, { service: ep.service, query });
      if (isJsonOutput(program)) return printJson(data);
      formatOutput({
        columns: ['id', 'kind', 'accountId', 'status', 'createdAt'],
        headers: ['ID', 'Kind', 'Account', 'Status', 'Created'],
        rows: data.proposals || [],
      }, { format: program.opts().output });
    });

  mail
    .command('resolve')
    .description('Approve or deny a proposal')
    .argument('<proposalId>', 'proposal ID')
    .requiredOption('--decision <decision>', 'approve or deny')
    .action(async (proposalId, options) => {
      auth.requireAuth();
      if (!VALID_DECISIONS.includes(options.decision)) {
        throw new Error(`invalid --decision "${options.decision}" (expected approve or deny)`);
      }
      const ep = resolveEndpoint('inboxq.proposals.resolve', { proposalId });
      const data = await client.post(ep.path, { service: ep.service, body: { decision: options.decision } });
      if (isJsonOutput(program)) return printJson(data);
      printSuccess(`Proposal ${proposalId} ${options.decision}d.`);
    });

  // ── moves (AQ-9E U2: reversible moves) ─────────────────────────────────

  mail
    .command('moves')
    .description('List recent undoable moves (most recent first)')
    .option('--account <id>', 'filter by account ID')
    .option('--limit <n>', 'max results', '20')
    .action(async (options) => {
      auth.requireAuth();
      const query = { limit: options.limit };
      if (options.account) query.accountId = options.account;
      const ep = resolveEndpoint('inboxq.moves.recent');
      const data = await client.get(ep.path, { service: ep.service, query });
      if (isJsonOutput(program)) return printJson(data);
      formatOutput({
        columns: ['id', 'fromFolder', 'toFolder', 'kind'],
        headers: ['Move ID', 'From', 'To', 'Kind'],
        rows: data.moves || [],
      }, { format: program.opts().output });
    });

  mail
    .command('undo')
    .description('Undo a recorded move: reverse the IMAP move back to its source folder')
    .argument('<moveId>', 'move ID (from `quox mail moves`)')
    .action(async (moveId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('inboxq.moves.undo');
      const data = await client.post(ep.path, { service: ep.service, body: { moveId } });
      if (isJsonOutput(program)) return printJson(data);
      printSuccess(`Move ${moveId} undone; message restored to ${data.restoredTo || 'its source folder'}.`);
    });
}
