/**
 * Reading text size, per device (a phone and a desk screen want different
 * sizes), so localStorage is the right home; failures are silent. Each surface
 * passes its own storage key so a size chosen for notes does not resize email.
 */
export const ZOOM_STEPS = Object.freeze([0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.7])
export const DEFAULT_ZOOM = 1

export function clampZoom(z) {
  const n = Number(z)
  if (!Number.isFinite(n)) return DEFAULT_ZOOM
  return ZOOM_STEPS.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), DEFAULT_ZOOM)
}

/** dir: +1 bigger, -1 smaller. Stays put at either end. */
export function stepZoom(z, dir) {
  const i = ZOOM_STEPS.indexOf(clampZoom(z))
  return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + (dir > 0 ? 1 : -1)))]
}

export function loadZoom(key) {
  try { const v = localStorage.getItem(key); return v === null ? DEFAULT_ZOOM : clampZoom(v) } catch { return DEFAULT_ZOOM }
}
export function saveZoom(key, z) {
  try { localStorage.setItem(key, String(clampZoom(z))) } catch { /* convenience only */ }
}
