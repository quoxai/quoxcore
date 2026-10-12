/**
 * REG-CORE post-deploy seed runner.
 *
 * Runs the full REG-CORE seeding sequence against production auth DB:
 *   1. seed-models.js       (5 models into model_definitions)
 *   2. seed-core-agents.js  (31 core agents with governance metadata)
 *
 * Idempotent — safe to re-run. Both sub-seeders use INSERT OR IGNORE.
 *
 * Run inside the auth container:
 *   docker exec quox-auth node /app/scripts/seed-reg-all.js
 * Or locally against the production DB:
 *   AUTH_DB_PATH=/var/lib/quox/auth.db node services/auth/scripts/seed-reg-all.js
 */

import { main as seedModels } from './seed-models.js';
import { main as seedCoreAgents } from './seed-core-agents.js';

async function run() {
  console.log('=== REG-CORE seed runner ===\n');
  console.log('[1/2] Seeding models...');
  seedModels();
  console.log('');
  console.log('[2/2] Seeding core agents...');
  await seedCoreAgents();
  console.log('\n=== REG-CORE seeding complete ===');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(err => { console.error(err); process.exit(1); });
}

export { run };
