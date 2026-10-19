'use strict';

/**
 * Import job runner. Server-side, in-memory, org+user scoped.
 *
 * Every note is created through the ONE governed write path (notesqCall:
 * licence check, revision, quox.notes.create envelope). This module adds only
 * the job envelopes (quox.notes.import.started / .completed: counts, format and
 * scope, NEVER titles or content) and the bookkeeping.
 *
 * Dedupe: notes carry `import_ref` in their frontmatter properties. The brain's
 * list endpoint cannot filter by an arbitrary property, so each job pages the
 * target scope's notes once (archived included) and collects the import_refs it
 * finds; a note whose ref is already present is SKIPPED. If that scan fails the
 * whole job fails rather than risk duplicates.
 *
 * Failures are counted distinctly from skips and recorded per note; one bad
 * note never aborts the job.
 */

const crypto = require('node:crypto');
const { buildAttachmentMarkdown, attachmentUrl } = require('./attachments.js');

const JOB_TTL_MS = 60 * 60 * 1000;
const PAGE = 200;
const MAX_ERRORS = 20;
const CONCURRENCY = 2;

function createImportService({ notesqCall, uploadAttachment, audit, now = () => Date.now(), ttlMs = JOB_TTL_MS, jobStore = null }) {
  for (const [k, v] of Object.entries({ notesqCall, uploadAttachment, audit })) {
    if (typeof v !== 'function') throw new Error(`createImportService requires ${k}`);
  }
  const jobs = new Map();

  const emit = (intent, job, extra) => {
    try {
      const c = job.ctx || {};
      audit({
        // Same real-actor rule as lib/notesq/call.js, never a blanket sender.
        from: c.actor === 'agent' ? `agent.${c.agentId || 'unknown'}` : (c.actor === 'human' && c.userId ? `human.${c.userId}` : 'service.notesq'),
        type: 'action',
        intent,
        corr: job.id,
        payload: { orgId: job.orgId, userId: job.userId, job_id: job.id, format: job.format, scope: job.scope, ...extra },
      });
    } catch (e) {
      console.error('[notesq-import] audit emit failed:', e?.message);
    }
  };

  const sweep = () => {
    const t = now();
    for (const [id, j] of jobs) if (j.status !== 'running' && t - j.createdAt > ttlMs) jobs.delete(id);
  };

  const view = (j) => ({
    status: j.status, total: j.total, created: j.created, skipped: j.skipped, failed: j.failed,
    errors: j.errors, collections: j.collections, format: j.format, scope: j.scope,
    ...(j.fatal ? { error: j.fatal } : {}),
  });

  async function existingRefs(job) {
    const refs = new Set();
    for (let offset = 0; ; offset += PAGE) {
      const r = await notesqCall({
        ctx: job.ctx, method: 'GET', path: '/notesq/notes', scope: job.scope,
        query: { scope: job.scope, limit: PAGE, offset, archived: 'include' },
      });
      if (r.status !== 200) throw new Error(`dedupe scan failed (${r.status} ${r.json?.error || ''})`.trim());
      const list = r.json?.notes || [];
      for (const n of list) {
        const ref = n.properties?.import_ref;
        if (typeof ref === 'string') refs.add(ref);
      }
      if (!list.length || offset + list.length >= (r.json?.total ?? 0)) break;
    }
    return refs;
  }

  async function run(job, parsed) {
    const uploads = new Map(); // sha -> Promise<fileId>, one upload per blob per job
    const fileFor = (sha) => {
      if (!uploads.has(sha)) {
        const bytes = parsed.blobs.get(sha);
        uploads.set(sha, uploadAttachment({ orgId: job.orgId, userId: job.userId, sha, name: job.names.get(sha), mime: job.mimes.get(sha), bytes }));
      }
      return uploads.get(sha);
    };
    const fail = (title, error) => {
      job.failed++;
      if (job.errors.length < MAX_ERRORS) job.errors.push({ title, error: String(error).slice(0, 300) });
      console.error('[notesq-import] note failed:', String(error).slice(0, 200));
    };
    try {
      const refs = await existingRefs(job);
      const queue = parsed.notes.slice();
      const worker = async () => {
        for (let n = queue.shift(); n; n = queue.shift()) {
          try {
            if (refs.has(n.ref)) { job.skipped++; continue; }
            let markdown = n.markdown;
            for (let i = 0; i < n.attachments.length; i++) {
              const a = n.attachments[i];
              job.names.set(a.sha, job.names.get(a.sha) || a.name);
              job.mimes.set(a.sha, job.mimes.get(a.sha) || a.mime);
              const file = await fileFor(a.sha);
              markdown = markdown.split(`{{quox-att:${i}}}`).join(buildAttachmentMarkdown({ name: a.name, size: a.size, type: a.mime, url: attachmentUrl(job.orgId, file.id) }));
            }
            const properties = { ...n.properties, ...(n.tags.length ? { tags: n.tags } : {}) };
            const r = await notesqCall({
              ctx: job.ctx, method: 'POST', path: '/notesq/notes', intent: 'quox.notes.create', scope: job.scope, authored: true,
              body: { scope: job.scope, markdown, properties },
            });
            if (r.status >= 200 && r.status < 300) {
              job.created++;
              refs.add(n.ref);
              job.collections[n.collection || '(none)'] = (job.collections[n.collection || '(none)'] || 0) + 1;
            } else {
              fail(n.title, `${r.status} ${r.json?.error || 'create_failed'}`);
            }
          } catch (e) {
            fail(n.title, e?.message || e);
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      job.status = 'done';
    } catch (e) {
      console.error('[notesq-import] job failed:', e?.message);
      job.status = 'failed';
      job.fatal = String(e?.message || e).slice(0, 300);
    }
    jobStore?.save(job); // quox#1015: the summary outlives the 1h memory TTL and a collector restart
    emit('quox.notes.import.completed', job, { status: job.status, total: job.total, created: job.created, skipped: job.skipped, failed: job.failed });
  }

  return {
    /** Start a job; returns the job id immediately, work continues in the background. */
    start({ ctx, parsed, scope, id }) {
      sweep();
      const job = {
        id: id || crypto.randomUUID(), orgId: ctx.orgId, userId: ctx.userId || null, ctx, scope, format: parsed.format,
        status: 'running', total: parsed.notes.length, created: 0, skipped: 0, failed: 0, errors: [], collections: {},
        createdAt: now(), names: new Map(), mimes: new Map(),
      };
      jobs.set(job.id, job);
      jobStore?.save(job);
      emit('quox.notes.import.started', job, { total: job.total });
      const done = run(job, parsed).catch((e) => { console.error('[notesq-import] runner crashed:', e?.message); job.status = 'failed'; job.fatal = 'internal_error'; jobStore?.save(job); });
      job.done = done;
      return job.id;
    },
    /** Org+user scoped lookup; null for unknown, expired or another caller's job. */
    get(jobId, { orgId, userId }) {
      sweep();
      let j = jobs.get(jobId);
      if (!j && jobStore) {
        // quox#1015: past the memory TTL or after a restart, read the persisted summary
        j = jobStore.load(jobId);
        // stored as running but no longer in memory: the collector restarted mid-job, it is not still going
        if (j && j.status === 'running') j = { ...j, status: 'interrupted', fatal: 'the collector restarted while this job was running; notes written before that are kept (re-run it: already-imported notes are skipped)' };
      }
      if (!j || j.orgId !== orgId || j.userId !== (userId || null)) return null;
      return view(j);
    },
    /**
     * Undo a batch: soft-delete every live note stamped with this batch_id
     * (found by its batch tag, then matched on the exact batch_id property so a
     * hand-applied tag never deletes anything). Revisions are kept; each note is
     * restorable. Works after the job record has expired.
     */
    async undo({ ctx, batchId }) {
      const tag = batchTag(batchId);
      const ids = [];
      for (let offset = 0; ; offset += PAGE) {
        const r = await notesqCall({
          ctx, method: 'GET', path: '/notesq/notes', scope: 'all',
          query: { scope: 'all', tag, limit: PAGE, offset, archived: 'include' },
        });
        if (r.status !== 200) return { status: r.status, error: r.json?.error || 'list_failed' };
        const list = r.json?.notes || [];
        for (const n of list) if (n.properties?.batch_id === batchId) ids.push(n.id);
        if (!list.length || offset + list.length >= (r.json?.total ?? 0)) break;
      }
      const out = { batch_id: batchId, found: ids.length, deleted: 0, failed: 0, errors: [] };
      for (const id of ids) {
        const r = await notesqCall({ ctx, method: 'DELETE', path: `/notesq/notes/${encodeURIComponent(id)}`, intent: 'quox.notes.delete', noteId: id });
        if (r.status >= 200 && r.status < 300) out.deleted++;
        else {
          out.failed++;
          if (out.errors.length < MAX_ERRORS) out.errors.push({ id, error: `${r.status} ${r.json?.error || 'delete_failed'}` });
        }
      }
      emit('quox.notes.batch.undone', { id: batchId, ctx, orgId: ctx.orgId, userId: ctx.userId || null, format: 'batch', scope: 'all' },
        { found: out.found, deleted: out.deleted, failed: out.failed });
      return { status: 200, result: out };
    },
    /** Test hook: resolves when a job finishes. */
    async settled(jobId) { const j = jobs.get(jobId); if (j) await j.done; },
  };
}

/** The visible tag every note of a batch carries (filterable in the UI and `quox notes ls --tag`). */
const batchTag = (batchId) => `batch-${String(batchId).slice(0, 8)}`;

/**
 * Stamp a parsed batch before it is written: the batch tag, the exact batch_id
 * (what undo matches on) and, when the caller named one, the authoring session.
 */
function stampBatch(parsed, { batchId, session }) {
  const tag = batchTag(batchId);
  for (const n of parsed.notes) {
    n.tags = [...new Set([...(n.tags || []), tag])];
    n.properties = { ...n.properties, batch_id: batchId, ...(session ? { batch_session: session } : {}) };
  }
  return parsed;
}

module.exports = { createImportService, JOB_TTL_MS, batchTag, stampBatch };
