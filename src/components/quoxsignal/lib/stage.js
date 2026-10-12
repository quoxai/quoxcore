/* The pipeline, in order. Exported so the stage indicator can render position rather
   than just a colour, and so 'is this the last stage' is derived rather than guessed. */
export const STAGE_ORDER = ['discovered', 'transcribed', 'analysed'];

/**
 * Client-side mirror of quox-signal's server/src/domain/stages.js's
 * LEGAL_TRANSITIONS. Item lifecycle: discovered (metadata only) ->
 * transcribed (audio + ASR) -> analysed (triaged, proposal possibly drawn).
 * Only forward, one step at a time. Kept in sync by hand since the dashboard
 * does not import the QuoxSignal server's code — same posture as the
 * standalone web app's own copy of this file.
 *
 * Ported verbatim from quox-signal/web/src/lib/stage.js.
 */
const NEXT_STAGE = {
  discovered: 'transcribed',
  transcribed: 'analysed',
  analysed: null
};

const ACTION_LABEL = {
  discovered: 'Transcribe',
  transcribed: 'Analyse',
  analysed: null
};

// Pipeline position, 0-indexed — used both to sort the Stage column and to
// pick each stage's qx-pill colour (see STAGE_PILL below). Distinct hues per
// stage (blue -> purple -> green) are what let the eye read "stage" as a
// left-to-right pipeline position instead of one flat grey chip.
const STAGE_RANK = { discovered: 0, transcribed: 1, analysed: 2 };

const STAGE_PILL = {
  discovered: 'qx-pill--info',
  transcribed: 'qx-pill--purple',
  analysed: 'qx-pill--success'
};

/** The stage this item would move to if its single action button were pressed, or null if it is terminal. */
export function nextStageFor(stage) {
  return NEXT_STAGE[stage] ?? null;
}

/** The verb shown on the single action button for this stage, or null if the item is terminal (no further stage). */
export function actionLabelFor(stage) {
  return ACTION_LABEL[stage] ?? null;
}

/** 0-indexed pipeline position for a stage, for sorting the Stage column. Unknown stages sort last. */
export function stageRank(stage) {
  return STAGE_RANK[stage] ?? STAGE_RANK.analysed + 1;
}

/** The qx-pill colour modifier for a stage, so the chip reads as a pipeline position at a glance. */
export function stagePillVariant(stage) {
  return STAGE_PILL[stage] || 'qx-pill--ghost';
}

/**
 * The four honest states a card's action can be in — matching what the server actually
 * knows, not what a click optimistically implies:
 *   idle    - nothing requested, no error; the normal per-stage button.
 *   working - the advance click is in flight (POST /stage has not come back yet).
 *   queued  - the server accepted the request (`requested_stage` set); a worker owns it
 *             now, no ASR/triage has run yet, so the stage itself has not moved.
 *   failed  - the worker tried and the attempt failed (`stage_error` set); the button
 *             returns to normal so the same click retries it.
 */
export function cardStatus(item, { advancing = false } = {}) {
  if (advancing) return 'working';
  if (item.stage_error) return 'failed';
  if (item.requested_stage) return 'queued';
  return 'idle';
}
