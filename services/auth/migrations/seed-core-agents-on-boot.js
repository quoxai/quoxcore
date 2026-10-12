/**
 * Seed the built-in agent roster on a fresh install.
 *
 * WHY
 * ---
 * The core agents (CommanderQ, ARCHITECT, ARCHIVIST, HYPERION, CIPHER and the
 * rest) live in src/config/agentRegistry.js as a static object, and
 * scripts/seed-core-agents.js copies them into the agents table so the database
 * can answer "what agents exist?". Nothing ever RAN that script on a fresh
 * install, so the table was empty on any new instance: the public demo had 0
 * rows where the development box had 45.
 *
 * The visible effect is that every surface built on the roster is empty out of
 * the box. That includes the iOS chat picker, which reads
 * /api/agents/custom -> auth /internal/agents -> this table. "Out of the box"
 * silently meant org scope assistants only.
 *
 * This is the same shape as the missing org scope it was found alongside: a
 * bootstrap step that works on an instance which grew organically, and quietly
 * produces nothing on a new one. Both are fixed at boot rather than left for
 * someone to notice.
 *
 * BEHAVIOUR
 * ---------
 * Runs only when there are no core agents, so a normal boot does no work and
 * prints nothing. The underlying seeder is INSERT OR IGNORE and safe to repeat
 * regardless; the guard exists to keep boot quiet and cheap rather than for
 * correctness.
 *
 * Non-fatal by contract, matching the vault migrations either side of it. A
 * missing agent roster is a degraded instance; a service that refuses to boot
 * is a dead one.
 */

import { getDb } from '../db/index.js';

export async function seedCoreAgentsIfEmpty() {
    const db = getDb();

    let existing;
    try {
        existing = db.prepare('SELECT COUNT(*) AS n FROM agents WHERE is_core = 1').get();
    } catch {
        // The table or column may not exist yet on a partially migrated
        // install. That is not this function's problem to solve.
        return { seeded: false, reason: 'agents table not ready' };
    }

    if (existing?.n > 0) {
        return { seeded: false, reason: `${existing.n} core agents already present` };
    }

    console.log('[CoreAgents] No core agents found, seeding the built-in roster');
    const { main } = await import('../scripts/seed-core-agents.js');
    await main();

    const after = db.prepare('SELECT COUNT(*) AS n FROM agents WHERE is_core = 1').get();
    console.log(`[CoreAgents] Roster seeded: ${after?.n ?? 0} core agents`);
    return { seeded: true, count: after?.n ?? 0 };
}
