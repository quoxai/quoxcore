/**
 * LLM routing policy commands: view/set/dry-run-test the org's execution
 * policy (which providers/models agents are allowed to route to).
 *
 * quox llm-policy get|set|test
 *
 * Backend: services/auth/routes/llm-routing-policies.js, mounted at plain
 * `/api` (org-scoped in the URL): GET/PUT `/api/orgs/:orgId/llm-routing-policy`,
 * POST `/api/orgs/:orgId/llm-routing-policy/test`. See
 * cli/lib/api/endpoints/llm-policy.js for the full verified response shapes.
 */

import { readFileSync } from 'node:fs';
import { formatDetail, printSuccess, printWarning } from '../core/output.js';
import { resolveOrgId, parseJSON } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

/**
 * Resolve a policy object from --file or --policy. Throws if neither given
 * or the input isn't a JSON object.
 */
function resolvePolicy(options) {
  let raw;
  if (options.file) {
    try {
      raw = readFileSync(options.file, 'utf-8');
    } catch (err) {
      throw new Error(`Could not read ${options.file}: ${err.message}`);
    }
  } else if (options.policy !== undefined) {
    raw = options.policy;
  } else {
    throw new Error('Policy input is required. Use --file <path> or --policy <json>.');
  }

  const policy = parseJSON(raw, options.file ? '--file contents' : '--policy');
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('Policy must be a JSON object.');
  }
  return policy;
}

export function registerLlmPolicyCommands(program, ctx) {
  const { client, auth } = ctx;

  const llmPolicy = program
    .command('llm-policy')
    .description('View, set, and dry-run-validate the org LLM routing policy');

  // ── llm-policy get ──────────────────────────────────────────────────────────

  llmPolicy
    .command('get')
    .description('Show the effective LLM routing policy for the active org')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('llm-policy.get', { orgId }).path, {
        service: resolveEndpoint('llm-policy.get', { orgId }).service,
      });

      if (data.source === 'seed') {
        printWarning('No org-specific policy saved — showing the built-in seed policy.');
      }

      formatDetail(data.policy, {
        format: program.opts().output,
        title: `LLM Routing Policy (source: ${data.source})`,
      });
    });

  // ── llm-policy set ──────────────────────────────────────────────────────────

  llmPolicy
    .command('set')
    .description('Save a new LLM routing policy for the active org (requires ORG_MANAGE_SETTINGS)')
    .option('--file <path>', 'path to a JSON file containing the policy object')
    .option('--policy <json>', 'inline JSON policy object')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const policy = resolvePolicy(options);

      const data = await client.put(resolveEndpoint('llm-policy.set', { orgId }).path, {
        service: resolveEndpoint('llm-policy.set', { orgId }).service,
        body: { policy },
      });

      printSuccess('LLM routing policy saved.');
      formatDetail(data.policy, { format: program.opts().output });
    });

  // ── llm-policy test ─────────────────────────────────────────────────────────

  llmPolicy
    .command('test')
    .description('Dry-run validate a policy without saving it')
    .option('--file <path>', 'path to a JSON file containing the policy object')
    .option('--policy <json>', 'inline JSON policy object')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const policy = resolvePolicy(options);

      const data = await client.post(resolveEndpoint('llm-policy.test', { orgId }).path, {
        service: resolveEndpoint('llm-policy.test', { orgId }).service,
        body: { policy },
      });

      if (data.valid) {
        printSuccess('Policy is valid.');
      } else {
        printWarning(`Policy is invalid (${(data.errors || []).length} error(s)).`);
      }
      formatDetail(data, { format: program.opts().output });
    });
}
