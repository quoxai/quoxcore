/**
 * QCX-5g — Per-widget CSS overrides sanitiser.
 *
 * Admins write CSS in the StyleTab "5 Levels of CSS Control" surface.
 * The output goes into a <style> element inside the widget's shadow DOM.
 * The widget runs on third-party customer sites, so we strip the obvious
 * escape vectors:
 *   - </style>      — would close the wrapping style block and let
 *                     subsequent text execute as HTML.
 *   - <script ...>  — defence in depth; CSS strings shouldn't contain
 *                     HTML markup at all.
 *   - javascript:   — historic vector inside url(); modern browsers
 *                     block it but we strip anyway for older WebViews.
 *   - expression(   — ancient IE filter, dead but cheap to strip.
 * Length is capped at 32KB so a malformed paste can't bloat /widget.js.
 *
 * Intent: defensive scrubbing, not a CSS parser. Admins are first-party,
 * so a strict reject would lock them out of legitimate customisation.
 */

'use strict';

const MAX_BYTES = 32 * 1024;

function sanitiseStyleOverrides(input) {
  if (typeof input !== 'string' || input.length === 0) return '';
  let css = input
    .replace(/<\/style\s*>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*>/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/expression\s*\(/gi, '');
  if (css.length > MAX_BYTES) css = css.slice(0, MAX_BYTES);
  return css;
}

module.exports = { sanitiseStyleOverrides };
