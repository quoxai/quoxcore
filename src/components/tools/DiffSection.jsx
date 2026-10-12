/**
 * DiffSection — Monaco DiffEditor section for the Toolsmith right rail.
 *
 * When pendingPatch is null: shows empty state.
 * When pendingPatch has 1 patch: renders the DiffEditor.
 * When pendingPatch has multiple patches: renders a file-tab row above the editor.
 *
 * Uses renderSideBySide:false (inline diff) per the plan's Bolt/v0 convention.
 *
 * Props:
 *   pendingPatch  { patches: [{ path, oldText, newText }], rationale } | null
 *   files         { [filename]: currentContent } — current editor state (fallback
 *                 if patch.oldText is stale)
 *   onApply       () => void
 *   onDiscard     () => void
 *   agentColor    CSS color (default '#f97316')
 */

import { useState, Suspense, lazy } from 'react'

// Lazy-load DiffEditor — already part of @monaco-editor/react bundle; lazy is
// belt-and-suspenders for tree-shaking and first-paint perf.
const DiffEditor = lazy(() =>
  import('@monaco-editor/react').then(m => ({ default: m.DiffEditor }))
)

const AGENT_COLOR = '#f97316'

const FILE_LANGUAGE = {
  'script.py': 'python',
  'tool.json': 'json',
  'tests.json': 'json',
  'requirements.txt': 'plaintext',
  'README.md': 'markdown',
}

export function DiffSection({
  pendingPatch = null,
  files = {},
  onApply,
  onDiscard,
  agentColor = AGENT_COLOR,
}) {
  const [activeTab, setActiveTab] = useState(0)

  // Normalise active tab index when patches change
  const patches = pendingPatch?.patches || []
  const safeTab = Math.min(activeTab, Math.max(patches.length - 1, 0))

  if (!pendingPatch || patches.length === 0) {
    return (
      <div
        data-testid="diff-section-empty"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          gap: 8,
          color: 'rgba(255,255,255,0.3)',
          fontSize: 12,
          fontFamily: "'Inter',system-ui,sans-serif",
          padding: '24px 16px',
          textAlign: 'center',
        }}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="rgba(255,255,255,0.2)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        No proposed edits. Ask Toolsmith to write or refactor code.
      </div>
    )
  }

  const activePatch = patches[safeTab]
  const language = FILE_LANGUAGE[activePatch?.path] || 'plaintext'

  // The "original" side is oldText from the patch (what was before).
  // If oldText is empty (new file), fall back to current file content.
  const originalValue = activePatch?.oldText != null
    ? activePatch.oldText
    : (files[activePatch?.path] || '')

  const modifiedValue = activePatch?.newText || ''

  return (
    <div
      data-testid="diff-section"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {/* File tabs — only shown when multiple patches */}
      {patches.length > 1 && (
        <div
          data-testid="diff-file-tabs"
          style={{
            display: 'flex',
            flexShrink: 0,
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            padding: '0 4px',
            overflowX: 'auto',
          }}
        >
          {patches.map((p, i) => {
            const isActive = i === safeTab
            return (
              <button
                key={p.path}
                data-testid={`diff-tab-${p.path}`}
                onClick={() => setActiveTab(i)}
                title={p.path}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: "'Inter',system-ui,sans-serif",
                  color: isActive ? agentColor : 'var(--text-secondary, rgba(255,255,255,0.6))',
                  background: 'none',
                  border: 'none',
                  borderBottom: isActive ? `2px solid ${agentColor}` : '2px solid transparent',
                  padding: '4px 6px 2px',
                  cursor: 'pointer',
                  flexShrink: 0,
                  whiteSpace: 'nowrap',
                  transition: 'color 0.12s ease, border-color 0.12s ease',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {/* Generic file icon — consistent with outer tab icon convention */}
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                  aria-hidden="true"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
                {p.path}
              </button>
            )
          })}
        </div>
      )}

      {/* DiffEditor */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Suspense
          fallback={
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <span className="qx-spinner qx-spinner--sm" />
            </div>
          }
        >
          <DiffEditor
            height="100%"
            language={language}
            original={originalValue}
            modified={modifiedValue}
            theme="vs-dark"
            options={{
              renderSideBySide: false,
              readOnly: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 11,
              padding: { top: 4, bottom: 4 },
              lineDecorationsWidth: 0,
            }}
          />
        </Suspense>
      </div>

      {/* Action bar */}
      <div
        data-testid="diff-action-bar"
        style={{
          display: 'flex',
          gap: 6,
          padding: '6px 8px',
          flexShrink: 0,
          borderTop: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <button
          data-testid="diff-apply-btn"
          onClick={onApply}
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: '4px 12px',
            borderRadius: 5,
            border: `1px solid ${agentColor}50`,
            background: `${agentColor}18`,
            color: agentColor,
            cursor: 'pointer',
            fontFamily: "'Inter',system-ui,sans-serif",
          }}
        >
          Apply
        </button>
        <button
          data-testid="diff-discard-btn"
          onClick={onDiscard}
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: '4px 12px',
            borderRadius: 5,
            border: '1px solid rgba(255,255,255,0.15)',
            background: 'transparent',
            color: 'rgba(255,255,255,0.5)',
            cursor: 'pointer',
            fontFamily: "'Inter',system-ui,sans-serif",
          }}
        >
          Discard
        </button>
      </div>
    </div>
  )
}

export default DiffSection
