/**
 * Quox File Storage Service
 *
 * Manages file uploads for the chat interface.
 * Stores files as base64 in localStorage with metadata tracking.
 *
 * Features:
 * - Support for images (jpg, png, gif, webp) and documents (pdf, txt, md, json)
 * - File metadata: id, name, type, size, uploadedAt, associatedChat
 * - Size limits with warnings (5MB per file, 50MB total)
 * - List, get, delete operations
 * - Storage usage tracking
 * - Memory integration (entities, working set, vector search)
 */

import {
  createFileEntity,
  indexFileContent,
  trackFileAccess,
  removeFileEntity,
  isPremiumFilesAvailable
} from './fileMemoryBridge'

import { orgGet, orgSet, orgRemove } from './orgScopedStorage'
import { logFileUploaded, logFileDeleted, logFolderCreated, logFolderDeleted, logFolderUpdated } from './fileAudit'

const STORAGE_BASE = 'files'
const STORAGE_KEY = STORAGE_BASE
const METADATA_BASE = 'files-meta'
const FOLDERS_BASE = 'files-folders'
const SETTINGS_BASE = 'files-settings'

// Server-side file storage API (for unlimited storage)
// In dev, use the dedicated Vite proxy path so requests do not collide with the
// dashboard's own /files route and fall back to the SPA HTML shell.
const DEFAULT_FILE_SERVER_URL = import.meta.env.DEV ? '/files-api' : '/files'
const FILE_SERVER_URL = import.meta.env.VITE_FILE_SERVER_URL || DEFAULT_FILE_SERVER_URL

// Server state tracking
let serverAvailable = null // null = unknown, true/false = checked
let serverCheckPromise = null
let lastServerCheck = 0
const SERVER_CHECK_INTERVAL = 30000 // Re-check every 30 seconds

// Reset server state on org switch so availability re-checks for new org
if (typeof window !== 'undefined') {
  window.addEventListener('quox-org-switch', () => {
    serverAvailable = null
    serverCheckPromise = null
    lastServerCheck = 0
  })
}

// No limits by default - user controls their own server
// These are only used if explicitly enabled in settings
const DEFAULT_MAX_FILE_SIZE = Number.MAX_SAFE_INTEGER // No limit
const DEFAULT_MAX_TOTAL_SIZE = Number.MAX_SAFE_INTEGER // No limit

/**
 * Check if file server is available
 * @returns {Promise<boolean>}
 */
export async function checkServerHealth() {
  const now = Date.now()

  // Return cached result if recent
  if (serverAvailable !== null && (now - lastServerCheck) < SERVER_CHECK_INTERVAL) {
    return serverAvailable
  }

  // Avoid concurrent checks
  if (serverCheckPromise) {
    return serverCheckPromise
  }

  serverCheckPromise = (async () => {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3000)

      const response = await fetch(`${FILE_SERVER_URL}/health`, {
        signal: controller.signal
      })
      clearTimeout(timeout)

      serverAvailable = response.ok
      lastServerCheck = now

      if (serverAvailable) {
        console.log('[FileStorage] Server available at', FILE_SERVER_URL)
      }
      return serverAvailable
    } catch (err) {
      serverAvailable = false
      lastServerCheck = now
      console.warn('[FileStorage] Server not available:', err.message)
      return false
    } finally {
      serverCheckPromise = null
    }
  })()

  return serverCheckPromise
}

/**
 * Get server status info for UI
 */
export function getServerStatus() {
  return {
    url: FILE_SERVER_URL,
    available: serverAvailable,
    lastCheck: lastServerCheck ? new Date(lastServerCheck).toISOString() : null
  }
}

/**
 * Load metadata from server
 */
async function loadServerMetadata() {
  try {
    const response = await fetch(`${FILE_SERVER_URL}/metadata`)
    if (response.ok) {
      return await response.json()
    }
  } catch (err) {
    console.warn('[FileStorage] Failed to load server metadata:', err)
  }
  return null
}

/**
 * Save metadata to server
 */
async function saveServerMetadata(metadata) {
  try {
    const response = await fetch(`${FILE_SERVER_URL}/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata)
    })
    return response.ok
  } catch (err) {
    console.warn('[FileStorage] Failed to save server metadata:', err)
    return false
  }
}

/**
 * Load folders from server
 */
async function loadServerFolders() {
  try {
    const response = await fetch(`${FILE_SERVER_URL}/folders`)
    if (response.ok) {
      return await response.json()
    }
  } catch (err) {
    console.warn('[FileStorage] Failed to load server folders:', err)
  }
  return null
}

/**
 * Save folders to server
 */
async function saveServerFolders(folders) {
  try {
    const response = await fetch(`${FILE_SERVER_URL}/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(folders)
    })
    return response.ok
  } catch (err) {
    console.warn('[FileStorage] Failed to save server folders:', err)
    return false
  }
}

/**
 * Sync metadata between localStorage and server
 *
 * DISABLED: Server metadata/folders endpoints are NOT org-scoped.
 * The server stores a single flat metadata.json shared across all orgs,
 * which causes cross-org data leakage when syncing. localStorage (via
 * orgGet/orgSet) is the authoritative metadata store — already org-isolated.
 * The server is used only as a blob store for file data.
 *
 * To re-enable, the server needs org-scoped metadata endpoints:
 *   GET/POST /orgs/:orgId/metadata
 *   GET/POST /orgs/:orgId/folders
 */
export async function syncMetadata() {
  console.log('[FileStorage] Metadata sync skipped (server metadata not org-scoped)')
  return { synced: false, reason: 'disabled_not_org_scoped' }
}

/**
 * Recover orphaned files from server that have no metadata
 *
 * DISABLED: Server file listing is NOT org-scoped. All orgs share
 * a flat FILES_DIR, so listing "orphaned" files pulls in every other
 * org's uploads — a cross-org data leak.
 *
 * To re-enable, the server needs org-scoped file storage:
 *   /orgs/:orgId/files/ directory isolation
 *   GET /orgs/:orgId/list endpoint
 */
export async function recoverOrphanedFiles() {
  console.warn('[FileStorage] Recovery disabled (server storage not org-scoped)')
  return { recovered: 0, files: [] }
}

/**
 * Get file storage settings
 * @returns {Object} Settings with maxFileSize and maxTotalSize
 */
export function getFileStorageSettings() {
  try {
    const stored = orgGet(SETTINGS_BASE)
    if (stored) {
      const settings = JSON.parse(stored)
      return {
        maxFileSize: settings.maxFileSize || DEFAULT_MAX_FILE_SIZE,
        maxTotalSize: settings.maxTotalSize || DEFAULT_MAX_TOTAL_SIZE,
        // Limits disabled by default - user controls their own server
        enforceFileSizeLimit: settings.enforceFileSizeLimit === true, // default false
        enforceTotalSizeLimit: settings.enforceTotalSizeLimit === true // default false
      }
    }
  } catch (err) {
    console.warn('[FileStorage] Failed to load settings:', err)
  }
  return {
    maxFileSize: DEFAULT_MAX_FILE_SIZE,
    maxTotalSize: DEFAULT_MAX_TOTAL_SIZE,
    enforceFileSizeLimit: false, // No limits by default
    enforceTotalSizeLimit: false // No limits by default
  }
}

/**
 * Update file storage settings
 * @param {Object} newSettings - Partial settings to update
 * @returns {Object} Updated settings
 */
export function setFileStorageSettings(newSettings) {
  const current = getFileStorageSettings()
  const updated = { ...current, ...newSettings }
  try {
    orgSet(SETTINGS_BASE, JSON.stringify(updated))
  } catch (err) {
    console.warn('[FileStorage] Failed to save settings:', err)
  }
  return updated
}

// For backward compatibility
const MAX_FILE_SIZE = DEFAULT_MAX_FILE_SIZE
const MAX_TOTAL_SIZE = DEFAULT_MAX_TOTAL_SIZE

// Root folder constant
export const ROOT_FOLDER = '/'

// Supported file types
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
const SUPPORTED_DOC_TYPES = ['application/pdf', 'text/plain', 'text/markdown', 'application/json']
const SUPPORTED_EXTENSIONS = {
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'png': 'image/png',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'pdf': 'application/pdf',
  'txt': 'text/plain',
  'md': 'text/markdown',
  'json': 'application/json'
}

/**
 * Generate a unique file ID
 */
function generateFileId() {
  return `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

/**
 * Get file metadata from localStorage (internal)
 */
function getFileMetadataLocal() {
  try {
    const data = orgGet(METADATA_BASE)
    return data ? JSON.parse(data) : []
  } catch (err) {
    console.error('[FileStorage] Failed to parse metadata:', err)
    return []
  }
}

/**
 * Save file metadata to localStorage (internal)
 */
function saveFileMetadataLocal(metadata) {
  try {
    orgSet(METADATA_BASE, JSON.stringify(metadata))
  } catch (err) {
    console.error('[FileStorage] Failed to save metadata to localStorage:', err)
    // Don't throw - server might still work
  }
}

/**
 * Get file metadata (with server fallback)
 */
function getFileMetadata() {
  return getFileMetadataLocal()
}

/**
 * Save file metadata to localStorage AND server
 */
function saveFileMetadata(metadata) {
  // Always save to localStorage first (fast, synchronous)
  saveFileMetadataLocal(metadata)

  // Also save to server (async, don't block)
  if (serverAvailable !== false) {
    saveServerMetadata(metadata).catch(err => {
      console.warn('[FileStorage] Background server sync failed:', err)
    })
  }
}

/**
 * Get file data from server or localStorage
 * Always tries server first (uploads go to server since saveFileDataAsync),
 * falls back to localStorage for legacy files uploaded before server storage.
 */
async function getFileDataAsync(fileId) {
  // Always try server first — uploads go there
  const isServerUp = await checkServerHealth()
  if (isServerUp) {
    try {
      const response = await fetch(`${FILE_SERVER_URL}/file/${fileId}/base64`)
      if (response.ok) {
        const result = await response.json()
        return result.data ? `data:application/octet-stream;base64,${result.data}` : null
      }
    } catch (err) {
      console.warn('[FileStorage] Server fetch failed, trying localStorage:', err)
    }
  }
  // Fallback to localStorage for legacy files
  try {
    const key = `${STORAGE_KEY}_${fileId}`
    return localStorage.getItem(key)
  } catch (err) {
    console.error('[FileStorage] Failed to get file data:', err)
    return null
  }
}

/**
 * Get file data synchronously (for backward compatibility - uses cached or localStorage)
 * Prefer getFileDataAsync() which tries the server first.
 */
function getFileData(fileId) {
  try {
    // Try org-scoped key first
    const orgData = orgGet(`${STORAGE_KEY}_${fileId}`)
    if (orgData) return orgData
    // Fallback to raw localStorage key (legacy)
    return localStorage.getItem(`${STORAGE_KEY}_${fileId}`)
  } catch (err) {
    console.error('[FileStorage] Failed to get file data:', err)
    return null
  }
}

/**
 * Save file data to server (required - no localStorage fallback)
 *
 * Files must be stored on the file server for reliable unlimited storage.
 * localStorage is only used for metadata, not file content.
 */
async function saveFileDataAsync(fileId, base64Data, filename) {
  const isServerUp = await checkServerHealth()

  if (!isServerUp) {
    throw new Error(
      'File server is not running. Start it with:\n\n' +
      '  cd /opt/quoxcore/services/files && npm start\n\n' +
      'The file server provides unlimited storage for your files.'
    )
  }

  try {
    const response = await fetch(`${FILE_SERVER_URL}/upload-base64`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId, data: base64Data, filename })
    })

    if (response.ok) {
      console.log('[FileStorage] File saved to server:', fileId)
      return { storage: 'server' }
    }

    const errorData = await response.json().catch(() => ({}))
    throw new Error(errorData.error || `Server responded with ${response.status}`)
  } catch (err) {
    if (err.message.includes('File server is not running')) {
      throw err
    }
    console.error('[FileStorage] Server save failed:', err.message)
    throw new Error(`Failed to save file to server: ${err.message}`)
  }
}

/**
 * Save file data synchronously (deprecated - use saveFileDataAsync)
 */
function saveFileData(fileId, base64Data) {
  try {
    const key = `${STORAGE_KEY}_${fileId}`
    localStorage.setItem(key, base64Data)
  } catch (err) {
    console.error('[FileStorage] Failed to save file data:', err)
    throw new Error('Failed to save file data - storage may be full')
  }
}

/**
 * Delete file data from server and localStorage.
 *
 * Returns true ONLY when the server confirms deletion with a 2xx response.
 * Callers must not treat a non-confirmed delete as success (F08): a 500,
 * a network error, or an unreachable file server must not splice local
 * metadata or emit deletion evidence while the server-side blob survives.
 */
async function deleteFileDataAsync(fileId) {
  const isServerUp = await checkServerHealth()
  if (!isServerUp) {
    console.warn('[FileStorage] Server delete not confirmed (server unreachable):', fileId)
    return false
  }

  let confirmed = false
  try {
    const response = await fetch(`${FILE_SERVER_URL}/file/${fileId}`, { method: 'DELETE' })
    confirmed = response.ok
    if (!confirmed) {
      console.warn('[FileStorage] Server delete not confirmed, status:', response.status)
    }
  } catch (err) {
    console.warn('[FileStorage] Server delete failed:', err)
    return false
  }

  if (!confirmed) {
    return false
  }

  // Also clean localStorage (legacy files)
  try {
    const key = `${STORAGE_KEY}_${fileId}`
    localStorage.removeItem(key)
  } catch (err) {
    console.error('[FileStorage] Failed to delete file data:', err)
  }
  return true
}

/**
 * Delete file data from localStorage (sync version)
 */
function deleteFileData(fileId) {
  deleteFileDataAsync(fileId).catch(err => {
    console.warn('[FileStorage] Async delete failed:', err)
  })
  try {
    const key = `${STORAGE_KEY}_${fileId}`
    localStorage.removeItem(key)
  } catch (err) {
    console.error('[FileStorage] Failed to delete file data:', err)
  }
}

/**
 * Get folder metadata from localStorage (internal)
 */
function getFolderMetadataLocal() {
  try {
    const data = orgGet(FOLDERS_BASE)
    return data ? JSON.parse(data) : []
  } catch (err) {
    console.error('[FileStorage] Failed to parse folder metadata:', err)
    return []
  }
}

/**
 * Save folder metadata to localStorage (internal)
 */
function saveFolderMetadataLocal(folders) {
  try {
    orgSet(FOLDERS_BASE, JSON.stringify(folders))
  } catch (err) {
    console.error('[FileStorage] Failed to save folder metadata to localStorage:', err)
  }
}

/**
 * Get folder metadata
 */
function getFolderMetadata() {
  return getFolderMetadataLocal()
}

/**
 * Save folder metadata to localStorage AND server
 */
function saveFolderMetadata(folders) {
  saveFolderMetadataLocal(folders)

  if (serverAvailable !== false) {
    saveServerFolders(folders).catch(err => {
      console.warn('[FileStorage] Background folder sync failed:', err)
    })
  }
}

/**
 * Normalize folder path (ensure leading slash, no trailing slash except root)
 */
function normalizePath(path) {
  if (!path || path === '/') return '/'
  // Ensure leading slash, remove trailing slash
  let normalized = path.startsWith('/') ? path : '/' + path
  if (normalized !== '/' && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

/**
 * Get parent path from a path
 */
function getParentPath(path) {
  const normalized = normalizePath(path)
  if (normalized === '/') return null
  const parts = normalized.split('/')
  parts.pop()
  return parts.length <= 1 ? '/' : parts.join('/')
}

/**
 * Get folder name from path
 */
function getFolderName(path) {
  const normalized = normalizePath(path)
  if (normalized === '/') return 'Root'
  return normalized.split('/').pop()
}

/**
 * Check if file type is supported
 */
export function isFileTypeSupported(file) {
  const mimeType = file.type
  const extension = file.name.split('.').pop()?.toLowerCase()

  // Check by MIME type
  if (SUPPORTED_IMAGE_TYPES.includes(mimeType) || SUPPORTED_DOC_TYPES.includes(mimeType)) {
    return true
  }

  // Check by extension as fallback
  if (extension && SUPPORTED_EXTENSIONS[extension]) {
    return true
  }

  return false
}

/**
 * Get file category (image or document)
 */
export function getFileCategory(file) {
  const mimeType = file.type || getMimeFromExtension(file.name)

  if (SUPPORTED_IMAGE_TYPES.includes(mimeType)) {
    return 'image'
  }
  if (SUPPORTED_DOC_TYPES.includes(mimeType)) {
    return 'document'
  }
  return 'unknown'
}

/**
 * Get MIME type from file extension
 */
function getMimeFromExtension(filename) {
  const extension = filename.split('.').pop()?.toLowerCase()
  return SUPPORTED_EXTENSIONS[extension] || 'application/octet-stream'
}

// ============================================
// FOLDER OPERATIONS
// ============================================

/**
 * Create a new folder
 * @param {string} path - Full folder path (e.g., "/Documents/Work")
 * @param {Object} options - Folder options
 * @param {string} options.icon - Folder icon (emoji or icon name)
 * @param {string} options.color - Folder color (hex or CSS color)
 * @returns {Object} Created folder metadata
 */
export function createFolder(path, options = {}) {
  const normalized = normalizePath(path)

  if (normalized === '/') {
    throw new Error('Cannot create root folder')
  }

  const folders = getFolderMetadata()

  // Check if folder already exists
  if (folders.find(f => f.path === normalized)) {
    throw new Error('Folder already exists')
  }

  // Ensure parent folder exists (create if needed)
  const parentPath = getParentPath(normalized)
  if (parentPath && parentPath !== '/' && !folders.find(f => f.path === parentPath)) {
    // Recursively create parent
    createFolder(parentPath)
  }

  const folder = {
    path: normalized,
    name: getFolderName(normalized),
    icon: options.icon || '📁',
    color: options.color || null,
    createdAt: new Date().toISOString(),
    personality: options.personality || null
  }

  folders.push(folder)
  saveFolderMetadata(folders)

  logFolderCreated(folder)
  console.log('[FileStorage] Folder created:', normalized)
  return folder
}

/**
 * Rename a folder
 * @param {string} oldPath - Current folder path
 * @param {string} newName - New folder name (not full path)
 * @returns {Object} Updated folder metadata
 */
export function renameFolder(oldPath, newName) {
  const normalizedOld = normalizePath(oldPath)

  if (normalizedOld === '/') {
    throw new Error('Cannot rename root folder')
  }

  const folders = getFolderMetadata()
  const folderIndex = folders.findIndex(f => f.path === normalizedOld)

  if (folderIndex === -1) {
    throw new Error('Folder not found')
  }

  // Calculate new path
  const parentPath = getParentPath(normalizedOld)
  const newPath = parentPath === '/' ? `/${newName}` : `${parentPath}/${newName}`
  const normalizedNew = normalizePath(newPath)

  // Check if new path already exists
  if (folders.find(f => f.path === normalizedNew)) {
    throw new Error('A folder with this name already exists')
  }

  // Update folder
  folders[folderIndex] = {
    ...folders[folderIndex],
    path: normalizedNew,
    name: newName
  }

  // Update all subfolders
  folders.forEach((f, i) => {
    if (f.path.startsWith(normalizedOld + '/')) {
      folders[i] = {
        ...f,
        path: f.path.replace(normalizedOld, normalizedNew)
      }
    }
  })

  // Update all files in this folder and subfolders
  const files = getFileMetadata()
  let filesUpdated = 0
  files.forEach(file => {
    if (file.folderPath === normalizedOld) {
      file.folderPath = normalizedNew
      filesUpdated++
    } else if (file.folderPath?.startsWith(normalizedOld + '/')) {
      file.folderPath = file.folderPath.replace(normalizedOld, normalizedNew)
      filesUpdated++
    }
  })

  if (filesUpdated > 0) {
    saveFileMetadata(files)
  }

  saveFolderMetadata(folders)

  console.log('[FileStorage] Folder renamed:', normalizedOld, '->', normalizedNew)
  return folders[folderIndex]
}

/**
 * Delete a folder
 * @param {string} path - Folder path to delete
 * @param {Object} options - Delete options
 * @param {boolean} options.recursive - Delete contents (default: false, throws if not empty)
 * @returns {number} Number of files deleted
 */
export function deleteFolder(path, options = {}) {
  const normalized = normalizePath(path)

  if (normalized === '/') {
    throw new Error('Cannot delete root folder')
  }

  const folders = getFolderMetadata()
  const folderIndex = folders.findIndex(f => f.path === normalized)

  if (folderIndex === -1) {
    throw new Error('Folder not found')
  }

  // Get files in this folder
  const files = getFileMetadata()
  const filesInFolder = files.filter(f =>
    f.folderPath === normalized || f.folderPath?.startsWith(normalized + '/')
  )

  // Get subfolders
  const subfolders = folders.filter(f => f.path.startsWith(normalized + '/'))

  if (!options.recursive && (filesInFolder.length > 0 || subfolders.length > 0)) {
    throw new Error(`Folder is not empty (${filesInFolder.length} files, ${subfolders.length} subfolders)`)
  }

  // Delete files if recursive.
  // deleteFile() is now async (F08: it only confirms deletion after the
  // server returns a 2xx). deleteFolder() keeps its existing synchronous
  // contract for callers, so per-file deletes are fired without blocking;
  // filesDeleted stays an optimistic count of files queued for deletion,
  // same as before this fix, not a confirmed-deleted count.
  let filesDeleted = 0
  if (options.recursive) {
    filesInFolder.forEach(file => {
      deleteFile(file.id).catch(err => {
        console.warn('[FileStorage] Recursive folder delete failed for file:', file.id, err)
      })
      filesDeleted++
    })
  }

  // Remove subfolders
  const updatedFolders = folders.filter(f =>
    f.path !== normalized && !f.path.startsWith(normalized + '/')
  )

  saveFolderMetadata(updatedFolders)

  logFolderDeleted(normalized, filesDeleted)
  console.log('[FileStorage] Folder deleted:', normalized, `(${filesDeleted} files)`)
  return filesDeleted
}

/**
 * Update folder metadata
 * @param {string} path - Folder path
 * @param {Object} updates - Fields to update (icon, color, personality)
 * @returns {Object} Updated folder
 */
export function updateFolder(path, updates) {
  const normalized = normalizePath(path)
  const folders = getFolderMetadata()
  const folderIndex = folders.findIndex(f => f.path === normalized)

  if (folderIndex === -1) {
    throw new Error('Folder not found')
  }

  folders[folderIndex] = {
    ...folders[folderIndex],
    ...updates,
    path: normalized, // Don't allow path change through this method
    name: getFolderName(normalized)
  }

  saveFolderMetadata(folders)
  logFolderUpdated(normalized, updates)
  return folders[folderIndex]
}

/**
 * Get folder by path
 * @param {string} path - Folder path
 * @returns {Object|null} Folder metadata or null
 */
export function getFolder(path) {
  const normalized = normalizePath(path)
  if (normalized === '/') {
    return { path: '/', name: 'Root', icon: '📁', createdAt: null }
  }
  return getFolderMetadata().find(f => f.path === normalized) || null
}

/**
 * List all folders as flat array
 * @returns {Array} All folders
 */
export function listFolders() {
  return getFolderMetadata()
}

/**
 * Get folder tree structure
 * @returns {Object} Hierarchical folder tree
 */
export function getFolderTree() {
  const folders = getFolderMetadata()
  const files = getFileMetadata()

  // Build tree starting from root
  const tree = {
    path: '/',
    name: 'Root',
    icon: '📁',
    children: [],
    fileCount: files.filter(f => !f.folderPath || f.folderPath === '/').length
  }

  // Sort folders by path depth
  const sorted = [...folders].sort((a, b) =>
    a.path.split('/').length - b.path.split('/').length
  )

  // Build nested structure
  sorted.forEach(folder => {
    const parentPath = getParentPath(folder.path)
    const parent = findNodeByPath(tree, parentPath)

    if (parent) {
      parent.children.push({
        ...folder,
        children: [],
        fileCount: files.filter(f => f.folderPath === folder.path).length
      })
    }
  })

  return tree
}

/**
 * Find node in tree by path
 */
function findNodeByPath(node, path) {
  if (node.path === path) return node
  for (const child of node.children || []) {
    const found = findNodeByPath(child, path)
    if (found) return found
  }
  return null
}

/**
 * Move a file to a different folder
 * @param {string} fileId - File ID
 * @param {string} targetPath - Target folder path
 * @returns {Object} Updated file metadata
 */
export function moveFile(fileId, targetPath) {
  const normalized = normalizePath(targetPath)

  // Verify target folder exists (or is root)
  if (normalized !== '/' && !getFolder(normalized)) {
    throw new Error('Target folder does not exist')
  }

  const files = getFileMetadata()
  const fileIndex = files.findIndex(f => f.id === fileId)

  if (fileIndex === -1) {
    throw new Error('File not found')
  }

  const oldPath = files[fileIndex].folderPath || '/'
  files[fileIndex].folderPath = normalized
  saveFileMetadata(files)

  console.log('[FileStorage] File moved:', files[fileIndex].name, oldPath, '->', normalized)
  return files[fileIndex]
}

/**
 * Move multiple files to a folder
 * @param {Array<string>} fileIds - File IDs to move
 * @param {string} targetPath - Target folder path
 * @returns {number} Number of files moved
 */
export function moveFiles(fileIds, targetPath) {
  let moved = 0
  fileIds.forEach(id => {
    try {
      moveFile(id, targetPath)
      moved++
    } catch {
      // Skip files that can't be moved
    }
  })
  return moved
}

/**
 * Rename a file
 * @param {string} fileId - File ID
 * @param {string} newName - New file name
 * @returns {Object} Updated file metadata
 */
export function renameFile(fileId, newName) {
  if (!newName || newName.trim() === '') {
    throw new Error('File name cannot be empty')
  }

  const files = getFileMetadata()
  const fileIndex = files.findIndex(f => f.id === fileId)

  if (fileIndex === -1) {
    throw new Error('File not found')
  }

  const oldName = files[fileIndex].name
  files[fileIndex].name = newName.trim()
  saveFileMetadata(files)

  console.log('[FileStorage] File renamed:', oldName, '->', newName)
  return files[fileIndex]
}

// ============================================
// STORAGE STATS
// ============================================

/**
 * Calculate total storage used
 */
export function getStorageUsage() {
  const metadata = getFileMetadata()
  const settings = getFileStorageSettings()
  let totalSize = 0

  metadata.forEach(file => {
    totalSize += file.size || 0
  })

  const maxSize = settings.maxTotalSize
  return {
    used: totalSize,
    limit: maxSize,
    max: maxSize, // alias for backward compatibility
    percent: Math.round((totalSize / maxSize) * 100),
    fileCount: metadata.length,
    formatted: {
      used: formatFileSize(totalSize),
      max: formatFileSize(maxSize)
    },
    settings // Include settings for UI
  }
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes) {
  if (bytes === 0) return '0 B'
  if (!Number.isFinite(bytes) || bytes >= Number.MAX_SAFE_INTEGER) return 'Unlimited'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

/**
 * Upload a file
 * @param {File} file - The file to upload
 * @param {Object} options - Upload options
 * @param {string} options.chatId - Associated chat/conversation ID
 * @param {string} options.messageId - Associated message ID
 * @param {string} options.folderPath - Target folder path (default: "/")
 * @returns {Promise<Object>} - File metadata
 */
export async function uploadFile(file, options = {}) {
  const settings = getFileStorageSettings()

  // Validate file type
  if (!isFileTypeSupported(file)) {
    throw new Error(`Unsupported file type: ${file.type || file.name.split('.').pop()}`)
  }

  // Optional size limits (disabled by default - user controls their server)
  if (settings.enforceFileSizeLimit && file.size > settings.maxFileSize) {
    throw new Error(`File too large: ${formatFileSize(file.size)}. Maximum: ${formatFileSize(settings.maxFileSize)}. Disable limits in Settings > Files.`)
  }

  if (settings.enforceTotalSizeLimit) {
    const usage = getStorageUsage()
    if (usage.used + file.size > settings.maxTotalSize) {
      throw new Error(`Storage limit exceeded. Disable limits in Settings > Files.`)
    }
  }

  const warnings = []

  // Read file as base64
  const base64Data = await fileToBase64(file)

  // Generate file ID and metadata
  const fileId = generateFileId()
  const category = getFileCategory(file)

  const fileMetadata = {
    id: fileId,
    name: file.name,
    type: file.type || getMimeFromExtension(file.name),
    category,
    size: file.size,
    uploadedAt: new Date().toISOString(),
    folderPath: normalizePath(options.folderPath || '/'),
    chatId: options.chatId || null,
    messageId: options.messageId || null,
    thumbnail: category === 'image' ? await generateThumbnail(file) : null
  }

  // Save file data (async to server)
  await saveFileDataAsync(fileId, base64Data, file.name)

  // Update metadata
  const allMetadata = getFileMetadata()
  allMetadata.unshift(fileMetadata) // Add to beginning (newest first)
  saveFileMetadata(allMetadata)

  logFileUploaded(fileMetadata)
  console.log('[FileStorage] File uploaded:', fileMetadata.name, fileId)

  // Memory integration - create entity and index content
  try {
    // Create file entity in memory (works for free tier)
    await createFileEntity(fileMetadata)

    // Index text content if premium and text-based file
    if (isPremiumFilesAvailable()) {
      const textTypes = ['text/plain', 'text/markdown', 'application/json']
      if (textTypes.includes(fileMetadata.type)) {
        await indexFileContent(fileId, { ...fileMetadata, data: base64Data })
      }
    }
  } catch (memErr) {
    console.warn('[FileStorage] Memory integration failed (non-fatal):', memErr)
    // Don't fail upload if memory integration fails
  }

  return {
    ...fileMetadata,
    warnings
  }
}

/**
 * Convert file to base64
 */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = (err) => reject(err)
    reader.readAsDataURL(file)
  })
}

/**
 * Generate thumbnail for image files
 */
async function generateThumbnail(file, maxSize = 100) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')

        // Calculate thumbnail dimensions
        let width = img.width
        let height = img.height

        if (width > height) {
          if (width > maxSize) {
            height = Math.round((height * maxSize) / width)
            width = maxSize
          }
        } else {
          if (height > maxSize) {
            width = Math.round((width * maxSize) / height)
            height = maxSize
          }
        }

        canvas.width = width
        canvas.height = height
        ctx.drawImage(img, 0, 0, width, height)

        resolve(canvas.toDataURL('image/jpeg', 0.7))
      }
      img.onerror = () => resolve(null)
      img.src = e.target.result
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/**
 * Get a file by ID (async version for server storage)
 */
export async function getFileAsync(fileId) {
  const metadata = getFileMetadata().find(f => f.id === fileId)
  if (!metadata) return null

  const data = await getFileDataAsync(fileId)

  // Track file access in working set memory
  try {
    trackFileAccess(metadata)
  } catch {
    // Non-fatal - don't break file access
  }

  return {
    ...metadata,
    data
  }
}

/**
 * Get a file by ID (sync version - may not have data if stored on server)
 */
export function getFile(fileId) {
  const metadata = getFileMetadata().find(f => f.id === fileId)
  if (!metadata) return null

  const data = getFileData(fileId)

  // Track file access in working set memory
  try {
    trackFileAccess(metadata)
  } catch {
    // Non-fatal - don't break file access
  }

  return {
    ...metadata,
    data
  }
}

/**
 * List all files
 * @param {Object} options - Filter options
 * @param {string} options.folderPath - Filter by folder path
 * @param {boolean} options.recursive - Include files in subfolders
 * @param {string} options.chatId - Filter by chat ID
 * @param {string} options.category - Filter by category (image/document)
 * @param {string} options.search - Search query
 * @param {string} options.sortBy - Sort by (name/size/date)
 */
export function listFiles(options = {}) {
  let files = getFileMetadata()

  // Filter by folder path
  if (options.folderPath !== undefined) {
    const normalized = normalizePath(options.folderPath)
    if (options.recursive) {
      // Include files in folder and all subfolders
      if (normalized === '/') {
        // Root recursive = all files, no filter needed
      } else {
        files = files.filter(f => {
          const filePath = f.folderPath || '/'
          return filePath === normalized || filePath.startsWith(normalized + '/')
        })
      }
    } else {
      // Only files in this exact folder
      files = files.filter(f => (f.folderPath || '/') === normalized)
    }
  }

  // Filter by chat ID
  if (options.chatId) {
    files = files.filter(f => f.chatId === options.chatId)
  }

  // Filter by category
  if (options.category) {
    files = files.filter(f => f.category === options.category)
  }

  // Filter by search query
  if (options.search) {
    const query = options.search.toLowerCase()
    files = files.filter(f => f.name.toLowerCase().includes(query))
  }

  // Sort
  if (options.sortBy === 'name') {
    files.sort((a, b) => a.name.localeCompare(b.name))
  } else if (options.sortBy === 'size') {
    files.sort((a, b) => b.size - a.size)
  } else {
    // Default: sort by upload date (newest first)
    files.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
  }

  return files
}

/**
 * Delete a file.
 *
 * F08: local metadata removal and deletion evidence only happen after the
 * server confirms the delete with a 2xx. A failed/unreachable server delete
 * returns false and leaves the file's metadata and evidence untouched, so
 * the dashboard never claims a file is gone when its blob still exists.
 */
export async function deleteFile(fileId) {
  const metadata = getFileMetadata()
  const index = metadata.findIndex(f => f.id === fileId)

  if (index === -1) {
    return false
  }

  const target = metadata[index]

  const confirmed = await deleteFileDataAsync(fileId)
  if (!confirmed) {
    console.error('[FileStorage] Delete not confirmed by server, local metadata preserved:', fileId)
    return false
  }

  // Remove metadata only now that the server has confirmed deletion
  metadata.splice(index, 1)
  saveFileMetadata(metadata)

  // Remove file entity from memory
  try {
    removeFileEntity(fileId, target.name)
  } catch {
    // Non-fatal
  }

  logFileDeleted(fileId, target.name)
  console.log('[FileStorage] File deleted:', target.name, fileId)
  return true
}

/**
 * Delete multiple files
 */
export async function deleteFiles(fileIds) {
  let deleted = 0
  for (const id of fileIds) {
    if (await deleteFile(id)) deleted++
  }
  return deleted
}

/**
 * Delete all files for a chat
 */
export function deleteFilesForChat(chatId) {
  const files = listFiles({ chatId })
  return deleteFiles(files.map(f => f.id))
}

/**
 * Associate a file with a message
 */
export function associateFileWithMessage(fileId, messageId, chatId) {
  const metadata = getFileMetadata()
  const file = metadata.find(f => f.id === fileId)

  if (!file) return false

  file.messageId = messageId
  file.chatId = chatId
  saveFileMetadata(metadata)

  return true
}

/**
 * Get files attached to a message
 */
export function getFilesForMessage(messageId) {
  return listFiles().filter(f => f.messageId === messageId)
}

/**
 * Search files by name or content (for documents)
 */
export function searchFiles(query) {
  if (!query || query.trim() === '') {
    return listFiles()
  }

  const lowerQuery = query.toLowerCase()
  const metadata = getFileMetadata()

  return metadata.filter(file => {
    // Search in filename
    if (file.name.toLowerCase().includes(lowerQuery)) {
      return true
    }

    // Search in chat context
    if (file.chatId && file.chatId.toLowerCase().includes(lowerQuery)) {
      return true
    }

    return false
  })
}

/**
 * Export all files for backup
 */
export function exportFiles() {
  const metadata = getFileMetadata()
  const files = metadata.map(m => ({
    ...m,
    data: getFileData(m.id)
  }))

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    files
  }
}

/**
 * Import files from backup
 */
export function importFiles(backup, options = { merge: true }) {
  if (!backup || !backup.files) {
    throw new Error('Invalid backup format')
  }

  const existingMetadata = options.merge ? getFileMetadata() : []
  const existingIds = new Set(existingMetadata.map(f => f.id))

  let imported = 0
  let skipped = 0

  backup.files.forEach(file => {
    if (existingIds.has(file.id)) {
      skipped++
      return
    }

    // Save file data
    if (file.data) {
      saveFileData(file.id, file.data)
    }

    // Add metadata
    const { data, ...metadata } = file
    existingMetadata.push(metadata)
    imported++
  })

  saveFileMetadata(existingMetadata)

  return { imported, skipped }
}

/**
 * Clear all files (use with caution)
 */
export function clearAllFiles() {
  const metadata = getFileMetadata()

  // Delete all file data
  metadata.forEach(file => {
    deleteFileData(file.id)
  })

  // Clear metadata
  saveFileMetadata([])

  console.log('[FileStorage] All files cleared')
  return metadata.length
}

/**
 * Get file icon based on type
 */
export function getFileIcon(fileType) {
  if (SUPPORTED_IMAGE_TYPES.includes(fileType)) {
    return 'image'
  }

  switch (fileType) {
    case 'application/pdf':
      return 'pdf'
    case 'text/plain':
      return 'text'
    case 'text/markdown':
      return 'markdown'
    case 'application/json':
      return 'json'
    default:
      return 'file'
  }
}

/**
 * Check if a file is an image
 */
export function isImageFile(file) {
  const type = typeof file === 'string' ? file : (file.type || getMimeFromExtension(file.name))
  return SUPPORTED_IMAGE_TYPES.includes(type)
}

/**
 * Get supported file types as accept string for input
 */
export function getSupportedFileTypes() {
  return [
    ...SUPPORTED_IMAGE_TYPES,
    ...SUPPORTED_DOC_TYPES,
    ...Object.keys(SUPPORTED_EXTENSIONS).map(ext => `.${ext}`)
  ].join(',')
}

/**
 * Initialize file storage - call on app startup
 * Checks server health and syncs metadata
 */
export async function initFileStorage() {
  console.log('[FileStorage] Initializing...')

  // Check server health — server is a blob store only,
  // metadata lives in org-scoped localStorage
  const isServerUp = await checkServerHealth()

  if (isServerUp) {
    return { serverAvailable: true }
  } else {
    console.warn('[FileStorage] Server not available - uploads will fail until server starts')
    return { serverAvailable: false, warning: 'File server not running - uploads disabled' }
  }
}

// Default export with all functions
export default {
  // File operations
  uploadFile,
  getFile,
  getFileAsync,
  listFiles,
  deleteFile,
  deleteFiles,
  deleteFilesForChat,
  associateFileWithMessage,
  getFilesForMessage,
  searchFiles,
  moveFile,
  moveFiles,
  renameFile,
  // Folder operations
  createFolder,
  renameFolder,
  deleteFolder,
  updateFolder,
  getFolder,
  listFolders,
  getFolderTree,
  ROOT_FOLDER,
  // Storage and utilities
  getStorageUsage,
  formatFileSize,
  isFileTypeSupported,
  getFileCategory,
  getFileIcon,
  isImageFile,
  getSupportedFileTypes,
  exportFiles,
  importFiles,
  clearAllFiles,
  // Server management
  initFileStorage,
  checkServerHealth,
  getServerStatus,
  syncMetadata,
  recoverOrphanedFiles
}
