/**
 * Knowledge Tab Utilities (CW-7)
 *
 * Validation, formatting, and configuration for knowledge source management.
 */

export const SUPPORTED_FILE_TYPES = [
  { ext: '.pdf', label: 'PDF Documents', mime: 'application/pdf', maxSizeMB: 25 },
  { ext: '.docx', label: 'Word Documents', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', maxSizeMB: 25 },
  { ext: '.txt', label: 'Plain Text', mime: 'text/plain', maxSizeMB: 10 },
  { ext: '.md', label: 'Markdown', mime: 'text/markdown', maxSizeMB: 10 },
  { ext: '.csv', label: 'CSV Spreadsheets', mime: 'text/csv', maxSizeMB: 10 },
  { ext: '.xlsx', label: 'Excel Spreadsheets', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', maxSizeMB: 25 },
  { ext: '.html', label: 'HTML Pages', mime: 'text/html', maxSizeMB: 10 },
  { ext: '.json', label: 'JSON Files', mime: 'application/json', maxSizeMB: 10 },
]

export const SOURCE_STATUSES = ['pending', 'indexing', 'indexed', 'error', 'quarantined']

const STATUS_DISPLAY = {
  pending: { label: 'Pending', color: '#f59e0b', icon: '⏳' },
  indexing: { label: 'Indexing', color: '#38bdf8', icon: '🔄' },
  indexed: { label: 'Indexed', color: '#30ff90', icon: '✓' },
  error: { label: 'Error', color: '#ef4444', icon: '✕' },
  quarantined: { label: 'Quarantined', color: '#ef4444', icon: '⛔' },
}

export function formatSourceStatus(status) {
  return STATUS_DISPLAY[status] || { label: status, color: 'rgba(255,255,255,0.65)', icon: '?' }
}

const MAX_FILE_SIZE = 25 * 1024 * 1024 // 25MB default

/**
 * Validate a knowledge source before submission.
 */
export function validateKnowledgeSource(source) {
  const errors = []

  if (!source.name?.trim()) {
    errors.push('Source name is required')
  }

  switch (source.type) {
    case 'file': {
      if (source.size && source.size > MAX_FILE_SIZE) {
        errors.push(`File size exceeds maximum (${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB)`)
      }
      const ext = source.name?.toLowerCase().match(/\.[a-z]+$/)?.[0]
      if (ext && !SUPPORTED_FILE_TYPES.some(t => t.ext === ext)) {
        errors.push(`Unsupported file type: ${ext}`)
      }
      break
    }
    case 'url': {
      if (!source.url) {
        errors.push('URL is required')
      } else {
        try { new URL(source.url) }
        catch { errors.push('Invalid URL format') }
      }
      break
    }
    case 'qa': {
      if (!source.question?.trim()) errors.push('Question is required')
      if (!source.answer?.trim()) errors.push('Answer is required')
      break
    }
  }

  return errors
}
