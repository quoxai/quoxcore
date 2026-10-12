/**
 * FileSkillPanel Component
 *
 * File operations skill panel:
 * - Shows available skills based on file selection
 * - Execute skills (summarize, compare, extract, etc.)
 * - Display results with save option
 *
 * Premium feature - requires Advanced Memory plugin.
 */

import { useState, useEffect } from 'react'
import {
  FILE_SKILLS,
  isFileOpsAvailable,
  getAvailableSkills,
  executeSkill,
  saveResultAsFile
} from '../../services/fileOpsAgent'
import './file-skill-panel.css'

/**
 * Skill button component
 */
function SkillButton({ skill, onClick, disabled }) {
  const icons = {
    document: (
      <><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></>
    ),
    compare: (
      <><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></>
    ),
    code: (
      <><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></>
    ),
    search: (
      <><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></>
    ),
    warning: (
      <><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></>
    ),
    quiz: (
      <><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></>
    )
  }

  return (
    <button
      className={`skill-button ${disabled ? 'disabled' : ''}`}
      onClick={() => !disabled && onClick(skill)}
      disabled={disabled}
      title={skill.description}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {icons[skill.icon] || icons.document}
      </svg>
      <span>{skill.name}</span>
    </button>
  )
}

/**
 * Result display component
 */
function SkillResult({ result, onSave, onClose }) {
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(result)
    } finally {
      setSaving(false)
    }
  }

  if (!result) return null

  const hasError = result.error

  return (
    <div className={`skill-result ${hasError ? 'error' : ''}`}>
      <div className="skill-result-header">
        <h4>
          {hasError ? 'Error' : FILE_SKILLS[result.skillId]?.name || 'Result'}
        </h4>
        <button className="skill-result-close" onClick={onClose}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <div className="skill-result-body">
        {hasError ? (
          <div className="skill-error">
            <p>{result.message}</p>
            {result.upgrade && (
              <div className="skill-upgrade-cta">
                <h5>{result.upgrade.title}</h5>
                <p>{result.upgrade.message}</p>
                <span className="skill-price">{result.upgrade.price}</span>
              </div>
            )}
          </div>
        ) : (
          <>
            {/* File info */}
            {result.file && (
              <div className="skill-result-file">
                <span className="file-label">File:</span>
                <span className="file-name">{result.file.name}</span>
              </div>
            )}

            {result.files && (
              <div className="skill-result-files">
                <span className="file-label">Files:</span>
                <ul>
                  {result.files.map(f => (
                    <li key={f.id}>{f.name}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Result data */}
            {result.result && (
              <div className="skill-result-data">
                {/* Summary */}
                {result.result.summary && (
                  <div className="result-section">
                    <h5>Summary</h5>
                    <p>{result.result.summary}</p>
                  </div>
                )}

                {/* Key Points */}
                {result.result.keyPoints?.length > 0 && (
                  <div className="result-section">
                    <h5>Key Points</h5>
                    <ul>
                      {result.result.keyPoints.map((point, i) => (
                        <li key={i}>{point}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Topics/Themes */}
                {(result.result.mainTopics || result.result.themes)?.length > 0 && (
                  <div className="result-section">
                    <h5>Topics</h5>
                    <div className="result-tags">
                      {(result.result.mainTopics || result.result.themes).map((topic, i) => (
                        <span key={i} className="result-tag">{topic}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Comparison metrics */}
                {result.result.overlapPercentage !== undefined && (
                  <div className="result-section">
                    <h5>Similarity</h5>
                    <div className="result-metric">
                      <span className="metric-value">{result.result.overlapPercentage}%</span>
                      <span className="metric-label">word overlap</span>
                    </div>
                  </div>
                )}

                {/* Differences */}
                {result.result.differences?.length > 0 && (
                  <div className="result-section">
                    <h5>Differences</h5>
                    <ul>
                      {result.result.differences.map((diff, i) => (
                        <li key={i}>{diff}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Extracted data */}
                {result.result.data && (
                  <div className="result-section">
                    <h5>Extracted Data</h5>
                    <pre className="result-json">
                      {JSON.stringify(result.result.data, null, 2)}
                    </pre>
                  </div>
                )}

                {/* Stats */}
                {result.result.wordCount && (
                  <div className="result-stats">
                    <span>{result.result.wordCount} words</span>
                    {result.result.fileCount && (
                      <span>{result.result.fileCount} files</span>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Status indicator */}
            {result.status === 'ready' && (
              <div className="skill-status-ready">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/>
                </svg>
                <span>Analysis ready - connect Claude API for full results</span>
              </div>
            )}
          </>
        )}
      </div>

      {!hasError && (
        <div className="skill-result-actions">
          <button
            className="skill-action-btn save"
            onClick={handleSave}
            disabled={saving}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
            </svg>
            {saving ? 'Saving...' : 'Save as File'}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Main FileSkillPanel Component
 */
export function FileSkillPanel({
  selectedFiles = [],
  currentFolder = '/',
  onResultSaved
}) {
  const [availableSkills, setAvailableSkills] = useState([])
  const [executing, setExecuting] = useState(null)
  const [result, setResult] = useState(null)
  const isAvailable = isFileOpsAvailable()

  // Update available skills when selection changes
  useEffect(() => {
    const skills = getAvailableSkills(selectedFiles.length)
    setAvailableSkills(skills)
  }, [selectedFiles])

  // Handle skill execution
  const handleExecuteSkill = async (skill) => {
    if (executing) return

    setExecuting(skill.id)
    setResult(null)

    try {
      const fileIds = selectedFiles.map(f => f.id)
      const skillResult = await executeSkill(skill.id, fileIds, {
        folderPath: currentFolder
      })
      setResult(skillResult)
    } catch (err) {
      setResult({
        error: 'execution_failed',
        message: err.message
      })
    } finally {
      setExecuting(null)
    }
  }

  // Handle save result
  const handleSaveResult = async (resultToSave) => {
    try {
      const saved = await saveResultAsFile(resultToSave, {
        folderPath: currentFolder
      })
      onResultSaved?.(saved)
      return saved
    } catch (err) {
      console.error('Failed to save result:', err)
      throw err
    }
  }

  // Don't render if no files selected or not available
  if (selectedFiles.length === 0) {
    return null
  }

  return (
    <div className="file-skill-panel">
      <div className="skill-panel-header">
        <h3>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>
          </svg>
          ARCHIVIST Skills
        </h3>
        <span className="skill-selection-count">
          {selectedFiles.length} file{selectedFiles.length !== 1 ? 's' : ''} selected
        </span>
      </div>

      {!isAvailable ? (
        <div className="skill-premium-banner">
          <div className="premium-icon">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
          </div>
          <div className="premium-text">
            <h4>File Intelligence</h4>
            <p>Summarize, compare, and extract data from files with ARCHIVIST agent.</p>
            <span className="premium-price">Advanced Memory - $99</span>
          </div>
        </div>
      ) : availableSkills.length === 0 ? (
        <div className="skill-no-skills">
          <p>No skills available for current selection.</p>
          <p className="skill-hint">
            Select 1 file for summarize/extract, 2 files for compare.
          </p>
        </div>
      ) : (
        <div className="skill-buttons">
          {availableSkills.map(skill => (
            <SkillButton
              key={skill.id}
              skill={skill}
              onClick={handleExecuteSkill}
              disabled={executing === skill.id}
            />
          ))}
        </div>
      )}

      {/* Loading indicator */}
      {executing && (
        <div className="skill-loading">
          <svg className="spin" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 11-6.22-8.56"/><path d="M21 3v6h-6"/>
          </svg>
          <span>Analyzing with {FILE_SKILLS[executing]?.name}...</span>
        </div>
      )}

      {/* Result display */}
      {result && (
        <SkillResult
          result={result}
          onSave={handleSaveResult}
          onClose={() => setResult(null)}
        />
      )}
    </div>
  )
}

export default FileSkillPanel
