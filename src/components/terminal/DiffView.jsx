/**
 * DiffView
 *
 * Presentational component that renders a line-level diff with colored lines.
 * Added lines are green, removed lines are red, context lines are gray.
 * Consecutive context blocks >5 lines are collapsed with an expand toggle.
 *
 * Props:
 *   diff: { lines: [{ type: 'added'|'removed'|'context', content: string }],
 *           stats: { added: number, removed: number, context: number } }
 */

import { useState, useMemo } from 'react';
import './DiffView.css';

const CONTEXT_COLLAPSE_THRESHOLD = 5;

/**
 * Group diff lines into renderable chunks: context blocks, added/removed lines.
 * Consecutive context lines > CONTEXT_COLLAPSE_THRESHOLD are collapsed.
 */
function buildChunks(lines) {
  const chunks = [];
  let contextBuffer = [];
  let newLineNum = 0;

  function flushContext() {
    if (contextBuffer.length === 0) return;
    if (contextBuffer.length > CONTEXT_COLLAPSE_THRESHOLD) {
      // Show first 2, collapsible middle, last 2
      const head = contextBuffer.slice(0, 2);
      const middle = contextBuffer.slice(2, -2);
      const tail = contextBuffer.slice(-2);
      chunks.push({ type: 'context-lines', lines: head });
      chunks.push({ type: 'collapsed', count: middle.length, lines: middle });
      chunks.push({ type: 'context-lines', lines: tail });
    } else {
      chunks.push({ type: 'context-lines', lines: contextBuffer });
    }
    contextBuffer = [];
  }

  for (const line of lines) {
    if (line.type === 'context') {
      newLineNum++;
      contextBuffer.push({ ...line, lineNum: newLineNum });
    } else {
      flushContext();
      if (line.type === 'added') {
        newLineNum++;
        chunks.push({ type: 'added', content: line.content, lineNum: newLineNum });
      } else {
        chunks.push({ type: 'removed', content: line.content });
      }
    }
  }
  flushContext();

  return chunks;
}

export default function DiffView({ diff }) {
  const [expandedSections, setExpandedSections] = useState(new Set());

  const chunks = useMemo(() => buildChunks(diff.lines), [diff.lines]);

  const toggleSection = (idx) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  if (!diff || !diff.lines || diff.lines.length === 0) {
    return <div className="diff-view__empty">No changes</div>;
  }

  return (
    <div className="diff-view">
      {/* Stats bar */}
      <div className="diff-view__stats">
        {diff.stats.added > 0 && (
          <span className="diff-view__stat diff-view__stat--added">+{diff.stats.added}</span>
        )}
        {diff.stats.removed > 0 && (
          <span className="diff-view__stat diff-view__stat--removed">-{diff.stats.removed}</span>
        )}
        <span className="diff-view__stat diff-view__stat--context">{diff.stats.context} unchanged</span>
      </div>

      {/* Diff lines */}
      <div className="diff-view__lines">
        {chunks.map((chunk, idx) => {
          if (chunk.type === 'context-lines') {
            return chunk.lines.map((line, i) => (
              <div key={`ctx-${idx}-${i}`} className="diff-view__line diff-view__line--context">
                <span className="diff-view__gutter">{line.lineNum}</span>
                <span className="diff-view__content">{line.content || ' '}</span>
              </div>
            ));
          }

          if (chunk.type === 'collapsed') {
            const isExpanded = expandedSections.has(idx);
            if (isExpanded) {
              return chunk.lines.map((line, i) => (
                <div key={`exp-${idx}-${i}`} className="diff-view__line diff-view__line--context">
                  <span className="diff-view__gutter">{line.lineNum}</span>
                  <span className="diff-view__content">{line.content || ' '}</span>
                </div>
              ));
            }
            return (
              <div
                key={`col-${idx}`}
                className="diff-view__collapsed"
                onClick={() => toggleSection(idx)}
                role="button"
                tabIndex={0}
              >
                ... {chunk.count} unchanged lines ...
              </div>
            );
          }

          if (chunk.type === 'added') {
            return (
              <div key={`add-${idx}`} className="diff-view__line diff-view__line--added">
                <span className="diff-view__gutter">+</span>
                <span className="diff-view__content">{chunk.content || ' '}</span>
              </div>
            );
          }

          if (chunk.type === 'removed') {
            return (
              <div key={`rem-${idx}`} className="diff-view__line diff-view__line--removed">
                <span className="diff-view__gutter">-</span>
                <span className="diff-view__content">{chunk.content || ' '}</span>
              </div>
            );
          }

          return null;
        })}
      </div>
    </div>
  );
}
