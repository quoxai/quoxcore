/**
 * Cost estimate for advancing one item a stage. Formula per the SCOUT house
 * rate ($0.006/min, OpenAI whisper-1 pricing measured in quox-signal's
 * README.md): duration_seconds / 60 * 0.006 USD. Shown to 3 decimals.
 * Duration is only known once an item has been transcribed or its source
 * metadata carried it, so an unknown duration shows "~" rather than a number
 * that would be wrong (never guess a cost).
 *
 * Ported verbatim from the standalone quox-signal/web/src/lib/cost.js — pure
 * logic, no UI, safe to carry over as-is.
 */
export function estimateCost(durationS) {
  if (durationS === null || durationS === undefined || Number.isNaN(durationS)) return null;
  return (durationS / 60) * 0.006;
}

export function formatCost(durationS) {
  const cost = estimateCost(durationS);
  if (cost === null) return '~';
  return `$${cost.toFixed(3)}`;
}

/**
 * Bulk selection estimate. Sums the known durations and flags whether any
 * selected item's duration is unknown, so the caller can mark the total as
 * a floor ("$0.012+") instead of presenting an incomplete sum as exact —
 * cost must never be shown wrong, only honestly incomplete.
 */
export function sumCost(durationsS) {
  const known = durationsS.filter((d) => d !== null && d !== undefined && !Number.isNaN(d));
  const hasUnknown = known.length !== durationsS.length;
  if (known.length === 0) return { total: null, hasUnknown, label: '~' };
  const total = known.reduce((sum, d) => sum + (d / 60) * 0.006, 0);
  return { total, hasUnknown, label: hasUnknown ? `$${total.toFixed(3)}+` : `$${total.toFixed(3)}` };
}
