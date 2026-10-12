/**
 * LiveAnalysisSection — wraps the AnalyserPanel + header for use as an
 * extraSection in ToolsmithChatSidebar.
 *
 * Extracted from the Preview-tab branch in ScriptForgeView to be a peer
 * section alongside Diff in the right rail.
 *
 * Props: same as AnalyserPanel (result, lastAnalysedAt, activeFile)
 */

import { AnalyserPanel } from './ScriptForgeView'

export function LiveAnalysisSection({ result, lastAnalysedAt, activeFile }) {
  return (
    <div
      data-testid="live-analysis-section"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        overflowY: 'auto',
      }}
    >
      <div style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'rgba(255,255,255,0.35)',
        padding: '8px 12px 4px',
        flexShrink: 0,
      }}>
        Live Analysis
      </div>
      <AnalyserPanel
        result={result}
        lastAnalysedAt={lastAnalysedAt}
        activeFile={activeFile}
      />
    </div>
  )
}

export default LiveAnalysisSection
