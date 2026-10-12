/**
 * Prompt commands: user-owned prompts library (CRUD + versions + import/export)
 *
 * quox prompt list|get|create|update|delete|versions|restore|export|import
 *
 * Backend: services/auth/routes/prompts.js, mounted at plain `/api/prompts`
 * (NOT org-scoped in the URL — server.js:726). Every operation still requires
 * an org_id: GETs take it as a query param, writes take it as a body field.
 */

import { readFileSync } from 'node:fs';
import { formatOutput, formatDetail, printSuccess, printWarning, printInfo } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { confirmDestructive } from '../core/confirm.js';

/** Parse a stored JSON-string field (tags/variables/deploy_targets) back to an array/object. */
function parseJsonField(value) {
  if (Array.isArray(value) || (value !== null && typeof value === 'object')) return value;
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Format a created_at/updated_at value for display. The value may be an
 * epoch-millis number, an all-digits epoch-millis string, or an ISO string,
 * depending on the path it came through. Falsy values pass through as-is
 * rather than rendering "Invalid Date".
 */
function formatTimestamp(value) {
  if (!value) return value;
  const isEpochMillis = (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && /^\d+$/.test(value));
  const date = isEpochMillis ? new Date(Number(value)) : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/**
 * Extract `{{identifier}}` template variables from prompt body text, in
 * order of first appearance, deduped. Conservative identifier pattern
 * (`[A-Za-z_][A-Za-z0-9_]*`) so arbitrary template expressions (helpers,
 * filters, nested paths) aren't misparsed as variable names.
 */
function extractVariables(body) {
  if (typeof body !== 'string' || body === '') return [];
  const seen = new Set();
  const variables = [];
  const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      variables.push(match[1]);
    }
  }
  return variables;
}

function normalizePrompt(p) {
  if (!p) return p;
  return {
    ...p,
    tags: parseJsonField(p.tags),
    variables: parseJsonField(p.variables),
    deploy_targets: parseJsonField(p.deploy_targets),
    created_at: formatTimestamp(p.created_at),
    updated_at: formatTimestamp(p.updated_at),
  };
}

/** Resolve prompt content from --content or --file. Throws if neither given. */
function resolveContent(options) {
  if (options.file) {
    return readFileSync(options.file, 'utf-8');
  }
  if (options.content !== undefined) {
    return options.content;
  }
  return undefined;
}

export function registerPromptCommands(program, ctx) {
  const { client, auth } = ctx;

  const prompt = program
    .command('prompt')
    .description('Manage the user-owned prompts library');

  // ── prompt list ─────────────────────────────────────────────────────────────

  prompt
    .command('list')
    .description('List prompts (own + org-visible)')
    .option('--search <text>', 'substring search on name/body')
    .option('--tags <tags>', 'comma-separated tag filter (match any)')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const query = { org_id: orgId };
      if (options.search) query.q = options.search;
      if (options.tags) query.tags = options.tags;

      const data = await client.get(resolveEndpoint('prompts.list').path, {
        service: resolveEndpoint('prompts.list').service,
        query,
      });
      const prompts = (data.prompts || data || []).map(normalizePrompt);

      formatOutput({
        columns: ['id', 'name', 'category', 'visibility', 'tags', 'updated_at'],
        headers: ['ID', 'Name', 'Category', 'Visibility', 'Tags', 'Updated'],
        rows: prompts.map(p => ({
          ...p,
          tags: Array.isArray(p.tags) ? p.tags.join(', ') : p.tags,
        })),
      }, { format: program.opts().output, emptyMessage: 'No prompts found.' });
    });

  // ── prompt get ──────────────────────────────────────────────────────────────

  prompt
    .command('get')
    .description('Show prompt details')
    .argument('<id>', 'prompt ID')
    .action(async (id) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('prompts.get', { id }).path, {
        service: resolveEndpoint('prompts.get', { id }).service,
        query: { org_id: orgId },
      });
      const p = normalizePrompt(data.prompt || data);

      formatDetail(p, {
        format: program.opts().output,
        title: `Prompt: ${p.name || id}`,
        fields: ['id', 'name', 'description', 'category', 'visibility', 'tags', 'body', 'variables', 'deploy_targets', 'created_at', 'updated_at'],
        labels: {
          id: 'ID', name: 'Name', description: 'Description', category: 'Category',
          visibility: 'Visibility', tags: 'Tags', body: 'Body', variables: 'Variables',
          deploy_targets: 'Deploy Targets', created_at: 'Created', updated_at: 'Updated',
        },
      });
    });

  // ── prompt create ───────────────────────────────────────────────────────────

  prompt
    .command('create')
    .description('Create a prompt')
    .requiredOption('--name <name>', 'prompt name')
    .option('--content <text>', 'prompt body text')
    .option('--file <path>', 'read prompt body from a file (overrides --content)')
    .option('--description <text>', 'description')
    .option('--tags <tags>', 'comma-separated tags')
    .option('--category <category>', 'category')
    .option('--visibility <vis>', 'private|org', 'private')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      const body = resolveContent(options);
      if (body === undefined || body.trim() === '') {
        throw new Error('Prompt content is required. Use --content <text> or --file <path>.');
      }

      const payload = { org_id: orgId, name: options.name, body };
      if (options.description) payload.description = options.description;
      if (options.tags) payload.tags = options.tags.split(',').map(t => t.trim()).filter(Boolean);
      if (options.category) payload.category = options.category;
      if (options.visibility) payload.visibility = options.visibility;
      // fleet #398: nothing extracted {{var}} tokens from the body, so
      // `variables` was always stored as []. Only fill it in when the
      // caller didn't explicitly pass one, and only when the body actually
      // contains variables (keeps the payload identical to before for
      // variable-less prompts).
      const createdVariables = extractVariables(body);
      if (payload.variables === undefined && createdVariables.length > 0) payload.variables = createdVariables;

      const data = await client.post(resolveEndpoint('prompts.create').path, {
        service: resolveEndpoint('prompts.create').service,
        body: payload,
      });
      printSuccess(`Prompt "${options.name}" created.`);
      formatDetail(normalizePrompt(data.prompt || data), { format: program.opts().output });
    });

  // ── prompt update ───────────────────────────────────────────────────────────

  prompt
    .command('update')
    .description('Update a prompt (bumps version)')
    .argument('<id>', 'prompt ID')
    .option('--name <name>', 'new name')
    .option('--content <text>', 'new body text')
    .option('--file <path>', 'read new body from a file (overrides --content)')
    .option('--description <text>', 'new description')
    .option('--tags <tags>', 'new tags (comma-separated)')
    .option('--category <category>', 'new category')
    .option('--visibility <vis>', 'private|org')
    .action(async (id, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      const newBody = resolveContent(options);
      const payload = { org_id: orgId };
      if (options.name) payload.name = options.name;
      if (newBody !== undefined) payload.body = newBody;
      if (options.description !== undefined) payload.description = options.description;
      if (options.tags) payload.tags = options.tags.split(',').map(t => t.trim()).filter(Boolean);
      if (options.category) payload.category = options.category;
      if (options.visibility) payload.visibility = options.visibility;
      // Re-extract {{var}} tokens whenever the body changes, so stale
      // variables from the old body don't linger. Only when the caller
      // didn't explicitly pass one.
      if (newBody !== undefined && payload.variables === undefined) {
        payload.variables = extractVariables(newBody);
      }

      if (Object.keys(payload).length === 1) {
        throw new Error('Specify at least one field to update (--name, --content/--file, --description, --tags, --category, --visibility).');
      }

      const data = await client.patch(resolveEndpoint('prompts.update', { id }).path, {
        service: resolveEndpoint('prompts.update', { id }).service,
        body: payload,
      });
      printSuccess('Prompt updated.');
      formatDetail(normalizePrompt(data.prompt || data), { format: program.opts().output });
    });

  // ── prompt delete ───────────────────────────────────────────────────────────

  prompt
    .command('delete')
    .description('Delete a prompt (soft-delete)')
    .argument('<id>', 'prompt ID')
    .option('--force', 'skip confirmation')
    .action(async (id, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      const confirmed = await confirmDestructive(program, options, `Delete prompt ${id}? This cannot be undone.`);
      if (!confirmed) {
        printInfo('Cancelled.');
        return;
      }

      // NOTE: org_id MUST be sent in the body, not the query string. The
      // handler's `req.body || req.query` fallback (prompts.js:431) never
      // reaches req.query because express.json() leaves req.body as a
      // truthy `{}` even on a request with no JSON body.
      await client.delete(resolveEndpoint('prompts.delete', { id }).path, {
        service: resolveEndpoint('prompts.delete', { id }).service,
        body: { org_id: orgId },
      });
      printSuccess('Prompt deleted.');
    });

  // ── prompt versions ─────────────────────────────────────────────────────────

  prompt
    .command('versions')
    .description('Show version history for a prompt')
    .argument('<id>', 'prompt ID')
    .action(async (id) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('prompts.versions', { id }).path, {
        service: resolveEndpoint('prompts.versions', { id }).service,
        query: { org_id: orgId },
      });
      const versions = data.versions || data || [];

      formatOutput({
        columns: ['version', 'name', 'created_at', 'created_by'],
        headers: ['Version', 'Name', 'Created', 'By'],
        rows: versions,
      }, { format: program.opts().output, emptyMessage: 'No version history found.' });
    });

  // ── prompt restore ──────────────────────────────────────────────────────────

  prompt
    .command('restore')
    .description('Restore a prompt to a previous version')
    .argument('<id>', 'prompt ID')
    .argument('<version>', 'version number to restore')
    .action(async (id, version) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.post(resolveEndpoint('prompts.restore', { id, version }).path, {
        service: resolveEndpoint('prompts.restore', { id, version }).service,
        body: { org_id: orgId },
      });
      printSuccess(`Prompt restored from version ${version}.`);
      formatDetail(normalizePrompt(data.prompt || data), { format: program.opts().output });
    });

  // ── prompt export ───────────────────────────────────────────────────────────

  prompt
    .command('export')
    .description('Export all of the caller\'s prompts as JSON')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('prompts.export').path, {
        service: resolveEndpoint('prompts.export').service,
        query: { org_id: orgId },
      });
      console.log(JSON.stringify(data, null, 2));
    });

  // ── prompt import ───────────────────────────────────────────────────────────

  prompt
    .command('import')
    .description('Bulk-import prompts from a JSON file (as produced by `quox prompt export`)')
    .argument('<file>', 'path to a JSON file with an array of prompts or { prompts: [...] }')
    .action(async (file) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      let parsed;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf-8'));
      } catch (err) {
        throw new Error(`Could not read/parse ${file}: ${err.message}`);
      }
      const prompts = Array.isArray(parsed) ? parsed : (parsed.prompts || []);
      if (!Array.isArray(prompts) || prompts.length === 0) {
        throw new Error(`No prompts found in ${file}. Expected an array or { "prompts": [...] }.`);
      }

      const data = await client.post(resolveEndpoint('prompts.import').path, {
        service: resolveEndpoint('prompts.import').service,
        body: { org_id: orgId, prompts },
      });
      printSuccess(`Imported ${data.imported ?? 0} prompt(s).`);
      if ((data.imported ?? 0) < prompts.length) {
        printWarning(`${prompts.length - (data.imported ?? 0)} prompt(s) were skipped (missing name/body).`);
      }
    });
}
