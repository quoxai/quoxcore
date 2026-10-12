/**
 * File Storage Server
 *
 * Server-side file storage for the Quox Dashboard.
 * Replaces localStorage with disk-based storage for unlimited capacity.
 *
 * Endpoints:
 * - POST   /upload      - Upload a file (multipart/form-data)
 * - GET    /file/:id    - Download a file
 * - DELETE /file/:id    - Delete a file
 * - GET    /list        - List all files
 * - GET    /metadata    - Get all file metadata
 * - POST   /metadata    - Save all file metadata
 * - GET    /folders     - Get folder structure
 * - POST   /folders     - Save folder structure
 * - GET    /health      - Health check
 */

const express = require('express')
const cors = require('cors')
const multer = require('multer')
const path = require('path')
const fs = require('fs').promises
const { existsSync, mkdirSync, createReadStream, readFileSync } = require('fs')

// Version resolution: QUOXCORE_VERSION build arg → canonical /app/VERSION file
// → '0.0.0'. Prevents silently reporting the placeholder when the build arg is
// not passed. NOTE: this service's Docker build context is ./services/files
// (see docker-compose.yml), so the repo-root VERSION file is NOT COPY'd into the
// image — /app/VERSION will be absent unless the compose context is widened, and
// this resolver correctly falls back to the env var / '0.0.0'. Read once at load.
const RESOLVED_VERSION = (() => {
  if (process.env.QUOXCORE_VERSION) return process.env.QUOXCORE_VERSION
  try {
    const v = readFileSync('/app/VERSION', 'utf8').trim()
    if (v) return v
  } catch { /* file absent — fall through */ }
  return '0.0.0'
})()
const { JSDOM } = require('jsdom')
const createDOMPurify = require('dompurify')
const contentDisposition = require('content-disposition')
const crypto = require('crypto')
// fleet #369 — pure, no I/O — extracted so the merge/join logic (upsert-by-
// id for uploaded names/types, list-time join) is directly unit-testable
// without importing this module, which binds a live port at load time.
const { mergeUploadMetadata, joinFileListMetadata } = require('./fileMetadataMerge.js')

// CLI-PARITY WP1.1: runtime route-introspection helper for GET /__routes.
// Loaded fail-safe — a missing/renamed helper must not crash-loop this
// service at boot. This service's Docker build context is ./services/files
// (see docker-compose.yml `files.build.context`), so it can't reach
// services/shared/* — a local copy lives at the service root (this
// service has no lib/ directory).
let listRoutes = () => []
try {
  ;({ listRoutes } = require('./routeIntrospection.cjs'))
} catch (err) {
  console.warn('[ROUTE_INTROSPECTION] Failed to load ./routeIntrospection.cjs:', err.message)
}

// Initialize DOMPurify with jsdom for server-side sanitization
const window = new JSDOM('').window
const DOMPurify = createDOMPurify(window)

// ─── AEE Audit Helper (structured JSON to stdout) ───────────────────────────
function auditEnvelope(intent, payload) {
  try {
    console.log('[AEE]', JSON.stringify({
      ts: new Date().toISOString(),
      from: 'service.files',
      to: 'system.aee',
      intent,
      payload: payload || {},
    }))
  } catch { /* fire-and-forget */ }
}

// Configure DOMPurify for SVG sanitization - remove all dangerous elements
const SVG_PURIFY_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  // Remove script tags, event handlers, and foreign objects
  FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed'],
  FORBID_ATTR: [
    // Event handlers
    'onload', 'onerror', 'onclick', 'onmouseover', 'onmouseout', 'onmousedown',
    'onmouseup', 'onmousemove', 'onfocus', 'onblur', 'onchange', 'onsubmit',
    'onreset', 'onselect', 'onkeydown', 'onkeypress', 'onkeyup', 'ondblclick',
    'oncontextmenu', 'ondrag', 'ondragend', 'ondragenter', 'ondragleave',
    'ondragover', 'ondragstart', 'ondrop', 'onscroll', 'oncopy', 'oncut',
    'onpaste', 'onabort', 'oncanplay', 'oncanplaythrough', 'ondurationchange',
    'onemptied', 'onended', 'oninput', 'oninvalid', 'onloadeddata',
    'onloadedmetadata', 'onloadstart', 'onpause', 'onplay', 'onplaying',
    'onprogress', 'onratechange', 'onseeked', 'onseeking', 'onstalled',
    'onsuspend', 'ontimeupdate', 'onvolumechange', 'onwaiting', 'onwheel',
    'ontouchstart', 'ontouchmove', 'ontouchend', 'ontouchcancel',
    'onanimationstart', 'onanimationend', 'onanimationiteration',
    'ontransitionend', 'onpointerdown', 'onpointerup', 'onpointermove',
    'onpointerover', 'onpointerout', 'onpointerenter', 'onpointerleave',
    'onpointercancel', 'ongotpointercapture', 'onlostpointercapture'
  ],
  // Also remove href attributes with javascript: protocol
  ALLOW_UNKNOWN_PROTOCOLS: false
}

/**
 * Sanitize SVG content to remove malicious JavaScript
 * @param {Buffer|string} content - SVG file content
 * @returns {Buffer} - Sanitized SVG content
 */
function sanitizeSVG(content) {
  const svgString = content.toString('utf8')

  // Use DOMPurify to sanitize
  let sanitized = DOMPurify.sanitize(svgString, SVG_PURIFY_CONFIG)

  // Additional check: remove any remaining javascript: URLs that might slip through
  sanitized = sanitized.replace(/javascript:/gi, 'blocked:')
  sanitized = sanitized.replace(/data:text\/html/gi, 'blocked:')

  // Remove any xlink:href with javascript
  sanitized = sanitized.replace(/xlink:href\s*=\s*["']javascript:[^"']*["']/gi, 'xlink:href="blocked:"')

  return Buffer.from(sanitized, 'utf8')
}

/**
 * Check if a file is an SVG based on extension or mimetype
 * @param {string} filename - Original filename
 * @param {string} mimetype - File mimetype
 * @returns {boolean}
 */
function isSVGFile(filename, mimetype) {
  const ext = path.extname(filename).toLowerCase()
  return ext === '.svg' || mimetype === 'image/svg+xml'
}

const app = express()

// CORS — restrict to dashboard ports instead of wildcard (#186 security fix)
const FILES_ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:5173').split(',').map(o => o.trim())
const FILES_DASHBOARD_PORTS = ['3000', '3443', '443', '80']

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true)
    if (FILES_ALLOWED_ORIGINS.includes(origin)) return callback(null, true)
    try {
      const originUrl = new URL(origin)
      if (FILES_DASHBOARD_PORTS.includes(originUrl.port) ||
          (originUrl.port === '' && FILES_DASHBOARD_PORTS.includes(originUrl.protocol === 'https:' ? '443' : '80'))) {
        return callback(null, true)
      }
    } catch (e) { /* invalid URL */ }
    callback(new Error('Not allowed by CORS'))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}))

// CORS error handler
app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'cors_rejected', message: 'Origin not allowed by CORS policy' })
  }
  next(err)
})

app.use(express.json({ limit: '50mb' })) // Issue 1.4: Reasonable JSON body limit (was 10gb)

// Storage directory
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, 'data')
const FILES_DIR = path.join(STORAGE_DIR, 'files')
const METADATA_FILE = path.join(STORAGE_DIR, 'metadata.json')
const FOLDERS_FILE = path.join(STORAGE_DIR, 'folders.json')

// Ensure directories exist
if (!existsSync(STORAGE_DIR)) mkdirSync(STORAGE_DIR, { recursive: true })
if (!existsSync(FILES_DIR)) mkdirSync(FILES_DIR, { recursive: true })

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, FILES_DIR),
  filename: (req, file, cb) => {
    // Use cryptographically secure random bytes instead of Math.random()
    const randomPart = crypto.randomBytes(12).toString('base64url')
    const fileId = req.body.fileId || `file_${Date.now()}_${randomPart}`
    if (fileId.includes('..') || fileId.includes('/') || fileId.includes('\\')) {
      cb(Object.assign(new Error('invalid_file_id'), { status: 400 }))
      return
    }
    const ext = path.extname(file.originalname)
    cb(null, `${fileId}${ext}`)
  }
})

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // Issue 1.4: 100MB max per file (was Infinity)
    files: 10 // Issue 1.4: 10 files max per request (was 1000)
  }
})

// Load metadata from disk
async function loadMetadata() {
  try {
    const data = await fs.readFile(METADATA_FILE, 'utf8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

// Save metadata to disk
async function saveMetadata(metadata) {
  await fs.writeFile(METADATA_FILE, JSON.stringify(metadata, null, 2))
}


// Load folders from disk
async function loadFolders() {
  try {
    const data = await fs.readFile(FOLDERS_FILE, 'utf8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

// Save folders to disk
async function saveFolders(folders) {
  await fs.writeFile(FOLDERS_FILE, JSON.stringify(folders, null, 2))
}

// Upload file(s)
app.post('/upload', upload.array('files', 100), async (req, res) => {
  try {
    const results = []

    for (const file of req.files) {
      const fileId = path.basename(file.filename, path.extname(file.filename))

      // Sanitize SVG files to remove embedded JavaScript
      if (isSVGFile(file.originalname, file.mimetype)) {
        try {
          const content = await fs.readFile(file.path)
          const sanitized = sanitizeSVG(content)
          await fs.writeFile(file.path, sanitized)
          // Update file size after sanitization
          file.size = sanitized.length
          console.log(`Sanitized SVG file: ${file.originalname}`)
        } catch (sanitizeErr) {
          console.error(`Failed to sanitize SVG ${file.originalname}:`, sanitizeErr)
          // Delete the potentially malicious file
          await fs.unlink(file.path).catch(() => {})
          continue // Skip this file
        }
      }

      results.push({
        id: fileId,
        filename: file.filename,
        originalName: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
        path: file.path
      })
    }

    // fleet #369: originalName/mimetype were only ever returned in this
    // response, never persisted — callers that don't separately POST
    // /metadata (the dashboard frontend does via fileStorage.js;
    // `quox file upload` does not) lose them permanently, and /list had
    // no metadata to join even if it wanted to. Persist here so every
    // upload path gets real names/types in /list, matching the shape
    // fileStorage.js already uses (id, name, type, size, uploadedAt).
    if (results.length > 0) {
      try {
        const existingMetadata = await loadMetadata()
        await saveMetadata(mergeUploadMetadata(existingMetadata, results))
      } catch (metaErr) {
        console.warn('[Files] Failed to persist upload metadata:', metaErr.message)
      }
    }

    auditEnvelope('quox.files.uploaded', { count: results.length, totalSize: results.reduce((s, f) => s + f.size, 0) })
    res.json({ success: true, files: results })
  } catch (err) {
    console.error('Upload error:', err)
    res.status(500).json({ error: err.message })
  }
})

// Upload single file with base64 data (for backward compatibility)
app.post('/upload-base64', async (req, res) => {
  try {
    const { fileId, data, filename } = req.body

    if (!fileId || !data) {
      return res.status(400).json({ error: 'Missing fileId or data' })
    }

    if (fileId.includes('..') || fileId.includes('/') || fileId.includes('\\')) {
      return res.status(400).json({ error: 'invalid_file_id' })
    }

    // Remove data URL prefix if present and extract mimetype
    const dataUrlMatch = data.match(/^data:([^;]+);base64,/)
    const mimetype = dataUrlMatch ? dataUrlMatch[1] : ''
    const base64Data = data.replace(/^data:[^;]+;base64,/, '')
    let buffer = Buffer.from(base64Data, 'base64')

    const ext = filename ? path.extname(filename) : ''
    const filepath = path.join(FILES_DIR, `${fileId}${ext}`)

    // Sanitize SVG files to remove embedded JavaScript
    if (isSVGFile(filename || '', mimetype)) {
      try {
        buffer = sanitizeSVG(buffer)
        console.log(`Sanitized SVG file (base64): ${filename || fileId}`)
      } catch (sanitizeErr) {
        console.error(`Failed to sanitize SVG ${filename}:`, sanitizeErr)
        return res.status(400).json({ error: 'Invalid or malicious SVG file' })
      }
    }

    await fs.writeFile(filepath, buffer)

    auditEnvelope('quox.files.uploaded_base64', { fileId, size: buffer.length })
    res.json({
      success: true,
      id: fileId,
      size: buffer.length,
      path: filepath
    })
  } catch (err) {
    console.error('Upload base64 error:', err)
    res.status(500).json({ error: err.message })
  }
})

// Download file
// Issue 1.10: Fixed prefix matching to exact match with extension
app.get('/file/:id', async (req, res) => {
  try {
    const fileId = req.params.id

    // Issue 1.10: Validate no path traversal in file ID
    if (fileId.includes('..') || fileId.includes('/') || fileId.includes('\\')) {
      return res.status(400).json({ error: 'Invalid file ID' })
    }

    const files = await fs.readdir(FILES_DIR)
    // Issue 1.10: Exact match - file must be exactly the ID or ID with extension
    const file = files.find(f => f === fileId || f.startsWith(fileId + '.'))

    if (!file) {
      return res.status(404).json({ error: 'File not found' })
    }

    const filepath = path.join(FILES_DIR, file)

    // Issue 1.10: Verify resolved path is within FILES_DIR
    const resolvedPath = path.resolve(filepath)
    const resolvedDir = path.resolve(FILES_DIR)
    if (!resolvedPath.startsWith(resolvedDir + path.sep)) {
      return res.status(400).json({ error: 'Invalid file path' })
    }
    const stat = await fs.stat(filepath)
    const ext = path.extname(file).toLowerCase()

    res.setHeader('Content-Length', stat.size)

    // Security headers for SVG files - force download instead of inline rendering
    // This prevents any residual scripts from executing in the browser context
    if (ext === '.svg') {
      res.setHeader('Content-Type', 'image/svg+xml')
      // Use content-disposition library for proper RFC 5987 encoding
      // This prevents HTTP header injection via malicious filenames
      res.setHeader('Content-Disposition', contentDisposition(file, { type: 'attachment' }))
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    }

    createReadStream(filepath).pipe(res)
  } catch (err) {
    console.error('Download error:', err)
    res.status(500).json({ error: err.message })
  }
})

// Get file as base64 (for backward compatibility)
// Issue 1.10: Fixed prefix matching
app.get('/file/:id/base64', async (req, res) => {
  try {
    const fileId = req.params.id

    // Issue 1.10: Validate no path traversal
    if (fileId.includes('..') || fileId.includes('/') || fileId.includes('\\')) {
      return res.status(400).json({ error: 'Invalid file ID' })
    }

    const files = await fs.readdir(FILES_DIR)
    // Issue 1.10: Exact match with extension
    const file = files.find(f => f === fileId || f.startsWith(fileId + '.'))

    if (!file) {
      return res.status(404).json({ error: 'File not found' })
    }

    const filepath = path.join(FILES_DIR, file)
    const data = await fs.readFile(filepath)
    const base64 = data.toString('base64')
    const ext = path.extname(file).toLowerCase()

    // For SVG files, include a flag indicating the file was sanitized
    // and should be treated with care by the client
    res.json({
      id: req.params.id,
      data: base64,
      isSVG: ext === '.svg',
      sanitized: ext === '.svg' // SVGs are sanitized on upload
    })
  } catch (err) {
    console.error('Get base64 error:', err)
    res.status(500).json({ error: err.message })
  }
})

// Delete file
app.delete('/file/:id', async (req, res) => {
  try {
    const files = await fs.readdir(FILES_DIR)
    const file = files.find(f => f.startsWith(req.params.id))

    if (!file) {
      return res.status(404).json({ error: 'File not found' })
    }

    await fs.unlink(path.join(FILES_DIR, file))
    auditEnvelope('quox.files.deleted', { fileId: req.params.id })
    res.json({ success: true })
  } catch (err) {
    console.error('Delete error:', err)
    res.status(500).json({ error: err.message })
  }
})

// List all files
app.get('/list', async (req, res) => {
  try {
    const files = await fs.readdir(FILES_DIR)
    // fleet #369: join persisted metadata (name/type) — previously this
    // returned only the on-disk generated filename/id, so CLI users saw
    // dashes for Name and Type on every file.
    const metadata = await loadMetadata()
    const diskFiles = await Promise.all(files.map(async (f) => {
      const stat = await fs.stat(path.join(FILES_DIR, f))
      return { filename: f, id: path.basename(f, path.extname(f)), size: stat.size, mtime: stat.mtime }
    }))
    res.json({ files: joinFileListMetadata(diskFiles, metadata) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get all metadata
app.get('/metadata', async (req, res) => {
  try {
    const metadata = await loadMetadata()
    res.json(metadata)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Save all metadata
app.post('/metadata', async (req, res) => {
  try {
    await saveMetadata(req.body)
    auditEnvelope('quox.files.metadata_saved', { count: Array.isArray(req.body) ? req.body.length : 0 })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get folders
app.get('/folders', async (req, res) => {
  try {
    const folders = await loadFolders()
    res.json(folders)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Save folders
app.post('/folders', async (req, res) => {
  try {
    await saveFolders(req.body)
    auditEnvelope('quox.files.folders_saved', { count: Array.isArray(req.body) ? req.body.length : 0 })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Storage stats
app.get('/stats', async (req, res) => {
  try {
    const files = await fs.readdir(FILES_DIR)
    let totalSize = 0

    for (const f of files) {
      const stat = await fs.stat(path.join(FILES_DIR, f))
      totalSize += stat.size
    }

    res.json({
      fileCount: files.length,
      totalSize,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      storageDir: STORAGE_DIR
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'quox-files', version: RESOLVED_VERSION, storage: STORAGE_DIR })
})

// CLI-PARITY WP1.1: GET /__routes — fully-resolved route table for the CLI's
// live-vs-static endpoint diff. Mounted last (after every app.use/route
// above, before the error handlers).
// Auth: this service has no existing internal-auth middleware (all its
// routes are unauthenticated Docker-internal endpoints) — per the CLI
// parity plan, fall back to a shared X-Quox-Service-Key env check
// consistent with the other services' INTERNAL_SERVICE_KEY value.
app.get('/__routes', (req, res) => {
  const key = req.headers['x-quox-service-key']
  if (!key || key !== process.env.INTERNAL_SERVICE_KEY) {
    return res.status(401).json({ error: 'Invalid service key' })
  }
  res.json({ service: 'files', routes: listRoutes(app) })
})

// Global error sanitizer — prevent internal details leaking to users
app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'cors_rejected', message: 'Origin not allowed' })
  }
  if (err.message === 'invalid_file_id') {
    return res.status(400).json({ error: 'invalid_file_id' })
  }
  console.error(`[Files] Unhandled error on ${req.method} ${req.path}:`, err.message)
  const safeMessage = (process.env.NODE_ENV === 'production')
    ? 'An internal error occurred'
    : err.message?.substring(0, 200) || 'Unknown error'
  res.status(err.status || 500).json({ error: safeMessage })
})

const PORT = process.env.PORT || 3102

app.listen(PORT, '0.0.0.0', () => {
  console.log(`File Storage Server running on port ${PORT} (all interfaces)`)
  console.log(`Storage directory: ${STORAGE_DIR}`)
})

module.exports = app
