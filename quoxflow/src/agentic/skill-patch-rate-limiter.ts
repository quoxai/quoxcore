/**
 * QSKL-14a Slice 1 — Per-agent skill patch rate-limiter
 *
 * Default: 10 patches per 24-hour sliding window per agent.
 * Only patches whose patched_by starts with 'agent:' count toward the budget.
 * Override the threshold via env var QSKL_PATCH_RATE_LIMIT_PER_DAY (must be
 * a positive integer ≥ 1; invalid/zero/negative values throw on construction).
 *
 * No feature-flag toggle — the limiter is always active.
 */

import type { QuoxSkillPatchesStore } from '../store/quox-skill-patches-store.js';

const DEFAULT_THRESHOLD = 10;
const WINDOW_SECONDS = 86400; // 24 hours

// ─── Public types ─────────────────────────────────────────────────────────────

export interface PatchRateLimitResult {
  allowed: boolean;
  count: number;
  threshold: number;
  /** Seconds until the oldest in-window patch drops off. 0 when count < threshold. */
  retry_after: number;
}

export interface PatchRateLimiter {
  /**
   * Check whether agentId has headroom within the 24h sliding window.
   *
   * @param agentId - bare agent identifier, e.g. `"sentinel"` (not `"agent:sentinel"`)
   * @param now     - injectable clock for deterministic tests (defaults to `new Date()`)
   * @param orgId   - org scope for per-org rate-limit isolation. When provided, only
   *                  patches belonging to that org count toward the budget (prevents
   *                  org-A exhaustion from blocking org-B). When absent, all patches
   *                  for the agent are counted (backward-compat / orgId-less callers).
   */
  check(agentId: string, now?: Date, orgId?: string): Promise<PatchRateLimitResult>;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createPatchRateLimiter(deps: {
  patchesStore: QuoxSkillPatchesStore;
  env?: NodeJS.ProcessEnv;
}): PatchRateLimiter {
  const { patchesStore, env = process.env } = deps;

  // Resolve threshold — throws eagerly for invalid config.
  const threshold = resolveThreshold(env);

  return {
    async check(agentId: string, now: Date = new Date(), orgId?: string): Promise<PatchRateLimitResult> {
      const since = new Date(now.getTime() - WINDOW_SECONDS * 1000);

      const count = await patchesStore.countAgentPatchesSince(agentId, since, orgId);

      if (count < threshold) {
        return { allowed: true, count, threshold, retry_after: 0 };
      }

      // Budget exhausted — compute when the oldest patch drops off.
      const oldest = await patchesStore.oldestAgentPatchSince(agentId, since, orgId);
      const retry_after = computeRetryAfter(oldest?.createdAt ?? null, now);

      return { allowed: false, count, threshold, retry_after };
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveThreshold(env: NodeJS.ProcessEnv): number {
  const raw = env['QSKL_PATCH_RATE_LIMIT_PER_DAY'];
  if (raw === undefined || raw === null) {
    return DEFAULT_THRESHOLD;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(
      `Quox: QSKL_PATCH_RATE_LIMIT_PER_DAY must be a positive integer ≥ 1, got: ${JSON.stringify(raw)}`
    );
  }

  return parsed;
}

/**
 * retry_after = WINDOW_SECONDS - (now - oldest_ts_in_seconds)
 *
 * When oldest is null (shouldn't happen when count >= threshold, but defensive),
 * fall back to the full window.
 */
function computeRetryAfter(oldestCreatedAt: string | null, now: Date): number {
  if (!oldestCreatedAt) {
    return WINDOW_SECONDS;
  }

  const oldestMs = new Date(oldestCreatedAt).getTime();
  const elapsedSeconds = Math.floor((now.getTime() - oldestMs) / 1000);
  return Math.max(0, WINDOW_SECONDS - elapsedSeconds);
}
