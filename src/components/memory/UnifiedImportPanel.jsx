/**
 * QuoxCORE Unified Import Panel
 *
 * Multi-platform conversation import — ChatGPT, Claude, Gemini, Perplexity.
 * Same 4-step flow (upload > preview > importing > complete), per-platform parser.
 */

import { useState, useRef, useCallback } from 'react'
import {
  parseExport,
  previewImport,
  importConversations,
  getExportStats
} from '../../services/chatgptImporter'
import {
  parseClaudeExport,
  normalizeClaudeConversation,
  previewClaudeImport,
  importClaudeConversations,
  getClaudeExportStats
} from '../../services/claudeImporter'
import {
  parseGeminiExport,
  normalizeGeminiConversation,
  previewGeminiImport,
  importGeminiConversations,
  getGeminiExportStats
} from '../../services/geminiImporter'
import {
  parsePerplexityExport,
  normalizePerplexityConversation,
  previewPerplexityImport,
  importPerplexityConversations,
  getPerplexityExportStats
} from '../../services/perplexityImporter'
import { addToColdStorage, IMPORT_SOURCE } from '../../services/memoryPromotion'
import './memory.css'

// ============================================================================
// Platform config
// ============================================================================

const IMPORT_PLATFORMS = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    color: '#10a37f',
    accept: '.json',
    icon: 'G',
    importSource: IMPORT_SOURCE.CHATGPT,
    instructions: [
      'Go to ChatGPT Settings',
      'Select "Data controls"',
      'Click "Export data"',
      'Download and extract the ZIP file',
      'Upload the conversations.json file here'
    ]
  },
  {
    id: 'claude',
    label: 'Claude',
    color: '#d97706',
    accept: '.dms,.json,.zip',
    icon: 'C',
    importSource: IMPORT_SOURCE.CLAUDE,
    instructions: [
      'Go to Claude Settings',
      'Select "Privacy"',
      'Click "Export data"',
      'Download the .dms file',
      'Upload the .dms file (or extracted .json) here'
    ]
  },
  {
    id: 'gemini',
    label: 'Gemini',
    color: '#4285f4',
    accept: '.json,.zip',
    icon: 'G',
    importSource: IMPORT_SOURCE.GEMINI,
    instructions: [
      'Go to Google Takeout (takeout.google.com)',
      'Select "Gemini Apps" or "AI Studio"',
      'Click "Export"',
      'Download and extract the ZIP file',
      'Upload the JSON file or ZIP archive here'
    ]
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    color: '#20b2aa',
    accept: '.md,.json,.zip',
    icon: 'P',
    importSource: IMPORT_SOURCE.PERPLEXITY,
    instructions: [
      'Open a Perplexity search thread',
      'Click the share/export icon',
      'Choose "Export as Markdown"',
      'Or use a browser extension for bulk export',
      'Upload the .md, .json, or .zip file here'
    ]
  }
]

// ============================================================================
// Platform-specific handlers
// ============================================================================

async function handleChatGPTFile(file) {
  const text = await file.text()
  const data = JSON.parse(text)
  const stats = getExportStats(data)
  const preview = previewImport(data, { limit: 10 })
  return { rawData: data, stats, preview }
}

async function handleClaudeFile(file) {
  const stats = await getClaudeExportStats(file)
  const preview = await previewClaudeImport(file, { limit: 10 })
  return { rawData: file, stats, preview }
}

async function handleGeminiFile(file) {
  const stats = await getGeminiExportStats(file)
  const preview = await previewGeminiImport(file, { limit: 10 })
  return { rawData: file, stats, preview }
}

async function handlePerplexityFile(file) {
  const stats = await getPerplexityExportStats(file)
  const preview = await previewPerplexityImport(file, { limit: 10 })
  return { rawData: file, stats, preview }
}

const FILE_HANDLERS = {
  chatgpt: handleChatGPTFile,
  claude: handleClaudeFile,
  gemini: handleGeminiFile,
  perplexity: handlePerplexityFile
}

async function runImport(platform, rawData, options) {
  switch (platform) {
    case 'chatgpt':
      return importConversations(rawData, options)
    case 'claude':
      return importClaudeConversations(rawData, options)
    case 'gemini':
      return importGeminiConversations(rawData, options)
    case 'perplexity':
      return importPerplexityConversations(rawData, options)
    default:
      throw new Error(`Unknown platform: ${platform}`)
  }
}

// ============================================================================
// Main component
// ============================================================================

export function UnifiedImportPanel({ onClose, onImportComplete }) {
  const [platform, setPlatform] = useState('chatgpt')
  const [step, setStep] = useState('upload')
  const [file, setFile] = useState(null)
  const [rawData, setRawData] = useState(null)
  const [stats, setStats] = useState(null)
  const [preview, setPreview] = useState(null)
  const [importOptions, setImportOptions] = useState({
    extractMemories: true,
    updateStyle: true,
    useColdStorage: true,
    limit: 0,
    minMessageCount: 2
  })
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0, status: '' })
  const [importResult, setImportResult] = useState(null)
  const [error, setError] = useState(null)
  const [importStarting, setImportStarting] = useState(false)

  const fileInputRef = useRef(null)
  const activePlatform = IMPORT_PLATFORMS.find(p => p.id === platform)

  // Switch platform (only allowed during upload step)
  const handlePlatformSwitch = useCallback((id) => {
    if (step !== 'upload') return
    setPlatform(id)
    setError(null)
    setFile(null)
    setRawData(null)
    setStats(null)
    setPreview(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [step])

  // Handle file selection
  const handleFileSelect = useCallback(async (e) => {
    const selectedFile = e.target.files?.[0]
    if (!selectedFile) return

    setError(null)
    setFile(selectedFile)

    try {
      const handler = FILE_HANDLERS[platform]
      const result = await handler(selectedFile)
      setRawData(result.rawData)
      setStats(result.stats)
      setPreview(result.preview)
      setStep('preview')
    } catch (err) {
      setError(`Failed to parse file: ${err.message}`)
    }
  }, [platform])

  // Drag and drop
  const handleDrop = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    const droppedFile = e.dataTransfer?.files?.[0]
    if (droppedFile) {
      handleFileSelect({ target: { files: [droppedFile] } })
    }
  }, [handleFileSelect])

  const handleDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
  }

  // Import
  const handleImport = useCallback(async () => {
    if (!rawData) return

    setImportStarting(true)
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

    setStep('importing')
    setError(null)
    setImportProgress({ current: 0, total: stats?.conversationCount || 0, status: 'Parsing conversations...' })

    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

    try {
      const result = await runImport(platform, rawData, {
        extractMemoriesEnabled: importOptions.extractMemories,
        updateStyleProfile: importOptions.updateStyle,
        updateStyle: importOptions.updateStyle,
        limit: importOptions.limit || Infinity,
        minMessageCount: importOptions.minMessageCount,
        deduplicateMemories: true,
        deduplicateEnabled: true,
        onProgress: (progress) => {
          setImportProgress({
            current: progress.current,
            total: progress.total,
            status: progress.status
          })
        }
      })

      if (importOptions.useColdStorage) {
        try {
          addToColdStorage([], {
            source: activePlatform.importSource,
            metadata: {
              conversationsProcessed: result.conversationsProcessed,
              memoriesSaved: result.memoriesSaved
            }
          })
        } catch {
          // Non-critical
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
  }, [rawData, stats, importOptions, platform, activePlatform])

  // Reset
  const handleReset = () => {
    setStep('upload')
    setFile(null)
    setRawData(null)
    setStats(null)
    setPreview(null)
    setImportResult(null)
    setError(null)
    setImportStarting(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <div className="import-panel">
      {/* Header */}
      <div className="import-header">
        <div className="import-title">
          <svg className="import-icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <h2>Import Conversations</h2>
        </div>
        <div className="import-header-actions">
          {onClose && (
            <button className="import-close-btn" onClick={onClose} title="Close">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Platform Tabs */}
      <div className="import-platform-tabs">
        {IMPORT_PLATFORMS.map(p => (
          <button
            key={p.id}
            className={`platform-tab${platform === p.id ? ' active' : ''}${step !== 'upload' ? ' locked' : ''}`}
            onClick={() => handlePlatformSwitch(p.id)}
            disabled={step !== 'upload'}
            style={platform === p.id ? { '--platform-color': p.color } : {}}
          >
            <span className="platform-tab-icon" style={{ color: p.color }}>{p.icon}</span>
            <span className="platform-tab-label">{p.label}</span>
          </button>
        ))}
      </div>

      {/* Progress Steps */}
      <div className="import-steps">
        <div className={`import-step ${step === 'upload' ? 'active' : 'completed'}`}>
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
          <button className="error-dismiss" onClick={() => setError(null)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {/* Content */}
      <div className="import-content">
        {step === 'upload' && (
          <UploadStep
            platform={activePlatform}
            fileInputRef={fileInputRef}
            onFileSelect={handleFileSelect}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
          />
        )}

        {step === 'preview' && (
          <PreviewStep
            platform={activePlatform}
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
            platform={activePlatform}
            progress={importProgress}
            stats={stats}
          />
        )}

        {step === 'complete' && (
          <CompleteStep
            platform={activePlatform}
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

// ============================================================================
// Upload Step
// ============================================================================

function UploadStep({ platform, fileInputRef, onFileSelect, onDrop, onDragOver }) {
  return (
    <div className="upload-step">
      <div className="upload-zone" onDrop={onDrop} onDragOver={onDragOver}>
        <div className="upload-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <h3>Drop {platform.label} Export Here</h3>
        <p>or click to browse</p>
        <input
          ref={fileInputRef}
          type="file"
          accept={platform.accept}
          onChange={onFileSelect}
          className="upload-input"
        />
        <button
          className="upload-btn"
          onClick={() => fileInputRef.current?.click()}
          style={{ borderColor: platform.color, color: platform.color }}
        >
          Select File
        </button>
        <span className="upload-formats">Accepts: {platform.accept}</span>
      </div>

      <div className="upload-instructions">
        <h4>How to export from {platform.label}:</h4>
        <ol>
          {platform.instructions.map((step, idx) => (
            <li key={idx}>{step}</li>
          ))}
        </ol>
      </div>
    </div>
  )
}

// ============================================================================
// Preview Step
// ============================================================================

function PreviewStep({ platform, file, stats, preview, importOptions, onOptionsChange, onImport, onBack, isStarting }) {
  return (
    <div className="preview-step">
      {/* File Info */}
      <div className="preview-section">
        <h3>File Information</h3>
        <div className="file-info">
          <div className="info-item">
            <span className="info-label">Platform</span>
            <span className="info-value" style={{ color: platform.color }}>{platform.label}</span>
          </div>
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
                onChange={(e) => onOptionsChange({ ...importOptions, extractMemories: e.target.checked })}
              />
              Extract memories from conversations
            </label>
          </div>
          <div className="option-item">
            <label>
              <input
                type="checkbox"
                checked={importOptions.updateStyle}
                onChange={(e) => onOptionsChange({ ...importOptions, updateStyle: e.target.checked })}
              />
              Update communication style profile
            </label>
          </div>
          <div className="option-item">
            <label>
              <input
                type="checkbox"
                checked={importOptions.useColdStorage}
                onChange={(e) => onOptionsChange({ ...importOptions, useColdStorage: e.target.checked })}
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
              onChange={(e) => onOptionsChange({ ...importOptions, minMessageCount: parseInt(e.target.value) || 1 })}
            />
          </div>
          <div className="option-item">
            <label>Limit conversations (0 = all)</label>
            <input
              type="number"
              min="0"
              value={importOptions.limit}
              onChange={(e) => onOptionsChange({ ...importOptions, limit: parseInt(e.target.value) || 0 })}
            />
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="preview-actions">
        <button className="preview-btn back" onClick={onBack}>Back</button>
        <button
          className={`preview-btn import${isStarting ? ' starting' : ''}`}
          onClick={onImport}
          disabled={isStarting}
          style={!isStarting ? { background: platform.color } : {}}
        >
          {isStarting ? (
            <><span className="btn-spinner" /> Preparing Import...</>
          ) : (
            `Import from ${platform.label}`
          )}
        </button>
      </div>
    </div>
  )
}

// ============================================================================
// Importing Step
// ============================================================================

function ImportingStep({ platform, progress, stats }) {
  const percent = stats?.conversationCount > 0
    ? Math.round((progress.current / stats.conversationCount) * 100)
    : 0

  return (
    <div className="importing-step">
      <div className="import-spinner">
        <div className="spinner" style={{ borderTopColor: platform.color }} />
      </div>
      <h3>Importing {platform.label} Conversations...</h3>
      <div className="import-progress-bar">
        <div className="progress-fill" style={{ width: `${percent}%`, background: platform.color }} />
      </div>
      <div className="import-progress-text">
        <span>{progress.current} / {stats?.conversationCount || '?'}</span>
        <span>{percent}%</span>
      </div>
      <p className="import-status">{progress.status}</p>
      <p className="import-warning">Please do not close this window during import.</p>
    </div>
  )
}

// ============================================================================
// Complete Step
// ============================================================================

function CompleteStep({ platform, result, onReset, onClose }) {
  return (
    <div className="complete-step">
      <div className="complete-icon" style={{ color: platform.color }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      </div>
      <h3>{platform.label} Import Complete</h3>

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
                <span key={topic} className="topic-tag">{topic} ({count})</span>
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
              <div className="error-more">...and {result.errors.length - 5} more</div>
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
        <button className="complete-btn import-more" onClick={onReset}>Import Another File</button>
        <button className="complete-btn done" onClick={onClose} style={{ background: platform.color }}>Done</button>
      </div>

      <p className="complete-note">
        Imported memories are in cold storage awaiting promotion review.
        Visit the Memory Promotion Pipeline to review and promote them.
      </p>
    </div>
  )
}

export default UnifiedImportPanel
