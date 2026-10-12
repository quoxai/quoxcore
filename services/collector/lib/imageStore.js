/**
 * Image Store
 *
 * Stores generated images (from Gemini tools) as files on disk with JSON sidecar metadata.
 * Each image gets a ULID-based filename and a companion .json file for metadata.
 *
 * Storage layout:
 *   /var/lib/quox/images/{ULID}.png
 *   /var/lib/quox/images/{ULID}.json   (sidecar metadata)
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const configResolver = require('./configResolver.js');

const STORAGE_DIR = process.env.IMAGE_STORE_PATH || '/var/lib/quox/images';

// STABILITY-AUDITS #3: saveImage() had no retention/quota — an unbounded
// generation stream (chat image tools) fills the volume forever. Bounded by
// both total bytes and item count, env-configurable, pruning the OLDEST
// images first (see listImageFilesOldestFirst()) whenever a save pushes
// either past its threshold. Defaults sized for a single-node collector
// deployment, not a hard product limit — raise via env for larger volumes.
const DEFAULT_MAX_STORAGE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
const DEFAULT_MAX_STORAGE_COUNT = 5000;

// VAULT-INTEG P13 slice 2: was a bare process.env read — now resolved
// through configResolver.getInstanceSetting() (platformCapabilities.js
// IMAGE_STORE_MAX_BYTES), called fresh on every enforceQuota() call (every
// saveImage()), so a stored/env override applies to the very next save, no
// restart needed.
function getMaxStorageBytes() {
  const v = Number(configResolver.getInstanceSetting('IMAGE_STORE_MAX_BYTES').value);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_STORAGE_BYTES;
}

// VAULT-INTEG P13 slice 2: was a bare process.env read — now resolved
// through configResolver.getInstanceSetting() (platformCapabilities.js
// IMAGE_STORE_MAX_COUNT), called fresh on every enforceQuota() call (every
// saveImage()), so a stored/env override applies to the very next save, no
// restart needed.
function getMaxStorageCount() {
  const v = Number(configResolver.getInstanceSetting('IMAGE_STORE_MAX_COUNT').value);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_STORAGE_COUNT;
}

// AGENT-OVERHAUL-3 — nanobanana was renamed to ImagesQ (id: imagesq). Existing
// on-disk sidecars and auth file_objects rows created before the rename carry
// the literal string 'nanobanana' in their agent/namespace/source_plugin
// fields forever — those rows are never migrated destructively. All NEW
// writes use 'imagesq'. Reads/filters below match BOTH values via this
// back-compat alias list so pre-rename images stay visible and filterable.
const NAMESPACE_ALIASES = ['imagesq', 'nanobanana'];

// ULID-safe character set (Crockford Base32)
const ULID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generate a ULID (Universally Unique Lexicographically Sortable Identifier).
 * Timestamp prefix ensures chronological sorting.
 */
function generateUlid() {
  const now = Date.now();
  let ts = now;
  const timeChars = [];
  for (let i = 0; i < 10; i++) {
    timeChars.unshift(ULID_CHARS[ts % 32]);
    ts = Math.floor(ts / 32);
  }
  const randomBytes = crypto.randomBytes(10);
  const randChars = [];
  for (let i = 0; i < 16; i++) {
    randChars.push(ULID_CHARS[randomBytes[i % 10] % 32]);
  }
  return timeChars.join('') + randChars.join('');
}

// Strict ULID validation: exactly 26 Crockford Base32 chars
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function isValidUlid(id) {
  return typeof id === 'string' && ULID_RE.test(id);
}

/**
 * Ensure the storage directory exists.
 */
function ensureDir() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

async function ensureDirAsync() {
  try {
    await fsp.access(STORAGE_DIR);
  } catch {
    await fsp.mkdir(STORAGE_DIR, { recursive: true });
  }
}

// STABILITY-AUDITS #3: listImages() previously did a fresh
// fs.readdirSync + fs.readFileSync-per-sidecar on EVERY call. Sidecars only
// ever change via saveImage()/deleteImage() in this same process, so an
// in-memory cache hydrated once (lazily, on first list) and kept in sync
// incrementally by save/delete removes that per-call disk-read cost
// entirely after the first call. null = "not yet hydrated this process".
let _sidecarCache = null; // Map<id, sidecar>

/**
 * Hydrates _sidecarCache from disk the first time it's needed (one readdir
 * + one readFile per sidecar — the same total cost the old sync path paid
 * on every single call). Every call after the first returns the same Map
 * with no disk I/O at all.
 */
async function ensureCacheHydrated() {
  if (_sidecarCache) return _sidecarCache;
  await ensureDirAsync();
  const cache = new Map();
  let files;
  try {
    files = await fsp.readdir(STORAGE_DIR);
  } catch {
    _sidecarCache = cache;
    return _sidecarCache;
  }
  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  await Promise.all(jsonFiles.map(async (file) => {
    try {
      const raw = await fsp.readFile(path.join(STORAGE_DIR, file), 'utf8');
      const sidecar = JSON.parse(raw);
      if (sidecar && sidecar.id) cache.set(sidecar.id, sidecar);
    } catch {
      // Skip corrupt sidecars — same tolerance the old sync path had.
    }
  }));
  _sidecarCache = cache;
  return _sidecarCache;
}

/**
 * Lists every stored image file (not its sidecar) as {id, file, bytes},
 * sorted OLDEST first, using only a directory listing + per-file stat — no
 * sidecar JSON is read. This works because generateUlid() is
 * timestamp-prefixed (see above), so a plain filename sort IS a
 * chronological sort. Used by enforceQuota() below to find prune
 * candidates without paying listImages()'s content-read cost.
 */
function listImageFilesOldestFirst() {
  let entries;
  try {
    entries = fs.readdirSync(STORAGE_DIR);
  } catch {
    return [];
  }
  const imageFiles = entries
    .filter((f) => !f.endsWith('.json') && isValidUlid(f.slice(0, 26)))
    .sort(); // ULID prefix -> lexicographic sort == chronological sort
  const out = [];
  for (const file of imageFiles) {
    let bytes = 0;
    try {
      bytes = fs.statSync(path.join(STORAGE_DIR, file)).size;
    } catch {
      continue; // file vanished between readdir and stat — skip, not fatal
    }
    out.push({ id: file.slice(0, 26), file, bytes });
  }
  return out;
}

/**
 * Enforces the byte/count quota by deleting the OLDEST images (ULID order)
 * until back under BOTH thresholds. Runs synchronously at the end of every
 * saveImage() call — best-effort: a prune failure is logged and skipped,
 * never thrown, so a quota-enforcement hiccup can never block the save that
 * just succeeded.
 */
function enforceQuota() {
  const maxBytes = getMaxStorageBytes();
  const maxCount = getMaxStorageCount();
  const files = listImageFilesOldestFirst();
  let totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  let remaining = files.length;
  let idx = 0;
  while (idx < files.length && (remaining > maxCount || totalBytes > maxBytes)) {
    const victim = files[idx];
    try {
      deleteImage(victim.id);
      console.warn(`[imageStore] quota exceeded (max ${maxBytes} bytes / ${maxCount} items) — pruned oldest image ${victim.id} (${victim.bytes} bytes)`);
    } catch (err) {
      console.warn(`[imageStore] quota prune failed for ${victim.id} (non-fatal): ${err.message}`);
    }
    totalBytes -= victim.bytes;
    remaining -= 1;
    idx += 1;
  }
}

/**
 * Determine file extension from MIME type.
 */
function extFromMime(mimeType) {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  };
  return map[mimeType] || '.png';
}

/**
 * FU-4 — best-effort fire-and-forget persist of the image buffer into
 * the Core file_objects store. Runs asynchronously after saveImage()
 * returns; failures are logged but never thrown. Only fires when both
 * org_id AND user_id are available in metadata, and INTERNAL_SERVICE_KEY
 * is configured. Legacy disk + sidecar writes are unaffected either way.
 */
function persistToFileObjectsBestEffort({ buffer, mimeType, metadata, id, ext }) {
  const orgId = metadata?.org_id;
  const userId = metadata?.user_id;
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!orgId || !userId || !serviceKey) return;

  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const filename = `${id}${ext}`;

  // Construct FormData once. Fire without awaiting.
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename);
    form.append('org_id', orgId);
    form.append('created_by', userId);
    // Forward writes use the current agent id. Pre-rename rows carrying the
    // literal 'nanobanana' namespace are left as-is (see NAMESPACE_ALIASES).
    form.append('namespace', 'imagesq');
    form.append('source_plugin', 'imagesq');
    if (metadata?.prompt || metadata?.model) {
      form.append('metadata', JSON.stringify({
        prompt: metadata.prompt || null,
        model: metadata.model || null,
        agent: metadata.agent || null,
        aspect_ratio: metadata.aspect_ratio || null,
      }));
    }
    fetch(`${authUrl}/api/internal/files/upload`, {
      method: 'POST',
      headers: { 'x-service-key': serviceKey },
      body: form,
      // STABILITY-AUDITS #5: an unresponsive auth service used to leave this
      // fire-and-forget upload's promise pending forever (never awaited, so
      // it never surfaced as a hang, but the request socket and its data
      // stayed open indefinitely). Mirrors server.js:178's existing
      // AbortSignal.timeout pattern.
      signal: AbortSignal.timeout(15000),
    }).catch(err => {
      // eslint-disable-next-line no-console
      console.warn('[imageStore] file_objects persist failed (non-fatal):', err?.message || err);
    });
  } catch (err) {
    // Swallow any synchronous setup error — persist is best-effort.
    // eslint-disable-next-line no-console
    console.warn('[imageStore] file_objects persist setup failed (non-fatal):', err?.message || err);
  }
}

/**
 * Save a base64-encoded image to disk with sidecar metadata.
 *
 * @param {string} base64 - Base64-encoded image data
 * @param {string} mimeType - MIME type (e.g. 'image/png')
 * @param {object} metadata - Additional metadata (prompt, model, agent, org_id, user_id, aspect_ratio)
 * @returns {{ id, path, url, sidecar }} Saved image info
 */
function saveImage(base64, mimeType, metadata = {}) {
  if (!base64 || typeof base64 !== 'string') {
    throw new Error('base64 data is required');
  }
  if (!mimeType || typeof mimeType !== 'string') {
    throw new Error('mimeType is required');
  }

  ensureDir();
  const id = generateUlid();
  const ext = extFromMime(mimeType);
  const imageFile = path.join(STORAGE_DIR, `${id}${ext}`);
  const sidecarFile = path.join(STORAGE_DIR, `${id}.json`);

  // Write image (with size limit)
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB size limit`);
  }
  fs.writeFileSync(imageFile, buffer);

  // Write sidecar
  const sidecar = {
    id,
    prompt: metadata.prompt || null,
    model: metadata.model || null,
    agent: metadata.agent || null,
    org_id: metadata.org_id || null,
    user_id: metadata.user_id || null,
    aspect_ratio: metadata.aspect_ratio || null,
    created_at: new Date().toISOString(),
    mime_type: mimeType,
    file_size: buffer.length,
    file_name: `${id}${ext}`,
  };
  fs.writeFileSync(sidecarFile, JSON.stringify(sidecar, null, 2));

  // Keep the listImages() cache in sync incrementally rather than
  // invalidating it wholesale — if it hasn't been hydrated yet this
  // process (_sidecarCache still null), leave it null; the first
  // listImages() call will hydrate from disk and pick this image up then.
  if (_sidecarCache) _sidecarCache.set(id, sidecar);

  // FU-4 — fire-and-forget Core file_objects persist (no await).
  persistToFileObjectsBestEffort({ buffer, mimeType, metadata, id, ext });

  // STABILITY-AUDITS #3: retention/quota — prune oldest images if this save
  // pushed total bytes/count over the configured threshold.
  enforceQuota();

  return {
    id,
    path: imageFile,
    url: `/api/v1/images/${id}`,
    sidecar,
  };
}

/**
 * List images with optional filtering and pagination.
 *
 * @param {object} filters
 * @param {string} [filters.agent] - Filter by agent
 * @param {string} [filters.model] - Filter by model
 * @param {string} [filters.prompt] - Substring match in prompt
 * @param {string} [filters.org_id] - Filter by org
 * @param {string} [filters.from] - ISO date string (inclusive lower bound)
 * @param {string} [filters.to] - ISO date string (inclusive upper bound)
 * @param {number} [filters.page=1] - Page number (1-based)
 * @param {number} [filters.limit=20] - Items per page
 * @returns {Promise<{ images: object[], total: number, page: number, limit: number }>}
 *
 * STABILITY-AUDITS #3: previously synchronous, doing a fresh
 * fs.readdirSync + fs.readFileSync per sidecar on EVERY call — a listing
 * endpoint hit at any real frequency did a full directory content-read
 * every time. Now async (fs.promises) and served from the in-memory
 * _sidecarCache (see ensureCacheHydrated() above), which pays that same
 * disk-read cost only once per process lifetime.
 */
async function listImages(filters = {}) {
  const cache = await ensureCacheHydrated();
  const { agent, model, prompt, org_id, from, to } = filters;
  const page = Math.max(parseInt(filters.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(filters.limit, 10) || 20, 1), 100);

  let images = Array.from(cache.values());

  // Apply filters
  // Dual-read: filtering by any NAMESPACE_ALIASES member (currently 'imagesq'
  // or the pre-rename 'nanobanana') matches sidecars written under either
  // name, so old images stay reachable after the rename. Filtering by any
  // other agent id behaves as a normal exact match.
  if (agent) {
    if (NAMESPACE_ALIASES.includes(agent)) {
      images = images.filter(img => NAMESPACE_ALIASES.includes(img.agent));
    } else {
      images = images.filter(img => img.agent === agent);
    }
  }
  if (model) images = images.filter(img => img.model === model);
  if (org_id) images = images.filter(img => img.org_id === org_id);
  if (prompt) {
    const lower = prompt.toLowerCase();
    images = images.filter(img => img.prompt && img.prompt.toLowerCase().includes(lower));
  }
  if (from) {
    const fromDate = new Date(from);
    images = images.filter(img => new Date(img.created_at) >= fromDate);
  }
  if (to) {
    const toDate = new Date(to);
    images = images.filter(img => new Date(img.created_at) <= toDate);
  }

  // Sort newest first
  images.sort((a, b) => b.created_at.localeCompare(a.created_at));

  const total = images.length;
  const offset = (page - 1) * limit;
  const paged = images.slice(offset, offset + limit);

  // Attach URLs
  const result = paged.map(img => ({
    ...img,
    url: `/api/v1/images/${img.id}`,
  }));

  return { images: result, total, page, limit };
}

/**
 * Delete an image and its sidecar.
 *
 * @param {string} id - ULID of the image
 * @returns {boolean} true if deleted
 */
function deleteImage(id) {
  if (!isValidUlid(id)) {
    throw new Error('Invalid image ID');
  }

  ensureDir();

  // Find the image file (could be .png, .jpg, .webp, .gif)
  const files = fs.readdirSync(STORAGE_DIR);
  const imageFile = files.find(f => f.startsWith(id) && !f.endsWith('.json'));
  const sidecarFile = `${id}.json`;

  let deleted = false;
  if (imageFile) {
    fs.unlinkSync(path.join(STORAGE_DIR, imageFile));
    deleted = true;
  }
  if (files.includes(sidecarFile)) {
    fs.unlinkSync(path.join(STORAGE_DIR, sidecarFile));
    deleted = true;
  }

  // Keep the listImages() cache in sync — see the matching set() in
  // saveImage() above.
  if (_sidecarCache) _sidecarCache.delete(id);

  return deleted;
}

/**
 * Get the filesystem path for an image by ID.
 * Returns null if not found.
 *
 * @param {string} id - ULID of the image
 * @returns {{ filePath: string, mimeType: string } | null}
 */
function getImagePath(id) {
  if (!isValidUlid(id)) return null;

  ensureDir();
  const files = fs.readdirSync(STORAGE_DIR);
  const imageFile = files.find(f => f.startsWith(id) && !f.endsWith('.json'));
  if (!imageFile) return null;

  const ext = path.extname(imageFile).toLowerCase();
  const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

  return {
    filePath: path.join(STORAGE_DIR, imageFile),
    mimeType: mimeMap[ext] || 'image/png',
  };
}

module.exports = {
  saveImage,
  listImages,
  deleteImage,
  getImagePath,
  generateUlid,
  isValidUlid,
  STORAGE_DIR,
  NAMESPACE_ALIASES,
  DEFAULT_MAX_STORAGE_BYTES,
  DEFAULT_MAX_STORAGE_COUNT,
  // Test-only: drops the in-memory sidecar cache so a test that wipes
  // STORAGE_DIR between cases doesn't read a stale in-memory listing.
  _resetCacheForTest: () => { _sidecarCache = null; },
};
