/**
 * Integration commands — DEPRECATED alias of `quox vault`.
 *
 * VAULT-INTEG P6: this used to be a second, parallel implementation of
 * credential CRUD that could not actually supply secret field values (its
 * `create`/`update` sent a `config` body key the real route
 * (POST/PUT /orgs/:orgId/integrations) never reads — it expects
 * `credentials`). `quox vault` is the one working implementation; every
 * subcommand here just prints a one-line deprecation note to stderr and
 * forwards into the exact same action factories `quox vault` itself wires
 * up (see lib/commands/vault.js `make*Action` exports), so a script that
 * already calls `quox integration ...` keeps working (same HTTP calls, same
 * exit codes) without a second copy of the request/response handling to
 * drift out of sync.
 */

import {
  makeVaultListAction,
  makeVaultGetAction,
  makeVaultCreateAction,
  makeVaultUpdateAction,
  makeVaultDeleteAction,
  makeVaultTestAction,
} from './vault.js';

function warnDeprecated(subcommand, replacement) {
  console.error(`quox integration ${subcommand} is deprecated; use \`quox vault ${replacement}\` instead.`);
}

export function registerIntegrationCommands(program, ctx) {
  const integration = program
    .command('integration')
    .description('DEPRECATED: alias of `quox vault` — kept for existing scripts');

  integration
    .command('list')
    .description('DEPRECATED — alias of `quox vault list`')
    .option('--type <type>', 'filter by integration type')
    .option('--status <status>', 'filter by test status (success|failed|untested)')
    .action(async (options) => {
      warnDeprecated('list', 'list');
      return makeVaultListAction(ctx, program)(options);
    });

  integration
    .command('get')
    .description('DEPRECATED — alias of `quox vault get`')
    .argument('<integrationId>', 'integration ID')
    .action(async (integrationId) => {
      warnDeprecated('get', 'get');
      return makeVaultGetAction(ctx, program)(integrationId);
    });

  integration
    .command('create')
    .description('DEPRECATED — alias of `quox vault create`')
    .option('--type <type>', 'integration type (skip prompt)')
    .option('--label <label>', 'display label (skip prompt)')
    .option('--set-default', 'set as default for this type')
    .option('--no-test', 'skip connection test after creation')
    .option('--credentials-file <path>', 'JSON object of {field: value} for the credential fields (use 0600; supports "env:VAR_NAME" values)')
    .option('--credentials-stdin', 'read that same JSON object from stdin (never touches argv or disk)')
    .option('--metadata <json>', 'JSON object of non-secret metadata tags')
    .option('--repos <patterns>', 'repositories this credential covers: comma-separated owner/name, owner/*, or *')
    .option('--no-input', 'never prompt; fail with a clear error if a required field is missing')
    .action(async (options) => {
      warnDeprecated('create', 'create');
      return makeVaultCreateAction(ctx, program)(options);
    });

  integration
    .command('update')
    .description('DEPRECATED — alias of `quox vault update`')
    .argument('<integrationId>', 'integration ID')
    .option('--label <label>', 'new label')
    .option('--description <desc>', 'new description')
    .action(async (integrationId, options) => {
      warnDeprecated('update', 'update');
      return makeVaultUpdateAction(ctx, program)(integrationId, options);
    });

  integration
    .command('delete')
    .description('DEPRECATED — alias of `quox vault delete`')
    .argument('<integrationId>', 'integration ID')
    .option('--force', 'skip confirmation')
    .action(async (integrationId, options) => {
      warnDeprecated('delete', 'delete');
      return makeVaultDeleteAction(ctx, program)(integrationId, options);
    });

  integration
    .command('test')
    .description('DEPRECATED — alias of `quox vault test`')
    .argument('<integrationId>', 'integration ID')
    .action(async (integrationId) => {
      warnDeprecated('test', 'test');
      return makeVaultTestAction(ctx, program)(integrationId);
    });
}
