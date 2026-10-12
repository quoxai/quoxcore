/**
 * QuoxCORE File Manager
 *
 * File management interface for viewing, searching, and managing uploaded files.
 * Features:
 * - Grid/list view toggle
 * - Image thumbnails for photos
 * - File type icons for documents
 * - Upload date, size info
 * - Delete functionality
 * - Search/filter
 * - Storage usage indicator
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  listFiles,
  deleteFile,
  deleteFiles,
  getFile,
  getStorageUsage,
  formatFileSize,
  uploadFile,
  getSupportedFileTypes,
  searchFiles,
  clearAllFiles,
  exportFiles,
  importFiles,
  isImageFile,
  moveFile,
  moveFiles,
  renameFile,
  getFolder,
  listFolders,
  ROOT_FOLDER,
  getServerStatus,
  checkServerHealth,
  recoverOrphanedFiles,
  syncMetadata
} from '../../services/fileStorage'
import { isHybridSearchAvailable, isPremiumFilesAvailable, semanticFileSearch } from '../../services/fileMemoryBridge'
import { FolderTree } from './FolderTree'
import { useNavigate } from 'react-router-dom'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import './files.css'

/**
 * File card component for grid view
 */
function FileCard({ file, selected, onSelect, onDelete, onPreview, selectedFiles }) {
  const isImage = file.category === 'image'

  const handleDragStart = (e) => {
    // Drag selected files, or just this one if not selected
    const ids = selectedFiles?.size > 0 && selectedFiles.has(file.id)
      ? Array.from(selectedFiles)
      : [file.id]
    e.dataTransfer.setData('application/quox-file-ids', JSON.stringify(ids))
    e.dataTransfer.effectAllowed = 'move'
  }

  return (
    <div
      className={`file-card ${selected ? 'selected' : ''} ${isImage ? 'image' : 'document'}`}
      onClick={() => onSelect(file.id)}
      onDoubleClick={() => onPreview(file)}
      draggable
      onDragStart={handleDragStart}
    >
      <div className="file-card-preview">
        {isImage && file.thumbnail ? (
          <img src={file.thumbnail} alt={file.name} />
        ) : (
          <div className={`file-icon ${file.category}`}>
            <FileTypeIcon type={file.type} />
          </div>
        )}
        {selected && (
          <div className="file-selected-check">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5"/>
            </svg>
          </div>
        )}
      </div>
      <div className="file-card-info">
        <span className="file-name" title={file.name}>{file.name}</span>
        <span className="file-meta">
          {formatFileSize(file.size)} - {formatDate(file.uploadedAt)}
        </span>
      </div>
      <div className="file-card-actions">
        <button
          className="file-action-btn preview"
          onClick={(e) => { e.stopPropagation(); onPreview(file); }}
          title="Preview"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
        <button
          className="file-action-btn delete"
          onClick={(e) => { e.stopPropagation(); onDelete(file.id); }}
          title="Delete"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
          </svg>
        </button>
      </div>
    </div>
  )
}

/**
 * File row component for list view
 */
function FileRow({ file, selected, onSelect, onDelete, onPreview, selectedFiles }) {
  const isImage = file.category === 'image'

  const handleDragStart = (e) => {
    const ids = selectedFiles?.size > 0 && selectedFiles.has(file.id)
      ? Array.from(selectedFiles)
      : [file.id]
    e.dataTransfer.setData('application/quox-file-ids', JSON.stringify(ids))
    e.dataTransfer.effectAllowed = 'move'
  }

  return (
    <div
      className={`file-row ${selected ? 'selected' : ''}`}
      onClick={() => onSelect(file.id)}
      onDoubleClick={() => onPreview(file)}
      draggable
      onDragStart={handleDragStart}
    >
      <div className="file-row-checkbox">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onSelect(file.id)}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
      <div className="file-row-icon">
        {isImage && file.thumbnail ? (
          <img src={file.thumbnail} alt={file.name} className="row-thumbnail" />
        ) : (
          <FileTypeIcon type={file.type} />
        )}
      </div>
      <div className="file-row-name">
        <span title={file.name}>{file.name}</span>
      </div>
      <div className="file-row-type">
        {file.category === 'image' ? 'Image' : 'Document'}
      </div>
      <div className="file-row-size">
        {formatFileSize(file.size)}
      </div>
      <div className="file-row-date">
        {formatDate(file.uploadedAt)}
      </div>
      <div className="file-row-actions">
        <button
          className="file-action-btn preview"
          onClick={(e) => { e.stopPropagation(); onPreview(file); }}
          title="Preview"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
        <button
          className="file-action-btn delete"
          onClick={(e) => { e.stopPropagation(); onDelete(file.id); }}
          title="Delete"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
          </svg>
        </button>
      </div>
    </div>
  )
}

/**
 * File type icon component
 */
function FileTypeIcon({ type }) {
  const getIconPath = () => {
    if (type?.startsWith('image/')) {
      return 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z'
    }
    if (type === 'application/pdf') {
      return 'M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm10 5.5h1v-3h-1v3z'
    }
    if (type === 'application/json') {
      return 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z'
    }
    // Default document
    return 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z'
  }

  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
    </svg>
  )
}

/**
 * File preview modal
 */
function FilePreviewModal({ file, onClose }) {
  const [fullData, setFullData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (file) {
      const fileData = getFile(file.id)
      setFullData(fileData?.data || null)
      setLoading(false)
    }
  }, [file])

  if (!file) return null

  const isImage = file.category === 'image'

  return (
    <div className="file-preview-modal" onClick={onClose}>
      <div className="file-preview-content" onClick={(e) => e.stopPropagation()}>
        <div className="preview-modal-header">
          <h3>{file.name}</h3>
          <button className="preview-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>
        <div className="preview-modal-body">
          {loading ? (
            <div className="preview-loading">Loading...</div>
          ) : isImage && fullData ? (
            <img src={fullData} alt={file.name} className="preview-image" />
          ) : fullData && file.type === 'text/plain' ? (
            <pre className="preview-text">{atob(fullData.split(',')[1])}</pre>
          ) : fullData && file.type === 'application/json' ? (
            <pre className="preview-json">{JSON.stringify(JSON.parse(atob(fullData.split(',')[1])), null, 2)}</pre>
          ) : fullData && file.type === 'text/markdown' ? (
            <pre className="preview-markdown">{atob(fullData.split(',')[1])}</pre>
          ) : (
            <div className="preview-unsupported">
              <FileTypeIcon type={file.type} />
              <p>Preview not available for this file type</p>
              <a href={fullData} download={file.name} className="preview-download">
                Download File
              </a>
            </div>
          )}
        </div>
        <div className="preview-modal-footer">
          <span className="preview-meta">
            {formatFileSize(file.size)} - {formatDate(file.uploadedAt)}
          </span>
          {fullData && (
            <a href={fullData} download={file.name} className="preview-download-btn">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Download
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Breadcrumb navigation component
 */
function Breadcrumb({ path, onNavigate, orgName, orgLogo }) {
  const parts = path === '/' ? [] : path.split('/').filter(Boolean)
  const rootLabel = orgName || 'Files'

  return (
    <div className="fm-breadcrumb">
      {/* Org badge */}
      {orgName && (
        <span className="fm-org-badge">
          {orgLogo ? (
            <img src={orgLogo} alt="" className="fm-org-logo" />
          ) : (
            <span className="fm-org-avatar">{orgName.charAt(0).toUpperCase()}</span>
          )}
          <span className="fm-org-name">{orgName}</span>
          <span className="breadcrumb-separator">/</span>
        </span>
      )}

      <button
        className={`breadcrumb-item ${path === '/' ? 'current' : ''}`}
        onClick={() => onNavigate('/')}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
        </svg>
        <span>{rootLabel}</span>
      </button>

      {parts.map((part, i) => {
        const partPath = '/' + parts.slice(0, i + 1).join('/')
        const isCurrent = partPath === path

        return (
          <span key={partPath} className="breadcrumb-segment">
            <span className="breadcrumb-separator">/</span>
            <button
              className={`breadcrumb-item ${isCurrent ? 'current' : ''}`}
              onClick={() => onNavigate(partPath)}
            >
              {part}
            </button>
          </span>
        )
      })}
    </div>
  )
}

/**
 * Move files dialog
 */
function MoveFilesDialog({ fileIds, currentPath, onClose, onMoved }) {
  const [targetPath, setTargetPath] = useState('/')
  const folders = listFolders()

  const handleMove = () => {
    if (targetPath === currentPath) {
      onClose()
      return
    }

    const moved = moveFiles(fileIds, targetPath)
    onMoved(moved)
    onClose()
  }

  return (
    <div className="folder-dialog-overlay" onClick={onClose}>
      <div className="folder-dialog move-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Move {fileIds.length} file(s)</h3>

        <div className="move-folder-list">
          <button
            className={`move-folder-item ${targetPath === '/' ? 'selected' : ''}`}
            onClick={() => setTargetPath('/')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
            </svg>
            Root
          </button>

          {folders.map((folder) => (
            <button
              key={folder.path}
              className={`move-folder-item ${targetPath === folder.path ? 'selected' : ''}`}
              onClick={() => setTargetPath(folder.path)}
              style={{ paddingLeft: `${(folder.path.split('/').length - 1) * 16 + 12}px` }}
            >
              <span className="move-folder-icon">{folder.icon || '📁'}</span>
              {folder.name}
            </button>
          ))}
        </div>

        <div className="folder-dialog-actions">
          <button type="button" className="btn-cancel" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-create" onClick={handleMove}>Move Here</button>
        </div>
      </div>
    </div>
  )
}

/**
 * Rename file dialog
 */
function RenameFileDialog({ file, onClose, onRenamed }) {
  const [name, setName] = useState(file.name)
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
    // Select filename without extension
    const dotIndex = file.name.lastIndexOf('.')
    if (dotIndex > 0) {
      inputRef.current?.setSelectionRange(0, dotIndex)
    } else {
      inputRef.current?.select()
    }
  }, [file.name])

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('File name is required')
      return
    }

    try {
      renameFile(file.id, name.trim())
      onRenamed()
      onClose()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="folder-dialog-overlay" onClick={onClose}>
      <div className="folder-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Rename File</h3>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="File name"
            className="folder-input"
          />
          {error && <p className="folder-error">{error}</p>}
          <div className="folder-dialog-actions">
            <button type="button" className="btn-cancel" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-create">Rename</button>
          </div>
        </form>
      </div>
    </div>
  )
}

/**
 * Format date for display
 */
function formatDate(isoString) {
  const date = new Date(isoString)
  const now = new Date()
  const diff = now - date

  // Less than 24 hours
  if (diff < 86400000) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  // Less than 7 days
  if (diff < 604800000) {
    const days = Math.floor(diff / 86400000)
    return `${days}d ago`
  }

  // Default: show date
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/**
 * Main File Manager Component
 */
export function FileManager() {
  const { currentOrg } = useWorkspace()
  const [files, setFiles] = useState([])
  const [viewMode, setViewMode] = useState('grid') // 'grid' or 'list'
  const [selectedFiles, setSelectedFiles] = useState(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all') // 'all', 'image', 'document'
  const [sortBy, setSortBy] = useState('date') // 'date', 'name', 'size'
  const [storage, setStorage] = useState(null)
  const [previewFile, setPreviewFile] = useState(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef(null)

  // Folder navigation state
  const [currentFolder, setCurrentFolder] = useState('/')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [folderRefresh, setFolderRefresh] = useState(0)
  const [moveDialog, setMoveDialog] = useState(null)
  const [renameDialog, setRenameDialog] = useState(null)

  // Semantic search state
  const [semanticSearchEnabled, setSemanticSearchEnabled] = useState(false)
  const [semanticResults, setSemanticResults] = useState(null)
  const [searchingSemantics, setSearchingSemantics] = useState(false)

  // Server status state
  const [serverStatus, setServerStatus] = useState({ available: null, checking: false })
  const [recovering, setRecovering] = useState(false)
  const [recoveryResult, setRecoveryResult] = useState(null)

  // Drag-and-drop state
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const [dragCounter, setDragCounter] = useState(0)
  const dropZoneRef = useRef(null)

  // Navigation for ARCHIVIST chat
  const navigate = useNavigate()

  // Load files and storage info
  const loadFiles = useCallback(async () => {
    // If semantic search is enabled and there's a query, use hybrid search
    if (semanticSearchEnabled && searchQuery.trim() && isHybridSearchAvailable()) {
      setSearchingSemantics(true)
      try {
        const result = await semanticFileSearch(searchQuery, {
          limit: 20,
          folderPath: currentFolder,
          recursive: false
        })

        if (!result.blocked && result.results?.length > 0) {
          // Get full file data for semantic results
          const fileIds = result.results.map(r => r.fileId)
          const allFiles = listFiles({ folderPath: currentFolder })
          const matchedFiles = allFiles.filter(f => fileIds.includes(f.id))

          // Sort by semantic score
          matchedFiles.sort((a, b) => {
            const scoreA = result.results.find(r => r.fileId === a.id)?.score || 0
            const scoreB = result.results.find(r => r.fileId === b.id)?.score || 0
            return scoreB - scoreA
          })

          setFiles(matchedFiles)
          setSemanticResults(result)
          setSearchingSemantics(false)
          setStorage(getStorageUsage())
          return
        }
      } catch (err) {
        console.warn('[FileManager] Semantic search failed:', err)
      }
      setSearchingSemantics(false)
    }

    // Standard file listing
    setSemanticResults(null)
    const options = {
      folderPath: currentFolder,
      category: categoryFilter === 'all' ? undefined : categoryFilter,
      sortBy: sortBy,
      search: searchQuery
    }
    setFiles(listFiles(options))
    setStorage(getStorageUsage())
  }, [currentFolder, categoryFilter, sortBy, searchQuery, semanticSearchEnabled])

  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  // Check server health on mount
  useEffect(() => {
    const checkServer = async () => {
      setServerStatus(prev => ({ ...prev, checking: true }))
      const available = await checkServerHealth()
      setServerStatus({ available, checking: false })
    }
    checkServer()
  }, [])

  // Handle file recovery
  const handleRecoverFiles = async () => {
    setRecovering(true)
    setRecoveryResult(null)
    try {
      const result = await recoverOrphanedFiles()
      setRecoveryResult(result)
      if (result.recovered > 0) {
        loadFiles()
        setFolderRefresh(n => n + 1)
      }
    } catch (err) {
      setRecoveryResult({ error: err.message })
    } finally {
      setRecovering(false)
    }
  }

  // Handle sync metadata
  const handleSyncMetadata = async () => {
    setServerStatus(prev => ({ ...prev, checking: true }))
    try {
      await syncMetadata()
      const available = await checkServerHealth()
      setServerStatus({ available, checking: false })
      loadFiles()
    } catch (err) {
      console.error('[FileManager] Sync failed:', err)
      setServerStatus(prev => ({ ...prev, checking: false }))
    }
  }

  // Handle file selection
  const handleSelect = (fileId) => {
    setSelectedFiles(prev => {
      const newSet = new Set(prev)
      if (newSet.has(fileId)) {
        newSet.delete(fileId)
      } else {
        newSet.add(fileId)
      }
      return newSet
    })
  }

  // Select all files
  const selectAll = () => {
    if (selectedFiles.size === files.length) {
      setSelectedFiles(new Set())
    } else {
      setSelectedFiles(new Set(files.map(f => f.id)))
    }
  }

  // Delete single file
  const handleDelete = (fileId) => {
    if (confirm('Delete this file?')) {
      deleteFile(fileId)
      setSelectedFiles(prev => {
        const newSet = new Set(prev)
        newSet.delete(fileId)
        return newSet
      })
      loadFiles()
    }
  }

  // Delete selected files
  const handleDeleteSelected = () => {
    if (selectedFiles.size === 0) return

    if (confirm(`Delete ${selectedFiles.size} file(s)?`)) {
      deleteFiles(Array.from(selectedFiles))
      setSelectedFiles(new Set())
      loadFiles()
    }
  }

  // Clear all files
  const handleClearAll = () => {
    if (confirm('Delete ALL files? This cannot be undone.')) {
      clearAllFiles()
      setSelectedFiles(new Set())
      loadFiles()
    }
  }

  // Handle file upload
  const handleUpload = async (e) => {
    const uploadedFiles = e.target.files
    if (!uploadedFiles || uploadedFiles.length === 0) return

    setUploading(true)

    try {
      for (const file of Array.from(uploadedFiles)) {
        await uploadFile(file, { folderPath: currentFolder })
      }
      loadFiles()
      setFolderRefresh((n) => n + 1)
    } catch (err) {
      alert(`Upload failed: ${err.message}`)
    }

    setUploading(false)
    e.target.value = ''
  }

  // Handle folder selection
  const handleFolderSelect = (path) => {
    setCurrentFolder(path)
    setSelectedFiles(new Set())
  }

  // Handle "Chat with Folder" - navigates to ARCHIVIST chat page
  const handleChatWithFolder = (path) => {
    const folderPath = encodeURIComponent(path || currentFolder)
    navigate(`/archivist?folder=${folderPath}`)
  }

  // Handle move selected files
  const handleMoveSelected = () => {
    if (selectedFiles.size === 0) return
    setMoveDialog({ fileIds: Array.from(selectedFiles) })
  }

  // Handle rename file
  const handleRename = (file) => {
    setRenameDialog({ file })
  }

  // Export files
  const handleExport = () => {
    const data = exportFiles()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `quox-files-${new Date().toISOString().split('T')[0]}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Import files
  const handleImport = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = e.target.files?.[0]
      if (!file) return

      try {
        const text = await file.text()
        const data = JSON.parse(text)
        const result = importFiles(data)
        alert(`Imported ${result.imported} files (${result.skipped} skipped)`)
        loadFiles()
      } catch (err) {
        alert(`Import failed: ${err.message}`)
      }
    }
    input.click()
  }

  // Drag-and-drop handlers for file upload
  const handleDragEnter = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragCounter(prev => prev + 1)
    if (e.dataTransfer?.items && e.dataTransfer.items.length > 0) {
      setIsDraggingOver(true)
    }
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragCounter(prev => {
      const newCount = prev - 1
      if (newCount === 0) {
        setIsDraggingOver(false)
      }
      return newCount
    })
  }

  const handleDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDraggingOver(false)
    setDragCounter(0)

    const droppedFiles = e.dataTransfer?.files
    if (!droppedFiles || droppedFiles.length === 0) return

    setUploading(true)

    try {
      let uploadCount = 0
      for (const file of Array.from(droppedFiles)) {
        // Check if it's a supported file type
        const supportedTypes = getSupportedFileTypes().split(',')
        const fileExt = '.' + file.name.split('.').pop().toLowerCase()
        const isSupported = supportedTypes.some(type =>
          type.includes(fileExt) || type === '*/*' || file.type.startsWith(type.replace('/*', ''))
        )

        if (isSupported || file.type) {
          await uploadFile(file, { folderPath: currentFolder })
          uploadCount++
        }
      }

      if (uploadCount > 0) {
        loadFiles()
        setFolderRefresh(n => n + 1)
      }

      if (uploadCount < droppedFiles.length) {
        alert(`Uploaded ${uploadCount} of ${droppedFiles.length} files. Some files were not supported.`)
      }
    } catch (err) {
      alert(`Upload failed: ${err.message}`)
    }

    setUploading(false)
  }

  return (
    <div
      className={`file-manager ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${isDraggingOver ? 'drag-over' : ''}`}
      ref={dropZoneRef}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDraggingOver && (
        <div className="fm-drop-overlay">
          <div className="fm-drop-indicator">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <span>Drop files here to upload</span>
            <span className="fm-drop-folder">to: {currentFolder === '/' ? 'Root' : currentFolder}</span>
          </div>
        </div>
      )}
      {/* Folder Sidebar */}
      <div className="fm-sidebar">
        <button
          className="fm-sidebar-toggle"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {sidebarCollapsed ? (
              <path d="M9 18l6-6-6-6" />
            ) : (
              <path d="M15 18l-6-6 6-6" />
            )}
          </svg>
        </button>

        {!sidebarCollapsed && (
          <FolderTree
            selectedPath={currentFolder}
            onSelect={handleFolderSelect}
            onChatWithFolder={handleChatWithFolder}
            refreshTrigger={folderRefresh}
            rootLabel={currentOrg?.name || 'Files'}
            onDropFiles={(fileIds, targetPath) => {
              if (targetPath === currentFolder) return
              const moved = moveFiles(fileIds, targetPath)
              if (moved > 0) {
                setSelectedFiles(new Set())
                loadFiles()
                setFolderRefresh(n => n + 1)
              }
            }}
          />
        )}
      </div>

      {/* Main Content */}
      <div className="fm-main">
        {/* Header */}
        <div className="fm-header">
          <div className="fm-title">
            <Breadcrumb
              path={currentFolder}
              onNavigate={handleFolderSelect}
              orgName={currentOrg?.name}
              orgLogo={currentOrg?.logo_url}
            />
          </div>

          {/* Storage indicator with server status */}
          <div className="fm-storage-section">
            {/* Server status indicator */}
            <div className={`fm-server-status ${serverStatus.available === true ? 'online' : serverStatus.available === false ? 'offline' : 'unknown'}`}>
              <span className="status-dot" />
              <span className="status-text">
                {serverStatus.checking ? 'Checking...' :
                 serverStatus.available === true ? 'Server' :
                 serverStatus.available === false ? 'Local only' : 'Unknown'}
              </span>
              {serverStatus.available === false && (
                <button
                  className="fm-mini-btn"
                  onClick={handleSyncMetadata}
                  title="Retry server connection"
                  disabled={serverStatus.checking}
                >
                  ↻
                </button>
              )}
            </div>

            {/* Storage bar */}
            {storage && (
              <div className="fm-storage">
                <div className="storage-bar">
                  <div
                    className={`storage-fill ${storage.percent > 90 ? 'critical' : storage.percent > 70 ? 'warning' : ''}`}
                    style={{ width: `${storage.percent}%` }}
                  />
                </div>
                <span className="storage-text">
                  {storage.formatted.used} / {storage.formatted.max} ({storage.fileCount} files)
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Toolbar */}
        <div className="fm-toolbar">
        {/* Search */}
        <div className="fm-search-container">
          <div className="fm-search">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              type="text"
              placeholder={semanticSearchEnabled ? "Semantic search..." : "Search files..."}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchingSemantics && (
              <span className="fm-search-loading">
                <svg className="spin" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 11-6.22-8.56"/><path d="M21 3v6h-6"/>
                </svg>
              </span>
            )}
          </div>
          {/* Semantic Search Toggle - Premium Feature */}
          <label
            className={`fm-semantic-toggle ${!isPremiumFilesAvailable() ? 'disabled' : ''}`}
            title={isPremiumFilesAvailable()
              ? 'Enable AI-powered semantic search'
              : 'Semantic search requires Advanced Memory plugin'
            }
          >
            <input
              type="checkbox"
              checked={semanticSearchEnabled}
              onChange={(e) => setSemanticSearchEnabled(e.target.checked)}
              disabled={!isPremiumFilesAvailable()}
            />
            <span className="fm-toggle-icon">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>
              </svg>
            </span>
            <span className="fm-toggle-label">AI</span>
            {!isPremiumFilesAvailable() && (
              <span className="fm-premium-badge">PRO</span>
            )}
          </label>
        </div>

        {/* Filters */}
        <div className="fm-filters">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="fm-filter-select"
          >
            <option value="all">All Files</option>
            <option value="image">Images</option>
            <option value="document">Documents</option>
          </select>

          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="fm-filter-select"
          >
            <option value="date">Newest</option>
            <option value="name">Name</option>
            <option value="size">Size</option>
          </select>
        </div>

        {/* View toggle */}
        <div className="fm-view-toggle">
          <button
            className={viewMode === 'grid' ? 'active' : ''}
            onClick={() => setViewMode('grid')}
            title="Grid view"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
            </svg>
          </button>
          <button
            className={viewMode === 'list' ? 'active' : ''}
            onClick={() => setViewMode('list')}
            title="List view"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Actions */}
        <div className="fm-actions">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={getSupportedFileTypes()}
            onChange={handleUpload}
            style={{ display: 'none' }}
          />
          <button
            className="fm-btn primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            {uploading ? 'Uploading...' : 'Upload'}
          </button>

          {/* Chat with Folder button */}
          <button
            className="fm-btn archivist"
            onClick={() => handleChatWithFolder(currentFolder)}
            title="Chat with ARCHIVIST about this folder"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
            Chat with Folder
          </button>

          {selectedFiles.size > 0 && (
            <>
              <button className="fm-btn secondary" onClick={handleMoveSelected}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                </svg>
                Move ({selectedFiles.size})
              </button>
              <button className="fm-btn danger" onClick={handleDeleteSelected}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                </svg>
                Delete ({selectedFiles.size})
              </button>
            </>
          )}

          <div className="fm-dropdown">
            <button className="fm-btn secondary fm-dropdown-toggle">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="5" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="19" r="1" fill="currentColor"/>
              </svg>
            </button>
            <div className="fm-dropdown-menu">
              <button onClick={selectAll}>
                {selectedFiles.size === files.length ? 'Deselect All' : 'Select All'}
              </button>
              <button onClick={handleExport}>Export All</button>
              <button onClick={handleImport}>Import</button>
              <hr />
              <button className="danger" onClick={handleClearAll}>Clear All</button>
            </div>
          </div>
        </div>
      </div>

      {/* File list/grid */}
      <div className={`fm-content ${viewMode}`}>
        {files.length === 0 ? (
          <div className="fm-empty">
            <svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
            </svg>
            <h3>No files yet</h3>
            <p>Upload images, PDFs, text, or JSON files to get started</p>
            <button
              className="fm-btn primary"
              onClick={() => fileInputRef.current?.click()}
            >
              Upload Files
            </button>
          </div>
        ) : viewMode === 'grid' ? (
          <div className="fm-grid">
            {files.map(file => (
              <FileCard
                key={file.id}
                file={file}
                selected={selectedFiles.has(file.id)}
                onSelect={handleSelect}
                onDelete={handleDelete}
                onPreview={setPreviewFile}
                selectedFiles={selectedFiles}
              />
            ))}
          </div>
        ) : (
          <div className="fm-list">
            <div className="fm-list-header">
              <div className="file-row-checkbox">
                <input
                  type="checkbox"
                  checked={selectedFiles.size === files.length && files.length > 0}
                  onChange={selectAll}
                />
              </div>
              <div className="file-row-icon">Type</div>
              <div className="file-row-name">Name</div>
              <div className="file-row-type">Category</div>
              <div className="file-row-size">Size</div>
              <div className="file-row-date">Date</div>
              <div className="file-row-actions">Actions</div>
            </div>
            {files.map(file => (
              <FileRow
                key={file.id}
                file={file}
                selected={selectedFiles.has(file.id)}
                onSelect={handleSelect}
                onDelete={handleDelete}
                onPreview={setPreviewFile}
                selectedFiles={selectedFiles}
              />
            ))}
          </div>
        )}
      </div>

      </div>

      {/* Preview modal */}
      {previewFile && (
        <FilePreviewModal
          file={previewFile}
          onClose={() => setPreviewFile(null)}
        />
      )}

      {/* Move files dialog */}
      {moveDialog && (
        <MoveFilesDialog
          fileIds={moveDialog.fileIds}
          currentPath={currentFolder}
          onClose={() => setMoveDialog(null)}
          onMoved={(count) => {
            loadFiles()
            setSelectedFiles(new Set())
            setFolderRefresh((n) => n + 1)
          }}
        />
      )}

      {/* Rename file dialog */}
      {renameDialog && (
        <RenameFileDialog
          file={renameDialog.file}
          onClose={() => setRenameDialog(null)}
          onRenamed={loadFiles}
        />
      )}
    </div>
  )
}

export default FileManager
