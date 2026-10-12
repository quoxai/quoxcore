/**
 * LLM commands: provider status incl. degraded state and the failover target.
 *
 * quox llm status
 *
 * Backend: collector `GET /chat/status` (same endpoint as `quox chat-status`,
 * key 'chat.status.list'). This is the curated LLM view of it: it surfaces the
 * failover fields shipped with the LLM failover chain work (`degraded`,
 * `degraded_reason`, `degraded_until`, `fallback_hint`) and warns loudly when
 * the primary provider is in a failover cooldown. Routing policy itself lives
 * under `quox llm-policy`.
 */

import { formatDetail, printWarning } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerLlmCommands(program, ctx) {
  const { client } = ctx;

  const llm = program
    .command('llm')
    .description('LLM provider status and failover');

  llm
    .command('status')
    .description('Show LLM provider status, degraded state, and the failover target')
    .action(async () => {
      // No requireAuth: the route is public on collectors that allowlist it,
      // but the token is attached when logged in (the dev gate requires a JWT).
      const data = await client.get(resolveEndpoint('chat.status.list').path, { service: resolveEndpoint('chat.status.list').service });

      if (data.degraded) {
        const reason = data.degraded_reason ? ` (${data.degraded_reason})` : '';
        const fallback = data.fallback_hint
          ? ` Failing over to ${data.fallback_hint.provider}:${data.fallback_hint.model}.`
          : '';
        printWarning(`Primary provider degraded${reason}.${fallback}`);
      }

      formatDetail(data, {
        format: program.opts().output,
        title: 'LLM Status',
      });
    });
}
