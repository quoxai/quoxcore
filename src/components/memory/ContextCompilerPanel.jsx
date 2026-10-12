/**
 * QuoxCORE Context Compiler Panel
 *
 * UI for visualizing how context is assembled for LLM interactions.
 * Shows budget allocation, section breakdown, and compilation preview.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  compileContext,
  quickCompile,
  fullCompile,
  formatPacketAsText,
  previewCompilation,
  validatePacket,
  COMPILER_CONFIG
} from '../../services/contextCompiler'
import { LocalOnlyNotice } from './LocalOnlyNotice'
import './memory.css'

// Section colors for visual distinction
const SECTION_COLORS = {
  userKernel: '#38bdf8',
  workingSet: '#e74c3c',
  operationalState: '#27ae60',
  openLoops: '#f39c12',
  intents: '#3498db',
  beliefs: '#1abc9c',
  failures: '#e74c3c',
  memories: '#4a9eff',
  decisions: '#0ea5e9',
  contradictions: '#e74c3c',
  style: '#95a5a6'
}

/**
 * Context Compiler Panel
 */
export function ContextCompilerPanel({ onClose }) {
  const [packet, setPacket] = useState(null)
  const [formattedText, setFormattedText] = useState('')
  const [queryInput, setQueryInput] = useState('')
  const [compileMode, setCompileMode] = useState('full') // quick | full | custom
  const [loading, setLoading] = useState(false)
  const [validation, setValidation] = useState(null)
  const [activeTab, setActiveTab] = useState('overview')
  const [showRawJson, setShowRawJson] = useState(false)

  // Preview compilation on query change
  const [preview, setPreview] = useState(null)
  useEffect(() => {
    if (queryInput.trim()) {
      const previewData = previewCompilation(queryInput)
      setPreview(previewData)
    } else {
      setPreview(null)
    }
  }, [queryInput])

  // Compile context
  const handleCompile = useCallback(async () => {
    if (!queryInput.trim()) return

    setLoading(true)
    try {
      let result
      switch (compileMode) {
        case 'quick':
          result = await quickCompile(queryInput)
          break
        case 'full':
          result = await fullCompile(queryInput)
          break
        default:
          result = await compileContext(queryInput)
      }

      setPacket(result)
      setFormattedText(formatPacketAsText(result))
      setValidation(validatePacket(result))
    } catch (err) {
      console.error('Compilation failed:', err)
      setValidation({ valid: false, issues: [err.message] })
    }
    setLoading(false)
  }, [queryInput, compileMode])

  // Budget visualization data
  const budgetData = packet?.metadata?.budget ? {
    used: packet.metadata.budget.used,
    total: packet.metadata.budget.total,
    remaining: packet.metadata.budget.remaining,
    percent: packet.metadata.budget.utilizationPercent
  } : null

  // Section breakdown
  const sectionBreakdown = packet?.metadata?.sections || {}

  return (
    <div className="context-compiler-panel">
      {/* Header */}
      <div className="cc-header">
        <div className="cc-title">
          <span className="cc-icon">{'{}'}</span>
          <h2>Context Compiler</h2>
        </div>
        <div className="cc-header-actions">
          {onClose && (
            <button className="cc-close-btn" onClick={onClose}>X</button>
          )}
        </div>
      </div>

      <LocalOnlyNotice label="working set, belief, failure, and style sections of this preview" />

      {/* Query Input */}
      <div className="cc-query-section">
        <div className="cc-query-input">
          <input
            type="text"
            placeholder="Enter a test query to compile context..."
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCompile()}
          />
        </div>
        <div className="cc-compile-options">
          <select
            value={compileMode}
            onChange={(e) => setCompileMode(e.target.value)}
          >
            <option value="quick">Quick (~2000 tokens)</option>
            <option value="full">Full (~4000 tokens)</option>
            <option value="custom">Custom</option>
          </select>
          <button
            className="cc-compile-btn"
            onClick={handleCompile}
            disabled={loading || !queryInput.trim()}
          >
            {loading ? 'Compiling...' : 'Compile'}
          </button>
        </div>
      </div>

      {/* Preview (before compilation) */}
      {preview && !packet && (
        <div className="cc-preview">
          <h4>Compilation Preview</h4>
          <div className="cc-preview-grid">
            <div className="cc-preview-item">
              <span className="preview-label">Current Focus</span>
              <span className={`preview-value ${preview.wouldInclude.currentFocus ? 'yes' : 'no'}`}>
                {preview.wouldInclude.currentFocus ? 'Yes' : 'No'}
              </span>
            </div>
            <div className="cc-preview-item">
              <span className="preview-label">Projects</span>
              <span className="preview-value">{preview.wouldInclude.activeProjects}</span>
            </div>
            <div className="cc-preview-item">
              <span className="preview-label">Entities</span>
              <span className="preview-value">{preview.wouldInclude.recentEntities}</span>
            </div>
            <div className="cc-preview-item">
              <span className="preview-label">Open Loops</span>
              <span className="preview-value">{preview.wouldInclude.relevantOpenLoops}</span>
            </div>
            <div className="cc-preview-item">
              <span className="preview-label">Decisions</span>
              <span className="preview-value">{preview.wouldInclude.recentDecisions}</span>
            </div>
            <div className="cc-preview-item">
              <span className="preview-label">Est. Tokens</span>
              <span className="preview-value">
                {preview.estimatedTokens.min} - {preview.estimatedTokens.max}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Results */}
      {packet && (
        <>
          {/* Validation Status */}
          {validation && (
            <div className={`cc-validation ${validation.valid ? 'valid' : 'invalid'}`}>
              <span className="validation-icon">{validation.valid ? 'OK' : '!'}</span>
              <span className="validation-text">
                {validation.valid ? 'Packet Valid' : `Issues: ${validation.issues.join(', ')}`}
              </span>
              <span className="compilation-time">
                Compiled in {packet.metadata.processingTimeMs}ms
              </span>
            </div>
          )}

          {/* Budget Overview */}
          {budgetData && (
            <div className="cc-budget-section">
              <h4>Token Budget</h4>
              <div className="cc-budget-bar">
                <div
                  className="cc-budget-used"
                  style={{ width: `${budgetData.percent}%` }}
                />
                <div className="cc-budget-labels">
                  <span>Used: {budgetData.used}</span>
                  <span>{budgetData.percent}%</span>
                  <span>Total: {budgetData.total}</span>
                </div>
              </div>
            </div>
          )}

          {/* Tab Navigation */}
          <div className="cc-tabs">
            <button
              className={activeTab === 'overview' ? 'active' : ''}
              onClick={() => setActiveTab('overview')}
            >
              Overview
            </button>
            <button
              className={activeTab === 'sections' ? 'active' : ''}
              onClick={() => setActiveTab('sections')}
            >
              Sections
            </button>
            <button
              className={activeTab === 'formatted' ? 'active' : ''}
              onClick={() => setActiveTab('formatted')}
            >
              Formatted
            </button>
            <button
              className={activeTab === 'raw' ? 'active' : ''}
              onClick={() => setActiveTab('raw')}
            >
              Raw JSON
            </button>
          </div>

          {/* Content */}
          <div className="cc-content">
            {activeTab === 'overview' && (
              <OverviewTab packet={packet} sectionBreakdown={sectionBreakdown} />
            )}
            {activeTab === 'sections' && (
              <SectionsTab packet={packet} />
            )}
            {activeTab === 'formatted' && (
              <FormattedTab text={formattedText} />
            )}
            {activeTab === 'raw' && (
              <RawJsonTab packet={packet} />
            )}
          </div>
        </>
      )}

      {/* Empty State */}
      {!packet && !preview && (
        <div className="cc-empty-state">
          <div className="empty-icon">{'{...}'}</div>
          <p>Enter a query above to see how context would be compiled</p>
          <p className="empty-hint">
            The Context Compiler assembles relevant memories, current state,
            and user preferences into a structured packet for LLM interactions.
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * Overview Tab - High-level compilation summary
 */
function OverviewTab({ packet, sectionBreakdown }) {
  // Section usage chart
  const sections = Object.entries(sectionBreakdown)
    .filter(([_, data]) => data.tokens > 0)
    .sort((a, b) => b[1].tokens - a[1].tokens)

  const totalTokens = sections.reduce((sum, [_, data]) => sum + data.tokens, 0)

  return (
    <div className="cc-overview">
      {/* Section Token Distribution */}
      <div className="cc-section-chart">
        <h4>Token Distribution</h4>
        <div className="cc-chart-bars">
          {sections.map(([name, data]) => {
            const percent = Math.round((data.tokens / totalTokens) * 100)
            return (
              <div key={name} className="cc-chart-row">
                <span className="chart-label">{name}</span>
                <div className="chart-bar-container">
                  <div
                    className="chart-bar"
                    style={{
                      width: `${percent}%`,
                      backgroundColor: SECTION_COLORS[name] || '#4a9eff'
                    }}
                  />
                </div>
                <span className="chart-value">{data.tokens}t</span>
                <span className="chart-items">
                  {data.items !== undefined && `(${data.items} items)`}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Key Metrics */}
      <div className="cc-metrics-grid">
        <div className="cc-metric">
          <span className="metric-value">
            {packet.workingSet.currentFocus ? 'Yes' : 'No'}
          </span>
          <span className="metric-label">Has Focus</span>
        </div>
        <div className="cc-metric">
          <span className="metric-value">{packet.openLoops.length}</span>
          <span className="metric-label">Open Loops</span>
        </div>
        <div className="cc-metric">
          <span className="metric-value">{packet.memories.length}</span>
          <span className="metric-label">Memories</span>
        </div>
        <div className="cc-metric">
          <span className="metric-value">{packet.contradictions.length}</span>
          <span className="metric-label">Conflicts</span>
        </div>
        <div className="cc-metric">
          <span className="metric-value">{packet.warnings.length}</span>
          <span className="metric-label">Warnings</span>
        </div>
        <div className="cc-metric">
          <span className="metric-value">{packet.failures?.length || 0}</span>
          <span className="metric-label">Failures</span>
        </div>
      </div>

      {/* Warnings */}
      {packet.warnings.length > 0 && (
        <div className="cc-warnings">
          <h4>Warnings</h4>
          <div className="cc-warnings-list">
            {packet.warnings.map((w, idx) => (
              <div key={idx} className="cc-warning-item">
                <span className="warning-icon">!</span>
                <span className="warning-text">{w.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Contradictions */}
      {packet.contradictions.length > 0 && (
        <div className="cc-contradictions">
          <h4>Memory Conflicts</h4>
          <div className="cc-contradictions-list">
            {packet.contradictions.map((c, idx) => (
              <div key={idx} className="cc-contradiction-item">
                <div className="contradiction-claims">
                  <span className="claim-a">"{c.claim_a}"</span>
                  <span className="vs">vs</span>
                  <span className="claim-b">"{c.claim_b}"</span>
                </div>
                {c.resolution && (
                  <div className="contradiction-resolution">{c.resolution}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Sections Tab - Detailed view of each section
 */
function SectionsTab({ packet }) {
  const [expandedSections, setExpandedSections] = useState(new Set(['workingSet', 'memories']))

  const toggleSection = (section) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(section)) {
        next.delete(section)
      } else {
        next.add(section)
      }
      return next
    })
  }

  return (
    <div className="cc-sections">
      {/* User Kernel */}
      <SectionCard
        name="userKernel"
        title="User Kernel"
        color={SECTION_COLORS.userKernel}
        expanded={expandedSections.has('userKernel')}
        onToggle={() => toggleSection('userKernel')}
      >
        <div className="section-content">
          {packet.userKernel.name && <p><strong>Name:</strong> {packet.userKernel.name}</p>}
          {packet.userKernel.role && <p><strong>Role:</strong> {packet.userKernel.role}</p>}
          {Object.keys(packet.userKernel.preferences).length > 0 && (
            <div className="prefs-list">
              <strong>Preferences:</strong>
              {Object.entries(packet.userKernel.preferences).map(([k, v]) => (
                <span key={k} className="pref-item">{k}: {v}</span>
              ))}
            </div>
          )}
        </div>
      </SectionCard>

      {/* Working Set */}
      <SectionCard
        name="workingSet"
        title="Working Set"
        color={SECTION_COLORS.workingSet}
        expanded={expandedSections.has('workingSet')}
        onToggle={() => toggleSection('workingSet')}
      >
        <div className="section-content">
          {packet.workingSet.currentFocus && (
            <p><strong>Focus:</strong> {packet.workingSet.currentFocus}</p>
          )}
          {packet.workingSet.activeProjects.length > 0 && (
            <p><strong>Projects:</strong> {packet.workingSet.activeProjects.join(', ')}</p>
          )}
          {packet.workingSet.recentEntities.length > 0 && (
            <div className="entities-list">
              <strong>Recent Entities:</strong>
              {packet.workingSet.recentEntities.map((e, i) => (
                <span key={i} className="entity-tag">{e}</span>
              ))}
            </div>
          )}
        </div>
      </SectionCard>

      {/* Open Loops */}
      <SectionCard
        name="openLoops"
        title="Open Loops"
        color={SECTION_COLORS.openLoops}
        count={packet.openLoops.length}
        expanded={expandedSections.has('openLoops')}
        onToggle={() => toggleSection('openLoops')}
      >
        <div className="section-content">
          {packet.openLoops.length > 0 ? (
            <div className="loops-list">
              {packet.openLoops.map((loop, idx) => (
                <div key={idx} className={`loop-item priority-${loop.priority}`}>
                  <span className="loop-type">[{loop.type}]</span>
                  <span className="loop-desc">{loop.description}</span>
                  {loop.whereWeLeftOff && (
                    <span className="loop-context">Left off: {loop.whereWeLeftOff}</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="empty">No open loops</p>
          )}
        </div>
      </SectionCard>

      {/* Beliefs */}
      <SectionCard
        name="beliefs"
        title="Epistemic State"
        color={SECTION_COLORS.beliefs}
        expanded={expandedSections.has('beliefs')}
        onToggle={() => toggleSection('beliefs')}
      >
        <div className="section-content">
          {packet.beliefs.facts?.length > 0 && (
            <div className="beliefs-subsection">
              <h5>Facts</h5>
              {packet.beliefs.facts.map((f, idx) => (
                <div key={idx} className="belief-item fact">
                  {f.content}
                  {f.confidence && <span className="confidence">{Math.round(f.confidence * 100)}%</span>}
                </div>
              ))}
            </div>
          )}
          {packet.beliefs.assumptions?.length > 0 && (
            <div className="beliefs-subsection">
              <h5>Assumptions</h5>
              {packet.beliefs.assumptions.map((a, idx) => (
                <div key={idx} className="belief-item assumption">
                  {a.content}
                  {a.basis && <span className="basis">{a.basis}</span>}
                </div>
              ))}
            </div>
          )}
          {packet.beliefs.hypotheses?.length > 0 && (
            <div className="beliefs-subsection">
              <h5>Hypotheses</h5>
              {packet.beliefs.hypotheses.map((h, idx) => (
                <div key={idx} className="belief-item hypothesis">
                  {h.statement}
                  {h.evidence && (
                    <span className="evidence">
                      [{h.evidence.supporting}+ / {h.evidence.refuting}-]
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {!packet.beliefs.facts?.length && !packet.beliefs.assumptions?.length && !packet.beliefs.hypotheses?.length && (
            <p className="empty">No epistemic state recorded</p>
          )}
        </div>
      </SectionCard>

      {/* Failures */}
      <SectionCard
        name="failures"
        title="Failure Warnings"
        color={SECTION_COLORS.failures}
        count={packet.failures?.length || 0}
        expanded={expandedSections.has('failures')}
        onToggle={() => toggleSection('failures')}
      >
        <div className="section-content">
          {packet.failures?.length > 0 ? (
            <div className="failures-list">
              {packet.failures.map((f, idx) => (
                <div key={idx} className="failure-item">
                  <div className="failure-what">{f.whatFailed}</div>
                  <div className="failure-reason">{f.reason}</div>
                  {f.advice && <div className="failure-advice">Advice: {f.advice}</div>}
                  {f.workaround && <div className="failure-workaround">Workaround: {f.workaround}</div>}
                </div>
              ))}
            </div>
          ) : (
            <p className="empty">No relevant failures</p>
          )}
        </div>
      </SectionCard>

      {/* Memories */}
      <SectionCard
        name="memories"
        title="Retrieved Memories"
        color={SECTION_COLORS.memories}
        count={packet.memories.length}
        expanded={expandedSections.has('memories')}
        onToggle={() => toggleSection('memories')}
      >
        <div className="section-content">
          {packet.memories.length > 0 ? (
            <div className="memories-list">
              {packet.memories.map((mem, idx) => (
                <div key={idx} className={`memory-item type-${mem.type}`}>
                  <span className="memory-content">{mem.content}</span>
                  <div className="memory-meta">
                    <span className="memory-type">{mem.type}</span>
                    {mem.confidence && (
                      <span className="memory-confidence">{Math.round(mem.confidence * 100)}%</span>
                    )}
                    <span className="memory-source">{mem.source}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty">No memories retrieved</p>
          )}
        </div>
      </SectionCard>

      {/* Decisions */}
      <SectionCard
        name="decisions"
        title="Recent Decisions"
        color={SECTION_COLORS.decisions}
        count={packet.decisions.length}
        expanded={expandedSections.has('decisions')}
        onToggle={() => toggleSection('decisions')}
      >
        <div className="section-content">
          {packet.decisions.length > 0 ? (
            <div className="decisions-list">
              {packet.decisions.map((dec, idx) => (
                <div key={idx} className="decision-item">
                  <span className="decision-text">{dec.decision}</span>
                  {dec.rationale && (
                    <span className="decision-rationale">{dec.rationale}</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="empty">No recent decisions</p>
          )}
        </div>
      </SectionCard>

      {/* Style */}
      <SectionCard
        name="style"
        title="Style Recommendations"
        color={SECTION_COLORS.style}
        expanded={expandedSections.has('style')}
        onToggle={() => toggleSection('style')}
      >
        <div className="section-content">
          {Object.keys(packet.style.recommendations || {}).length > 0 && (
            <div className="style-recs">
              {Object.entries(packet.style.recommendations).map(([k, v]) => (
                v && <span key={k} className="style-rec">{k}: {v}</span>
              ))}
            </div>
          )}
          {packet.style.instructions?.length > 0 && (
            <div className="style-instructions">
              <strong>Instructions:</strong>
              <ul>
                {packet.style.instructions.map((inst, idx) => (
                  <li key={idx}>{inst}</li>
                ))}
              </ul>
            </div>
          )}
          {!Object.keys(packet.style.recommendations || {}).length && !packet.style.instructions?.length && (
            <p className="empty">No style recommendations</p>
          )}
        </div>
      </SectionCard>
    </div>
  )
}

/**
 * Section Card Component
 */
function SectionCard({ name, title, color, count, expanded, onToggle, children }) {
  return (
    <div className={`cc-section-card ${expanded ? 'expanded' : ''}`}>
      <div
        className="section-header"
        onClick={onToggle}
        style={{ borderLeftColor: color }}
      >
        <span className="expand-icon">{expanded ? 'v' : '>'}</span>
        <span className="section-title">{title}</span>
        {count !== undefined && <span className="section-count">{count}</span>}
      </div>
      {expanded && children}
    </div>
  )
}

/**
 * Formatted Tab - Shows prompt-ready text
 */
function FormattedTab({ text }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="cc-formatted">
      <div className="formatted-actions">
        <button className="copy-btn" onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
        <span className="char-count">{text.length} chars</span>
      </div>
      <pre className="formatted-text">{text}</pre>
    </div>
  )
}

/**
 * Raw JSON Tab
 */
function RawJsonTab({ packet }) {
  const [copied, setCopied] = useState(false)
  const jsonText = JSON.stringify(packet, null, 2)

  const handleCopy = () => {
    navigator.clipboard.writeText(jsonText)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="cc-raw-json">
      <div className="json-actions">
        <button className="copy-btn" onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy JSON'}
        </button>
        <span className="json-size">{(jsonText.length / 1024).toFixed(1)} KB</span>
      </div>
      <pre className="json-text">{jsonText}</pre>
    </div>
  )
}

export default ContextCompilerPanel
