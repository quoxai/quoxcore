/**
 * file_objects routes — FU-1
 *
 * Core file service. Every uploaded/generated file in the system flows
 * through here. Storage is content-addressed on disk (SHA-256) with a
 * per-org path prefix so sibling orgs can't read each other's blobs even
 * if the DB layer were bypassed.
 *
 * Physical storage:
 *   AUTH_FILES_ROOT (env, default /var/lib/quox/file-objects)
 *     └── {org_id}/{sha256[:2]}/{sha256}
 *
 * De-dup: uploading the same content twice within one org points a second
 * file_objects row at the same blob. Delete is soft (status='deleted');
 * a nightly job can sweep blobs whose reference count drops to zero.
 */

import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { prepare } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';
import { ulid, getPagination, formatPaginatedResponse } from '../utils/helpers.js';
import { validateNamespace, validateVirtualPath, contentAddressedPath } from '../lib/fileObjectsValidator.js';

// Stored-XSS hardening for file downloads. Uploader-declared mime is never
// trusted: only allowlisted raster images + PDF whose leading bytes match the
// claimed type are served inline; everything else is a forced download as
// application/octet-stream. nosniff + sandbox CSP go on every response.
const INLINE_MAGIC = {
  'image/png': (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a'),
  'image/webp': (b) => b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/avif': (b) => b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp' && /^avi[fs]$/.test(b.subarray(8, 12).toString('latin1')),
  'application/pdf': (b) => b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-',
};

export function fileServeHeaders(mime, filename, headBytes) {
  const declared = String(mime || '').split(';')[0].trim().toLowerCase();
  const head = Buffer.isBuffer(headBytes) ? headBytes : Buffer.alloc(0);
  const check = INLINE_MAGIC[declared];
  const inline = !!(check && check(head));
  const safeName = String(filename || 'file').replace(/[\x00-\x1f\x7f"\\]/g, '_');
  const encoded = encodeURIComponent(String(filename || 'file').replace(/[\x00-\x1f\x7f]/g, '_'));
  return {
    'Content-Type': inline ? declared : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encoded}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
  };
}

function safeCompare(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}
function requireInternalAuth(req, res, next) {
  const expected = process.env.INTERNAL_SERVICE_KEY;
  if (!expected) return res.status(401).json({ error: 'Service key not configured' });
  const key = req.headers['x-service-key'];
  if (key && safeCompare(String(key), expected)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

export const fileObjectsInternalRouter = Router();
fileObjectsInternalRouter.use(requireInternalAuth);

const router = Router();
router.use(requireAuth);

const FILES_ROOT = process.env.AUTH_FILES_ROOT || '/var/lib/quox/file-objects';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB default cap

// Ensure root exists on first require — fails fast if misconfigured.
try { fs.mkdirSync(FILES_ROOT, { recursive: true }); } catch { /* noop — will surface on write */ }

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

function rowToFile(r) {
  if (!r) return null;
  let metadata = {};
  try { metadata = r.metadata_json ? JSON.parse(r.metadata_json) : {}; } catch { /* noop */ }
  return {
    id: r.id,
    org_id: r.org_id,
    created_by: r.created_by,
    namespace: r.namespace,
    virtual_path: r.virtual_path,
    filename: r.filename,
    mime: r.mime,
    size_bytes: r.size_bytes,
    sha256: r.sha256,
    source_plugin: r.source_plugin,
    source_ref: r.source_ref,
    metadata,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/**
 * F10 (cross-plugin defect sweep, 2026-10-03): create operations here had no
 * retry-idempotency mechanism. SHA-256 dedup only collapses the on-disk
 * BLOB — it does nothing to stop a retried request (lost response, timeout,
 * proxy retry) from inserting a second, distinct file_objects row for the
 * same logical create, with its own quota/billing consequences.
 *
 * Callers that want retry-safety pass `idempotency_key` (scoped per org by
 * the unique index on (org_id, idempotency_key)); a second create with the
 * same key returns the row from the FIRST create instead of inserting a new
 * one. Callers that omit the key keep today's behavior unchanged — this is
 * additive, not a required field.
 */
function insertFileObjectIdempotent(orgId, idempotencyKey, fields) {
  if (idempotencyKey) {
    const existing = prepare(
      'SELECT * FROM file_objects WHERE org_id = ? AND idempotency_key = ?'
    ).get(orgId, idempotencyKey);
    if (existing) {
      return { row: existing, created: false };
    }
  }

  const id = ulid();
  try {
    prepare(`
      INSERT INTO file_objects
        (id, org_id, created_by, namespace, virtual_path, filename, mime, size_bytes, sha256, blob_path,
         source_plugin, source_ref, metadata_json, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, orgId, fields.createdBy, fields.namespace, fields.virtualPath, fields.filename,
      fields.mime, fields.sizeBytes, fields.sha256, fields.blobPath,
      fields.sourcePlugin, fields.sourceRef, JSON.stringify(fields.metadata || {}),
      idempotencyKey || null,
    );
  } catch (err) {
    // Race: two concurrent requests with the same key both missed the
    // SELECT above. The unique index rejects the loser; fall back to the
    // winner's row rather than surfacing a 500 for a request that is, by
    // definition, a safe retry.
    if (idempotencyKey && /UNIQUE constraint failed.*idempotency_key/i.test(err.message || '')) {
      const existing = prepare(
        'SELECT * FROM file_objects WHERE org_id = ? AND idempotency_key = ?'
      ).get(orgId, idempotencyKey);
      if (existing) return { row: existing, created: false };
    }
    throw err;
  }

  return { row: prepare('SELECT * FROM file_objects WHERE id = ?').get(id), created: true };
}

function writeBlobIfAbsent(orgId, sha256, buffer) {
  const relPath = contentAddressedPath(orgId, sha256);
  const absPath = path.join(FILES_ROOT, relPath);
  if (fs.existsSync(absPath)) return relPath;
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  // Atomic write via tmp + rename so concurrent uploads don't half-write.
  const tmp = absPath + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, buffer);
  try { fs.renameSync(tmp, absPath); }
  catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* noop */ }
    if (!fs.existsSync(absPath)) throw err;
  }
  return relPath;
}

router.post('/orgs/:orgId/files/upload', requireOrgMembership, upload.single('file'), (req, res) => {
  try {
    const { orgId } = req.params;
    const userId = req.user?.id || req.user?.sub;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });
    if (!req.file) return res.status(400).json({ error: 'file field required' });

    const bodyOrg = req.body?.org_id;
    if (bodyOrg && bodyOrg !== orgId) return res.status(403).json({ error: 'cross_org_forbidden' });

    const namespace = req.body?.namespace || 'files';
    const nsErr = validateNamespace(namespace);
    if (nsErr) return res.status(400).json({ error: nsErr });

    const filename = (req.body?.filename || req.file.originalname || 'file').slice(0, 255);
    const virtualPath = req.body?.virtual_path || `/${namespace.replace(/\//g, '_')}/${filename}`;
    const vpErr = validateVirtualPath(virtualPath);
    if (vpErr) return res.status(400).json({ error: vpErr });

    const sourcePlugin = req.body?.source_plugin || null;
    const sourceRef = req.body?.source_ref || null;
    let metadata = {};
    if (req.body?.metadata) {
      try { metadata = typeof req.body.metadata === 'string' ? JSON.parse(req.body.metadata) : req.body.metadata; }
      catch { return res.status(400).json({ error: 'metadata must be valid JSON' }); }
    }

    const buffer = req.file.buffer;
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

    // De-dup within the org — reuse the existing blob path if any row has this sha.
    const existing = prepare('SELECT id, blob_path FROM file_objects WHERE org_id = ? AND sha256 = ? LIMIT 1').get(orgId, sha256);
    let blobPath;
    if (existing && existing.blob_path) {
      blobPath = existing.blob_path;
      // Sanity — if disk copy is missing (corrupted deploy), re-write it.
      if (!fs.existsSync(path.join(FILES_ROOT, blobPath))) {
        blobPath = writeBlobIfAbsent(orgId, sha256, buffer);
      }
    } else {
      blobPath = writeBlobIfAbsent(orgId, sha256, buffer);
    }

    const id = ulid();
    prepare(`
      INSERT INTO file_objects
        (id, org_id, created_by, namespace, virtual_path, filename, mime, size_bytes, sha256, blob_path,
         source_plugin, source_ref, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, orgId, userId, namespace, virtualPath, filename,
      req.file.mimetype || 'application/octet-stream',
      buffer.length, sha256, blobPath,
      sourcePlugin, sourceRef, JSON.stringify(metadata || {}),
    );

    const row = prepare('SELECT * FROM file_objects WHERE id = ?').get(id);
    res.status(201).json(rowToFile(row));
  } catch (err) {
    console.error('file upload error:', err);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

router.get('/orgs/:orgId/files', requireOrgMembership, (req, res) => {
  try {
    const { orgId } = req.params;
    const pagination = getPagination(req.query, 50, 200);
    const nsPrefix = typeof req.query.namespace_prefix === 'string' ? req.query.namespace_prefix : '';
    const includeDeleted = req.query.include_deleted === 'true';

    const where = ['org_id = ?'];
    const params = [orgId];
    if (!includeDeleted) { where.push("status = 'active'"); }
    if (nsPrefix) { where.push('namespace LIKE ?'); params.push(nsPrefix + '%'); }
    const whereSql = where.join(' AND ');

    const total = prepare(`SELECT COUNT(*) AS n FROM file_objects WHERE ${whereSql}`).get(...params).n;
    const rows = prepare(`
      SELECT * FROM file_objects
      WHERE ${whereSql}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pagination.limit, pagination.offset);
    res.json(formatPaginatedResponse(rows.map(rowToFile), total, pagination));
  } catch (err) {
    console.error('file list error:', err);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

router.get('/orgs/:orgId/files/:fileId/meta', requireOrgMembership, (req, res) => {
  try {
    const { orgId, fileId } = req.params;
    const row = prepare('SELECT * FROM file_objects WHERE id = ? AND org_id = ?').get(fileId, orgId);
    if (!row) return res.status(404).json({ error: 'file_not_found' });
    res.json(rowToFile(row));
  } catch (err) {
    console.error('file meta error:', err);
    res.status(500).json({ error: 'Failed to load file' });
  }
});

router.get('/orgs/:orgId/files/:fileId', requireOrgMembership, (req, res) => {
  try {
    const { orgId, fileId } = req.params;
    const row = prepare('SELECT blob_path, mime, filename, size_bytes, status FROM file_objects WHERE id = ? AND org_id = ?').get(fileId, orgId);
    if (!row) return res.status(404).json({ error: 'file_not_found' });
    if (row.status === 'deleted') return res.status(410).json({ error: 'file_deleted' });

    const abs = path.resolve(path.join(FILES_ROOT, row.blob_path));
    const rootResolved = path.resolve(FILES_ROOT);
    if (!abs.startsWith(rootResolved + path.sep)) return res.status(400).json({ error: 'invalid_blob_path' });
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'blob_missing' });

    const head = Buffer.alloc(16);
    let n = 0;
    try {
      const fd = fs.openSync(abs, 'r');
      try { n = fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
    } catch { n = 0; }
    const headers = fileServeHeaders(row.mime, row.filename, head.subarray(0, n));
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.setHeader('Content-Length', row.size_bytes);
    fs.createReadStream(abs).pipe(res);
  } catch (err) {
    console.error('file stream error:', err);
    res.status(500).json({ error: 'Failed to stream file' });
  }
});

router.patch('/orgs/:orgId/files/:fileId', requireOrgMembership, (req, res) => {
  try {
    const { orgId, fileId } = req.params;
    const existing = prepare('SELECT id FROM file_objects WHERE id = ? AND org_id = ?').get(fileId, orgId);
    if (!existing) return res.status(404).json({ error: 'file_not_found' });

    const { virtual_path, filename, metadata } = req.body || {};
    const updates = [];
    const params = [];
    if (virtual_path !== undefined) {
      const err = validateVirtualPath(virtual_path);
      if (err) return res.status(400).json({ error: err });
      updates.push('virtual_path = ?'); params.push(virtual_path);
    }
    if (filename !== undefined) {
      if (typeof filename !== 'string' || !filename.length || filename.length > 255) return res.status(400).json({ error: 'filename must be 1-255 chars' });
      updates.push('filename = ?'); params.push(filename);
    }
    if (metadata !== undefined) {
      if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return res.status(400).json({ error: 'metadata must be an object' });
      updates.push('metadata_json = ?'); params.push(JSON.stringify(metadata));
    }
    if (updates.length === 0) return res.status(400).json({ error: 'no updatable fields' });
    updates.push("updated_at = datetime('now')");
    params.push(fileId);

    prepare(`UPDATE file_objects SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    const row = prepare('SELECT * FROM file_objects WHERE id = ?').get(fileId);
    res.json(rowToFile(row));
  } catch (err) {
    console.error('file patch error:', err);
    res.status(500).json({ error: 'Failed to update file' });
  }
});

router.delete('/orgs/:orgId/files/:fileId', requireOrgMembership, (req, res) => {
  try {
    const { orgId, fileId } = req.params;
    const info = prepare(`
      UPDATE file_objects
      SET status = 'deleted', deleted_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND org_id = ? AND status = 'active'
    `).run(fileId, orgId);
    if (info.changes === 0) {
      const exists = prepare('SELECT id FROM file_objects WHERE id = ? AND org_id = ?').get(fileId, orgId);
      if (!exists) return res.status(404).json({ error: 'file_not_found' });
      return res.status(410).json({ error: 'file_already_deleted' });
    }
    res.status(204).end();
  } catch (err) {
    console.error('file delete error:', err);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// ── CW-FU — Internal service-key upload ──────────────────────────────────
// Collector calls this after parsing a knowledge file so the blob is
// preserved in the unified store. Body: multipart file + org_id +
// namespace + created_by + optional source_plugin/source_ref/metadata.

const internalUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

fileObjectsInternalRouter.post('/files/upload', internalUpload.single('file'), (req, res) => {
  try {
    const { org_id, namespace, created_by, source_plugin, source_ref, filename } = req.body || {};
    const idempotencyKey = req.headers['idempotency-key'] || req.body?.idempotency_key || null;
    if (!req.file) return res.status(400).json({ error: 'file field required' });
    if (!org_id) return res.status(400).json({ error: 'org_id required' });
    if (!created_by) return res.status(400).json({ error: 'created_by required' });
    const nsErr = validateNamespace(namespace);
    if (nsErr) return res.status(400).json({ error: nsErr });

    const orgRow = prepare('SELECT id FROM orgs WHERE id = ?').get(org_id);
    if (!orgRow) return res.status(404).json({ error: 'org_not_found' });

    // F10: a retried request carrying the same idempotency_key as a prior
    // create returns that create's row instead of allocating a new one —
    // checked before any blob write so a retry can't even duplicate disk I/O.
    if (idempotencyKey) {
      const priorRow = prepare(
        'SELECT * FROM file_objects WHERE org_id = ? AND idempotency_key = ?'
      ).get(org_id, idempotencyKey);
      if (priorRow) {
        return res.status(200).json(rowToFile(priorRow));
      }
    }

    const fn = (filename || req.file.originalname || 'file').slice(0, 255);
    const virtualPath = req.body?.virtual_path || `/${namespace.replace(/\//g, '_')}/${fn}`;
    const vpErr = validateVirtualPath(virtualPath);
    if (vpErr) return res.status(400).json({ error: vpErr });

    let metadata = {};
    if (req.body?.metadata) {
      try { metadata = typeof req.body.metadata === 'string' ? JSON.parse(req.body.metadata) : req.body.metadata; }
      catch { return res.status(400).json({ error: 'metadata must be valid JSON' }); }
    }

    const buffer = req.file.buffer;
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const existing = prepare('SELECT id, blob_path FROM file_objects WHERE org_id = ? AND sha256 = ? LIMIT 1').get(org_id, sha256);
    let blobPath;
    if (existing && existing.blob_path && fs.existsSync(path.join(FILES_ROOT, existing.blob_path))) {
      blobPath = existing.blob_path;
    } else {
      blobPath = writeBlobIfAbsent(org_id, sha256, buffer);
    }

    const { row, created } = insertFileObjectIdempotent(org_id, idempotencyKey, {
      createdBy: created_by,
      namespace,
      virtualPath,
      filename: fn,
      mime: req.file.mimetype || 'application/octet-stream',
      sizeBytes: buffer.length,
      sha256,
      blobPath,
      sourcePlugin: source_plugin || null,
      sourceRef: source_ref || null,
      metadata,
    });
    res.status(created ? 201 : 200).json(rowToFile(row));
  } catch (err) {
    console.error('internal file upload error:', err);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

export default router;
