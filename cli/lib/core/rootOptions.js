/**
 * The root `quox` program's global options, in one place so the binary
 * (bin/quox.js) and the safety-flag test (test/safetyFlagsReachLeaf.test.js)
 * build the SAME root. A test that re-typed this list would pass against a
 * root the binary does not have.
 */
import { mergeShadowedGlobals, assertDryRunHonoured } from './global-flags.js';

export function applyRootOptions(program) {
  return program
    .option('-o, --output <format>', 'output format: table, json, csv, quiet', 'table')
    .option('--json', 'shorthand for --output json')
    .option('-q, --quiet', 'suppress output, show IDs only')
    .option('--org <slug|id>', 'override active organization (slug, name or ID; must match your session org)')
    .option('-p, --profile <name>', 'use a specific config profile')
    .option('--no-color', 'disable colored output')
    .option('-v, --verbose', 'show detailed output')
    .option('--debug', 'show HTTP request/response details')
    .option('--dry-run', 'show what would happen without executing')
    .option('-y, --yes', 'skip confirmation prompts')
    .option('--insecure', 'allow self-signed SSL certificates');
}

/**
 * The flag-delivery hooks every invocation needs, in order:
 *  1. a value typed on the root or on a parent group reaches the leaf that
 *     declared the same option (commander binds it to the first command that
 *     knows it, so the leaf would otherwise read undefined or its default);
 *  2. a --dry-run the leaf cannot honour is refused before anything runs.
 */
export function installFlagDeliveryHooks(program) {
  program.hook('preAction', (thisCommand, actionCommand) => {
    mergeShadowedGlobals(thisCommand, actionCommand);
  });
  program.hook('preAction', (thisCommand, actionCommand) => {
    assertDryRunHonoured(thisCommand, actionCommand);
  });
  return program;
}
