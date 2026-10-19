'use strict';
/**
 * quox#1015: durable NotesQ import job summaries (table notesq_import_jobs,
 * migrations/aee/045). The running job lives in memory (run.js); this keeps
 * what `quox notes import-status` reports after the 1h memory TTL or a
 * collector restart. getDb is lazy because aeeDb opens after routes register;
 * with no db every call is a no-op and load() returns null.
 */
function createImportJobStore(getDb) {
  const db = () => { try { return getDb() || null; } catch { return null; } };

  function save(job) {
    const d = db();
    if (!d) return false;
    try {
      d.prepare(`INSERT INTO notesq_import_jobs (id, org_id, user_id, status, format, scope, total, created, skipped, failed, errors_json, collections_json, fatal, created_at, updated_at)
        VALUES (@id, @org_id, @user_id, @status, @format, @scope, @total, @created, @skipped, @failed, @errors_json, @collections_json, @fatal, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, total = excluded.total, created = excluded.created, skipped = excluded.skipped,
          failed = excluded.failed, errors_json = excluded.errors_json, collections_json = excluded.collections_json, fatal = excluded.fatal, updated_at = excluded.updated_at`)
        .run({
          id: job.id, org_id: job.orgId, user_id: job.userId || null, status: job.status, format: job.format || null, scope: job.scope || null,
          total: job.total || 0, created: job.created || 0, skipped: job.skipped || 0, failed: job.failed || 0,
          errors_json: JSON.stringify(job.errors || []), collections_json: JSON.stringify(job.collections || {}),
          fatal: job.fatal || null, created_at: job.createdAt, updated_at: Date.now(),
        });
      return true;
    } catch (e) {
      console.error('[notesq-import] job persist failed:', e?.message);
      return false;
    }
  }

  function load(id) {
    const d = db();
    if (!d) return null;
    try {
      const r = d.prepare('SELECT * FROM notesq_import_jobs WHERE id = ?').get(id);
      if (!r) return null;
      return {
        id: r.id, orgId: r.org_id, userId: r.user_id, status: r.status, format: r.format, scope: r.scope,
        total: r.total, created: r.created, skipped: r.skipped, failed: r.failed,
        errors: JSON.parse(r.errors_json || '[]'), collections: JSON.parse(r.collections_json || '{}'),
        fatal: r.fatal || undefined, createdAt: r.created_at,
      };
    } catch (e) {
      console.error('[notesq-import] job load failed:', e?.message);
      return null;
    }
  }

  return { save, load };
}

module.exports = { createImportJobStore };
