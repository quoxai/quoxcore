/**
 * FolderTree Component
 *
 * Displays a collapsible tree view of folders with:
 * - Expand/collapse functionality
 * - Folder selection
 * - Right-click context menu
 * - File counts per folder
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  getFolderTree,
  createFolder,
  renameFolder,
  deleteFolder
} from '../../services/fileStorage'

/**
 * Folder icon component
 */
function FolderIcon({ isOpen, icon, color }) {
  if (icon && icon !== '📁') {
    return <span className="folder-emoji">{icon}</span>
  }

  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke={color || 'currentColor'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="folder-svg-icon"
    >
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  )
}

/**
 * Chevron icon for expand/collapse
 */
function ChevronIcon({ isExpanded }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`chevron-icon ${isExpanded ? 'expanded' : ''}`}
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  )
}

/**
 * Context menu component
 */
function ContextMenu({ x, y, folder, onClose, onAction }) {
  const menuRef = useRef(null)

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  const menuItems = [
    { id: 'newFolder', label: 'New Folder', icon: '📁' },
    { id: 'rename', label: 'Rename', icon: '✏️', disabled: folder.path === '/' },
    { id: 'delete', label: 'Delete', icon: '🗑️', disabled: folder.path === '/', danger: true },
    { id: 'divider' },
    { id: 'chat', label: 'Chat with Folder', icon: '💬' }
  ]

  return (
    <div
      ref={menuRef}
      className="folder-context-menu"
      style={{ left: x, top: y }}
    >
      {menuItems.map((item, i) =>
        item.id === 'divider' ? (
          <div key={i} className="context-menu-divider" />
        ) : (
          <button
            key={item.id}
            className={`context-menu-item ${item.danger ? 'danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              onAction(item.id, folder)
              onClose()
            }}
          >
            <span className="context-menu-icon">{item.icon}</span>
            {item.label}
          </button>
        )
      )}
    </div>
  )
}

/**
 * New folder dialog
 */
function NewFolderDialog({ parentPath, onClose, onCreated }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('Folder name is required')
      return
    }

    try {
      const path = parentPath === '/' ? `/${name.trim()}` : `${parentPath}/${name.trim()}`
      createFolder(path)
      onCreated()
      onClose()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="folder-dialog-overlay" onClick={onClose}>
      <div className="folder-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>New Folder</h3>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Folder name"
            className="folder-input"
          />
          {error && <p className="folder-error">{error}</p>}
          <div className="folder-dialog-actions">
            <button type="button" className="btn-cancel" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-create">Create</button>
          </div>
        </form>
      </div>
    </div>
  )
}

/**
 * Rename folder dialog
 */
function RenameFolderDialog({ folder, onClose, onRenamed }) {
  const [name, setName] = useState(folder.name)
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('Folder name is required')
      return
    }

    try {
      renameFolder(folder.path, name.trim())
      onRenamed()
      onClose()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="folder-dialog-overlay" onClick={onClose}>
      <div className="folder-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Rename Folder</h3>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Folder name"
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
 * Single folder node in tree
 */
function FolderNode({
  folder,
  level,
  selectedPath,
  expandedPaths,
  onSelect,
  onToggle,
  onContextMenu,
  onDropFiles
}) {
  const [dragOver, setDragOver] = useState(false)
  const isSelected = folder.path === selectedPath
  const isExpanded = expandedPaths.has(folder.path)
  const hasChildren = folder.children && folder.children.length > 0

  const handleFolderDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.types.includes('application/quox-file-ids')) {
      e.dataTransfer.dropEffect = 'move'
      setDragOver(true)
    }
  }

  const handleFolderDragLeave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
  }

  const handleFolderDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const data = e.dataTransfer.getData('application/quox-file-ids')
    if (data && onDropFiles) {
      const fileIds = JSON.parse(data)
      onDropFiles(fileIds, folder.path)
    }
  }

  return (
    <div className="folder-node">
      <div
        className={`folder-item ${isSelected ? 'selected' : ''} ${dragOver ? 'drag-target' : ''}`}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={() => onSelect(folder.path)}
        onContextMenu={(e) => onContextMenu(e, folder)}
        onDragOver={handleFolderDragOver}
        onDragLeave={handleFolderDragLeave}
        onDrop={handleFolderDrop}
      >
        {hasChildren ? (
          <button
            className="folder-toggle"
            onClick={(e) => {
              e.stopPropagation()
              onToggle(folder.path)
            }}
          >
            <ChevronIcon isExpanded={isExpanded} />
          </button>
        ) : (
          <span className="folder-toggle-spacer" />
        )}

        <FolderIcon isOpen={isExpanded} icon={folder.icon} color={folder.color} />

        <span className="folder-name">{folder.name}</span>

        {folder.fileCount > 0 && (
          <span className="folder-count">{folder.fileCount}</span>
        )}
      </div>

      {hasChildren && isExpanded && (
        <div className="folder-children">
          {folder.children.map((child) => (
            <FolderNode
              key={child.path}
              folder={child}
              level={level + 1}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              onSelect={onSelect}
              onToggle={onToggle}
              onContextMenu={onContextMenu}
              onDropFiles={onDropFiles}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Main FolderTree Component
 */
export function FolderTree({
  selectedPath = '/',
  onSelect,
  onChatWithFolder,
  refreshTrigger,
  rootLabel,
  onDropFiles
}) {
  const [tree, setTree] = useState(null)
  const [expandedPaths, setExpandedPaths] = useState(new Set(['/']))
  const [contextMenu, setContextMenu] = useState(null)
  const [newFolderDialog, setNewFolderDialog] = useState(null)
  const [renameDialog, setRenameDialog] = useState(null)

  // Load folder tree
  const loadTree = useCallback(() => {
    const folderTree = getFolderTree()
    setTree(folderTree)
  }, [])

  useEffect(() => {
    loadTree()
  }, [loadTree, refreshTrigger])

  // Toggle folder expansion
  const handleToggle = useCallback((path) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  // Handle folder selection
  const handleSelect = useCallback((path) => {
    onSelect?.(path)

    // Auto-expand when selecting
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      next.add(path)
      return next
    })
  }, [onSelect])

  // Handle context menu
  const handleContextMenu = useCallback((e, folder) => {
    e.preventDefault()
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      folder
    })
  }, [])

  // Handle context menu action
  const handleContextAction = useCallback((action, folder) => {
    switch (action) {
      case 'newFolder':
        setNewFolderDialog({ parentPath: folder.path })
        break
      case 'rename':
        setRenameDialog({ folder })
        break
      case 'delete':
        if (confirm(`Delete folder "${folder.name}" and all its contents?`)) {
          try {
            deleteFolder(folder.path, { recursive: true })
            loadTree()
            if (selectedPath === folder.path || selectedPath.startsWith(folder.path + '/')) {
              onSelect?.('/')
            }
          } catch (err) {
            alert(err.message)
          }
        }
        break
      case 'chat':
        onChatWithFolder?.(folder.path)
        break
    }
  }, [loadTree, selectedPath, onSelect, onChatWithFolder])

  if (!tree) {
    return <div className="folder-tree-loading">Loading...</div>
  }

  return (
    <div className="folder-tree">
      <div className="folder-tree-header">
        <span className="folder-tree-title">Folders</span>
        <button
          className="folder-tree-add"
          onClick={() => setNewFolderDialog({ parentPath: selectedPath })}
          title="New Folder"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      </div>

      <div className="folder-tree-content">
        <FolderNode
          folder={rootLabel ? { ...tree, name: rootLabel } : tree}
          level={0}
          selectedPath={selectedPath}
          expandedPaths={expandedPaths}
          onSelect={handleSelect}
          onToggle={handleToggle}
          onContextMenu={handleContextMenu}
          onDropFiles={onDropFiles}
        />
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          folder={contextMenu.folder}
          onClose={() => setContextMenu(null)}
          onAction={handleContextAction}
        />
      )}

      {newFolderDialog && (
        <NewFolderDialog
          parentPath={newFolderDialog.parentPath}
          onClose={() => setNewFolderDialog(null)}
          onCreated={loadTree}
        />
      )}

      {renameDialog && (
        <RenameFolderDialog
          folder={renameDialog.folder}
          onClose={() => setRenameDialog(null)}
          onRenamed={loadTree}
        />
      )}
    </div>
  )
}

export default FolderTree
