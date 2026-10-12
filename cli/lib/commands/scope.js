/**
 * Scope commands
 *
 * quox scope list
 *
 * Scopes are read-only projections of the org/division/department/team
 * hierarchy — there is no backend write route for scopes. To create,
 * update, or delete a scope, use `quox org`, `quox division`,
 * `quox department`, or `quox team` instead.
 */

import { formatOutput } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerScopeCommands(program, ctx) {
  const { client, auth } = ctx;

  const scope = program
    .command('scope')
    .description('View scopes (read-only — use `quox org`/`quox division`/`quox team` to manage)');

  scope
    .command('list')
    .description('List scopes')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      // fleet #392: the route returns a nested {tree} unless flat=true is
      // sent, and it was never sent — so `data.scopes` was undefined,
      // `data` fell through as the object {tree: ...}, and `.map()` threw
      // TypeError. This command crashed rather than merely showing dashes.
      // Columns also renamed to the real ones (name_cache/scope_type);
      // `resources` has no counterpart at all, so `path` and `depth` are
      // shown instead of inventing a zero.
      const data = await client.get(resolveEndpoint('scopes.list', { orgId }).path, {
        service: resolveEndpoint('scopes.list', { orgId }).service,
        query: { flat: 'true' },
      });
      const scopes = Array.isArray(data.scopes) ? data.scopes : [];
      // fleet #399.3: `depth` is a scope-TYPE ordinal (services/auth/
      // migrations/000-baseline.sql: "0=org, 1=division, 2=department,
      // 3=team"), not a count of path segments below root. A team can
      // legitimately show Depth 3 while its `path` reads only two levels
      // deep. Header made self-explanatory rather than recomputing depth.
      formatOutput({
        columns: ['id', 'name', 'type', 'path', 'depth'],
        headers: ['ID', 'Name', 'Type', 'Path', 'Depth (0=org,1=div,2=dept,3=team)'],
        rows: scopes.map(s => ({
          id: s.id,
          name: s.name_cache,
          type: s.scope_type,
          path: s.path,
          depth: s.depth,
        })),
      }, { format: program.opts().output, emptyMessage: 'No scopes found.' });
    });
}
