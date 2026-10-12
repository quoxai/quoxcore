/**
 * fleet #369 — pure, no I/O, no Express. Split out of server.js so this
 * logic is directly unit-testable without importing server.js (which binds
 * a live port at module load via `app.listen(...)`).
 *
 * Two responsibilities:
 *   - mergeUploadMetadata: upsert-by-id, persisting a freshly-uploaded
 *     file's real name/type without touching any other file's entry.
 *   - joinFileListMetadata: join that persisted metadata onto raw on-disk
 *     file stats for /list, falling back to the raw filename/null when no
 *     metadata entry exists (files that predate this fix).
 *
 * Root cause this exists to fix: POST /upload captured originalName/
 * mimetype in its response but never persisted them anywhere GET /list
 * could read back, so every file uploaded outside the dashboard frontend
 * (which does a separate POST /metadata the CLI never made) showed as
 * dashes for Name and Type forever.
 */

function mergeUploadMetadata(existingMetadata, uploadResults, nowIso = new Date().toISOString()) {
  const byId = new Map(existingMetadata.map(m => [m.id, m]))
  for (const f of uploadResults) {
    byId.set(f.id, {
      ...byId.get(f.id),
      id: f.id,
      name: f.originalName,
      type: f.mimetype,
      size: f.size,
      uploadedAt: nowIso,
    })
  }
  return Array.from(byId.values())
}

function joinFileListMetadata(diskFiles, metadata) {
  const metaById = new Map(metadata.map(m => [m.id, m]))
  return diskFiles.map(({ filename, id, size, mtime }) => {
    const meta = metaById.get(id)
    return {
      filename,
      id,
      name: meta?.name || filename,
      type: meta?.type || null,
      size,
      created_at: meta?.uploadedAt || mtime,
      modified: mtime,
    }
  })
}

module.exports = { mergeUploadMetadata, joinFileListMetadata }
