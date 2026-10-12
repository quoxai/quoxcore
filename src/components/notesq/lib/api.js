/**
 * NotesQ API client — fetch wrapper over the collector-native routes at
 * /api/v1/notesq/*, reached via the same-origin `/collector` prefix (same
 * pattern as src/components/inboxq/lib/api.js).
 *
 * No client-side cache: notes are editable, the server is the source of truth
 * and stale reads would feed false conflicts.
 */
import { buildListQuery } from './listQuery';

const API_BASE = '/collector/api/v1/notesq';

/** Carries status + parsed body so callers can branch on 409/403. */
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `API error ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try { payload = res.status === 204 ? null : await res.json(); } catch { payload = null; }
  if (!res.ok) throw new ApiError(res.status, payload);
  return payload;
}

/** Multipart upload: the browser sets the boundary header, so none is set here. Status is checked before the body is trusted. */
async function upload(file, { dryRun, scope = 'org', collection } = {}) {
  const form = new FormData();
  form.append('file', file);
  form.append('dry_run', dryRun ? 'true' : 'false');
  form.append('scope', scope);
  if (collection) form.append('collection', collection);
  const res = await fetch(`${API_BASE}/import`, { method: 'POST', credentials: 'include', body: form });
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  if (!res.ok) {
    const err = new ApiError(res.status, payload);
    if (payload?.message) err.message = payload.message;
    throw err;
  }
  return payload;
}

/** Batch upload (format=batch, same fields the CLI sendBatch sends). -> 202 { job_id, batch_id } */
async function uploadBatch(blob, filename, { scope = 'org', session } = {}) {
  const form = new FormData();
  form.append('file', blob, filename);
  form.append('format', 'batch');
  form.append('dry_run', 'false');
  form.append('scope', scope);
  if (session) form.append('session', session);
  const res = await fetch(`${API_BASE}/import`, { method: 'POST', credentials: 'include', body: form });
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  if (!res.ok) {
    const err = new ApiError(res.status, payload);
    if (payload?.message) err.message = payload.message;
    throw err;
  }
  return payload;
}

const enc = encodeURIComponent;

export const api = {
  /** -> { notes: [{id,title,scope,vault_id,content_hash,updated_at,excerpt,properties,tags}], total } */
  listNotes(params) { return call(`/notes?${buildListQuery(params)}`); },
  /** -> { note: {id,title,scope,content_hash,updated_at,body,markdown,properties,tags,backlinks,outlinks} } */
  getNote(id) { return call(`/notes/${enc(id)}`); },
  /** -> 201 { note, revision } */
  createNote({ scope, markdown, properties }) {
    return call('/notes', { method: 'POST', body: { scope, markdown, properties: properties || {} } });
  },
  /** -> { note, revision, unchanged }; throws ApiError(409, {error:'conflict', current_hash}) */
  updateNote(id, { markdown, properties, base_hash }) {
    return call(`/notes/${enc(id)}`, { method: 'PUT', body: { markdown, properties, base_hash } });
  },
  /** AQ-9D P5. dry_run -> { payload:{name,category,description,bodyMd,tags} }; real -> 201 { skill:{id,name,edition}, note_updated, review:'pending' }; 400 too_short */
  proposeSkill(id, { dry_run = false } = {}) {
    return call(`/notes/${enc(id)}/propose-skill`, { method: 'POST', body: dry_run ? { dry_run: true } : {} });
  },
  /** -> { deleted, revision }; ApiError(403) when not author/admin */
  deleteNote(id) { return call(`/notes/${enc(id)}`, { method: 'DELETE' }); },
  /** -> { revisions: [{rev,action,content_hash,author_user_id,author_kind,created_at}] } */
  listRevisions(id) { return call(`/notes/${enc(id)}/revisions`); },
  /** -> { rev, action, author_kind, created_at, markdown } */
  getRevision(id, rev) { return call(`/notes/${enc(id)}/revisions/${enc(rev)}`); },
  /** -> { note, revision } */
  restoreRevision(id, rev) { return call(`/notes/${enc(id)}/restore`, { method: 'POST', body: { rev } }); },
  /** -> { collections:[{name,count}], tags:[{tag,count}], total, pinned, archived } */
  getFacets(scope = 'all') { return call(`/facets?scope=${enc(scope)}`); },
  /** -> { titles: [{id,title,scope}] } */
  searchTitles({ scope = 'all', q = '' } = {}) {
    return call(`/titles?scope=${enc(scope)}&q=${enc(q)}`);
  },
  /** Dry run -> { format, notes, attachments, collections:{name:count}, tags:[], warnings:[], sample:[] } */
  previewImport(file, opts = {}) { return upload(file, { ...opts, dryRun: true }); },
  /** -> 202 { job_id }; ApiError 400/402/403/413 carry {error,message} */
  startImport(file, opts = {}) { return upload(file, { ...opts, dryRun: false }); },
  /** -> { templates: [{name, source:'builtin'|'note', id?}] } */
  listTemplates() { return call('/templates'); },
  /** -> 201 { note }; ApiError 400/404 carry {error} */
  createFromTemplate({ template, scope, collection, title, tz }) {
    return call('/notes/from-template', { method: 'POST', body: { template, scope, collection: collection || undefined, title: title || undefined, tz } });
  },
  /** -> { schedules: [{id,template,title_pattern,cadence,weekday,hour,minute,tz,scope,collection,enabled,failures,last_error,disabled_reason,next_run_at,last_period}] } */
  listSchedules() { return call('/schedules'); },
  /** -> 201 { schedule }; ApiError 400 {error:'template_not_found'|'too_many_schedules'|...} */
  createSchedule(body) { return call('/schedules', { method: 'POST', body }); },
  /** -> { schedule } */
  setScheduleEnabled(id, enabled) { return call(`/schedules/${enc(id)}`, { method: 'PATCH', body: { enabled } }); },
  /** -> { deleted: true } */
  deleteSchedule(id) { return call(`/schedules/${enc(id)}`, { method: 'DELETE' }); },
  /** -> 202 { job_id, batch_id }. No retry: a retried upload would start a second batch. */
  startBatch(blob, filename, opts = {}) { return uploadBatch(blob, filename, opts); },
  /** -> { batch_id, found, deleted, failed, errors:[{id,error}] }; ApiError 403/400 carry {error} */
  undoBatch(batchId) { return call(`/batches/${enc(batchId)}/undo`, { method: 'POST', body: {} }); },
  /** -> { mentions:[{id,title,count,snippet}], related:[{id,title,excerpt,score}], mode }; ApiError 404 when the note is not visible */
  getSuggestions(id, { limit } = {}) {
    return call(`/notes/${enc(id)}/suggestions${limit ? `?limit=${enc(limit)}` : ''}`);
  },
  /** -> { scope, scanned, truncated, duplicates:[{kind,similarity,notes}], stale:[{id,title,updated_at,backlinks}], broken_links:[{source,target_raw,count}] } */
  getHealth({ scope = 'org', staleDays = 180 } = {}) {
    return call(`/health?scope=${enc(scope)}&stale_days=${enc(staleDays)}`);
  },
  /** -> { status:'running'|'done'|'failed', total, created, skipped, failed, errors:[{title,error}], collections } */
  getImportJob(jobId) { return call(`/import/${enc(jobId)}`); },
};
