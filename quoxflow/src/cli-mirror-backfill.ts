/**
 * SKILLRIGHTS-BRIDGE — QuoxSkills filesystem mirror backfill.
 *
 * The FS mirror (src/store/quox-skill-mirror.ts) is sync-on-write: it only
 * fires when a skill is created or updated, and only when
 * QUOX_SKILLS_MIRROR_PATH is set. Every row written before the mirror path
 * existed therefore has no SKILL.md on disk. This entrypoint reconstructs the
 * whole mirror from the store in one pass, so the SkillRights registry can
 * read a complete set of declared skills.
 *
 * Idempotent: mirrorSkillToDisk() overwrites by path, so re-running produces
 * byte-identical files. Rows are iterated in created_at order, so when several
 * versions of one skill share a category/name path the newest version wins.
 *
 * Run it (inside the quoxflow container, or any checkout with tsx):
 *   QUOX_SKILLS_MIRROR_PATH=/data/skills-mirror \
 *   DATABASE_URL=postgresql://... npx tsx src/cli-mirror-backfill.ts
 *
 * Without DATABASE_URL the store is in-memory and the run is a no-op (0
 * skills), which is reported rather than passed off as success.
 */

import { QuoxSkillsStore } from './store/quox-skills-store.js';
import { mirrorSkillToDisk, formatSkillForMirror } from './store/quox-skill-mirror.js';
import { logger } from './logger.js';
import fs from 'node:fs/promises';

const log = logger.for('MirrorBackfill');

export interface MirrorBackfillResult {
  /** Rows read from the store. */
  total: number;
  /** Rows whose SKILL.md is present on disk after the write attempt. */
  written: number;
  /** Rows whose SKILL.md is absent after the write attempt. */
  failed: number;
  /** category/name paths of the failures, for the operator to chase. */
  failures: string[];
}

export interface MirrorBackfillOptions {
  /** Called once per skill with a one-line result; defaults to the logger. */
  onSkill?: (line: string) => void;
}

/**
 * Mirror every skill in the store to disk.
 *
 * mirrorSkillToDisk() deliberately swallows FS errors (the mirror is not a
 * contract for the write path), so this function stats the target file after
 * each call rather than trusting a silent return. A backfill that reported
 * "61 written" while the volume was read-only would be exactly the lying
 * green check the house rules forbid.
 */
export async function runMirrorBackfill(
  store: QuoxSkillsStore,
  options: MirrorBackfillOptions = {}
): Promise<MirrorBackfillResult> {
  const mirrorPath = process.env.QUOX_SKILLS_MIRROR_PATH;
  if (!mirrorPath) {
    throw new Error(
      'QUOX_SKILLS_MIRROR_PATH is unset — nothing to back up to. Set it and re-run.'
    );
  }

  const emit = options.onSkill ?? ((line: string) => log.info(line));

  const skills = await store.listAllSkills();
  const result: MirrorBackfillResult = {
    total: skills.length,
    written: 0,
    failed: 0,
    failures: [],
  };

  for (const skill of skills) {
    const { filePath } = formatSkillForMirror(skill, mirrorPath);
    await mirrorSkillToDisk(skill);

    let ok = false;
    try {
      const stat = await fs.stat(filePath);
      ok = stat.isFile();
    } catch {
      ok = false;
    }

    const label = `${skill.category}/${skill.name}@${skill.version}`;
    if (ok) {
      result.written++;
      emit(`ok   ${label} -> ${filePath}${skill.license ? ` [${skill.license}]` : ''}`);
    } else {
      result.failed++;
      result.failures.push(label);
      emit(`FAIL ${label} -> ${filePath} (no file on disk after write)`);
    }
  }

  return result;
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────

export async function main(): Promise<number> {
  const dbUrl = process.env.DATABASE_URL;
  const store = dbUrl ? new QuoxSkillsStore({ connectionString: dbUrl }) : new QuoxSkillsStore();
  await store.init();

  if (!dbUrl) {
    log.warn('DATABASE_URL is unset — running against the in-memory store, which holds no rows.');
  }

  const result = await runMirrorBackfill(store);
  log.info(
    `Backfill complete: ${result.written}/${result.total} mirrored, ${result.failed} failed` +
      (result.failures.length ? ` (${result.failures.join(', ')})` : '')
  );
  await store.close();
  return result.failed === 0 ? 0 : 1;
}

// Run only when executed directly, never on import (the test imports this file).
const invokedDirectly =
  typeof process.argv[1] === 'string' && process.argv[1].includes('cli-mirror-backfill');
if (invokedDirectly) {
  main()
    .then(code => process.exit(code))
    .catch(err => {
      log.error('Backfill aborted', { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
}
