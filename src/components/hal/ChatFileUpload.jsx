/**
 * Chat File Upload Component
 *
 * Provides file/photo upload capability for the QuoxCORE chat interface.
 * Supports drag-and-drop, file preview, and upload progress.
 */

import { useState, useRef, useCallback } from 'react'
import {
  uploadFile,
  isFileTypeSupported,
  getFileCategory,
  formatFileSize,
  getStorageUsage,
  getSupportedFileTypes,
  isImageFile
} from '../../services/fileStorage'

/**
 * File preview component
 */
function FilePreview({ file, onRemove }) {
  const isImage = file.category === 'image'

  return (
    <div className="chat-file-preview">
      {isImage && file.thumbnail ? (
        <img src={file.thumbnail} alt={file.name} className="preview-thumbnail" />
      ) : (
        <div className={`preview-icon ${file.category}`}>
          {getFileIconSvg(file.type)}
        </div>
      )}
      <div className="preview-info">
        <span className="preview-name" title={file.name}>
          {file.name.length > 20 ? file.name.slice(0, 17) + '...' : file.name}
        </span>
        <span className="preview-size">{formatFileSize(file.size)}</span>
      </div>
      <button
        className="preview-remove"
        onClick={() => onRemove(file.id)}
        title="Remove file"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
      </button>
    </div>
  )
}

/**
 * Get SVG icon for file type
 */
function getFileIconSvg(fileType) {
  if (fileType?.startsWith('image/')) {
    return (
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
      </svg>
    )
  }

  if (fileType === 'application/pdf') {
    return (
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
      </svg>
    )
  }

  if (fileType === 'application/json') {
    return (
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
      </svg>
    )
  }

  // Default document icon
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
    </svg>
  )
}

/**
 * Chat File Upload Component
 */
export function ChatFileUpload({
  onFilesSelected,
  onFileUploaded,
  disabled = false,
  chatId = null,
  maxFiles = 5
}) {
  const [pendingFiles, setPendingFiles] = useState([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef(null)

  // Handle file selection
  const handleFileSelect = useCallback(async (files) => {
    setError(null)

    const fileArray = Array.from(files)
    const validFiles = []
    const errors = []

    // Validate files
    for (const file of fileArray) {
      if (!isFileTypeSupported(file)) {
        errors.push(`${file.name}: Unsupported file type`)
        continue
      }

      if (pendingFiles.length + validFiles.length >= maxFiles) {
        errors.push(`Maximum ${maxFiles} files allowed`)
        break
      }

      // Create preview
      const preview = {
        id: `pending_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        file,
        name: file.name,
        type: file.type,
        size: file.size,
        category: getFileCategory(file),
        thumbnail: null
      }

      // Generate thumbnail for images
      if (preview.category === 'image') {
        preview.thumbnail = await generatePreviewThumbnail(file)
      }

      validFiles.push(preview)
    }

    if (errors.length > 0) {
      setError(errors.join('. '))
    }

    if (validFiles.length > 0) {
      setPendingFiles(prev => [...prev, ...validFiles])
      if (onFilesSelected) {
        onFilesSelected(validFiles)
      }
    }
  }, [pendingFiles, maxFiles, onFilesSelected])

  // Generate thumbnail preview
  const generatePreviewThumbnail = (file) => {
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = (e) => resolve(e.target.result)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    })
  }

  // Remove pending file
  const removePendingFile = (fileId) => {
    setPendingFiles(prev => prev.filter(f => f.id !== fileId))
  }

  // Upload all pending files
  const uploadPendingFiles = async () => {
    if (pendingFiles.length === 0) return []

    setUploading(true)
    setError(null)

    const uploaded = []
    const errors = []

    for (const pending of pendingFiles) {
      try {
        const result = await uploadFile(pending.file, { chatId })
        uploaded.push(result)

        if (onFileUploaded) {
          onFileUploaded(result)
        }
      } catch (err) {
        errors.push(`${pending.name}: ${err.message}`)
      }
    }

    setPendingFiles([])
    setUploading(false)

    if (errors.length > 0) {
      setError(errors.join('. '))
    }

    return uploaded
  }

  // Clear all pending files
  const clearPendingFiles = () => {
    setPendingFiles([])
    setError(null)
  }

  // Handle drag events
  const handleDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!disabled) {
      setDragOver(true)
    }
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)

    if (disabled) return

    const files = e.dataTransfer?.files
    if (files && files.length > 0) {
      handleFileSelect(files)
    }
  }

  // Handle file input change
  const handleInputChange = (e) => {
    const files = e.target.files
    if (files && files.length > 0) {
      handleFileSelect(files)
    }
    // Reset input to allow selecting same file again
    e.target.value = ''
  }

  // Open file dialog
  const openFileDialog = () => {
    if (!disabled && fileInputRef.current) {
      fileInputRef.current.click()
    }
  }

  // Get storage usage for display
  const storage = getStorageUsage()

  return (
    <div
      className={`chat-file-upload ${dragOver ? 'drag-over' : ''} ${disabled ? 'disabled' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={getSupportedFileTypes()}
        onChange={handleInputChange}
        style={{ display: 'none' }}
      />

      {/* Upload button */}
      <button
        className="chat-upload-btn"
        onClick={openFileDialog}
        disabled={disabled || uploading}
        title="Attach file (images, PDF, text, JSON)"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          background: 'rgba(255, 255, 255, 0.04)',
          border: '1px solid rgba(255, 255, 255, 0.06)',
          borderRadius: 6,
          color: 'rgba(255, 255, 255, 0.5)',
          cursor: (disabled || uploading) ? 'not-allowed' : 'pointer',
          padding: 0,
          flexShrink: 0,
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.5)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
        </svg>
      </button>

      {/* Pending files preview */}
      {pendingFiles.length > 0 && (
        <div className="chat-files-pending">
          <div className="pending-header">
            <span className="pending-count">{pendingFiles.length} file{pendingFiles.length > 1 ? 's' : ''} ready</span>
            <button className="pending-clear" onClick={clearPendingFiles}>Clear</button>
          </div>
          <div className="pending-list">
            {pendingFiles.map(file => (
              <FilePreview
                key={file.id}
                file={file}
                onRemove={removePendingFile}
              />
            ))}
          </div>
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="chat-upload-error">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
          <span>{error}</span>
          <button onClick={() => setError(null)}>X</button>
        </div>
      )}

      {/* Uploading indicator */}
      {uploading && (
        <div className="chat-upload-progress">
          <div className="upload-spinner" />
          <span>Uploading...</span>
        </div>
      )}

      {/* Storage warning */}
      {storage.percent > 80 && (
        <div className="chat-storage-warning">
          Storage {storage.percent}% full ({storage.formatted.used} / {storage.formatted.max})
        </div>
      )}

      {/* Drag overlay */}
      {dragOver && (
        <div className="chat-drag-overlay">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <span>Drop files here</span>
        </div>
      )}
    </div>
  )
}

/**
 * Hook to manage file uploads in chat
 */
export function useChatFileUpload(chatId) {
  const [attachedFiles, setAttachedFiles] = useState([])

  const addFile = useCallback((fileMetadata) => {
    setAttachedFiles(prev => [...prev, fileMetadata])
  }, [])

  const removeFile = useCallback((fileId) => {
    setAttachedFiles(prev => prev.filter(f => f.id !== fileId))
  }, [])

  const clearFiles = useCallback(() => {
    setAttachedFiles([])
  }, [])

  const getFileIds = useCallback(() => {
    return attachedFiles.map(f => f.id)
  }, [attachedFiles])

  return {
    attachedFiles,
    addFile,
    removeFile,
    clearFiles,
    getFileIds,
    hasFiles: attachedFiles.length > 0
  }
}

export default ChatFileUpload
