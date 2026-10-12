/**
 * server-seed-helper.ts — QSKL-10.2
 *
 * Tiny helper that wraps the skill-seed-loader invocation for boot.
 * Extracted so it can be unit-tested without booting the full Hono app.
 *
 * Default-on: runs unless QUOX_SKILLS_SEED_DISABLED=true.
 */

import type { SeedSkillsOptions, SeedSkillsResult } from './store/skill-seed-loader.js';

export interface RunSeedLoaderOptions {
  /** Override the seed function (for testing). Defaults to real seedSkillsFromFs. */
  seedFn?: (opts?: SeedSkillsOptions) => Promise<SeedSkillsResult>;
}

/**
 * Run the skill seed loader at boot time.
 *
 * Returns the SeedSkillsResult, or null if seeding was disabled via
 * QUOX_SKILLS_SEED_DISABLED=true. Never throws — errors are captured in
 * result.errors and logged by the caller.
 */
export async function runSeedLoader(opts?: RunSeedLoaderOptions): Promise<SeedSkillsResult | null> {
  if (process.env.QUOX_SKILLS_SEED_DISABLED === 'true') {
    return null;
  }

  const seedFn = opts?.seedFn ?? (await import('./store/skill-seed-loader.js')).seedSkillsFromFs;
  return seedFn();
}
