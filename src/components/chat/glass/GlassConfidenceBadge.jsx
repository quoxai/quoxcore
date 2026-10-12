/**
 * GlassConfidenceBadge — QCX-5b
 *
 * Score-coloured pill. Returns null for non-numeric or out-of-range
 * scores so callers can render `{score != null && <Badge…>}` without
 * extra guards.
 */

import './glass-chat.css';

export function GlassConfidenceBadge({ score, label }) {
  if (typeof score !== 'number' || !isFinite(score) || score < 0 || score > 1) return null;
  const pct = Math.round(score * 100);
  let tier = 'low';
  if (score >= 0.70) tier = 'high';
  else if (score >= 0.40) tier = 'med';
  const prefix = label ? `${label} ` : '';
  return (
    <span className={`gcb-conf gcb-conf--${tier}`} data-tier={tier} title="Source-match confidence">
      {prefix}{pct}%
    </span>
  );
}
