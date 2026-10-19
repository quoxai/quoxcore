/**
 * quox peek <id>
 *
 * Look up an id without knowing what it is: an AEE envelope, inbox (approval) item, objective, workflow
 * run, WARD receipt or agent. The id's shape picks what to ask; every lookup is an existing read
 * endpoint; a miss names each kind tried and what it answered. The TUI's /peek prints the same card.
 */
import { createPeekFetchers, peekId, peekLines } from '../core/peek.js';
import { resolveOrgId } from './helpers.js';

export function registerPeekCommand(program, ctx) {
  const { client, auth } = ctx;
  program
    .command('peek')
    .description('Look up an envelope, inbox item, objective, run, WARD receipt or agent by id (read only)')
    .argument('<id>', 'the id, e.g. a ULID, a WARD entry UUID or an agent name')
    .action(async (id) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const r = await peekId(id, createPeekFetchers({ client, orgId: () => orgId }));
      if (program.opts().output === 'json') {
        console.log(JSON.stringify({ id: r.id, shape: r.shape, kind: r.hit?.kind || null, data: r.hit?.data || null, also: r.also, tried: r.tried }, null, 2));
      } else {
        for (const l of peekLines(r)) console.log(l.text);
      }
      if (!r.hit) process.exitCode = 5; // not found (the inbox verbs use 5 for not_found too)
    });
}
