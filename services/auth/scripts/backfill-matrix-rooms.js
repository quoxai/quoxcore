/**
 * Backfill Matrix room ledger rows for every existing org-tree node.
 * M-ROOMS #191 Phase 1. Idempotent: safe to run repeatedly; a second run
 * creates nothing new. Rows stay 'pending' until the appservice provision
 * endpoint lands (matrixProvisioner.callAppserviceProvision is stubbed).
 *
 * Run inside the auth environment:
 *   node services/auth/scripts/backfill-matrix-rooms.js [orgId]
 */

import { backfillRooms } from '../lib/matrixProvisioner.js';

const orgId = process.argv[2] || undefined;

const result = await backfillRooms({ orgId });
console.log('backfillRooms result:', JSON.stringify(result, null, 2));
if (result.errors.length > 0) {
    process.exitCode = 1;
}
