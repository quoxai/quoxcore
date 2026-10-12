/**
 * Powers commands: MCP endpoint + hosted-repo tool deploys (LIFECYCLE-P1..P3)
 *
 * quox powers detect|deploy|deploy-repo|status|finalize|update|archive|restore|config|delete
 *
 * Backend: services/auth/routes/powers.js, mounted org-scoped at
 * `/api/orgs/:orgId/powers/...`. Two deploy flows:
 *   - `deploy` (mcp_endpoint): probes a live MCP URL and registers it as a
 *     governed agent in one call. Requires `persona` (agent_id + name) upfront.
 *   - `deploy-repo` (mcp_hosted): kicks off an async container build from a
 *     GitHub repo (202 Accepted). Poll `status` until the build reaches a
 *     terminal state (`built`/`failed`), then call `finalize` (persona
 *     required there, NOT at deploy-repo time) to activate the agent.
 */

import { formatDetail, printSuccess, printWarning, printInfo } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

const TERMINAL_BUILD_STATES = new Set(['built', 'failed']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Commander collector for repeatable --env key=value flags -> [{ key, value }]. */
function collectEnvVar(input, previous) {
  const idx = input.indexOf('=');
  if (idx === -1) {
    throw new Error(`Invalid --env value "${input}". Expected key=value.`);
  }
  const key = input.slice(0, idx).trim();
  const value = input.slice(idx + 1);
  if (!key) {
    throw new Error(`Invalid --env value "${input}". Key cannot be empty.`);
  }
  return [...previous, { key, value }];
}

function buildPersona(options, { requireCore = false } = {}) {
  const persona = {};
  if (options.agentId) persona.agent_id = options.agentId;
  if (options.name) persona.name = options.name;
  if (options.description !== undefined) persona.description = options.description;
  if (options.icon) persona.icon = options.icon;
  if (options.systemPromptAdditions) persona.system_prompt_additions = options.systemPromptAdditions;
  if (requireCore && (!persona.agent_id || !persona.name)) {
    throw new Error('--agent-id and --name are required.');
  }
  return persona;
}

async function confirmOrSkip(message) {
  const { default: inquirer } = await import('inquirer');
  const ans = await inquirer.prompt([{ type: 'confirm', name: 'confirm', message, default: false }]);
  return ans.confirm;
}

export function registerPowersCommands(program, ctx) {
  const { client, auth } = ctx;

  const powers = program
    .command('powers')
    .description('Deploy and manage POWERS (MCP endpoint / hosted-repo tools)');

  // ── powers detect ───────────────────────────────────────────────────────────

  powers
    .command('detect')
    .description('Probe an MCP URL to see what kind of server it is and what tools it exposes')
    .requiredOption('--url <url>', 'MCP server URL')
    .option('--auth-kind <kind>', 'none|bearer|header', 'none')
    .option('--auth-value <value>', 'auth token/header value (required if --auth-kind is bearer or header)')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { url: options.url, authKind: options.authKind };
      if (options.authValue) body.authValue = options.authValue;
      const ep = resolveEndpoint('powers.detect', { orgId });
      const data = await client.post(ep.path, { service: ep.service, body });
      formatDetail(data, { format: program.opts().output, title: 'Detection Result' });
    });

  // ── powers deploy (mcp_endpoint) ────────────────────────────────────────────

  powers
    .command('deploy')
    .description('Deploy a live MCP endpoint as a governed agent (one-shot, no build)')
    .requiredOption('--url <url>', 'MCP server URL')
    .option('--auth-kind <kind>', 'none|bearer|header', 'none')
    .option('--auth-value <value>', 'auth token/header value')
    .requiredOption('--agent-id <id>', 'new agent id (lowercase letters/numbers/underscores, starts with a letter)')
    .requiredOption('--name <name>', 'agent display name')
    .option('--description <text>', 'agent description')
    .option('--icon <icon>', 'agent icon')
    .option('--system-prompt-additions <text>', 'extra system prompt text for the agent')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = {
        url: options.url,
        authKind: options.authKind,
        persona: buildPersona(options, { requireCore: true }),
      };
      if (options.authValue) body.authValue = options.authValue;
      const ep = resolveEndpoint('powers.deploy', { orgId });
      const data = await client.post(ep.path, { service: ep.service, body });
      printSuccess(`Power deployed: agent "${data.agent_id}" (tool ${data.tool_id}).`);
      formatDetail(data, { format: program.opts().output });
    });

  // ── powers deploy-repo (mcp_hosted) ─────────────────────────────────────────

  powers
    .command('deploy-repo')
    .description('Deploy a public GitHub repo as a hosted MCP power (builds a container; async)')
    .requiredOption('--repo-url <url>', 'public GitHub repo URL, e.g. https://github.com/owner/repo')
    .option('--env <key=value>', 'env var to inject into the build (repeatable)', collectEnvVar, [])
    .option('--agent-id <id>', 'reserve an agent id upfront (optional — can also be set at finalize)')
    .option('--force-suffix <suffix>', 'suffix to allow deploying the same repo again as a duplicate')
    .option('--no-poll', 'return immediately after kicking off the build instead of polling status')
    .option('--poll-interval <ms>', 'polling interval in ms', '3000')
    .option('--poll-timeout <ms>', 'max time to poll before giving up, in ms', '300000')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      const body = { repo_url: options.repoUrl, env_vars: options.env };
      if (options.agentId) body.persona = { agent_id: options.agentId };
      if (options.forceSuffix) body.force_suffix = options.forceSuffix;

      const deployEp = resolveEndpoint('powers.deploy-repo', { orgId });
      const data = await client.post(deployEp.path, { service: deployEp.service, body });
      printSuccess(`Build started: tool_def_id=${data.tool_def_id} (${data.tool_id}), build_state=${data.build_state}.`);

      if (options.poll === false) {
        formatDetail(data, { format: program.opts().output });
        printInfo(`Poll with: quox powers status ${data.tool_def_id}`);
        return;
      }

      const toolDefId = data.tool_def_id;
      const pollInterval = Number(options.pollInterval);
      const pollTimeout = Number(options.pollTimeout);
      const statusEp = resolveEndpoint('powers.deploy-repo.status', { orgId, toolDefId });
      const start = Date.now();
      let status = { build_state: data.build_state };

      while (!TERMINAL_BUILD_STATES.has(status.build_state) && (Date.now() - start) < pollTimeout) {
        await sleep(pollInterval);
        status = await client.get(statusEp.path, { service: statusEp.service });
        printInfo(`build_state=${status.build_state}`);
      }

      formatDetail(status, { format: program.opts().output, title: 'Build Status' });

      if (status.build_state === 'built') {
        printSuccess(`Build complete. Run: quox powers finalize ${toolDefId} --agent-id <id> --name <name>`);
      } else if (status.build_state === 'failed') {
        printWarning(`Build failed: ${status.build_failed_reason || 'unknown reason'}`);
      } else {
        printWarning(`Polling timed out before the build reached a terminal state. Check later: quox powers status ${toolDefId}`);
      }
    });

  // ── powers status ───────────────────────────────────────────────────────────

  powers
    .command('status')
    .description('Check a hosted-repo power\'s build status')
    .argument('<toolDefId>', 'tool definition ID')
    .action(async (toolDefId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('powers.deploy-repo.status', { orgId, toolDefId });
      const data = await client.get(ep.path, { service: ep.service });
      formatDetail(data, { format: program.opts().output, title: 'Build Status' });
    });

  // ── powers finalize ─────────────────────────────────────────────────────────

  powers
    .command('finalize')
    .description('Activate the agent for a completed hosted-repo build')
    .argument('<toolDefId>', 'tool definition ID')
    .requiredOption('--agent-id <id>', 'new agent id (lowercase letters/numbers/underscores, starts with a letter)')
    .requiredOption('--name <name>', 'agent display name')
    .option('--description <text>', 'agent description')
    .option('--icon <icon>', 'agent icon')
    .option('--system-prompt-additions <text>', 'extra system prompt text for the agent')
    .action(async (toolDefId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { persona: buildPersona(options, { requireCore: true }) };
      const ep = resolveEndpoint('powers.deploy-repo.finalize', { orgId, toolDefId });
      const data = await client.post(ep.path, { service: ep.service, body });
      printSuccess(`Power finalized: agent "${data.agent_id}" (tool ${data.tool_id}).`);
      formatDetail(data, { format: program.opts().output });
    });

  // ── powers update (redeploy at a new ref) ──────────────────────────────────

  powers
    .command('update')
    .description('Redeploy a hosted-repo power at a new git ref (branch/tag/commit)')
    .argument('<toolDefId>', 'tool definition ID')
    .requiredOption('--repo-ref <ref>', 'git ref to build, e.g. HEAD or a commit SHA')
    .action(async (toolDefId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('powers.deploy-repo.update', { orgId, toolDefId });
      const data = await client.post(ep.path, { service: ep.service, body: { repo_ref: options.repoRef } });
      printSuccess(`Update build started for ${toolDefId} at ref "${data.repo_ref}" (build_state=${data.build_state}).`);
      formatDetail(data, { format: program.opts().output });
    });

  // ── powers archive / restore ────────────────────────────────────────────────

  powers
    .command('archive')
    .description('Archive a hosted-repo power (disables it without deleting any rows)')
    .argument('<toolDefId>', 'tool definition ID')
    .action(async (toolDefId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('powers.deploy-repo.archive', { orgId, toolDefId });
      const data = await client.post(ep.path, { service: ep.service });
      printSuccess('Power archived.');
      formatDetail(data, { format: program.opts().output });
    });

  powers
    .command('restore')
    .description('Restore a previously archived hosted-repo power')
    .argument('<toolDefId>', 'tool definition ID')
    .action(async (toolDefId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('powers.deploy-repo.restore', { orgId, toolDefId });
      const data = await client.post(ep.path, { service: ep.service });
      printSuccess('Power restored.');
      formatDetail(data, { format: program.opts().output });
    });

  // ── powers config ───────────────────────────────────────────────────────────

  powers
    .command('config')
    .description('Update env vars and/or agent persona for a hosted-repo power without rebuilding')
    .argument('<toolDefId>', 'tool definition ID')
    .option('--env <key=value>', 'env var to set/rotate (repeatable)', collectEnvVar, [])
    .option('--name <name>', 'new agent display name')
    .option('--description <text>', 'new agent description')
    .option('--icon <icon>', 'new agent icon')
    .option('--system-prompt-additions <text>', 'new system prompt additions')
    .action(async (toolDefId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      const body = {};
      if (options.env && options.env.length > 0) body.env_vars = options.env;
      const persona = buildPersona(options);
      if (Object.keys(persona).length > 0) body.persona = persona;

      if (!body.env_vars && !body.persona) {
        throw new Error('Specify at least one of --env or a persona field (--name/--description/--icon/--system-prompt-additions).');
      }

      const ep = resolveEndpoint('powers.deploy-repo.config', { orgId, toolDefId });
      const data = await client.patch(ep.path, { service: ep.service, body });
      printSuccess('Power config updated.');
      formatDetail(data, { format: program.opts().output });
    });

  // ── powers delete ───────────────────────────────────────────────────────────

  powers
    .command('delete')
    .description('Permanently destroy a hosted-repo power (revokes agent, deletes credentials)')
    .argument('<toolDefId>', 'tool definition ID')
    .option('--force', 'skip confirmation')
    .action(async (toolDefId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      if (!options.force && !program.opts().yes) {
        const ok = await confirmOrSkip(`Permanently destroy power ${toolDefId}? This retires its agent and deletes its credentials. This cannot be undone.`);
        if (!ok) { printInfo('Cancelled.'); return; }
      }

      const ep = resolveEndpoint('powers.deploy-repo.delete', { orgId, toolDefId });
      const data = await client.delete(ep.path, { service: ep.service, query: { confirm: 'true' } });
      printSuccess('Power deleted.');
      formatDetail(data, { format: program.opts().output });
    });
}
