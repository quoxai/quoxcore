/**
 * Short local copy of quox-signal/lib/autonomy.js's AUTONOMY_LEVELS/
 * autonomyRank/AUTONOMY_DESCRIPTIONS — no cross-repo import between
 * quox-signal and quox-dashboard (same posture as the rest of this
 * lib/ directory, e.g. lib/stage.js and lib/health.js). Keep the wording
 * in sync by hand if the source file changes; quox-signal's own
 * lib/autonomy.js explicitly calls out this dashboard copy in its header
 * comment.
 *
 * SIGNAL-UX item 5: the CLI (`signal autonomy <source> <level>`) already
 * refuses to silently raise a source's autonomy — it prints what the new
 * level spends money on and the current budget caps BEFORE the PATCH goes
 * out. AutonomyControl.jsx applies the same rule in the dashboard.
 */
export const AUTONOMY_LEVELS = ['manual', 'auto-transcribe', 'auto-extract', 'auto-lens', 'auto-propose'];

export function autonomyRank(level) {
  const i = AUTONOMY_LEVELS.indexOf(level);
  return i === -1 ? 0 : i;
}

export const AUTONOMY_DESCRIPTIONS = {
  manual: 'Nothing runs without you. Every stage is a manual command.',
  'auto-transcribe': 'The worker automatically transcribes newly discovered items from this source (spends money on speech-to-text) without asking again. Never triages, lenses, or proposes on its own.',
  'auto-extract': 'The worker automatically transcribes AND triage-extracts items from this source (spends money on transcription + a triage call) without asking again. Never runs a lens or creates a proposal on its own.',
  'auto-lens': 'The worker automatically transcribes, extracts, and runs a lens over items from this source (spends money on transcription + triage + lens) without asking again. Never creates a proposal on its own.',
  'auto-propose': 'The worker automatically transcribes, extracts, lenses, AND drafts proposals from this source — the highest-spend level. Proposals still need a human decision; getting to one does not.'
};

/** True when moving from `from` to `to` spends more money unattended than before — the case that needs a confirm step. */
export function isRaise(from, to) {
  return autonomyRank(to) > autonomyRank(from);
}
