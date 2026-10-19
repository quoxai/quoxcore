/**
 * Admin commands: config, keys, services, logs, stats, retention
 */

import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerAdminCommands(program, ctx) {
  const { client, auth } = ctx;

  const admin = program
    .command('admin')
    .description('Platform administration');

  // Config
  const cfg = admin
    .command('config')
    .description('Manage platform configuration');

  cfg
    .command('get')
    .description('Get platform config (all keys, or one key)')
    .argument('[key]', 'show only this key')
    .action(async (key) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('admin.config.list').path, { service: resolveEndpoint('admin.config.list').service });
      const config = data.config || data;
      if (key) {
        // quox#533: `get <key>` used to be rejected outright.
        // #1010: auth returns an ARRAY of { key, value, ... } rows; an object map is handled too.
        if (Array.isArray(config)) {
          const row = config.find((r) => r && r.key === key);
          if (!row) throw new Error(`config key "${key}" not found. Run \`quox admin config get\` to list all keys.`);
          formatDetail(row, { format: program.opts().output, title: 'Platform Config' });
          return;
        }
        if (!config || typeof config !== 'object' || !(key in config)) {
          throw new Error(`config key "${key}" not found. Run \`quox admin config get\` to list all keys.`);
        }
        formatDetail({ [key]: config[key] }, { format: program.opts().output, title: 'Platform Config' });
        return;
      }
      formatDetail(config, { format: program.opts().output, title: 'Platform Config' });
    });

  cfg
    .command('set')
    .description('Set a config value')
    .argument('<key>', 'config key')
    .argument('<value>', 'config value')
    .action(async (key, value) => {
      auth.requireAuth();
      await client.patch(resolveEndpoint('admin.config.update', { key }).path, { service: resolveEndpoint('admin.config.update', { key }).service, body: { value } });
      printSuccess(`Config ${key} updated.`);
    });

  // LICENSE-LAUNCH LL-6b: enforcement posture + break-glass. Parity with the
  // dashboard's Settings → Security → Enforcement panel. In production a
  // security gate switched off in the environment is enforced anyway unless an
  // unexpired break-glass record exists, so an operator needs to see and set
  // those records from the CLI too, not only from the browser.
  const enforcement = admin
    .command('enforcement')
    .description('Security enforcement posture and break-glass windows');

  enforcement
    .command('list')
    .description('Show every enforcement flag: what the environment asks for and what is actually enforced')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('admin.enforcement.list');
      const data = await client.get(ep.path, { service: ep.service });
      const rows = (data.flags || []).map((f) => ({
        key: f.key,
        env: f.env_enforced ? 'enforce' : 'off',
        effective: f.forced_on ? 'ENFORCED (forced)' : (f.enforced ? 'enforced' : 'off'),
        break_glass: f.break_glass ? `until ${f.break_glass.expires_at}` : '-',
        reason: f.break_glass ? f.break_glass.reason : '',
      }));
      formatOutput({
        columns: ['key', 'env', 'effective', 'break_glass', 'reason'],
        headers: ['Flag', 'Env', 'Effective', 'Break-glass', 'Reason'],
        rows,
      }, { format: program.opts().output });
    });

  enforcement
    .command('break-glass')
    .description('Open a bounded break-glass window so a gate may stay off in production')
    .argument('<flag>', 'enforcement flag, e.g. COLLECTOR_AUTH_ENFORCE')
    .requiredOption('--reason <reason>', 'why this gate has to be off (recorded against your account)')
    .option('--hours <hours>', 'window length in hours, 72 maximum', '4')
    .action(async (flag, opts) => {
      auth.requireAuth();
      const hours = Number(opts.hours);
      if (!Number.isFinite(hours) || hours <= 0) {
        throw new Error('--hours must be a positive number of hours (72 maximum)');
      }
      const ep = resolveEndpoint('admin.enforcement.break_glass.open');
      const data = await client.post(ep.path, {
        service: ep.service,
        body: {
          flag,
          reason: opts.reason,
          expires_at: new Date(Date.now() + hours * 3600_000).toISOString(),
        },
      });
      printSuccess(`Break-glass open for ${flag} until ${data.break_glass.expires_at}.`);
    });

  enforcement
    .command('clear')
    .description('Close a break-glass window early')
    .argument('<flag>', 'enforcement flag, e.g. COLLECTOR_AUTH_ENFORCE')
    .action(async (flag) => {
      auth.requireAuth();
      const ep = resolveEndpoint('admin.enforcement.break_glass.clear', { flag });
      const data = await client.delete(ep.path, { service: ep.service });
      printSuccess(data.cleared
        ? `Break-glass closed for ${flag}.`
        : `No break-glass window was open for ${flag}.`);
    });

  // QUOXPERTICUS P2: governed agent-identity mint (instance-admin only).
  const agentIdentity = admin
    .command('agent-identity')
    .description('Manage governed agent identities (agent-typed user + bound mcp token)');

  agentIdentity
    .command('mint')
    .description('Mint (or rotate) an agent identity; prints the raw token ONCE')
    .argument('<agentId>', 'agent id, e.g. quoxperticus')
    // NOT requiredOption: --org shadows the root program's global --org
    // <slug> (bin/quox.js). Commander's mandatory-option check runs BEFORE
    // the mergeShadowedGlobals preAction hook, so a requiredOption here
    // always fired "required option '--org' not specified" even when the
    // user supplied it (quox#457 sweep). Validated explicitly below instead.
    .option('--org <orgId>', 'org ULID the agent operates under')
    .option('--rotate', 'revoke the live token and issue a new one')
    .action(async (agentId, opts) => {
      auth.requireAuth();
      if (!opts.org || !String(opts.org).trim()) {
        throw new Error(
          'Missing --org <orgId>. Usage: quox admin agent-identity mint <agentId> --org <orgId>'
        );
      }
      const ep = resolveEndpoint('admin.agent_identity.mint');
      const data = await client.post(ep.path, {
        service: ep.service,
        body: { agent_id: agentId, org_id: opts.org, rotate: opts.rotate === true },
      });
      printSuccess(`Agent identity ${data.agent_id} ${data.rotated ? 'rotated' : 'minted'} (user ${data.user_id}).`);
      console.log('Raw token (shown ONCE, place it in the supervisor root-only env):');
      console.log(data.token);
    });

  // Email / SMTP (QCPRO-SMTP): instance email onboarding parity
  const email = admin
    .command('email')
    .description('Instance email delivery (SMTP)');

  email
    .command('status')
    .description('Show email delivery status (configured, from, last test)')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('admin.email.status');
      const data = await client.get(ep.path, { service: ep.service });
      formatDetail(data, { format: program.opts().output, title: 'Email Delivery' });
    });

  email
    .command('setup')
    .description('Configure instance SMTP (password encrypted at rest; omit --pass to keep the stored one)')
    .requiredOption('--host <host>', 'SMTP host')
    .option('--port <port>', 'SMTP port', '587')
    .option('--user <user>', 'SMTP username')
    .option('--pass <pass>', 'SMTP password')
    .requiredOption('--from <from>', 'From address, e.g. "QuoxCORE <noreply@acme.com>"')
    .option('--secure', 'Use TLS (direct TLS for 465, STARTTLS otherwise)', true)
    .option('--no-secure', 'Disable TLS')
    .action(async (opts) => {
      auth.requireAuth();
      const ep = resolveEndpoint('admin.email.smtp');
      await client.put(ep.path, {
        service: ep.service,
        body: {
          host: opts.host,
          port: Number(opts.port),
          user: opts.user || '',
          pass: opts.pass || '',
          from: opts.from,
          secure: !!opts.secure,
        },
      });
      printSuccess('SMTP configured. Run "quox admin email test" to verify delivery.');
    });

  email
    .command('test')
    .description('Send a test email and report the honest outcome')
    .option('--to <address>', 'Recipient (defaults to your account email)')
    .action(async (opts) => {
      auth.requireAuth();
      const ep = resolveEndpoint('admin.email.test');
      const result = await client.post(ep.path, { service: ep.service, body: opts.to ? { to: opts.to } : {} });
      if (result.delivered) {
        printSuccess(`Delivered (message id ${result.message_id || 'unknown'}).`);
      } else {
        console.error(`Not delivered: ${result.reason || 'unknown error'}`);
        process.exitCode = 1;
      }
    });

  // API Keys
  const keys = admin
    .command('key')
    .description('Manage API keys');

  keys
    .command('list')
    .description('List API keys')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('admin.keys.list').path, { service: resolveEndpoint('admin.keys.list').service });
      formatOutput({
        // fleet #392: api_keys has key_preview/last_used_at; prefix, role
        // and expires_at don't exist on this row at all.
        columns: ['id', 'name', 'key_preview', 'last_used_at', 'created_at'],
        headers: ['ID', 'Name', 'Preview', 'Last Used', 'Created'],
        rows: data.keys || data,
      }, { format: program.opts().output });
    });

  keys
    .command('create')
    .description('Create an API key')
    .requiredOption('--name <name>', 'key name')
    .option('--role <role>', 'key role', 'viewer')
    .option('--expires <date>', 'expiry date (ISO)')
    .action(async (options) => {
      auth.requireAuth();
      const body = { name: options.name, role: options.role };
      if (options.expires) body.expires_at = options.expires;
      const data = await client.post(resolveEndpoint('admin.keys.create').path, { service: resolveEndpoint('admin.keys.create').service, body });
      if (data.key || data.api_key) {
        const key = data.key || data.api_key;
        if (program.opts().output === 'json') {
          console.log(JSON.stringify({ key, id: data.id, name: data.name }));
        } else if (program.opts().output === 'quiet') {
          console.log(key);
        } else {
          console.log(`API Key: ${key}`);
          console.log('(Save this key now — it will not be shown again)');
        }
      } else {
        printSuccess('API key created.');
      }
    });

  keys
    .command('delete')
    .description('Delete an API key')
    .argument('<keyId>', 'key ID')
    .action(async (keyId) => {
      auth.requireAuth();
      await client.delete(resolveEndpoint('admin.keys.delete', { keyId }).path, { service: resolveEndpoint('admin.keys.delete', { keyId }).service });
      printSuccess('API key deleted.');
    });

  keys
    .command('test')
    .description('Test an API key')
    .argument('<keyId>', 'key ID')
    .action(async (keyId) => {
      auth.requireAuth();
      const data = await client.post(resolveEndpoint('admin.keys.test', { keyId }).path, { service: resolveEndpoint('admin.keys.test', { keyId }).service });
      printSuccess(data.valid ? 'API key is valid.' : 'API key test failed.');
    });

  // Services
  const services = admin
    .command('service')
    .description('Manage platform services');

  services
    .command('list')
    .description('List registered services')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('admin.services.list').path, { service: resolveEndpoint('admin.services.list').service });
      formatOutput({
        // fleet #392: services has health_endpoint/last_check_at, not
        // url/last_check.
        columns: ['id', 'name', 'status', 'health_endpoint', 'last_check_at'],
        headers: ['ID', 'Name', 'Status', 'Health URL', 'Last Check'],
        rows: data.services || data,
      }, { format: program.opts().output });
    });

  // Logs
  admin
    .command('logs')
    .description('View admin audit logs')
    .option('--action <action>', 'filter by action')
    .option('--limit <n>', 'max results', '50')
    .action(async (options) => {
      auth.requireAuth();
      const query = { limit: options.limit };
      if (options.action) query.action = options.action;
      const data = await client.get(resolveEndpoint('admin.logs.list').path, { service: resolveEndpoint('admin.logs.list').service, query });
      formatOutput({
        // fleet #392: system_logs has { created_at, service, level, message,
        // user_id } — none of timestamp/user_email/action/detail exist, so
        // all four columns were dashes.
        columns: ['created_at', 'service', 'level', 'message', 'user_id'],
        headers: ['Time', 'Service', 'Level', 'Message', 'User'],
        rows: data.logs || data.entries || data,
      }, { format: program.opts().output });
    });

  // Stats
  admin
    .command('stats')
    .description('Show platform statistics')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('admin.stats.list').path, { service: resolveEndpoint('admin.stats.list').service });
      formatDetail(data.stats || data, { format: program.opts().output, title: 'Platform Stats' });
    });

  // Retention
  const retention = admin
    .command('retention')
    .description('Manage data retention');

  retention
    .command('config')
    .description('View retention config')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('admin.retention.config.list').path, { service: resolveEndpoint('admin.retention.config.list').service });
      formatDetail(data.config || data, { format: program.opts().output, title: 'Retention Config' });
    });

  retention
    .command('cleanup')
    .description('Run retention cleanup')
    .option('--dry-run', 'preview without deleting')
    .action(async (options) => {
      auth.requireAuth();
      const body = {};
      if (options.dryRun) body.dry_run = true;
      const data = await client.post(resolveEndpoint('admin.retention.cleanup').path, { service: resolveEndpoint('admin.retention.cleanup').service, body });
      if (options.dryRun) {
        // quox#1084: servers before the fix ignored dry_run and deleted for real.
        // Never present an unconfirmed result as a harmless preview.
        if (!data || data.dry_run !== true) {
          throw new Error('the server did not honour --dry-run (it predates quox#1084): the cleanup may have run for real. Check `quox admin retention stats`.');
        }
        formatDetail(data, { format: program.opts().output, title: 'Cleanup preview (dry run): nothing deleted' });
        return;
      }
      formatDetail(data, { format: program.opts().output, title: 'Cleanup Result' });
    });

  retention
    .command('stats')
    .description('View retention statistics')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('admin.retention.stats.list').path, { service: resolveEndpoint('admin.retention.stats.list').service });
      formatDetail(data.stats || data, { format: program.opts().output, title: 'Retention Stats' });
    });
}
