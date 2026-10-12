/**
 * Quota Store — Memory Tiering Server-Side Enforcement
 *
 * Tracks per-user memory usage counts and tier status.
 * Used by server.js middleware to enforce limits on write operations.
 */

import { getDatabase } from './db.js';
import { syncQuotaTierFromOrgPlan } from './orgPlanTier.js';

// Tier limits (must match src/services/memoryTier.js TIER_LIMITS)
//
// 2026-09-21 memory-quota audit: the old free limits (10 learned / 3 prefs /
// 20 episodic / 50 entities) were crippling — every org/user defaults to 'free'
// and the promote path (POST /api/memory/quota/tier) was NEVER wired, so 100%
// of users were permanently capped at 10 learned items. That is why memory
// always underwhelmed. Raised to GENEROUS-but-bounded values (a ceiling is kept
// as a runaway/abuse guardrail, not as an upsell). 'enterprise' added so the
// org plan can map to it. Final numbers + whether free should be effectively
// unlimited (memory-as-core) is an owner decision (QuoxPlan #4098).
export const TIER_LIMITS = {
  free: {
    maxLearnedItems: 2000,
    maxPreferences: 200,
    maxEpisodicItems: 2000,
    maxEntities: 5000,
  },
  premium: {
    maxLearnedItems: Infinity,
    maxPreferences: Infinity,
    maxEpisodicItems: Infinity,
    maxEntities: Infinity,
  },
  enterprise: {
    maxLearnedItems: Infinity,
    maxPreferences: Infinity,
    maxEpisodicItems: Infinity,
    maxEntities: Infinity,
  }
};

// Memory types that count toward "learned" quota
const LEARNED_TYPES = ['fact', 'preference', 'decision', 'constraint'];
const PREFERENCE_TYPE = 'preference';

/**
 * Get or create quota record for a user.
 * On first call, scans existing data to bootstrap counts.
 */
export function getQuota(orgId, userId) {
  const db = getDatabase();

  let row = db.prepare(
    'SELECT * FROM memory_quotas WHERE org_id = ? AND user_id = ?'
  ).get(orgId, userId);

  if (!row) {
    // Bootstrap: count existing data
    const learned = db.prepare(
      `SELECT COUNT(*) as c FROM memories
       WHERE org_id = ? AND user_id = ? AND valid = 1
       AND memory_type IN ('fact','preference','decision','constraint')`
    ).get(orgId, userId);

    const prefs = db.prepare(
      `SELECT COUNT(*) as c FROM memories
       WHERE org_id = ? AND user_id = ? AND valid = 1
       AND memory_type = 'preference'`
    ).get(orgId, userId);

    const episodic = db.prepare(
      `SELECT COUNT(*) as c FROM conversation_summaries
       WHERE org_id = ? AND user_id = ?`
    ).get(orgId, userId);

    const entities = db.prepare(
      `SELECT COUNT(*) as c FROM entities
       WHERE org_id = ? AND user_id = ?`
    ).get(orgId, userId);

    // Use INSERT OR IGNORE to avoid race condition with concurrent requests
    db.prepare(`
      INSERT OR IGNORE INTO memory_quotas (org_id, user_id, tier, learned_count, preference_count, episodic_count, entity_count)
      VALUES (?, ?, 'free', ?, ?, ?, ?)
    `).run(orgId, userId, learned.c, prefs.c, episodic.c, entities.c);

    row = db.prepare(
      'SELECT * FROM memory_quotas WHERE org_id = ? AND user_id = ?'
    ).get(orgId, userId);
  }

  // Check if trial has expired
  if (row.tier === 'premium' && row.tier_source === 'trial' && row.tier_expires_at) {
    if (new Date(row.tier_expires_at) < new Date()) {
      db.prepare(`
        UPDATE memory_quotas SET tier = 'free', tier_source = 'expired_trial', updated_at = datetime('now')
        WHERE org_id = ? AND user_id = ?
      `).run(orgId, userId);
      row.tier = 'free';
      row.tier_source = 'expired_trial';
    }
  }

  // quox#571 part 2: keep tier in line with the org's plan (enterprise orgs
  // were silently living under free limits). Fire-and-forget by design: the
  // write path stays synchronous, the row converges on the next call.
  syncQuotaTierFromOrgPlan(db, orgId, userId, row).catch(() => {});

  return row;
}

/**
 * Check if a write operation is allowed under the user's tier.
 * Returns { allowed: true } or { allowed: false, reason, limit, current, upgrade }
 */
export function checkWriteAllowed(orgId, userId, memoryType) {
  const quota = getQuota(orgId, userId);
  const limits = TIER_LIMITS[quota.tier] || TIER_LIMITS.free;

  // Check learned items limit
  if (LEARNED_TYPES.includes(memoryType)) {
    if (quota.learned_count >= limits.maxLearnedItems) {
      return {
        allowed: false,
        reason: 'tier_limit',
        limitName: 'learned_items',
        limit: limits.maxLearnedItems,
        current: quota.learned_count,
        tier: quota.tier,
        upgrade: quota.tier === 'free',
      };
    }
  }

  // Check preference sub-limit
  if (memoryType === PREFERENCE_TYPE) {
    if (quota.preference_count >= limits.maxPreferences) {
      return {
        allowed: false,
        reason: 'tier_limit',
        limitName: 'preferences',
        limit: limits.maxPreferences,
        current: quota.preference_count,
        tier: quota.tier,
        upgrade: quota.tier === 'free',
      };
    }
  }

  return { allowed: true, tier: quota.tier };
}

/**
 * Check if entity creation is allowed.
 */
export function checkEntityAllowed(orgId, userId) {
  const quota = getQuota(orgId, userId);
  const limits = TIER_LIMITS[quota.tier] || TIER_LIMITS.free;

  if (quota.entity_count >= limits.maxEntities) {
    return {
      allowed: false,
      reason: 'tier_limit',
      limitName: 'entities',
      limit: limits.maxEntities,
      current: quota.entity_count,
      tier: quota.tier,
      upgrade: quota.tier === 'free',
    };
  }

  return { allowed: true, tier: quota.tier };
}

/**
 * Increment quota counters after a successful write.
 */
export function incrementQuota(orgId, userId, memoryType) {
  const db = getDatabase();

  if (LEARNED_TYPES.includes(memoryType)) {
    const fields = memoryType === PREFERENCE_TYPE
      ? 'learned_count = learned_count + 1, preference_count = preference_count + 1'
      : 'learned_count = learned_count + 1';

    db.prepare(`
      UPDATE memory_quotas SET ${fields}, updated_at = datetime('now')
      WHERE org_id = ? AND user_id = ?
    `).run(orgId, userId);
  }
}

/**
 * Increment entity quota counter.
 */
export function incrementEntityQuota(orgId, userId) {
  const db = getDatabase();
  db.prepare(`
    UPDATE memory_quotas SET entity_count = entity_count + 1, updated_at = datetime('now')
    WHERE org_id = ? AND user_id = ?
  `).run(orgId, userId);
}

/**
 * Decrement entity quota counter after a deletion (quox#571 Part 4, Fix 1b).
 * Mirrors incrementEntityQuota; floored at 0 so a double-delete cannot drive
 * the count negative. Before this existed, entity_count only ever grew and
 * users marched toward the entity cap and never came back.
 */
export function decrementEntityQuota(orgId, userId) {
  const db = getDatabase();
  db.prepare(`
    UPDATE memory_quotas SET entity_count = MAX(0, entity_count - 1), updated_at = datetime('now')
    WHERE org_id = ? AND user_id = ?
  `).run(orgId, userId);
}

/**
 * Decrement quota for a memory that is being invalidated (soft-deleted /
 * consolidated) — quox#571 Part 4, Fix 1a.
 *
 * Takes the memory ROW (not req scope): the consolidation scheduler
 * authenticates as the 'service' user, so the invalidated memory's OWN
 * org_id/user_id must drive the decrement, never req.user_id. Only decrements
 * when the row was still valid (guards against under-counting an already
 * invalid row on a re-consolidation). Returns true if it decremented.
 */
export function decrementQuotaForInvalidatedMemory(memory) {
  if (!memory) return false;
  const wasValid = memory.valid === 1 || memory.valid === true;
  if (!wasValid) return false;
  decrementQuota(memory.org_id, memory.user_id, memory.memory_type);
  return true;
}

/**
 * Decrement quota counters after a deletion.
 */
export function decrementQuota(orgId, userId, memoryType) {
  const db = getDatabase();

  if (LEARNED_TYPES.includes(memoryType)) {
    const fields = memoryType === PREFERENCE_TYPE
      ? 'learned_count = MAX(0, learned_count - 1), preference_count = MAX(0, preference_count - 1)'
      : 'learned_count = MAX(0, learned_count - 1)';

    db.prepare(`
      UPDATE memory_quotas SET ${fields}, updated_at = datetime('now')
      WHERE org_id = ? AND user_id = ?
    `).run(orgId, userId);
  }
}

/**
 * Set a user's tier (called by plugin activation or admin override).
 */
export function setTier(orgId, userId, tier, source = 'plugin', expiresAt = null) {
  const db = getDatabase();
  const quota = getQuota(orgId, userId); // Ensure row exists

  db.prepare(`
    UPDATE memory_quotas
    SET tier = ?, tier_source = ?, tier_expires_at = ?, updated_at = datetime('now')
    WHERE org_id = ? AND user_id = ?
  `).run(tier, source, expiresAt, orgId, userId);

  return getQuota(orgId, userId);
}

/**
 * Recalculate quota counts from actual data (repair drift).
 */
export function recalculateQuota(orgId, userId) {
  const db = getDatabase();
  const quota = getQuota(orgId, userId); // Ensure row exists

  const learned = db.prepare(
    `SELECT COUNT(*) as c FROM memories
     WHERE org_id = ? AND user_id = ? AND valid = 1
     AND memory_type IN ('fact','preference','decision','constraint')`
  ).get(orgId, userId);

  const prefs = db.prepare(
    `SELECT COUNT(*) as c FROM memories
     WHERE org_id = ? AND user_id = ? AND valid = 1
     AND memory_type = 'preference'`
  ).get(orgId, userId);

  const episodic = db.prepare(
    `SELECT COUNT(*) as c FROM conversation_summaries
     WHERE org_id = ? AND user_id = ?`
  ).get(orgId, userId);

  const entities = db.prepare(
    `SELECT COUNT(*) as c FROM entities
     WHERE org_id = ? AND user_id = ?`
  ).get(orgId, userId);

  db.prepare(`
    UPDATE memory_quotas
    SET learned_count = ?, preference_count = ?, episodic_count = ?, entity_count = ?,
        updated_at = datetime('now')
    WHERE org_id = ? AND user_id = ?
  `).run(learned.c, prefs.c, episodic.c, entities.c, orgId, userId);

  return getQuota(orgId, userId);
}
