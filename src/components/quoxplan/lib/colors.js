/**
 * Tier / status color conventions, mirrored from the community roadmap-viewer
 * plugin (quox-dashboard/src/plugins/roadmap-viewer/RoadmapView.jsx TIER_COLORS
 * ~L13, STATUS_COLORS ~L30) so devs who know that view recognise this one.
 *
 * Mapped onto existing `.qx-pill`/`.qx-chip` variant classes (qx-components.css)
 * rather than new hardcoded colors — the qx-pill palette already lines up with
 * the roadmap-viewer hex values (critical=#ef4444/#f87171, info=#38bdf8,
 * purple=#a855f7/#c084fc, online=#30ff90, warn=#f59e0b).
 */

export const TIER_META = {
  0: { variant: 'critical', label: 'P0' },
  1: { variant: 'info', label: 'T1' },
  2: { variant: 'purple', label: 'T2' },
  3: { variant: 'online', label: 'T3' },
  4: { variant: 'warn', label: 'T4' },
  5: { variant: 'ghost', label: 'T5' }
};

export function tierMeta(tier) {
  return TIER_META[tier] ?? { variant: 'ghost', label: `T${tier}` };
}

export const STATUS_META = {
  NOT_STARTED: { variant: 'ghost', label: 'Not started' },
  IN_PROGRESS: { variant: 'warn', label: 'In progress' },
  COMPLETE: { variant: 'online', label: 'Complete' },
  BLOCKED: { variant: 'critical', label: 'Blocked' },
  DECISION_NEEDED: { variant: 'purple', label: 'Decision needed' }
};

export function statusMeta(status) {
  return STATUS_META[status] ?? { variant: 'ghost', label: status ?? 'Unknown' };
}

/** SVG/Gantt fill classes (defined in quoxplan.css) keyed the same way. */
export function ganttBarClass(status) {
  const variant = statusMeta(status).variant;
  return `qxp-bar qxp-bar--${variant}`;
}

/**
 * Resolves a variant name to the underlying design token (never a raw hex),
 * for the handful of spots (SVG fill/stroke, card accent borders) that need
 * an actual color value rather than a class name.
 */
export function variantColorVar(variant) {
  switch (variant) {
    case 'critical':
      return 'var(--m-error)';
    case 'warn':
      return 'var(--m-warning)';
    case 'online':
      return 'var(--m-success)';
    case 'info':
      return 'var(--m-quox-primary)';
    case 'purple':
      return 'var(--m-quox-secondary)';
    default:
      return 'var(--m-text-tertiary)';
  }
}

export function statusColorVar(status) {
  return variantColorVar(statusMeta(status).variant);
}

export function tierColorVar(tier) {
  return variantColorVar(tierMeta(tier).variant);
}

/**
 * Action item kind conventions (QUOXPLAN-P7): 'blocked' items came from a
 * stream entering BLOCKED (auto-emitted), 'decision' from DECISION_NEEDED,
 * 'manual' is anything a human typed in via the Add action item input.
 * Reuses the same variant palette as tier/status above so the glyph reads
 * consistently with the rest of the instrument language.
 */
export const ACTION_ITEM_KIND_META = {
  blocked: { variant: 'critical', label: 'Blocked' },
  decision: { variant: 'info', label: 'Decision' },
  manual: { variant: 'ghost', label: 'Manual' }
};

export function actionItemKindMeta(kind) {
  return ACTION_ITEM_KIND_META[kind] ?? ACTION_ITEM_KIND_META.manual;
}

export function actionItemKindColorVar(kind) {
  return variantColorVar(actionItemKindMeta(kind).variant);
}
