/**
 * SkillReviewBadge — QSKL-7.7b
 *
 * Small red badge shown when review_needed is true.
 * Uses glass-design-system qx-pill--danger class only.
 */

export default function SkillReviewBadge({ reviewNeeded }) {
  if (!reviewNeeded) return null

  return (
    <span className="qx-pill qx-pill--sm qx-pill--danger">
      Review needed
    </span>
  )
}
