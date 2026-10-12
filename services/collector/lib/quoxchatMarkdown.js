/**
 * QCX-4.2 — Safe markdown → HTML for the QuoxChat visitor widget.
 *
 * Threat model: the LLM may emit adversarial HTML/JS via prompt injection.
 * Strategy: HTML-escape the entire input first, then apply markdown regex
 * transforms on the already-escaped text. The only tags in the output are
 * emitted by this renderer. URLs are scheme-validated.
 *
 * Supported syntax (deliberate subset — what LLMs actually emit):
 *   # ## ###          headers (h1–h3)
 *   **bold**          strong
 *   *italic*          em
 *   `inline code`     code
 *   ```fenced```      <pre><code>
 *   - item            <ul><li>
 *   1. item           <ol><li>
 *   [text](url)       <a>   (http / https / mailto / // only)
 *   | a | b |...      tables (GFM)
 *   blank line        paragraph break
 *
 * This is a small hand-rolled renderer — no dependencies. The entire
 * widget has to fit in a single IIFE served from /widget.js, so pulling
 * in marked + DOMPurify would bloat every visitor's page and force a
 * build step we don't yet have. The renderer is tested exhaustively
 * against the XSS corpus in test/quoxchat-markdown.test.js.
 */

'use strict';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// URL scheme validation. Allow http(s), mailto, and protocol-relative (//host).
// Everything else (javascript:, data:, vbscript:, file:, etc.) is rejected.
function isSafeUrl(url) {
  const u = String(url).trim();
  if (u.startsWith('//')) return true;
  if (/^https?:\/\//i.test(u)) return true;
  if (/^mailto:/i.test(u)) return true;
  return false;
}

// Escape a URL for use in an href. Input is already HTML-escape-safe via
// escapeHtml, but we special-case quotes.
function escapeHref(url) {
  return String(url)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Apply inline transforms (code → bold → italic → links) to a single span
// of already-HTML-escaped text. Order matters: code first so its contents
// are not further rewritten, then bold before italic (** before *), then
// links last (their label is itself inline-rendered).
function renderInline(text) {
  // Inline code `foo` — content is already escaped, so just wrap.
  text = text.replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`);

  // Bold **foo**
  text = text.replace(/\*\*([^*\n][^*]*?)\*\*/g, (_, t) => `<strong>${t}</strong>`);

  // Italic *foo* — but not ** (already consumed by bold). Single asterisks
  // around word-ish text.
  text = text.replace(/(^|[^*])\*([^*\n][^*]*?)\*(?!\*)/g, (_, lead, t) => `${lead}<em>${t}</em>`);

  // Links [label](url) — unescape the URL we'll validate (the raw text was
  // HTML-escaped, so ampersands appear as &amp; — convert back for the
  // scheme check, then re-escape for the attribute).
  text = text.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (full, label, rawUrl) => {
    const url = rawUrl.replace(/&amp;/g, '&');
    if (!isSafeUrl(url)) return full; // leave the markdown as visible text
    const safeHref = escapeHref(url);
    // External http(s) links open in a new tab; mailto/// stay in-page.
    const attrs = /^https?:/i.test(url) ? ` target="_blank" rel="noopener noreferrer"` : '';
    return `<a href="${safeHref}"${attrs}>${label}</a>`;
  });

  return text;
}

// Block-level parser. Splits on blank lines, classifies each block, and
// renders it. Code fences are preserved verbatim (no inline transforms).
function renderBlocks(src) {
  const lines = src.split('\n');
  const blocks = [];
  let cur = [];
  let inFence = false;
  let fenceLang = '';
  let fenceBuf = [];

  const flush = () => {
    if (cur.length > 0) { blocks.push({ type: 'para', lines: cur }); cur = []; }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block boundary.
    const fenceOpen = line.match(/^```(\w*)\s*$/);
    if (fenceOpen && !inFence) {
      flush();
      inFence = true;
      fenceLang = fenceOpen[1] || '';
      fenceBuf = [];
      continue;
    }
    if (inFence) {
      if (/^```\s*$/.test(line)) {
        blocks.push({ type: 'code', lang: fenceLang, body: fenceBuf.join('\n') });
        inFence = false;
        fenceLang = '';
        fenceBuf = [];
      } else {
        fenceBuf.push(line);
      }
      continue;
    }

    // Blank line → paragraph break.
    if (/^\s*$/.test(line)) { flush(); continue; }

    cur.push(line);
  }
  // Close any dangling fence by treating accumulated lines as plain code.
  if (inFence && fenceBuf.length > 0) {
    blocks.push({ type: 'code', lang: fenceLang, body: fenceBuf.join('\n') });
  }
  flush();

  const rendered = [];
  for (const b of blocks) {
    if (b.type === 'code') {
      const body = escapeHtml(b.body);
      const cls = b.lang ? ` class="language-${escapeHtml(b.lang)}"` : '';
      rendered.push(`<pre><code${cls}>${body}\n</code></pre>`);
      continue;
    }

    // Para-classify: header? list? table? plain paragraph?
    const text = b.lines.join('\n');

    const h3 = text.match(/^###\s+(.*)$/);
    if (h3 && !text.includes('\n')) { rendered.push(`<h3>${renderInline(escapeHtml(h3[1]))}</h3>`); continue; }
    const h2 = text.match(/^##\s+(.*)$/);
    if (h2 && !text.includes('\n')) { rendered.push(`<h2>${renderInline(escapeHtml(h2[1]))}</h2>`); continue; }
    const h1 = text.match(/^#\s+(.*)$/);
    if (h1 && !text.includes('\n')) { rendered.push(`<h1>${renderInline(escapeHtml(h1[1]))}</h1>`); continue; }

    if (b.lines.every((l) => /^\s*-\s+/.test(l))) {
      const items = b.lines.map((l) => {
        const m = l.match(/^\s*-\s+(.*)$/);
        return `<li>${renderInline(escapeHtml(m[1]))}</li>`;
      });
      rendered.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (b.lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
      const items = b.lines.map((l) => {
        const m = l.match(/^\s*\d+\.\s+(.*)$/);
        return `<li>${renderInline(escapeHtml(m[1]))}</li>`;
      });
      rendered.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Table: at least 3 lines, second line is a separator, all lines have |.
    if (b.lines.length >= 2 &&
        /^\s*\|/.test(b.lines[0]) &&
        /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(b.lines[1])) {
      const splitRow = (r) => r.replace(/^\s*\|\s*|\s*\|\s*$/g, '').split(/\s*\|\s*/);
      const headers = splitRow(b.lines[0]).map((h) => `<th>${renderInline(escapeHtml(h))}</th>`).join('');
      const rows = b.lines.slice(2).map((r) => {
        const cells = splitRow(r).map((c) => `<td>${renderInline(escapeHtml(c))}</td>`).join('');
        return `<tr>${cells}</tr>`;
      }).join('');
      rendered.push(`<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`);
      continue;
    }

    // Default: paragraph. Multi-line content gets <br> between lines.
    const escapedLines = b.lines.map((l) => renderInline(escapeHtml(l)));
    rendered.push(`<p>${escapedLines.join('<br>')}</p>`);
  }
  return rendered.join('\n');
}

function renderMarkdown(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  return renderBlocks(text);
}

module.exports = { renderMarkdown };
