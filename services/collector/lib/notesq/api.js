'use strict';

/**
 * NotesQ governed entry point: /api/v1/notesq/*. The collector authenticates,
 * resolves org, licence-gates (plugin id 'notesq'), emits AEE evidence and
 * proxies 1:1 to quoxbrain's service-key-only /notesq/* routes.
 *
 * Fail closed: registerNotesqRoutes THROWS at init if any governance dep is
 * missing (unlike lib/inboxq/api.js, which defaults the licence gate to
 * always-true). The licence check is awaited.
 *
 * Identity headers sent to the brain are derived ONLY from the authenticated
 * request (org via resolveOrgId, user/role from req.user, actor class from
 * the credential), never from client headers or body.
 * AEE envelopes NEVER carry note content/body/title.
 */


const crypto = require('node:crypto');
const multer = require('multer');
const { createNotesqCall, LICENCE_ID } = require('./call.js');
const { parseImport, summarise, FORMATS } = require('./import/index.js');
const { createImportService, stampBatch } = require('./import/run.js');
const { createAttachmentUploader } = require('./import/upload.js');

const { createPendingSkill } = require('../skillCreate.js');
const { BUILTIN_TEMPLATES, varsFor, renderTemplate, resolveTemplate, noteTitle } = require('./templates.js');

const IMPORT_MAX_BYTES = 100 * 1024 * 1024;
const REQUIRED = ['requireAuth', 'resolveOrgId', 'isPluginLicensed', 'audit', 'deriveActorType', 'isHumanAdmin'];

function registerNotesqRoutes(app, deps) {
  for (const k of REQUIRED) {
    if (!deps || typeof deps[k] !== 'function') throw new Error(`registerNotesqRoutes requires deps.${k}`);
  }
  // Actor class + admin come from utils/httpAuth via deps (the one boundary),
  // never re-decided here.
  const { requireAuth, resolveOrgId, deriveActorType, isHumanAdmin, isPluginLicensed, audit } = deps;
  // The ONE boundary: licence, headers, brain fetch, evidence (lib/notesq/call.js).
  // The agent tools (lib/notesqTools.js) consume this same function.
  const notesqCall = deps.notesqCall || createNotesqCall(deps);

  // spec: { method, path(req)->brain path, query?:bool, body?(req)->obj, intent?, scope?(req) }
  const route = (spec) => async (req, res) => {
    try {
      const orgId = resolveOrgId(req);
      if (!orgId) return res.status(401).json({ error: 'unauthenticated' });
      // An agent-operated user session (SVC-AUTH #447 agent_ops) is authored as agent.
      const actor = req.user?.agent_ops ? 'agent' : deriveActorType(req);
      if (spec.humanOnly && spec.humanOnly(req) && actor !== 'human') {
        return res.status(403).json({ error: spec.humanOnlyError || 'human_required' });
      }
      const out = await notesqCall({
        ctx: { orgId, userId: req.user?.id || req.auth?.userId || null, isAdmin: isHumanAdmin(req), actor, agentId: req.user?.agent_id || req.user?.id || null },
        method: spec.method,
        path: spec.path(req),
        query: spec.query ? req.query : undefined,
        body: spec.body ? spec.body(req) : undefined,
        authored: Boolean(spec.body && spec.authored),
        intent: typeof spec.intent === 'function' ? spec.intent(req) : spec.intent,
        noteId: req.params.id || null,
        scope: spec.scope ? spec.scope(req) : (req.body?.scope || req.query?.scope || null),
      });
      return res.status(out.status).json(out.json);
    } catch (e) {
      console.error('[notesq] route error:', e?.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  };

  const B = '/api/v1/notesq';
  const queryScope = (r) => String((r.query && r.query.scope) || 'all');
  const bodyScope = (r) => (r.body && typeof r.body.scope === 'string' ? r.body.scope : null);
  app.get(`${B}/notes`, requireAuth, route({ method: 'GET', path: () => '/notesq/notes', query: true, scope: queryScope }));
  app.get(`${B}/facets`, requireAuth, route({ method: 'GET', path: () => '/notesq/facets', query: true, scope: queryScope }));
  app.get(`${B}/titles`, requireAuth, route({ method: 'GET', path: () => '/notesq/titles', query: true, scope: queryScope }));
  app.get(`${B}/notes/:id`, requireAuth, route({ method: 'GET', path: (r) => `/notesq/notes/${encodeURIComponent(r.params.id)}` }));
  app.post(`${B}/notes`, requireAuth, route({
    method: 'POST', path: () => '/notesq/notes', intent: 'quox.notes.create', scope: bodyScope,
    authored: true, body: (r) => ({ scope: r.body?.scope, content: r.body?.content, markdown: r.body?.markdown, properties: r.body?.properties }),
  }));
  app.get(`${B}/notes/:id/related`, requireAuth, route({ method: 'GET', query: true, path: (r) => `/notesq/notes/${encodeURIComponent(r.params.id)}/related` }));
  app.get(`${B}/notes/:id/suggestions`, requireAuth, route({ method: 'GET', query: true, path: (r) => `/notesq/notes/${encodeURIComponent(r.params.id)}/suggestions` }));
  app.get(`${B}/health`, requireAuth, route({ method: 'GET', path: () => '/notesq/health', query: true, scope: (r) => String((r.query && r.query.scope) || 'org') }));
  app.put(`${B}/notes/:id`, requireAuth, route({
    method: 'PUT', path: (r) => `/notesq/notes/${encodeURIComponent(r.params.id)}`, intent: 'quox.notes.update',
    authored: true, body: (r) => ({ content: r.body?.content, markdown: r.body?.markdown, properties: r.body?.properties, base_hash: r.body?.base_hash }),
  }));
  // Purge is irreversible (erases the note and every revision). Only the literal
  // ?purge=true is forwarded (allowlist, no other query key), human actors only;
  // the brain still enforces author/admin.
  const isPurge = (r) => r.query && r.query.purge === 'true';
  // Optimistic-concurrency token (query or If-Match); the brain checks it
  // atomically with the mutation and answers 409 {error:'conflict', currentHash}.
  const expectedHashOf = (r) => {
    const v = (r.query && r.query.expected_hash) || String((r.headers && r.headers['if-match']) || '').replace(/^W\//, '').replace(/^"|"$/g, '');
    return typeof v === 'string' && v ? v : '';
  };
  app.delete(`${B}/notes/:id`, requireAuth, route({
    method: 'DELETE',
    path: (r) => {
      const qs = new URLSearchParams();
      if (isPurge(r)) qs.set('purge', 'true');
      if (expectedHashOf(r)) qs.set('expected_hash', expectedHashOf(r));
      const q = qs.toString();
      return `/notesq/notes/${encodeURIComponent(r.params.id)}${q ? `?${q}` : ''}`;
    },
    intent: (r) => (isPurge(r) ? 'quox.notes.purge' : 'quox.notes.delete'),
    humanOnly: isPurge,
    humanOnlyError: 'purge_requires_human',
  }));
  app.get(`${B}/notes/:id/revisions`, requireAuth, route({ method: 'GET', path: (r) => `/notesq/notes/${encodeURIComponent(r.params.id)}/revisions` }));
  app.get(`${B}/notes/:id/revisions/:rev`, requireAuth, route({ method: 'GET', path: (r) => `/notesq/notes/${encodeURIComponent(r.params.id)}/revisions/${encodeURIComponent(r.params.rev)}` }));
  app.post(`${B}/notes/:id/restore`, requireAuth, route({
    method: 'POST', path: (r) => `/notesq/notes/${encodeURIComponent(r.params.id)}/restore`, intent: 'quox.notes.restore',
    authored: true, body: (r) => ({ rev: r.body?.rev, expected_hash: r.body?.expected_hash || expectedHashOf(r) || undefined }),
  }));
  app.post(`${B}/vault`, requireAuth, route({ method: 'POST', path: () => '/notesq/vault', scope: bodyScope, body: (r) => ({ scope: r.body?.scope }) }));

  // IMPORT (AQ-9D P7): POST /import (dry_run or start a job) + GET /import/:jobId.
  // Notes are written through the same notesqCall (licence, revision, envelope).
  // Job envelopes carry counts only, never titles or content.
  const importService = createImportService({
    notesqCall,
    audit,
    uploadAttachment: deps.uploadAttachment || createAttachmentUploader({ fetchImpl: deps.fetchImpl }),
  });
  const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: IMPORT_MAX_BYTES, files: 1 } });
  const importCtx = (req) => {
    const orgId = resolveOrgId(req);
    if (!orgId) return null;
    const actor = req.user?.agent_ops ? 'agent' : deriveActorType(req);
    return { orgId, userId: req.user?.id || req.auth?.userId || null, isAdmin: isHumanAdmin(req), actor, agentId: req.user?.agent_id || req.user?.id || null };
  };
  // Licence gate runs BEFORE the upload is buffered.
  const importGate = async (req, res, next) => {
    try {
      const c = importCtx(req);
      if (!c) return res.status(401).json({ error: 'unauthenticated' });
      if (!(await isPluginLicensed(c.orgId, LICENCE_ID))) return res.status(402).json({ error: `${LICENCE_ID} not licensed for this org` });
      req.notesqImportCtx = c;
      return next();
    } catch (e) {
      console.error('[notesq] import gate error:', e?.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  };
  const importBody = (req, res, next) => importUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file_too_large', max_bytes: IMPORT_MAX_BYTES });
    return res.status(400).json({ error: 'invalid_upload' });
  });
  app.post(`${B}/import`, requireAuth, importGate, importBody, async (req, res) => {
    try {
      const ctx = req.notesqImportCtx;
      const opt = (k) => (req.body && req.body[k] !== undefined ? req.body[k] : req.query[k]);
      if (!req.file) return res.status(400).json({ error: 'file_required' });
      const scope = opt('scope') === undefined ? 'org' : String(opt('scope'));
      if (scope !== 'org' && scope !== 'user') return res.status(400).json({ error: 'invalid_scope' });
      const format = opt('format') ? String(opt('format')) : undefined;
      if (format && !FORMATS.includes(format)) return res.status(400).json({ error: 'invalid_format' });
      const dryRun = ['true', '1', true].includes(opt('dry_run'));
      const collection = opt('collection') ? String(opt('collection')).slice(0, 120) : undefined;
      if (!dryRun) {
        // People and agents may import (same rule as every other NotesQ write:
        // notes are stamped with the real author kind and evidenced as the real
        // actor). A bare service call has no one to attribute the notes to.
        if (ctx.actor !== 'human' && ctx.actor !== 'agent') return res.status(403).json({ error: 'import_requires_user_or_agent' });
        if (!ctx.userId) return res.status(400).json({ error: 'user_required' });
      }
      let parsed;
      try {
        parsed = await parseImport(req.file.buffer, { filename: req.file.originalname, format, collection });
      } catch (e) {
        return res.status(400).json({ error: e.code || 'parse_failed', message: e.message });
      }
      if (dryRun) return res.json(summarise(parsed));
      if (parsed.format === 'batch') {
        // A batch is one job whose id IS the batch id: every note is tagged and stamped with it, so undo works after the job expires.
        const raw = opt('session');
        const session = typeof raw === 'string' && /^[\w.:@-]{1,80}$/.test(raw) ? raw : null;
        const batchId = crypto.randomUUID();
        stampBatch(parsed, { batchId, session });
        importService.start({ ctx, parsed, scope, id: batchId });
        return res.status(202).json({ job_id: batchId, batch_id: batchId });
      }
      const jobId = importService.start({ ctx, parsed, scope });
      return res.status(202).json({ job_id: jobId });
    } catch (e) {
      console.error('[notesq] import error:', e?.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });
  app.get(`${B}/import/:jobId`, requireAuth, importGate, async (req, res) => {
    const c = req.notesqImportCtx;
    const j = importService.get(req.params.jobId, { orgId: c.orgId, userId: c.userId });
    if (!j) return res.status(404).json({ error: 'not_found' });
    return res.json(j);
  });
  // BATCH UNDO (AQ-9D P8): soft-delete everything one batch created. Same
  // author/admin delete rule as single notes (the brain enforces it per note).
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  app.post(`${B}/batches/:batchId/undo`, requireAuth, importGate, async (req, res) => {
    try {
      const ctx = req.notesqImportCtx;
      if (!UUID.test(req.params.batchId)) return res.status(400).json({ error: 'invalid_batch_id' });
      if (ctx.actor !== 'human' && ctx.actor !== 'agent') return res.status(403).json({ error: 'undo_requires_user_or_agent' });
      if (!ctx.userId) return res.status(400).json({ error: 'user_required' });
      const out = await importService.undo({ ctx, batchId: req.params.batchId.toLowerCase() });
      if (out.status !== 200) return res.status(out.status).json({ error: out.error });
      return res.json(out.result);
    } catch (e) {
      console.error('[notesq] batch undo error:', e?.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // PROPOSE AS SKILL (AQ-9D P5): turn a note (an SOP) into a PENDING-REVIEW
  // skill. Never auto: createPendingSkill forces edition 'experimental', so a
  // human must approve it in the skill review queue before anyone can run it.
  // The provenance link is the tag `source:notesq:<noteId>` on the skill, plus
  // flat properties on the note (brain properties are scalars only).
  // The AEE envelope carries ids and the skill name, never note content.
  const MIN_SKILL_WORDS = 50;
  const slugify = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  const plainText = (t) => String(t)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[\[([^\]|]*)(\|[^\]]*)?\]\]/g, '$1')
    .replace(/[`*_~>#]/g, '').replace(/\s+/g, ' ').trim();
  const firstParagraph = (md) => {
    for (const block of String(md).split(/\n\s*\n/)) {
      const lines = block.split('\n').filter((l) => l.trim() && !/^\s*#{1,6}\s/.test(l));
      if (lines.length) {
        const txt = plainText(lines.join(' '));
        if (txt) return txt.length > 200 ? `${txt.slice(0, 199).trimEnd()}\u2026` : txt;
      }
    }
    return '';
  };
  const stripFrontMatter = (md) => String(md || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  app.post(`${B}/notes/:id/propose-skill`, requireAuth, importGate, async (req, res) => {
    try {
      const ctx = req.notesqImportCtx;
      if (ctx.actor !== 'human' && ctx.actor !== 'agent') return res.status(403).json({ error: 'propose_requires_user_or_agent' });
      if (!ctx.userId) return res.status(400).json({ error: 'user_required' });
      const noteId = req.params.id;
      const b = req.body || {};
      const read = await notesqCall({ ctx, method: 'GET', path: `/notesq/notes/${encodeURIComponent(noteId)}`, noteId });
      if (read.status !== 200) return res.status(read.status === 404 ? 404 : read.status).json(read.json || { error: 'not_found' });
      const note = read.json?.note || {};
      const bodyMd = stripFrontMatter(note.markdown).trim();
      if (bodyMd.split(/\s+/).filter(Boolean).length < MIN_SKILL_WORDS) return res.status(400).json({ error: 'too_short', min_words: MIN_SKILL_WORDS });
      const name = (typeof b.name === 'string' && b.name.trim()) ? slugify(b.name) : (slugify(note.title) || `note-${String(noteId).slice(0, 8).toLowerCase()}`);
      if (!name) return res.status(400).json({ error: 'invalid_name' });
      const category = (typeof b.category === 'string' && b.category.trim()) ? b.category.trim().slice(0, 40) : 'procedure';
      const description = firstParagraph(bodyMd) || name;
      const tags = ['notesq', `source:notesq:${noteId}`];
      if (b.dry_run === true || b.dry_run === 'true') {
        return res.json({ dry_run: true, payload: { name, category, description, bodyMd, tags }, review: 'experimental' });
      }
      const created = await createPendingSkill(
        { orgId: ctx.orgId, userId: ctx.userId, agentId: ctx.actor === 'agent' ? ctx.agentId : null, token: (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null },
        // quox#748: an agent proposing a skill needs a human review; a person proposing their own note does not.
        { name, category, description, bodyMd, tags, ...(ctx.actor === 'agent' ? { requireHumanReview: true, reviewSource: 'notesq' } : {}) },
      );
      if (!created.ok) return res.status(created.status >= 400 ? created.status : 502).json({ error: created.error, message: created.message });
      const skill = created.skill;
      // Link back on the note, governed (base_hash from the read above). A 409
      // or any failure leaves the skill created; we report note_updated:false.
      let noteUpdated = false;
      const upd = await notesqCall({
        ctx, method: 'PUT', path: `/notesq/notes/${encodeURIComponent(noteId)}`, intent: 'quox.notes.update', noteId, authored: true,
        body: {
          markdown: note.markdown || '',
          properties: { ...(note.properties || {}), proposed_skill_id: String(skill.id), proposed_skill_name: String(skill.name), proposed_skill_at: new Date().toISOString() },
          base_hash: note.content_hash,
        },
      });
      noteUpdated = upd.status >= 200 && upd.status < 300;
      try {
        audit({
          from: ctx.actor === 'agent' ? `agent.${ctx.agentId || 'unknown'}` : `human.${ctx.userId}`,
          type: 'action',
          intent: 'quox.notes.skill.proposed',
          corr: noteId,
          payload: { orgId: ctx.orgId, userId: ctx.userId, noteId, skill_id: skill.id, skill_name: skill.name, note_updated: noteUpdated },
        });
      } catch (e) {
        console.error('[notesq] propose-skill audit failed:', e?.message);
      }
      return res.status(201).json({ skill: { id: skill.id, name: skill.name, edition: skill.edition }, note_updated: noteUpdated, review: 'experimental' });
    } catch (e) {
      console.error('[notesq] propose-skill error:', e?.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // TEMPLATES + SCHEDULES (AQ-9D P4). Everything goes through notesqCall.
  const reqCtx = (req) => {
    const orgId = resolveOrgId(req);
    if (!orgId) return null;
    const actor = req.user?.agent_ops ? 'agent' : deriveActorType(req);
    return { orgId, userId: req.user?.id || req.auth?.userId || null, isAdmin: isHumanAdmin(req), actor, agentId: req.user?.agent_id || req.user?.id || null };
  };
  const templateDeps = (ctx) => ({
    listUserTemplates: async () => {
      const out = await notesqCall({ ctx, method: 'GET', path: '/notesq/notes', query: { scope: 'all', limit: 200, archived: 'exclude' }, scope: 'all' });
      if (out.status !== 200) return [];
      return (out.json?.notes || []).filter((n) => n && n.properties && n.properties.template === true);
    },
    loadNote: async (id) => {
      const out = await notesqCall({ ctx, method: 'GET', path: `/notesq/notes/${encodeURIComponent(id)}`, noteId: id });
      if (out.status !== 200) return '';
      const j = out.json || {};
      return j.markdown || j.note?.markdown || j.revision?.markdown || '';
    },
  });
  app.get(`${B}/templates`, requireAuth, async (req, res) => {
    try {
      const ctx = reqCtx(req);
      if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
      if (!(await isPluginLicensed(ctx.orgId, LICENCE_ID))) return res.status(402).json({ error: `${LICENCE_ID} not licensed for this org` });
      const templates = Object.values(BUILTIN_TEMPLATES).map((t) => ({ name: t.name, source: 'builtin' }));
      if (ctx.userId) {
        for (const n of await templateDeps(ctx).listUserTemplates()) templates.push({ name: noteTitle(n), source: 'note', id: n.id });
      }
      return res.json({ templates });
    } catch (e) {
      console.error('[notesq] templates error:', e?.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });
  app.post(`${B}/notes/from-template`, requireAuth, async (req, res) => {
    try {
      const ctx = reqCtx(req);
      if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
      const b = req.body || {};
      const scope = typeof b.scope === 'string' ? b.scope : 'user';
      const tpl = await resolveTemplate(b.template, templateDeps(ctx));
      if (!tpl) return res.status(404).json({ error: 'template_not_found' });
      const r = renderTemplate(tpl, varsFor(Date.now(), b.tz || 'UTC'), { title: b.title });
      const properties = { from_template: tpl.name };
      if (b.collection) properties.collection = String(b.collection).slice(0, 120);
      const out = await notesqCall({
        ctx, method: 'POST', path: '/notesq/notes', intent: 'quox.notes.create', scope, authored: true,
        body: { scope, markdown: r.markdown, properties },
      });
      return res.status(out.status).json(out.json);
    } catch (e) {
      console.error('[notesq] from-template error:', e?.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });
  app.get(`${B}/schedules`, requireAuth, route({ method: 'GET', path: () => '/notesq/schedules' }));
  app.post(`${B}/schedules`, requireAuth, async (req, res, next) => {
    try {
      const ctx = reqCtx(req);
      if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
      if (!(await isPluginLicensed(ctx.orgId, LICENCE_ID))) return res.status(402).json({ error: `${LICENCE_ID} not licensed for this org` });
      const tpl = await resolveTemplate(req.body?.template, templateDeps(ctx));
      if (!tpl) return res.status(400).json({ error: 'template_not_found' });
      return next();
    } catch (e) {
      console.error('[notesq] schedule precheck error:', e?.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  }, route({
    method: 'POST', path: () => '/notesq/schedules', intent: 'quox.notes.schedule.create', scope: bodyScope,
    body: (r) => {
      const b = r.body || {};
      return {
        template: b.template, cadence: b.cadence, weekday: b.weekday, hour: b.hour, minute: b.minute, tz: b.tz,
        scope: b.scope, collection: b.collection, title_pattern: b.title_pattern,
      };
    },
  }));
  app.patch(`${B}/schedules/:id`, requireAuth, route({
    method: 'PATCH', path: (r) => `/notesq/schedules/${encodeURIComponent(r.params.id)}`, intent: 'quox.notes.schedule.update',
    body: (r) => ({ enabled: r.body?.enabled }),
  }));
  app.delete(`${B}/schedules/:id`, requireAuth, route({
    method: 'DELETE', path: (r) => `/notesq/schedules/${encodeURIComponent(r.params.id)}`, intent: 'quox.notes.schedule.delete',
  }));
  return notesqCall;
}

module.exports = { registerNotesqRoutes, LICENCE_ID };
