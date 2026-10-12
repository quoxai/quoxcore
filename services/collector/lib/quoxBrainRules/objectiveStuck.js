/**
 * QuoxBrain Rule: objective-stuck
 *
 * Trigger: An objective has been open for ≥7 days AND has had
 * no progress envelope in the last 48 hours.
 *
 * ctx: {
 *   objectives: Array<{ id, title, status, created_at }>
 *   progressEnvelopes: Array<{ objective_id, ts }>
 * }
 */

const OPEN_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const PROGRESS_CUTOFF_MS = 48 * 60 * 60 * 1000;
const id = 'objective-stuck';

function evaluate(ctx = {}) {
  const { objectives = [], progressEnvelopes = [] } = ctx;

  if (objectives.length === 0) {
    return { matches: false };
  }

  const now = Date.now();
  const progressCutoff = now - PROGRESS_CUTOFF_MS;

  // Build set of objective ids with recent progress
  const recentlyActive = new Set(
    progressEnvelopes
      .filter((e) => new Date(e.ts).getTime() >= progressCutoff)
      .map((e) => e.objective_id),
  );

  // Find qualifying objectives (open, ≥7d, no recent progress)
  let oldest = null;

  for (const obj of objectives) {
    if (obj.status !== 'open') continue;
    const ageMs = now - new Date(obj.created_at).getTime();
    if (ageMs < OPEN_THRESHOLD_MS) continue;
    if (recentlyActive.has(obj.id)) continue;

    if (!oldest || ageMs > oldest.ageMs) {
      oldest = { obj, ageMs };
    }
  }

  if (!oldest) {
    return { matches: false };
  }

  const days = Math.floor(oldest.ageMs / (24 * 60 * 60 * 1000));

  return {
    matches: true,
    payload: {
      objectiveId: oldest.obj.id,
      title: oldest.obj.title,
      days,
    },
  };
}

module.exports = { id, evaluate };
