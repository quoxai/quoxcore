/**
 * QCX-5h — Pure helpers for the StyleTab component.
 *
 * Kept as pure functions so the merge/parse logic can be unit-tested
 * without rendering React.
 */

const VALID_THEMES = ['auto', 'light', 'dark'];

function _isMeaningful(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string' && v.length === 0) return false;
  return true;
}

/**
 * Fold StyleTab fields into the existing embed_config_json shape.
 * Skips empty/null/undefined values so the user clearing a field doesn't
 * accidentally wipe an existing setting (use the explicit "Reset" affordance
 * instead). Returns a fresh object — caller can JSON.stringify it.
 */
export function mergeStyleConfig(prev, partial) {
  const base = prev && typeof prev === 'object' ? { ...prev } : {};
  const next = { ...base };
  for (const [k, v] of Object.entries(partial || {})) {
    // w6k: clearing Custom CSS must actually clear it. The server deep-merges
    // embed_config and removes a key sent as null.
    if (k === 'style_overrides' && v === '') { next[k] = null; continue; }
    if (!_isMeaningful(v)) continue;
    next[k] = v;
  }
  if (next.theme && !VALID_THEMES.includes(next.theme)) next.theme = 'auto';
  return next;
}

/**
 * Read the StyleTab-relevant fields out of a widget. Tolerates string
 * embed_config_json, object embed_config (already parsed), and missing/
 * malformed inputs.
 */
export function parseExistingStyleConfig(widget) {
  const fallback = { theme: 'auto', accent_color: '', style_overrides: '' };
  if (!widget || typeof widget !== 'object') return fallback;
  let cfg = widget.embed_config;
  if (!cfg && typeof widget.embed_config_json === 'string') {
    try { cfg = JSON.parse(widget.embed_config_json); } catch { cfg = null; }
  }
  if (!cfg || typeof cfg !== 'object') return fallback;
  return {
    theme: VALID_THEMES.includes(cfg.theme) ? cfg.theme : 'auto',
    accent_color: typeof cfg.accent_color === 'string' ? cfg.accent_color : '',
    style_overrides: typeof cfg.style_overrides === 'string' ? cfg.style_overrides : '',
  };
}
