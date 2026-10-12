/**
 * QSKL-11a — Time-based Skill Decay Cron
 * Extended by MEM-DECAY MD.2 (see docs/STREAM_MEM_DECAY_PLAN_V2.md §5 MD.2).
 *
 * Daily sweep that:
 *   - Demotes `edition='stable'` skills idle ≥ STABLE_TO_EXPERIMENTAL_DAYS to 'experimental'
 *   - Dims `decay_state='active'` skills idle ≥ STABLE_TO_EXPERIMENTAL_DAYS (and still below
 *     the archive threshold) to `decay_state='cooling'` (MEM-DECAY MD.2 — wires the
 *     'cooling' value documented in migration 007 but never written until now)
 *   - Flags any skill idle ≥ ARCHIVE_CANDIDATE_DAYS with decay_state='archive_candidate'
 *   - Success-rate branch (MEM-DECAY MD.3): for `edition='experimental'` skills with
 *     `total_invocations_30d >= MIN_INVOCATIONS_FOR_SUCCESS_RATE_DECAY` (read from the
 *     `skill_scoreboard` view, see `skill-scoreboard.ts` / migration 008), mirrors
 *     crystalliser.ts's MIN_EXECUTIONS=3 / MIN_SUCCESS_RATE=0.8 thresholds, inverted for
 *     demotion instead of promotion:
 *       - `success_rate_30d < SUCCESS_RATE_ARCHIVE_THRESHOLD` (0.5) → `decay_state='archive_candidate'`
 *       - `SUCCESS_RATE_ARCHIVE_THRESHOLD <= success_rate_30d < SUCCESS_RATE_REVIEW_THRESHOLD` (0.8)
 *          → `review_needed=true`
 *     Runs only when the optional `scoreboard` dep is supplied (skipped, not erroring, when absent).
 *
 * Default-ON. Set QSKL_DECAY_DISABLED=true to short-circuit.
 * Tune thresholds via:
 *   QSKL_DECAY_STABLE_TO_EXPERIMENTAL_DAYS (default 60) — also used as the cooling threshold
 *   QSKL_DECAY_ARCHIVE_CANDIDATE_DAYS      (default 180)
 *
 * Guardrails (STREAM_MEM_DECAY_PLAN_V2 §0 / §4.2 / §11 S2):
 *   - Zero DELETE statements anywhere in this module — every transition is a column UPDATE
 *     via QuoxSkillsStore.update() / setReviewNeeded(); see skill-decay-cron.test.ts's static
 *     audit test.
 *   - Idle-based decay only ever considers rows with last_used_at IS NOT NULL (enforced in
 *     the store queries) — the seed catalog (0 live invocations) and any never-searched
 *     skill can NEVER be swept into 'cooling' or 'archive_candidate'.
 *   - Cooling is windowed to [stableDays, archiveDays) so it never re-touches rows that the
 *     archive_candidate pass already flags — no double-write, no test regression.
 *   - The success-rate branch only ever considers rows with total_invocations_30d above the
 *     minimum — same "don't judge on no signal" guardrail as the idle passes.
 *
 * Emission: EvidenceStore.store() rows per-item (unchanged, historical shape) PLUS a single
 * AEE `quox.decay.swept` event envelope per run via the optional `envelopeStore` dep — MEM-DECAY
 * MD.2 closes the "no AEE/VOLT envelope" gap noted in STREAM_MEM_DECAY_PLAN_V2 §1.2. Envelope
 * emission is fire-and-forget: it never throws and never blocks the sweep.
 */

import { ulid } from 'ulid';
import type { QuoxSkillsStore } from '../store/quox-skills-store.js';
import type { EvidenceStore } from '../evidence/types.js';
import type { EnvelopeStore } from '../store/envelope-store.js';
import { envelopes as envelopeFactory, Intents } from '../core/envelope.js';

/** MEM-DECAY MD.3: minimal shape the success-rate branch needs from a skill_scoreboard
 * row — deliberately narrower than the full ScoreboardRow so callers can wire this dep
 * off skill-scoreboard.ts's listSkillScoreboard() without a hard pg.Pool coupling here. */
export interface SkillDecayScoreboardRow {
  skill_id: string;
  success_rate_30d: string | number;
  total_invocations_30d: number;
}

/** MEM-DECAY MD.3: optional success-rate-branch dependency. Absent = branch skipped
 * (backward-compatible, mirrors envelopeStore's optionality). */
export interface SkillDecayScoreboardReader {
  list(): Promise<SkillDecayScoreboardRow[]>;
}

// Mirrors crystalliser.ts:50-51 (MIN_EXECUTIONS=3 / MIN_SUCCESS_RATE=0.8), inverted here
// for demotion instead of promotion.
const MIN_INVOCATIONS_FOR_SUCCESS_RATE_DECAY = 3;
const SUCCESS_RATE_ARCHIVE_THRESHOLD = 0.5;
const SUCCESS_RATE_REVIEW_THRESHOLD = 0.8;

export interface SkillDecayCronDeps {
  store: QuoxSkillsStore;
  evidenceStore?: EvidenceStore;
  /**
   * MEM-DECAY MD.2: optional AEE envelope store. When provided, one
   * `quox.decay.swept` event envelope is appended per run. Fire-and-forget —
   * absent or failing envelopeStore never affects sweep behavior.
   */
  envelopeStore?: EnvelopeStore;
  env?: NodeJS.ProcessEnv;
  /** Injectable clock for deterministic tests. Defaults to () => new Date(). */
  now?: () => Date;
  /**
   * MEM-DECAY MD.3: optional skill_scoreboard reader powering the success-rate
   * branch. When absent, the branch is skipped entirely (no error) — same
   * optionality pattern as envelopeStore.
   */
  scoreboard?: SkillDecayScoreboardReader;
}

export interface SkillDecayCronResult {
  ran: boolean;
  demoted: number;
  /** MEM-DECAY MD.2: count of skills newly dimmed to decay_state='cooling' this run. */
  cooling_flagged: number;
  archive_flagged: number;
  /** MEM-DECAY MD.3: count of experimental skills newly flagged review_needed=true
   * this run via the success-rate branch (0.5 <= success_rate_30d < 0.8). */
  review_flagged: number;
  reason?: 'disabled';
}

export interface SkillDecayCron {
  run(): Promise<SkillDecayCronResult>;
}

export function createSkillDecayCron(deps: SkillDecayCronDeps): SkillDecayCron {
  const {
    store,
    evidenceStore,
    envelopeStore,
    env = process.env,
    now = () => new Date(),
    scoreboard,
  } = deps;

  return {
    async run(): Promise<SkillDecayCronResult> {
      // Default-ON: short-circuit only when QSKL_DECAY_DISABLED is exactly 'true'.
      if (env.QSKL_DECAY_DISABLED === 'true') {
        return { ran: false, demoted: 0, cooling_flagged: 0, archive_flagged: 0, review_flagged: 0, reason: 'disabled' };
      }

      const stableDays =
        parseInt(env.QSKL_DECAY_STABLE_TO_EXPERIMENTAL_DAYS ?? '', 10) || 60;
      const archiveDays =
        parseInt(env.QSKL_DECAY_ARCHIVE_CANDIDATE_DAYS ?? '', 10) || 180;

      const currentNow = now();
      let demoted = 0;
      let coolingFlagged = 0;
      let archiveFlagged = 0;
      let reviewFlagged = 0;

      const demotedIds: string[] = [];
      const coolingIds: string[] = [];
      const archiveIds: string[] = [];
      const reviewIds: string[] = [];

      // ── Pass 1: stable → experimental demotion ────────────────────────────
      const staleStable = await store.listStaleStableSkills(stableDays, currentNow);

      for (const skill of staleStable) {
        const lastUsedMs = skill.lastUsedAt ? new Date(skill.lastUsedAt).getTime() : null;
        if (lastUsedMs === null) continue; // extra guard — store already excludes nulls

        const daysIdle = Math.floor((currentNow.getTime() - lastUsedMs) / 86400000);

        await store.update(skill.id, { edition: 'experimental' });
        demoted++;
        demotedIds.push(skill.id);

        if (evidenceStore) {
          const meta = {
            skill_id: skill.id,
            agent_id: 'system:decay-cron',
            from_status: 'stable',
            to_status: 'experimental',
            reason: 'decay',
            days_idle: daysIdle,
            last_used_at: skill.lastUsedAt,
          };
          try {
            await evidenceStore.store({
          orgId: skill.orgId,
              correlationId: skill.id,
              envelopeId: ulid(),
              type: 'skill_status_change',
              contentType: 'application/json',
              content: JSON.stringify(meta),
              metadata: meta as Record<string, unknown>,
            });
          } catch (evidenceErr: unknown) {
            console.warn(
              '[SkillDecayCron] evidenceStore.store(skill_status_change) failed (best-effort):',
              evidenceErr,
            );
          }
        }
      }

      // ── Pass 2: cooling dim (MEM-DECAY MD.2) ───────────────────────────────
      // Window [stableDays, archiveDays): rows already past archiveDays are handled by
      // pass 3 below and are never touched here (the store query bounds this explicitly).
      const coolingCandidates = await store.listCoolingCandidateSkills(stableDays, archiveDays, currentNow);

      for (const skill of coolingCandidates) {
        const lastUsedMs = skill.lastUsedAt ? new Date(skill.lastUsedAt).getTime() : null;
        if (lastUsedMs === null) continue;

        const daysIdle = Math.floor((currentNow.getTime() - lastUsedMs) / 86400000);

        await store.update(skill.id, { decayState: 'cooling' });
        coolingFlagged++;
        coolingIds.push(skill.id);

        if (evidenceStore) {
          const meta = {
            skill_id: skill.id,
            agent_id: 'system:decay-cron',
            from_status: 'active',
            to_status: 'cooling',
            reason: 'decay',
            days_idle: daysIdle,
            last_used_at: skill.lastUsedAt,
          };
          try {
            await evidenceStore.store({
          orgId: skill.orgId,
              correlationId: skill.id,
              envelopeId: ulid(),
              type: 'skill_cooling',
              contentType: 'application/json',
              content: JSON.stringify(meta),
              metadata: meta as Record<string, unknown>,
            });
          } catch (evidenceErr: unknown) {
            console.warn(
              '[SkillDecayCron] evidenceStore.store(skill_cooling) failed (best-effort):',
              evidenceErr,
            );
          }
        }
      }

      // ── Pass 3: archive_candidate flag ────────────────────────────────────
      const veryStale = await store.listVeryStaleSkills(archiveDays, currentNow);

      for (const skill of veryStale) {
        const lastUsedMs = skill.lastUsedAt ? new Date(skill.lastUsedAt).getTime() : null;
        if (lastUsedMs === null) continue;

        const daysIdle = Math.floor((currentNow.getTime() - lastUsedMs) / 86400000);
        const priorDecayState = skill.decayState;

        await store.update(skill.id, { decayState: 'archive_candidate' });
        archiveFlagged++;
        archiveIds.push(skill.id);

        if (evidenceStore) {
          const meta = {
            skill_id: skill.id,
            agent_id: 'system:decay-cron',
            reason: 'decay',
            days_idle: daysIdle,
            last_used_at: skill.lastUsedAt,
            prior_decay_state: priorDecayState,
          };
          try {
            await evidenceStore.store({
          orgId: skill.orgId,
              correlationId: skill.id,
              envelopeId: ulid(),
              type: 'skill_archive_candidate',
              contentType: 'application/json',
              content: JSON.stringify(meta),
              metadata: meta as Record<string, unknown>,
            });
          } catch (evidenceErr: unknown) {
            console.warn(
              '[SkillDecayCron] evidenceStore.store(skill_archive_candidate) failed (best-effort):',
              evidenceErr,
            );
          }
        }
      }

      // ── Pass 4: success-rate branch (MEM-DECAY MD.3) ──────────────────────
      // Only runs when a scoreboard reader is supplied — skipped, not errored, otherwise.
      if (scoreboard) {
        const experimentalSkills = await store.listAllExperimentalSkills();

        if (experimentalSkills.length > 0) {
          const scoreboardRows = await scoreboard.list();
          const scoreboardBySkillId = new Map(scoreboardRows.map(row => [row.skill_id, row]));

          for (const skill of experimentalSkills) {
            const row = scoreboardBySkillId.get(skill.id);
            if (!row) continue; // no scoreboard signal yet — never judge on absence of data

            const totalInvocations30d = Number(row.total_invocations_30d);
            if (
              !Number.isFinite(totalInvocations30d) ||
              totalInvocations30d < MIN_INVOCATIONS_FOR_SUCCESS_RATE_DECAY
            ) {
              continue;
            }

            const successRate30d = Number(row.success_rate_30d);
            if (!Number.isFinite(successRate30d)) continue;

            if (successRate30d < SUCCESS_RATE_ARCHIVE_THRESHOLD) {
              await store.update(skill.id, { decayState: 'archive_candidate' });
              archiveFlagged++;
              archiveIds.push(skill.id);

              if (evidenceStore) {
                const meta = {
                  skill_id: skill.id,
                  agent_id: 'system:decay-cron',
                  reason: 'low_success_rate',
                  success_rate_30d: successRate30d,
                  total_invocations_30d: totalInvocations30d,
                  prior_decay_state: skill.decayState,
                };
                try {
                  await evidenceStore.store({
                    orgId: skill.orgId,
                    correlationId: skill.id,
                    envelopeId: ulid(),
                    type: 'skill_archive_candidate',
                    contentType: 'application/json',
                    content: JSON.stringify(meta),
                    metadata: meta as Record<string, unknown>,
                  });
                } catch (evidenceErr: unknown) {
                  console.warn(
                    '[SkillDecayCron] evidenceStore.store(skill_archive_candidate low_success_rate) failed (best-effort):',
                    evidenceErr,
                  );
                }
              }
            } else if (successRate30d < SUCCESS_RATE_REVIEW_THRESHOLD) {
              await store.setReviewNeeded(skill.id, true);
              reviewFlagged++;
              reviewIds.push(skill.id);

              if (evidenceStore) {
                const meta = {
                  skill_id: skill.id,
                  agent_id: 'system:decay-cron',
                  reason: 'low_success_rate',
                  success_rate_30d: successRate30d,
                  total_invocations_30d: totalInvocations30d,
                };
                try {
                  await evidenceStore.store({
                    orgId: skill.orgId,
                    correlationId: skill.id,
                    envelopeId: ulid(),
                    type: 'skill_review_needed',
                    contentType: 'application/json',
                    content: JSON.stringify(meta),
                    metadata: meta as Record<string, unknown>,
                  });
                } catch (evidenceErr: unknown) {
                  console.warn(
                    '[SkillDecayCron] evidenceStore.store(skill_review_needed) failed (best-effort):',
                    evidenceErr,
                  );
                }
              }
            }
          }
        }
      }

      // ── AEE evidence: one batch envelope per sweep (MEM-DECAY MD.2) ────────
      // Fire-and-forget — absent/failing envelopeStore never affects sweep results.
      if (envelopeStore) {
        try {
          const sweepId = ulid();
          const envelope = envelopeFactory.event(Intents.DECAY.SWEPT, sweepId, {
            sweep_type: 'skill_decay',
            demoted,
            cooling_flagged: coolingFlagged,
            archive_flagged: archiveFlagged,
            review_flagged: reviewFlagged,
            demoted_ids: demotedIds,
            cooling_ids: coolingIds,
            archive_ids: archiveIds,
            review_ids: reviewIds,
            swept_at: currentNow.toISOString(),
          });
          await envelopeStore.append(envelope);
        } catch (envelopeErr: unknown) {
          console.warn(
            '[SkillDecayCron] envelopeStore.append(quox.decay.swept) failed (best-effort):',
            envelopeErr,
          );
        }
      }

      return {
        ran: true,
        demoted,
        cooling_flagged: coolingFlagged,
        archive_flagged: archiveFlagged,
        review_flagged: reviewFlagged,
      };
    },
  };
}
