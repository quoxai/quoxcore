/**
 * QuoxCORE ChatGPT Import Panel
 *
 * UI for importing ChatGPT conversation exports into QuoxCORE's memory system.
 * Supports file upload, preview, and controlled import.
 */

import { useState, useRef, useCallback } from 'react'
import {
  parseExport,
  previewImport,
  importConversations,
  getExportStats
} from '../../services/chatgptImporter'
import { addToColdStorage, IMPORT_SOURCE } from '../../services/memoryPromotion'
import './memory.css'

/**
 * ChatGPT Import Panel
 */
export function ChatGPTImportPanel({ onClose, onImportComplete }) {
  const [step, setStep] = useState('upload') // upload, preview, importing, complete
  const [file, setFile] = useState(null)
  const [rawData, setRawData] = useState(null)
  const [stats, setStats] = useState(null)
  const [preview, setPreview] = useState(null)
  const [importOptions, setImportOptions] = useState({
    extractMemories: true,
    updateStyle: true,
    useColdStorage: true,
    limit: 0, // 0 = no limit
    minMessageCount: 2
  })
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0, status: '' })
  const [importResult, setImportResult] = useState(null)
  const [error, setError] = useState(null)

  const fileInputRef = useRef(null)

  // Handle file selection
  const handleFileSelect = useCallback(async (e) => {
    const selectedFile = e.target.files?.[0]
    if (!selectedFile) return

    setError(null)
    setFile(selectedFile)

    try {
      const text = await selectedFile.text()
      const data = JSON.parse(text)
      setRawData(data)

      // Get stats
      const exportStats = getExportStats(data)
      setStats(exportStats)

      // Generate preview
      setImportProgress({ current: 0, total: 0, status: 'Generating preview...' })
      const previewData = previewImport(data, { limit: 10 })
      setPreview(previewData)

      setStep('preview')
    } catch (err) {
      setError(`Failed to parse file: ${err.message}`)
    }
  }, [])

  // Handle drag and drop
  const handleDrop = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()

    const droppedFile = e.dataTransfer?.files?.[0]
    if (droppedFile) {
      // Create a synthetic event to reuse handleFileSelect
      const syntheticEvent = { target: { files: [droppedFile] } }
      handleFileSelect(syntheticEvent)
    }
  }, [handleFileSelect])

  const handleDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
  }

  // Handle import
  const [importStarting, setImportStarting] = useState(false)

  const handleImport = useCallback(async () => {
    if (!rawData) return

    // Immediate button feedback
    setImportStarting(true)

    // Yield to let React repaint the button before heavy work
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

    setStep('importing')
    setError(null)
    setImportProgress({ current: 0, total: stats?.conversationCount || 0, status: 'Parsing conversations...' })

    // Yield again so importing step renders before we block
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

    try {
      const result = await importConversations(rawData, {
        extractMemoriesEnabled: importOptions.extractMemories,
        updateStyleProfile: importOptions.updateStyle,
        limit: importOptions.limit || Infinity,
        minMessageCount: importOptions.minMessageCount,
        deduplicateMemories: true,
        onProgress: (progress) => {
          setImportProgress({
            current: progress.current,
            total: progress.total,
            status: progress.status
          })
        }
      })

      // If using cold storage, record the import for review tracking
      if (importOptions.useColdStorage) {
        try {
          addToColdStorage([], {
            source: IMPORT_SOURCE.CHATGPT,
            metadata: { conversationsProcessed: result.conversationsProcessed, memoriesSaved: result.memoriesSaved }
          })
        } catch {
          // Non-critical — memories already saved server-side
        }
      }

      setImportResult(result)
      setStep('complete')
      setImportStarting(false)
    } catch (err) {
      setError(`Import failed: ${err.message}`)
      setStep('preview')
      setImportStarting(false)
    }
  }, [rawData, stats, importOptions, importProgress])

  // Reset
  const handleReset = () => {
    setStep('upload')
    setFile(null)
    setRawData(null)
    setStats(null)
    setPreview(null)
    setImportResult(null)
    setError(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  return (
    <div className="import-panel">
      {/* Header */}
      <div className="import-header">
        <div className="import-title">
          <span className="import-icon">C</span>
          <h2>ChatGPT Import</h2>
        </div>
        <div className="import-header-actions">
          {onClose && (
            <button className="import-close-btn" onClick={onClose}>X</button>
          )}
        </div>
      </div>

      {/* Progress Steps */}
      <div className="import-steps">
        <div className={`import-step ${step === 'upload' ? 'active' : step !== 'upload' ? 'completed' : ''}`}>
          <span className="step-number">1</span>
          <span className="step-label">Upload</span>
        </div>
        <div className="step-line" />
        <div className={`import-step ${step === 'preview' ? 'active' : ['importing', 'complete'].includes(step) ? 'completed' : ''}`}>
          <span className="step-number">2</span>
          <span className="step-label">Preview</span>
        </div>
        <div className="step-line" />
        <div className={`import-step ${step === 'importing' ? 'active' : step === 'complete' ? 'completed' : ''}`}>
          <span className="step-number">3</span>
          <span className="step-label">Import</span>
        </div>
        <div className="step-line" />
        <div className={`import-step ${step === 'complete' ? 'active completed' : ''}`}>
          <span className="step-number">4</span>
          <span className="step-label">Done</span>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="import-error">
          <span className="error-icon">!</span>
          <span className="error-text">{error}</span>
          <button className="error-dismiss" onClick={() => setError(null)}>X</button>
        </div>
      )}

      {/* Content */}
      <div className="import-content">
        {step === 'upload' && (
          <UploadStep
            fileInputRef={fileInputRef}
            onFileSelect={handleFileSelect}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
          />
        )}

        {step === 'preview' && (
          <PreviewStep
            file={file}
            stats={stats}
            preview={preview}
            importOptions={importOptions}
            onOptionsChange={setImportOptions}
            onImport={handleImport}
            onBack={handleReset}
            isStarting={importStarting}
          />
        )}

        {step === 'importing' && (
          <ImportingStep
            progress={importProgress}
            stats={stats}
          />
        )}

        {step === 'complete' && (
          <CompleteStep
            result={importResult}
            onReset={handleReset}
            onClose={() => {
              if (onImportComplete) onImportComplete(importResult)
              if (onClose) onClose()
            }}
          />
        )}
      </div>
    </div>
  )
}

/**
 * Upload Step
 */
function UploadStep({ fileInputRef, onFileSelect, onDrop, onDragOver }) {
  return (
    <div className="upload-step">
      <div
        className="upload-zone"
        onDrop={onDrop}
        onDragOver={onDragOver}
      >
        <div className="upload-icon">[^]</div>
        <h3>Drop ChatGPT Export Here</h3>
        <p>or click to browse</p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={onFileSelect}
          className="upload-input"
        />
        <button
          className="upload-btn"
          onClick={() => fileInputRef.current?.click()}
        >
          Select File
        </button>
      </div>

      <div className="upload-instructions">
        <h4>How to export from ChatGPT:</h4>
        <ol>
          <li>Go to ChatGPT Settings</li>
          <li>Select "Data controls"</li>
          <li>Click "Export data"</li>
          <li>Download and extract the ZIP file</li>
          <li>Upload the <code>conversations.json</code> file here</li>
        </ol>
      </div>
    </div>
  )
}

/**
 * Preview Step
 */
function PreviewStep({ file, stats, preview, importOptions, onOptionsChange, onImport, onBack, isStarting }) {
  return (
    <div className="preview-step">
      {/* File Info */}
      <div className="preview-section">
        <h3>File Information</h3>
        <div className="file-info">
          <div className="info-item">
            <span className="info-label">File</span>
            <span className="info-value">{file?.name}</span>
          </div>
          <div className="info-item">
            <span className="info-label">Format</span>
            <span className="info-value">{stats?.format || 'Unknown'}</span>
          </div>
          <div className="info-item">
            <span className="info-label">Conversations</span>
            <span className="info-value">{stats?.conversationCount || 0}</span>
          </div>
          <div className="info-item">
            <span className="info-label">Messages</span>
            <span className="info-value">{stats?.totalMessages || 0}</span>
          </div>
          <div className="info-item">
            <span className="info-label">Date Range</span>
            <span className="info-value">
              {stats?.dateRange?.oldest
                ? `${new Date(stats.dateRange.oldest).toLocaleDateString()} - ${new Date(stats.dateRange.newest).toLocaleDateString()}`
                : 'Unknown'}
              {stats?.dateRange?.spanDays && ` (${stats.dateRange.spanDays} days)`}
            </span>
          </div>
        </div>
      </div>

      {/* Models Used */}
      {stats?.models?.length > 0 && (
        <div className="preview-section">
          <h3>Models Used</h3>
          <div className="models-list">
            {stats.models.map((m, idx) => (
              <span key={idx} className="model-tag">
                {m.model} ({m.count})
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Extraction Preview */}
      <div className="preview-section">
        <h3>Extraction Preview</h3>
        <div className="extraction-summary">
          <div className="summary-item">
            <span className="summary-value">{preview?.summary?.estimatedMemories || 0}</span>
            <span className="summary-label">Est. Memories</span>
          </div>
          <div className="summary-item">
            <span className="summary-value">{preview?.summary?.topTopics?.length || 0}</span>
            <span className="summary-label">Topics Detected</span>
          </div>
          <div className="summary-item">
            <span className="summary-value">
              {Math.round((preview?.summary?.styleConfidence || 0) * 100)}%
            </span>
            <span className="summary-label">Style Confidence</span>
          </div>
        </div>

        {/* Top Topics */}
        {preview?.summary?.topTopics?.length > 0 && (
          <div className="topics-preview">
            <h4>Detected Topics</h4>
            <div className="topic-tags">
              {preview.summary.topTopics.map((topic, idx) => (
                <span key={idx} className="topic-tag">{topic}</span>
              ))}
            </div>
          </div>
        )}

        {/* Sample Memories */}
        {preview?.sampleMemories?.length > 0 && (
          <div className="sample-memories">
            <h4>Sample Extracted Memories</h4>
            <div className="memory-samples">
              {preview.sampleMemories.slice(0, 5).map((mem, idx) => (
                <div key={idx} className="memory-sample">
                  <span className={`memory-type type-${mem.type}`}>{mem.type}</span>
                  <span className="memory-content">{mem.content}</span>
                  <span className="memory-confidence">
                    {Math.round((mem.confidence || 0) * 100)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Import Options */}
      <div className="preview-section">
        <h3>Import Options</h3>
        <div className="import-options">
          <div className="option-item">
            <label>
              <input
                type="checkbox"
                checked={importOptions.extractMemories}
                onChange={(e) => onOptionsChange({
                  ...importOptions,
                  extractMemories: e.target.checked
                })}
              />
              Extract memories from conversations
            </label>
          </div>
          <div className="option-item">
            <label>
              <input
                type="checkbox"
                checked={importOptions.updateStyle}
                onChange={(e) => onOptionsChange({
                  ...importOptions,
                  updateStyle: e.target.checked
                })}
              />
              Update communication style profile
            </label>
          </div>
          <div className="option-item">
            <label>
              <input
                type="checkbox"
                checked={importOptions.useColdStorage}
                onChange={(e) => onOptionsChange({
                  ...importOptions,
                  useColdStorage: e.target.checked
                })}
              />
              Use cold storage (recommended for review)
            </label>
            <span className="option-hint">
              Imported memories go to quarantine for manual promotion
            </span>
          </div>
          <div className="option-item">
            <label>Minimum messages per conversation</label>
            <input
              type="number"
              min="1"
              max="100"
              value={importOptions.minMessageCount}
              onChange={(e) => onOptionsChange({
                ...importOptions,
                minMessageCount: parseInt(e.target.value) || 1
              })}
            />
          </div>
          <div className="option-item">
            <label>Limit conversations (0 = all)</label>
            <input
              type="number"
              min="0"
              value={importOptions.limit}
              onChange={(e) => onOptionsChange({
                ...importOptions,
                limit: parseInt(e.target.value) || 0
              })}
            />
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="preview-actions">
        <button className="preview-btn back" onClick={onBack}>
          Back
        </button>
        <button
          className={`preview-btn import${isStarting ? ' starting' : ''}`}
          onClick={onImport}
          disabled={isStarting}
        >
          {isStarting ? (
            <>
              <span className="btn-spinner" />
              Preparing Import...
            </>
          ) : (
            'Start Import'
          )}
        </button>
      </div>
    </div>
  )
}

/**
 * Importing Step
 */
function ImportingStep({ progress, stats }) {
  const percent = stats?.conversationCount > 0
    ? Math.round((progress.current / stats.conversationCount) * 100)
    : 0

  return (
    <div className="importing-step">
      <div className="import-spinner">
        <div className="spinner" />
      </div>
      <h3>Importing Conversations...</h3>
      <div className="import-progress-bar">
        <div
          className="progress-fill"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="import-progress-text">
        <span>{progress.current} / {stats?.conversationCount || '?'}</span>
        <span>{percent}%</span>
      </div>
      <p className="import-status">{progress.status}</p>
      <p className="import-warning">
        Please do not close this window during import.
      </p>
    </div>
  )
}

/**
 * Complete Step
 */
function CompleteStep({ result, onReset, onClose }) {
  return (
    <div className="complete-step">
      <div className="complete-icon">OK</div>
      <h3>Import Complete</h3>

      <div className="complete-stats">
        <div className="stat-item">
          <span className="stat-value">{result?.conversationsProcessed || 0}</span>
          <span className="stat-label">Conversations Processed</span>
        </div>
        <div className="stat-item">
          <span className="stat-value">{result?.memoriesExtracted || 0}</span>
          <span className="stat-label">Memories Extracted</span>
        </div>
        <div className="stat-item">
          <span className="stat-value">{result?.memoriesSaved || 0}</span>
          <span className="stat-label">Memories Saved</span>
        </div>
        {result?.styleUpdated && (
          <div className="stat-item">
            <span className="stat-value">YES</span>
            <span className="stat-label">Style Updated</span>
          </div>
        )}
      </div>

      {/* Topics Found */}
      {Object.keys(result?.topicsFound || {}).length > 0 && (
        <div className="complete-section">
          <h4>Topics Discovered</h4>
          <div className="topic-tags">
            {Object.entries(result.topicsFound)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 10)
              .map(([topic, count]) => (
                <span key={topic} className="topic-tag">
                  {topic} ({count})
                </span>
              ))}
          </div>
        </div>
      )}

      {/* Errors */}
      {result?.errors?.length > 0 && (
        <div className="complete-section errors">
          <h4>Warnings ({result.errors.length})</h4>
          <div className="error-list">
            {result.errors.slice(0, 5).map((err, idx) => (
              <div key={idx} className="error-item">
                {err.conversation && `Conv: ${err.conversation} - `}
                {err.memory && `Memory: ${err.memory.substring(0, 30)}... - `}
                {err.error}
              </div>
            ))}
            {result.errors.length > 5 && (
              <div className="error-more">
                ...and {result.errors.length - 5} more
              </div>
            )}
          </div>
        </div>
      )}

      {/* Style Analysis */}
      {result?.styleAnalysis && (
        <div className="complete-section">
          <h4>Style Analysis</h4>
          <p>
            Analyzed {result.styleAnalysis.messageCount} messages
            (confidence: {Math.round(result.styleAnalysis.confidence * 100)}%)
          </p>
        </div>
      )}

      <div className="complete-actions">
        <button className="complete-btn import-more" onClick={onReset}>
          Import Another File
        </button>
        <button className="complete-btn done" onClick={onClose}>
          Done
        </button>
      </div>

      <p className="complete-note">
        Imported memories are in cold storage awaiting promotion review.
        Visit the Memory Promotion Pipeline to review and promote them.
      </p>
    </div>
  )
}

export default ChatGPTImportPanel
