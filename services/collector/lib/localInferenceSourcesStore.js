/**
 * localInferenceSourcesStore.js — org-scoped in-memory store for registered
 * local inference sources (Ollama / vLLM / llama.cpp / NVIDIA NIM endpoints).
 *
 * SECURITY FIX (SEC-LOCAL-INF-ORG, 2026-09-25): this was previously a bare
 * process-global `Map` declared directly in server.js with no org field at
 * all — `GET /api/v1/local-inference/sources` iterated the WHOLE map
 * (`Array.from(localInferenceSources.values())`) with no auth gate, so any
 * caller on the network could enumerate, register into, or delete every
 * org's registered inference endpoints (including base URLs and, pre-mask,
 * auth tokens). server.js's routes now require `requireServiceOrUserAuth()`
 * and call into this store's org-scoped accessors instead of touching a raw
 * Map directly.
 *
 * Extracted into its own module (dependency-injected, no server.js import)
 * so the org-scoping logic is unit-testable without booting the full
 * server.js process — server.js reads env, opens a DB and calls
 * server.listen() on require(), so it cannot be required() directly in a
 * test (see test/stabilityAuditsServerJs.unit.test.js and
 * lib/devServersStore.js, which use the same pattern).
 *
 * Sources stay keyed by their plain caller-supplied `id` (NOT `orgId:id`).
 * SEC-LOCAL-INF-ORG-CHAT (quox#599, 2026-09-25): `resolveLocalSource()` in
 * server.js (chat-time path, POST /api/v1/quoxchat/message local-inference
 * branch, server.js ~1695/23932/24806) now calls `getForOrg(id, orgId)`
 * with the authenticated caller's org instead of the unscoped lookup, so a
 * cross-org source id resolves to null (same "not found" as a nonexistent
 * id) rather than routing the caller's chat through another org's endpoint
 * + auth token. Re-keying the Map itself was NOT done as part of that fix
 * (still plain `id`, not `orgId:id`) — practical consequence, flagged
 * rather than silently accepted: two different orgs choosing the SAME `id`
 * string still clobber each other's registration (last write wins), even
 * though each org can now only look up / list / delete its OWN sources
 * afterward via the org-scoped accessors. A follow-up should either enforce
 * global id uniqueness at registration or move to a composite key.
 */

'use strict';

function createLocalInferenceSourcesStore() {
  /** @type {Map<string, object>} id -> { ...source, orgId } */
  const sources = new Map();

  /**
   * @param {object} source - must include `id`; other fields are opaque.
   * @param {string} orgId - the authenticated caller's org. Required.
   */
  function register(source, orgId) {
    if (!orgId) {
      throw new Error('orgId is required to register a local inference source');
    }
    if (!source || !source.id) {
      throw new Error('source.id is required');
    }
    sources.set(source.id, { ...source, orgId });
  }

  /**
   * Unscoped lookup by plain id. SEC-LOCAL-INF-ORG-CHAT (quox#599):
   * resolveLocalSource() in server.js no longer calls this — it uses
   * getForOrg() so chat-time lookups are org-scoped. No current caller
   * needs a cross-org lookup; kept for now (name-distinct from
   * listForOrg/deleteForOrg/getForOrg so a future caller can't reach for
   * this by accident when they mean an org-scoped op) rather than removed,
   * since deleting it is outside this fix's scope.
   */
  function getUnscoped(id) {
    return sources.get(id) || null;
  }

  /** Org-scoped list — only entries belonging to `orgId`. */
  function listForOrg(orgId) {
    if (!orgId) return [];
    return Array.from(sources.values()).filter((s) => s.orgId === orgId);
  }

  /**
   * Org-scoped delete. Returns false both when the id doesn't exist AND when
   * it belongs to a different org — the caller should respond 404 either
   * way, so cross-org callers can't distinguish "not found" from "not yours"
   * (no existence disclosure).
   */
  function deleteForOrg(id, orgId) {
    if (!orgId) return false;
    const existing = sources.get(id);
    if (!existing || existing.orgId !== orgId) return false;
    sources.delete(id);
    return true;
  }

  /** Org-scoped point lookup — used by a route that needs to look before deleting/reading one entry. */
  function getForOrg(id, orgId) {
    if (!orgId) return null;
    const existing = sources.get(id);
    if (!existing || existing.orgId !== orgId) return null;
    return existing;
  }

  return { register, getUnscoped, listForOrg, deleteForOrg, getForOrg };
}

module.exports = { createLocalInferenceSourcesStore };
