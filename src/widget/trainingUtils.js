/**
 * Training Tab Utilities (CW-8.6)
 */

export function getConfidenceBadge(score) {
  const s = typeof score === 'number' ? score : 0
  if (s >= 0.8) return { color: '#30ff90', label: 'High', icon: '✓' }
  if (s >= 0.5) return { color: '#f59e0b', label: 'Medium', icon: '~' }
  return { color: '#ef4444', label: 'Low', icon: '!' }
}

export function formatSourceAttribution({ source, section, title, score, pinned }) {
  return {
    // Public /message replies carry human titles only (no internal ids).
    label: title || (section ? `${source} › ${section}` : (source || 'Knowledge')),
    badge: pinned ? 'Pinned' : 'Retrieved',
    badgeColor: pinned ? '#a855f7' : '#38bdf8',
    scoreDisplay: `${Math.round((score || 0) * 100)}%`,
  }
}
