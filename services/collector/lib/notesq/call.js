'use strict';

/**
 * notesqCall: the ONE in-process boundary to quoxbrain's service-key-only
 * /notesq/* routes. Both the HTTP routes (lib/notesq/api.js) and the agent
 * tools (lib/notesqTools.js) call this function, so the licence check
 * (awaited, fail closed), identity header derivation, brain fetch and AEE
 * evidence (quox.notes.*, never content) live in exactly one place.
 *
 * ctx = { orgId, userId, isAdmin, actor } is derived by the CALLER from the
 * authenticated request / tool ctx, never from client or model input.
 * Resolves { status, json }; never throws.
 */

const LICENCE_ID = 'notesq';
const QUERY_KEYS = ['scope', 'limit', 'offset', 'q', 'collection', 'tag', 'pinned', 'archived', 'stale_days'];

function createNotesqCall(deps) {
  const need = ['isPluginLicensed', 'audit'];
  for (const k of need) {
    if (!deps || typeof deps[k] !== 'function') throw new Error(`createNotesqCall requires deps.${k}`);
  }
  const { isPluginLicensed, audit } = deps;
  const fetchImpl = deps.fetchImpl || fetch;
  const brainUrl = String(deps.brainUrl || process.env.QUOXBRAIN_URL || 'http://quoxbrain:3106').replace(/\/$/, '');
  const serviceKey = deps.serviceKey !== undefined ? deps.serviceKey : (process.env.INTERNAL_SERVICE_KEY || '');

  // The envelope sender is the REAL actor. A blanket 'agent.notesq' labelled
  // every human and CLI write as the NotesQ agent (found 2026-10-07).
  const actorFrom = (ctx) => {
    if (ctx.from) return ctx.from;
    if (ctx.actor === 'agent') return `agent.${ctx.agentId || 'unknown'}`;
    if (ctx.actor === 'human' && ctx.userId) return `human.${ctx.userId}`;
    return 'service.notesq';
  };
  const emit = (intent, ctx, noteId, extra = {}) => {
    try {
      audit({
        from: actorFrom(ctx),
        type: 'action',
        intent,
        corr: noteId || null,
        payload: { orgId: ctx.orgId, userId: ctx.userId, noteId: noteId || null, scope: extra.scope || null, rev: extra.rev ?? null, content_hash: extra.content_hash || null },
      });
    } catch (e) {
      console.error('[notesq] audit emit failed:', e?.message);
    }
  };

  /**
   * @param {{ctx:{orgId,userId,isAdmin,actor}, method:string, path:string, query?:object,
   *   body?:object, authored?:boolean (stamp author_kind from actor), intent?:string, noteId?:string, scope?:string|null}} o
   *   path is the brain path (/notesq/...); scope is the request scope used for the
   *   user_required check and evidence ('user'/'all' need a user id).
   */
  return async function notesqCall(o) {
    try {
      const c = (o && o.ctx) || {};
      const orgId = c.orgId;
      if (!orgId) return { status: 401, json: { error: 'unauthenticated' } };
      const licensed = await isPluginLicensed(orgId, LICENCE_ID);
      if (!licensed) return { status: 402, json: { error: `${LICENCE_ID} not licensed for this org` } };

      const actor = c.actor === 'agent' ? 'agent' : (c.actor || 'human');
      const ctx = { orgId, userId: c.userId || null, actor, agentId: c.agentId || null };
      const scope = o.scope || null;
      if (!ctx.userId && (scope === 'user' || scope === 'all')) {
        return { status: 400, json: { error: 'user_required' } };
      }
      let url = brainUrl + o.path;
      if (o.query) {
        const qs = new URLSearchParams();
        for (const k of QUERY_KEYS) if (o.query[k] !== undefined) qs.set(k, String(o.query[k]));
        const s = qs.toString();
        if (s) url += `?${s}`;
      }
      const headers = {
        'Content-Type': 'application/json',
        'X-Service-Key': serviceKey,
        'X-Org-Id': orgId,
        'X-User-Is-Admin': c.isAdmin === true ? 'true' : 'false',
        'X-Author-Kind': actor === 'agent' ? 'agent' : 'human',
      };
      if (ctx.userId) headers['X-User-Id'] = String(ctx.userId);
      const opts = { method: o.method, headers };
      if (o.body) opts.body = JSON.stringify(o.authored ? { ...o.body, author_kind: actor === 'agent' ? 'agent' : 'human' } : o.body);

      let upstream;
      let json;
      try {
        upstream = await fetchImpl(url, opts);
        json = await upstream.json();
      } catch (e) {
        console.error('[notesq] brain request failed:', e?.message);
        return { status: 502, json: { error: 'brain_unavailable' } };
      }

      const status = upstream.status;
      const noteId = (json && json.note && json.note.id) || o.noteId || null;
      if (status >= 200 && status < 300 && o.intent) {
        emit(o.intent, ctx, noteId, {
          scope: json?.note?.scope || scope,
          rev: json?.revision?.rev,
          content_hash: json?.revision?.content_hash || json?.note?.content_hash,
        });
      } else if (status === 409 && o.intent) {
        emit('quox.notes.conflict', ctx, noteId, { content_hash: json?.current_hash });
      } else if (status === 403) {
        emit('quox.notes.denied', ctx, noteId, { scope: o.scope || o.query?.scope });
      }
      return { status, json };
    } catch (e) {
      console.error('[notesq] call error:', e?.message);
      return { status: 500, json: { error: 'internal_error' } };
    }
  };
}

module.exports = { createNotesqCall, LICENCE_ID };
