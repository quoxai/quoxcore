/**
 * QCX-4.3 — Rich message-type renderers for the QuoxChat widget.
 *
 * Pure functions. Each returns an HTML string safe to inject via
 * innerHTML in the widget's shadow DOM. All user data is HTML-escaped
 * and URLs are scheme-validated (same rules as quoxchatMarkdown.js).
 *
 * Inlined into the widget by the /widget.js route, same as the markdown
 * module. Tested in test/quoxchat-cards.test.js.
 */

'use strict';

// Module-local — deliberately _named to avoid clashes with the markdown
// module when both are inlined into the widget IIFE.
const CARDS_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function _esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => CARDS_ESC[c]);
}

function _isSafeUrl(url) {
  const u = String(url || '').trim();
  if (u.startsWith('//')) return true;
  if (/^https?:\/\//i.test(u)) return true;
  if (/^mailto:/i.test(u)) return true;
  return false;
}

function _escHref(url) {
  return String(url)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// "Looking that up..." / "Done" / "Error — <reason>" chips.
const STATE_LABELS = {
  running: 'Looking that up…',
  ok: 'Done',
  error: 'Error',
};

// Input summary: one line like `query: "refunds"`. Truncated hard at 80 chars.
function _inputSummary(input) {
  if (!input || typeof input !== 'object') return '';
  try {
    const entries = Object.entries(input);
    if (entries.length === 0) return '';
    const parts = entries.slice(0, 3).map(([k, v]) => {
      const val = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v ?? '');
      return `${k}: ${val}`;
    });
    const joined = parts.join(', ');
    return joined.length > 80 ? joined.slice(0, 79) + '…' : joined;
  } catch { return ''; }
}

function renderToolCard({ name, state, input, error } = {}) {
  const toolName = _esc(name || 'tool');
  const stateKey = state === 'ok' || state === 'error' ? state : 'running';
  const label = stateKey === 'error' && error
    ? `Error — ${_esc(error)}`
    : _esc(STATE_LABELS[stateKey]);
  const summary = _inputSummary(input);
  const hasInput = summary.length > 0 ? 'true' : 'false';
  const summaryHtml = summary ? `<div class="qx-tc-input">${_esc(summary)}</div>` : '';

  return (
    `<div class="qx-tool-card" data-tool="${toolName}" data-state="${stateKey}" data-has-input="${hasInput}">` +
      `<div class="qx-tc-head">` +
        `<span class="qx-tc-name">${toolName}</span>` +
        `<span class="qx-tc-status">${label}</span>` +
      `</div>` +
      summaryHtml +
    `</div>`
  );
}

function renderConfidenceBadge(score) {
  if (typeof score !== 'number' || !isFinite(score)) return '';
  const pct = Math.round(score * 100);
  let tier = 'low';
  if (score >= 0.70) tier = 'high';
  else if (score >= 0.40) tier = 'med';
  return `<span class="qx-confidence" data-tier="${tier}" title="Source-match confidence">${pct}% match</span>`;
}

function renderSourceChips(sources) {
  if (!Array.isArray(sources)) return '';
  // QC-HOLES vanish fix: a null/primitive entry used to throw here, and the
  // widget's finalize catch deleted the whole rendered reply. Filter first.
  sources = sources.filter((s) => s && typeof s === 'object');
  if (sources.length === 0) return '';
  const chips = sources.slice(0, 5).map((s) => {
    const label = _esc(s.source || '');
    const section = _esc(s.section || '');
    const score = typeof s.score === 'number' && isFinite(s.score) ? Math.round(s.score * 100) : null;
    const pinned = s.pinned === true ? ' data-pinned="true"' : '';
    const inner = section ? `${label} <span class="qx-chip-sec">› ${section}</span>` : label;
    const scoreSpan = score != null ? ` <span class="qx-chip-score">${score}%</span>` : '';
    const body = `${inner}${scoreSpan}`;
    // A server-vetted citation page (`url`) wins over a source that is itself a URL.
    const linkTarget = _isSafeUrl(s.url) ? s.url : (_isSafeUrl(s.source) ? s.source : null);
    if (linkTarget) {
      const href = _escHref(linkTarget);
      return `<a class="qx-chip" href="${href}" target="_blank" rel="noopener noreferrer"${pinned}>${body}</a>`;
    }
    return `<span class="qx-chip"${pinned}>${body}</span>`;
  }).join('');
  return `<div class="qx-chips">${chips}</div>`;
}

module.exports = { renderToolCard, renderConfidenceBadge, renderSourceChips };
