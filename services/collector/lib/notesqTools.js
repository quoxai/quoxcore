'use strict';

/**
 * notesqTools.js: the agent tool surface for NotesQ's own agent (`notesq`).
 *
 * NO second enforcement path. Every tool calls the ONE in-process boundary
 * `notesqCall` (lib/notesq/call.js), the same function the governed HTTP
 * routes use: licence check (awaited, fail closed), identity headers, brain
 * fetch, AEE quox.notes.* evidence (never content). Tools pass actor 'agent'
 * (author_kind agent) and the calling user's identity from the trusted tool
 * ctx; no tool input can name an org, user or admin flag. An agent is never a
 * human admin (isAdmin false), so the brain's author/admin rule is enforced
 * server-side exactly as for any agent-operated session.
 *
 * Writes execute directly: the authenticated user commanding the agent IS the
 * authorization (feedback-direct-user-action-is-authorization), and every write
 * records a revision, so notesq_history + notesq_restore undo anything.
 *
 * notesqCall is injected at boot (server.js, from registerNotesqRoutes's return
 * value) via setNotesqToolsCall(); unwired it refuses rather than guessing.
 */

const configResolver = require('./configResolver.js');

const BODY_CAP = 8000;
const HEALTH_ITEM_CAP = 20;
const POLICY_KEY = 'NOTESQ_AGENT_EDIT_POLICY';
const COLLECTION_KEY = 'NOTESQ_DEFAULT_COLLECTION';
const WRITE_TOOLS = new Set(['notesq_create', 'notesq_update', 'notesq_tag', 'notesq_restore', 'notesq_delete']);
const READ_ONLY_ERROR = 'Agent note edits are turned off for this org (NotesQ settings: agent edit policy read-only). Nothing was changed.';
const ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

let _call = null;
/** Wire in the shared notesqCall. Call once at startup. */
function setNotesqToolsCall(fn) {
  _call = typeof fn === 'function' ? fn : null;
}

/** Org setting read. A lookup failure returns null (callers choose their own safe default). */
function orgSetting(ctx, key) {
  try {
    const r = configResolver.getSetting(ctx && ctx.orgId, key);
    return r && typeof r.value === 'string' ? r.value : null;
  } catch {
    return null;
  }
}

function link(id) { return `/notes?note=${id}`; }

function cap(text) {
  const s = String(text || '');
  return s.length > BODY_CAP ? { text: s.slice(0, BODY_CAP), truncated: true, totalChars: s.length } : { text: s, truncated: false, totalChars: s.length };
}

function baseCtx(ctx) {
  if (!ctx || !ctx.orgId) {
    throw new Error('org_context_required: NotesQ tools need an authenticated org context.');
  }
  return { orgId: ctx.orgId, userId: ctx.userId || null, isAdmin: false, actor: 'agent', agentId: ctx.agentId || 'notesq' };
}

async function call(ctx, spec) {
  if (!_call) return { status: 503, json: { error: 'notesq_unavailable' } };
  return _call({ ctx: baseCtx(ctx), ...spec });
}

/** An error body is not data: map non-2xx to a clear failure result. */
function failure(res, extra = {}) {
  const s = res.status;
  const e = (res.json && res.json.error) || `request failed (${s})`;
  if (s === 402) return { success: false, notLicensed: true, error: 'NotesQ is not licensed for this org.' };
  if (s === 409) return { success: false, conflict: true, error: 'The note changed since it was read. Nothing was written. Re-read it and decide how to merge.', currentHash: res.json && res.json.current_hash, ...extra };
  if (s === 403) return { success: false, forbidden: true, error: 'You are not allowed to change this note (only its author or an admin can).' };
  if (s === 404) return { success: false, notFound: true, error: 'Note not found (or not visible to you).' };
  return { success: false, error: e };
}

function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

const SCOPES = ['org', 'user', 'all'];

function summary(n) {
  return {
    id: n.id,
    title: n.title,
    collection: (n.properties && n.properties.collection) || null,
    tags: n.tags || [],
    excerpt: n.excerpt || '',
    updated: n.updated_at,
    link: link(n.id),
  };
}

function listQuery(input, withQ) {
  const q = {};
  if (withQ && input.q) q.q = String(input.q);
  if (input.scope && SCOPES.includes(input.scope)) q.scope = input.scope;
  if (input.collection) q.collection = String(input.collection);
  if (input.tag) q.tag = String(input.tag);
  if (input.pinned !== undefined) q.pinned = String(Boolean(input.pinned));
  q.limit = Math.min(Math.max(parseInt(input.limit, 10) || 10, 1), 25);
  return q;
}

async function listOrSearch(input, ctx, withQ) {
  const query = listQuery(input || {}, withQ);
  if (withQ && !query.q) return { success: false, error: 'q is required' };
  const res = await call(ctx, { method: 'GET', path: '/notesq/notes', query, scope: query.scope || 'all' });
  if (res.status !== 200) return failure(res);
  const notes = (res.json.notes || []).map(summary);
  return { success: true, total: res.json.total ?? notes.length, count: notes.length, notes };
}

async function readNote(ctx, id) {
  const res = await call(ctx, { method: 'GET', path: `/notesq/notes/${encodeURIComponent(id)}`, noteId: id });
  if (res.status !== 200) return { res };
  return { res, note: res.json.note };
}

function titles(list) {
  return (list || []).map((x) => (typeof x === 'string' ? x : (x && (x.title || x.target || x.id)) || '')).filter(Boolean).slice(0, 25);
}

function stripProps(props) {
  // frontmatter replace-all semantics on the brain: always send the full set.
  return { ...(props || {}) };
}

const NOTESQ_TOOLS = {
  notesq_search: {
    name: 'notesq_search',
    description: 'Full-text search the user\'s notes (org-shared and private). Returns id, title, collection, tags, excerpt, updated and a /notes?note=<id> link per hit. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        scope: { type: 'string', enum: SCOPES },
        collection: { type: 'string' },
        tag: { type: 'string' },
        limit: { type: 'number', description: 'Max 25, default 10.' },
      },
      required: ['q'],
    },
    execute: async (input, ctx) => listOrSearch(input, ctx, true),
  },

  notesq_list: {
    name: 'notesq_list',
    description: 'List recent notes, newest first (pinned first), optionally filtered by scope, collection, tag or pinned. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: SCOPES },
        collection: { type: 'string' },
        tag: { type: 'string' },
        pinned: { type: 'boolean' },
        limit: { type: 'number', description: 'Max 25, default 10.' },
      },
    },
    execute: async (input, ctx) => listOrSearch(input, ctx, false),
  },

  notesq_read: {
    name: 'notesq_read',
    description: 'Read one note: title, properties, markdown (capped at 8000 chars, truncated flag set when cut), and the titles of notes linking to it and from it. Read-only.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: async (input, ctx) => {
      const id = input && input.id;
      if (!validId(id)) return { success: false, error: 'id is required' };
      const { res, note } = await readNote(ctx, id);
      if (!note) return failure(res);
      const md = cap(note.markdown);
      return {
        success: true,
        id: note.id,
        title: note.title,
        scope: note.scope,
        properties: note.properties || {},
        tags: note.tags || [],
        markdown: md.text,
        truncated: md.truncated,
        totalChars: md.totalChars,
        backlinks: titles(note.backlinks),
        outlinks: titles(note.outlinks),
        updated: note.updated_at,
        // Pass this back as base_hash when replacing, so a newer edit is never overwritten.
        base_hash: note.content_hash,
        link: link(note.id),
      };
    },
  },

  notesq_create: {
    name: 'notesq_create',
    description: 'Create a note NOW on the user\'s command. scope defaults to org (shared); use user for private. Returns the id and a /notes?note=<id> link. Never invent content: use what the user said.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        markdown: { type: 'string' },
        scope: { type: 'string', enum: ['org', 'user'] },
        collection: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'markdown'],
    },
    execute: async (input, ctx) => {
      const { title, markdown, collection, tags } = input || {};
      const scope = (input && input.scope) || 'org';
      if (!title || typeof title !== 'string') return { success: false, error: 'title is required' };
      if (typeof markdown !== 'string') return { success: false, error: 'markdown is required' };
      if (scope !== 'org' && scope !== 'user') return { success: false, error: 'scope must be org|user' };
      const properties = {};
      const defaultCollection = collection ? '' : (orgSetting(ctx, COLLECTION_KEY) || '').trim();
      if (collection) properties.collection = String(collection);
      else if (defaultCollection) properties.collection = defaultCollection;
      if (Array.isArray(tags) && tags.length) properties.tags = tags.map(String);
      const md = /^\s*#\s+/.test(markdown) ? markdown : `# ${title}\n\n${markdown}`;
      const res = await call(ctx, {
        method: 'POST', path: '/notesq/notes', intent: 'quox.notes.create', scope, authored: true,
        body: { scope, markdown: md, properties },
      });
      if (res.status !== 201 && res.status !== 200) return failure(res);
      const n = res.json.note || {};
      return { success: true, executed: true, id: n.id, title: n.title, scope: n.scope, link: link(n.id), result: `DONE: created "${n.title}" (${n.scope}).` };
    },
  },

  notesq_update: {
    name: 'notesq_update',
    description: 'Edit a note NOW: replace its markdown, or append text to the end, and/or set properties. To REPLACE markdown you MUST pass base_hash = the base_hash notesq_read returned for the version you read; if the note changed since, you get conflict:true and nothing is written (re-read, tell the user, never retry blindly). Append and properties-only edits may omit base_hash (they apply to the latest version). Every write is a revision and can be undone with notesq_restore.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        markdown: { type: 'string', description: 'Full replacement markdown.' },
        append: { type: 'string', description: 'Text appended to the end of the note.' },
        properties: { type: 'object', description: 'Properties merged into the existing ones.' },
        base_hash: { type: 'string', description: 'REQUIRED to replace markdown: the base_hash from notesq_read.' },
      },
      required: ['id'],
    },
    execute: async (input, ctx) => {
      const { id, markdown, append, properties, base_hash: baseHash } = input || {};
      if (!validId(id)) return { success: false, error: 'id is required' };
      if (markdown === undefined && !append && !properties) return { success: false, error: 'give markdown, append or properties' };
      if (markdown !== undefined && typeof markdown !== 'string') return { success: false, error: 'markdown must be a string' };
      if (append !== undefined && typeof append !== 'string') return { success: false, error: 'append must be a string' };
      // Replacing from a stale read would silently overwrite a newer human edit:
      // the tool used to fetch the LATEST hash itself, so it could never conflict.
      if (markdown !== undefined && !baseHash) return { success: false, error: 'base_hash required to replace a note: read it with notesq_read and pass its base_hash. Nothing was changed.' };
      return writeNote(ctx, id, (cur) => {
        let md = markdown !== undefined ? markdown : cur.markdown || '';
        if (append) md = `${md.replace(/\s+$/, '')}\n\n${append}`;
        const props = { ...stripProps(cur.properties), ...(properties && typeof properties === 'object' ? properties : {}) };
        return { markdown: md, properties: props };
      }, baseHash);
    },
  },

  notesq_tag: {
    name: 'notesq_tag',
    description: 'Change a note\'s organisation properties NOW: add/remove tags, set its collection, pin/unpin, archive/unarchive. Same base_hash conflict rule and revision as notesq_update.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        add: { type: 'array', items: { type: 'string' } },
        remove: { type: 'array', items: { type: 'string' } },
        collection: { type: 'string' },
        pinned: { type: 'boolean' },
        archived: { type: 'boolean' },
      },
      required: ['id'],
    },
    execute: async (input, ctx) => {
      const { id, add, remove, collection, pinned, archived } = input || {};
      if (!validId(id)) return { success: false, error: 'id is required' };
      if (!(add && add.length) && !(remove && remove.length) && collection === undefined && pinned === undefined && archived === undefined) {
        return { success: false, error: 'nothing to change' };
      }
      let props;
      const r = await writeNote(ctx, id, (cur) => {
        props = stripProps(cur.properties);
        if ((add && add.length) || (remove && remove.length)) {
          const have = Array.isArray(props.tags) ? props.tags.map(String) : [];
          const rm = new Set((remove || []).map(String));
          const next = [...new Set([...have, ...(add || []).map(String)])].filter((t) => !rm.has(t));
          if (next.length) props.tags = next; else delete props.tags;
        }
        if (collection !== undefined) { if (collection) props.collection = String(collection); else delete props.collection; }
        if (pinned !== undefined) props.pinned = Boolean(pinned);
        if (archived !== undefined) props.archived = Boolean(archived);
        return { markdown: cur.markdown || '', properties: props };
      });
      // State the resulting organisation, not just "updated": the agent reports
      // from this, so it can only claim what actually landed.
      if (r.success && props) {
        const yn = (v) => (v ? 'yes' : 'no');
        r.properties = props;
        r.result += ` Now: tags: ${(props.tags || []).join(', ') || '(none)'}; collection: ${props.collection || '(none)'}; pinned: ${yn(props.pinned)}; archived: ${yn(props.archived)}.`;
      }
      return r;
    },
  },

  notesq_history: {
    name: 'notesq_history',
    description: 'List a note\'s revisions (rev number, action, author kind, time), oldest first. Read-only.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: async (input, ctx) => {
      const id = input && input.id;
      if (!validId(id)) return { success: false, error: 'id is required' };
      const res = await call(ctx, { method: 'GET', path: `/notesq/notes/${encodeURIComponent(id)}/revisions`, noteId: id });
      if (res.status !== 200) return failure(res);
      const revisions = (res.json.revisions || []).slice(-30).map((r) => ({ rev: r.rev, action: r.action, authorKind: r.author_kind, at: r.created_at }));
      return { success: true, count: revisions.length, revisions };
    },
  },

  notesq_restore: {
    name: 'notesq_restore',
    description: 'Restore a note to an earlier revision NOW (writes a new revision, so it is itself undoable). Use notesq_history to find the rev.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, rev: { type: 'number' } }, required: ['id', 'rev'] },
    execute: async (input, ctx) => {
      const { id, rev } = input || {};
      if (!validId(id)) return { success: false, error: 'id is required' };
      if (!Number.isInteger(rev) || rev < 1) return { success: false, error: 'rev must be a positive integer' };
      const res = await call(ctx, {
        method: 'POST', path: `/notesq/notes/${encodeURIComponent(id)}/restore`, intent: 'quox.notes.restore', noteId: id, authored: true,
        body: { rev },
      });
      if (res.status !== 200) return failure(res);
      const n = res.json.note || {};
      return { success: true, executed: true, unchanged: Boolean(res.json.unchanged), id, link: link(id), result: res.json.unchanged ? `Note already matches revision ${rev}.` : `DONE: restored "${n.title}" to revision ${rev}.` };
    },
  },

  notesq_delete: {
    name: 'notesq_delete',
    description: 'Delete a note NOW (soft: revisions are retained). Only its author or an admin may delete; the server enforces that. Ask the user to confirm before calling.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: async (input, ctx) => {
      const id = input && input.id;
      if (!validId(id)) return { success: false, error: 'id is required' };
      const res = await call(ctx, { method: 'DELETE', path: `/notesq/notes/${encodeURIComponent(id)}`, intent: 'quox.notes.delete', noteId: id });
      if (res.status !== 200) return failure(res);
      return { success: true, executed: true, id, result: 'DONE: note deleted. Its revisions are retained.' };
    },
  },

  notesq_related: {
    name: 'notesq_related',
    description: 'Find notes related to a given note (hybrid/lexical retrieval). Read-only.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, limit: { type: 'number', description: 'Max 20, default 8.' } }, required: ['id'] },
    execute: async (input, ctx) => {
      const id = input && input.id;
      if (!validId(id)) return { success: false, error: 'id is required' };
      const limit = Math.min(Math.max(parseInt(input.limit, 10) || 8, 1), 20);
      const res = await call(ctx, { method: 'GET', path: `/notesq/notes/${encodeURIComponent(id)}/related`, query: { limit }, noteId: id });
      if (res.status !== 200) return failure(res);
      const related = (res.json.related || []).map((r) => ({ id: r.id || r.note_id, title: r.title, excerpt: r.excerpt || '', link: link(r.id || r.note_id) }));
      return { success: true, mode: res.json.mode, count: related.length, related };
    },
  },

  notesq_suggest_links: {
    name: 'notesq_suggest_links',
    description: 'Suggest links for a note: other notes whose titles are mentioned in its text (wrap the mention in [[Title]] to link it) and related notes by similarity. Read-only.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, limit: { type: 'number', description: 'Max 20, default 8.' } }, required: ['id'] },
    execute: async (input, ctx) => {
      const id = input && input.id;
      if (!validId(id)) return { success: false, error: 'id is required' };
      const limit = Math.min(Math.max(parseInt(input.limit, 10) || 8, 1), 20);
      const res = await call(ctx, { method: 'GET', path: `/notesq/notes/${encodeURIComponent(id)}/suggestions`, query: { limit }, noteId: id });
      if (res.status !== 200) return failure(res);
      const j = res.json || {};
      const mentions = (j.mentions || []).map((m) => ({ id: m.id, title: m.title, count: m.count, snippet: m.snippet || '', link: link(m.id) }));
      const related = (j.related || []).map((r) => ({ id: r.id, title: r.title, score: r.score, link: link(r.id) }));
      return { success: true, mode: j.mode, mentions, related };
    },
  },

  notesq_health: {
    name: 'notesq_health',
    description: 'Notebook health report: duplicate groups, stale notes still linked from others, and broken [[links]]. Read-only. Each section is trimmed to 20 items with a total.',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['org', 'user'], description: 'org (shared notes, default) or user (personal notes).' },
        stale_days: { type: 'number', description: 'Age in days before a note counts as stale, 30 to 3650, default 180.' },
      },
    },
    execute: async (input, ctx) => {
      const scope = input && input.scope !== undefined ? input.scope : 'org';
      if (scope !== 'org' && scope !== 'user') return { success: false, error: "scope must be 'org' or 'user'" };
      const query = { scope };
      if (input && input.stale_days !== undefined) {
        const d = Number(input.stale_days);
        if (!Number.isFinite(d) || d < 30 || d > 3650) return { success: false, error: 'stale_days must be between 30 and 3650' };
        query.stale_days = Math.round(d);
      }
      const res = await call(ctx, { method: 'GET', path: '/notesq/health', query, scope });
      if (res.status !== 200) return failure(res);
      const j = res.json || {};
      const ref = (n) => (n && n.id ? { ...n, link: link(n.id) } : n);
      const trim = (arr, map) => {
        const a = Array.isArray(arr) ? arr : [];
        return { total: a.length, items: a.slice(0, HEALTH_ITEM_CAP).map(map), more: Math.max(0, a.length - HEALTH_ITEM_CAP) };
      };
      return {
        success: true,
        scope: j.scope || scope,
        scanned: j.scanned,
        truncated: Boolean(j.truncated),
        duplicates: trim(j.duplicates, (g) => ({ ...g, notes: (g.notes || []).map(ref) })),
        stale: trim(j.stale, ref),
        broken_links: trim(j.broken_links, (b) => ({ ...b, source: ref(b.source) })),
      };
    },
  },
};

// ---- AQ-9D P3 approval mode ------------------------------------------------
// NOTESQ_AGENT_EDIT_POLICY = 'propose': an agent write files an approval card
// with the exact change (a diff for edits) and runs only when a human approves.
// The person asking in their own conversation is the approval for their own
// request (approvalGate's direct-request rule); delete always asks. The gate is
// injectable for tests.
const { lineDiff, fenced } = require('./notesq/diff.js');
const CONTROL_FIELDS = ['_approvalId', '_resumeToken', '_reason'];
let gateImpl = (...a) => require('./approvalGate').withApprovalGate(...a);
function _setGate(fn) { gateImpl = fn; }
const mdEsc = (v) => String(v == null ? '' : v).replace(/[\\`*_~#[\]>|]/g, (c) => `\\${c}`).replace(/\r?\n/g, ' ').slice(0, 160);

const BACKLINK_WARN_AT = 3;
const PAST_DECISIONS_AT = 3;
// Advisory lines for destructive proposals (replace / delete). Text only; never blocks.
async function adviceLines(toolName, cur, ctx) {
  const lines = [];
  const n = cur && Array.isArray(cur.backlinks) ? cur.backlinks.length : 0;
  if (n >= BACKLINK_WARN_AT) lines.push(`Heads up: ${n} other notes link here.`);
  try {
    const st = await require('./notesqWisdom.js').outcomeStats({ orgId: ctx.orgId, agentId: ctx.agentId, toolName });
    if (st && st.accepted + st.rejected + st.expired >= PAST_DECISIONS_AT) {
      lines.push(`Past decisions on this agent's ${toolName} proposals: ${st.accepted} accepted, ${st.rejected} rejected.`);
    }
  } catch (_) { /* advisory only */ }
  return lines.length ? `\n\n${lines.join('\n\n')}` : '';
}

async function proposalCard(toolName, input, ctx) {
  const who = String(ctx.agentId || 'notesq').toUpperCase();
  const head = (verb, title, id) => `**${who}** wants to ${verb} ${title ? `"${mdEsc(title)}"` : 'a note'}.${id ? ` [Open the note](${link(id)})` : ''}\n\nNothing changes until you approve. Every change is a revision you can undo.`;
  if (toolName === 'notesq_create') {
    const body = String(input.markdown || '').slice(0, 4000);
    const meta = [`scope: ${input.scope === 'user' ? 'personal' : 'team (org)'}`, input.collection ? `collection: ${mdEsc(input.collection)}` : '', Array.isArray(input.tags) && input.tags.length ? `tags: ${input.tags.map(mdEsc).join(', ')}` : ''].filter(Boolean).join(' · ');
    return { targetId: 'new-note', reason: `create note ${String(input.title || '').slice(0, 80)}`, title: `NotesQ: create "${String(input.title || 'Untitled').slice(0, 80)}"`, bodyMd: `${head('create', input.title)}\n\n${meta}\n\n${fenced(body, 'markdown')}` };
  }
  const { note: cur } = await readNote(ctx, input.id);
  const title = cur ? cur.title : input.id;
  if (toolName === 'notesq_update') {
    let next = cur ? (cur.markdown || '') : '';
    if (input.markdown !== undefined) next = String(input.markdown);
    if (input.append) next = `${next.replace(/\s+$/, '')}\n\n${input.append}`;
    const d = lineDiff(cur ? (cur.markdown || '') : '', next);
    const props = input.properties && typeof input.properties === 'object' ? `\n\nProperties set: ${Object.entries(input.properties).map(([k, v]) => `${mdEsc(k)} = ${mdEsc(JSON.stringify(v))}`).join(', ')}` : '';
    const stale = input.markdown !== undefined && cur && input.base_hash && input.base_hash !== cur.content_hash ? '\n\n**Warning:** the note has changed since the agent read it; approving will be refused as a conflict.' : '';
    const advice = input.markdown !== undefined ? await adviceLines(toolName, cur, ctx) : '';
    return { targetId: input.id, reason: `edit note ${String(title).slice(0, 80)}`, title: `NotesQ: edit "${String(title).slice(0, 80)}" (+${d.added} / -${d.removed})`, bodyMd: `${head('edit', title, input.id)}${advice}${stale}\n\n${d.changed ? fenced(d.text, 'diff') : '_No change to the text._'}${props}` };
  }
  if (toolName === 'notesq_tag') {
    const parts = [];
    if (Array.isArray(input.add) && input.add.length) parts.push(`add tags: ${input.add.map(mdEsc).join(', ')}`);
    if (Array.isArray(input.remove) && input.remove.length) parts.push(`remove tags: ${input.remove.map(mdEsc).join(', ')}`);
    if (input.collection !== undefined) parts.push(`collection: ${input.collection ? mdEsc(input.collection) : '(none)'}`);
    if (input.pinned !== undefined) parts.push(input.pinned ? 'pin' : 'unpin');
    if (input.archived !== undefined) parts.push(input.archived ? 'archive' : 'unarchive');
    return { targetId: input.id, reason: `organise note ${String(title).slice(0, 80)}`, title: `NotesQ: organise "${String(title).slice(0, 80)}"`, bodyMd: `${head('organise', title, input.id)}\n\n- ${parts.join('\n- ') || 'no change'}` };
  }
  if (toolName === 'notesq_restore') {
    return { targetId: input.id, reason: `restore note ${String(title).slice(0, 80)} to revision ${input.rev}`, title: `NotesQ: restore "${String(title).slice(0, 80)}" to revision ${input.rev}`, bodyMd: `${head(`restore to revision ${Number(input.rev)}`, title, input.id)}` };
  }
  const advice = await adviceLines(toolName, cur, ctx);
  return { targetId: input.id, reason: `delete note ${String(title).slice(0, 80)}`, title: `NotesQ: delete "${String(title).slice(0, 80)}"`, bodyMd: `${head('delete', title, input.id)}${advice}\n\nA delete is soft: the note and its history can be restored.` };
}

// Unknown argument names are refused before anything runs. A guessed name
// (addTags for add) used to be silently ignored while the rest of the call
// applied and reported DONE, and the agent then claimed the ignored change
// (AQ-9D scorecard, 2026-10-07).
for (const tool of Object.values(NOTESQ_TOOLS)) {
  const allowed = Object.keys(tool.input_schema.properties || {});
  const run = tool.execute;
  tool.execute = async (input, ctx) => {
    const unknown = Object.keys(input || {}).filter((k) => !allowed.includes(k) && !CONTROL_FIELDS.includes(k));
    if (unknown.length) {
      return { success: false, error: `unknown argument(s) ${unknown.join(', ')} for ${tool.name}; valid arguments: ${allowed.join(', ')}. Nothing was changed.` };
    }
    // Agent edit policy: refuse BEFORE any brain call. Fails open to 'direct'
    // when the lookup errors (the default posture), matching the registry default.
    const policy = WRITE_TOOLS.has(tool.name) ? orgSetting(ctx, POLICY_KEY) : null;
    if (policy === 'read_only') {
      return { success: false, error: READ_ONLY_ERROR };
    }
    const clean = Object.fromEntries(Object.entries(input || {}).filter(([k]) => !CONTROL_FIELDS.includes(k)));
    if (policy === 'propose') {
      // On a resume (approved) the gate verifies the token and input before running;
      // the card is only built when a proposal is being filed.
      const card = input && input._approvalId ? null : await proposalCard(tool.name, clean, ctx || {});
      return gateImpl(tool.name, input, () => run(clean, ctx), { ...(ctx || {}), _notesqPropose: true, _notesqProposal: card });
    }
    return run(clean, ctx);
  };
}

/** Read-modify-write with optimistic concurrency: fetch current content_hash,
 * send it as base_hash, surface a 409 as a conflict result. Never retries. */
async function writeNote(ctx, id, build, baseHash) {
  const { res: rres, note: cur } = await readNote(ctx, id);
  if (!cur) return failure(rres);
  const next = build(cur);
  const res = await call(ctx, {
    method: 'PUT', path: `/notesq/notes/${encodeURIComponent(id)}`, intent: 'quox.notes.update', noteId: id, authored: true,
    body: { markdown: next.markdown, properties: next.properties, base_hash: baseHash || cur.content_hash },
  });
  if (res.status !== 200) return failure(res);
  const n = res.json.note || cur;
  return { success: true, executed: true, unchanged: Boolean(res.json.unchanged), id, title: n.title, link: link(id), result: res.json.unchanged ? 'No change needed.' : `DONE: updated "${n.title}". Undo is available via history.` };
}

module.exports = {
  NOTESQ_TOOLS,
  setNotesqToolsCall,
  _internal: { baseCtx, cap, failure, BODY_CAP, proposalCard },
  _setGate,
};
