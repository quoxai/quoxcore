/**
 * ContactsQ API client: fetch wrapper over the collector routes at
 * /api/v1/contactsq/*, reached via the same-origin `/collector` prefix (same
 * pattern as NotesQ). No client-side cache: the server is the only source of
 * truth, and raw identifier values are never kept past the component that
 * asked to reveal them.
 */
const API_BASE = '/collector/api/v1/contactsq';

/** Carries status + parsed body so callers can branch on 403/404/409. */
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error || `API error ${status}`);
    this.status = status;
    this.body = body;
    this.code = body?.error || null;
  }
}

async function call(path, { method = 'GET', body, form } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: form !== undefined ? form : (body !== undefined ? JSON.stringify(body) : undefined),
  });
  let payload = null;
  try { payload = res.status === 204 ? null : await res.json(); } catch { payload = null; }
  if (!res.ok) throw new ApiError(res.status, payload);
  return payload;
}

const enc = encodeURIComponent;

/**
 * True when a 404 means "this endpoint is not deployed yet" rather than
 * "that contact does not exist". The collector answers a missing contact
 * with {error:'not_found'}; a missing route has no such body.
 */
export function isUnavailable(err) {
  return !!err && err.status === 404 && err.code !== 'not_found';
}

/** Build the /contacts query string. Empty values are dropped. */
export function buildListQuery({ q, status, limit = 200 } = {}) {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (status) p.set('status', status);
  if (limit) p.set('limit', String(limit));
  return p.toString();
}

/** Same-origin URL of a contact's photo (human session only); `v` is the card's photo_v, which busts the browser cache on change. */
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export function photoUrl(id, v) {
  return `${API_BASE}/contacts/${enc(id)}/photo${v ? `?v=${enc(v)}` : ''}`;
}

export const api = {
  /** -> { contacts: Card[] } */
  listContacts(params) { return call(`/contacts?${buildListQuery(params)}`); },
  /** -> { candidates: [Card & {confidence, match}], ambiguous, hint? } */
  search(q) { return call(`/search?q=${enc(q)}`); },
  /** -> { contact: Card } */
  getContact(id) { return call(`/contacts/${enc(id)}`); },
  /** Human-only. -> { contact: Card & { identifiers:[{id,channel,label,network,value,verification,is_primary}], notes } }; ApiError(403,'human_required') otherwise */
  getContactFull(id) { return call(`/contacts/${enc(id)}?projection=full`); },
  /** -> 201 { contact } */
  createContact(body) { return call('/contacts', { method: 'POST', body }); },
  /** P2. -> { contact } */
  updateContact(id, body) { return call(`/contacts/${enc(id)}`, { method: 'PUT', body }); },
  /** Archive, not erasure. -> { contact } */
  archiveContact(id) { return call(`/contacts/${enc(id)}`, { method: 'DELETE' }); },
  /** -> 201 { identifier:{id,channel,label,masked} }; ApiError(409,'identifier_in_use') */
  addIdentifier(id, body) { return call(`/contacts/${enc(id)}/identifiers`, { method: 'POST', body }); },

  /** P2. -> consent matrix + history */
  getConsents(id) { return call(`/contacts/${enc(id)}/consents`); },
  /** P2. Append-only. */
  addConsent(id, body) { return call(`/contacts/${enc(id)}/consents`, { method: 'POST', body }); },
  /** P2. Advisory, not persisted. -> { decision, reasons, pack } */
  checkPolicy(id, { purpose, channel }) { return call(`/contacts/${enc(id)}/policy`, { method: 'POST', body: { purpose, channel } }); },
  /** P2. -> { decisions: [...] } */
  getPolicyDecisions(id) { return call(`/contacts/${enc(id)}/policy-decisions`); },
  /** P1. Human only. -> { leases: [...] } */
  getLeases(contactId) { return call(`/leases?contact_id=${enc(contactId)}`); },
  /** P1. Human only: queue a governed call; the phone bridge redeems the lease and the voice agent speaks with them. -> { lease } */
  callContact(contactId, reason) { return call('/leases', { method: 'POST', body: { contact_id: contactId, projection: 'dial', channel: 'voice', purpose: 'service', ...(reason ? { reason } : {}) } }); },

  /** P3. Newest first. Humans get decrypted summaries; others never. -> { timeline: [{id,surface,direction,occurred_at,outcome,ref,summary?}] } */
  getTimeline(id, limit = 50) { return call(`/contacts/${enc(id)}/timeline?limit=${enc(limit)}`); },
  /** P8a. Latest handoff notes left by agents, newest first. Humans get the text. -> { handoffs: [{id,occurred_at,age_hours,agent_id,summary}] } */
  getHandoffs(id, limit = 3) { return call(`/contacts/${enc(id)}/handoffs?limit=${enc(limit)}`); },
  /** P3. Human or service. Record-only; reaches no one. -> 201 { touchpoint } */
  logTouchpoint(id, body) { return call(`/contacts/${enc(id)}/touchpoints`, { method: 'POST', body }); },
  /** P3. -> { edges: [{id,type,direction:'out'|'in',other:{id,kind,display_name},attrs?,since,until}] } */
  getEdges(id) { return call(`/contacts/${enc(id)}/edges`); },
  /** P3. Human. body {to_id,type,attrs?,since?,until?}. -> 201 { edge }; 409 edge_exists; 400 invalid_edge_kinds */
  addEdge(id, body) { return call(`/contacts/${enc(id)}/edges`, { method: 'POST', body }); },
  removeEdge(id, edgeId) { return call(`/contacts/${enc(id)}/edges/${enc(edgeId)}`, { method: 'DELETE' }); },

  /** -> { suppressed, reasons } */
  checkSuppression({ channel, value }) { return call('/suppressions/check', { method: 'POST', body: { channel, value } }); },
  /** -> 201 { suppression:{id,channel,reason} } */
  addSuppression({ channel, value, reason }) { return call('/suppressions', { method: 'POST', body: { channel, value, reason } }); },

  /** P1. -> { grants: [...] } */
  listGrants() { return call('/grants'); },
  /** P1. Human admin. -> 201 { grant } */
  createGrant(body) { return call('/grants', { method: 'POST', body }); },
  revokeGrant(id) { return call(`/grants/${enc(id)}`, { method: 'DELETE' }); },

  /** P8B. Human only. Tells the server which contact is open (in memory, 30 min). -> { ok } */
  setFocus(contactId) { return call('/focus', { method: 'POST', body: { contact_id: contactId } }); },
  /** P8B. -> { focus: { contact: Card, set_by, age_seconds } | null } */
  getFocus() { return call('/focus'); },

  /** -> { settings } */
  getSettings() { return call('/settings'); },
  /** Human admin. -> { settings } */
  putSettings(settings) { return call('/settings', { method: 'PUT', body: settings }); },
  /** P2. -> counts only */
  getStats() { return call('/stats'); },

  /** P4. Human admin. scope 'full' | 'identifiers_only'. -> { erasure, certificate }; 409 legal_hold | already_erased */
  eraseContact(id, { scope, reason_code }) { return call(`/contacts/${enc(id)}/erase`, { method: 'POST', body: { scope, reason_code } }); },
  /** P4. Human admin. -> { certificate, verified } */
  getErasureCertificate(id) { return call(`/erasures/${enc(id)}/certificate`); },
  /** P4. Human admin. The whole record, decrypted, plus the lease use ledger. */
  getDsar(id) { return call(`/contacts/${enc(id)}/dsar`); },
  /** P4. Human. -> { generated_at, bands: { name: { count, ids, truncated } } } */
  getCompliance() { return call('/compliance'); },
  /** P4. Human. -> { enabled, run_time_utc, last_run_at, last_status, next_tick_at, pending, ... } */
  getRetentionStatus() { return call('/retention/status'); },
  /** P4. Human admin. -> { run } */
  runRetention({ dry_run = false } = {}) { return call('/retention/run', { method: 'POST', body: { dry_run } }); },
  /** P4. Human. body { evidence_ref } */
  markNoticeSent(id, body) { return call(`/contacts/${enc(id)}/notice-sent`, { method: 'POST', body }); },
  /** P4. Human admin. Article 30 record, no personal data. */
  getProcessingRecord() { return call('/processing-record'); },

  /**
   * P5. Human admin. Multipart upload (the browser sets the boundary, so no JSON content type).
   * commit=false is a DRY RUN: nothing is written. -> { dry_run, format, report, import_id?, counts? }
   */
  importContacts(file, { commit = false, mapping, format } = {}) {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('dry_run', commit ? 'false' : 'true');
    if (format) form.append('format', format);
    if (mapping) form.append('mapping', JSON.stringify(mapping));
    return call('/import', { method: 'POST', form });
  },
  /** P7. Org admin. CardDAV pull sync (one way). -> { sources: [Source] } */
  listSyncSources() { return call('/sync/sources'); },
  /** -> 201 { source }; ApiError 422 credential_rejected | 409 addressbook_choice_required { addressbooks } | 409 source_exists */
  addSyncSource(body) { return call('/sync/sources', { method: 'POST', body }); },
  /** body: { enabled?, interval_min?, label? }. Enabling clears a retirement. -> { source } */
  updateSyncSource(id, body) { return call(`/sync/sources/${enc(id)}`, { method: 'PATCH', body }); },
  /** -> { dry_run, counts, source }; a dry run writes nothing. */
  runSyncSource(id, { dryRun = false } = {}) { return call(`/sync/sources/${enc(id)}/run`, { method: 'POST', body: { dry_run: !!dryRun } }); },
  /** Stops syncing and keeps every contact. -> { removed, links_removed } */
  removeSyncSource(id) { return call(`/sync/sources/${enc(id)}`, { method: 'DELETE' }); },
  /** P5. Human. -> { duplicates: [{a,b,reasons,suggested_survivor}] } */
  getDuplicates() { return call('/duplicates'); },
  /** P5. Human admin. Folds loser into survivor, undoable for 30 days. -> { merge, counts } */
  mergeContacts(survivorId, loserId) { return call(`/contacts/${enc(survivorId)}/merge`, { method: 'POST', body: { from_id: loserId } }); },
  /** P5. Human admin. -> { merges: [{id,survivor_id,loser_id,status,counts,merged_at,expires_at}] } */
  getMerges() { return call('/merges'); },
  /** P5. Human admin. -> { merge } */
  undoMerge(mergeId) { return call(`/merges/${enc(mergeId)}/undo`, { method: 'POST' }); },
  /** Human only. The org's own quox.contacts.* evidence events, newest first, codes and ids only. -> { events: [{id,ts,intent,actor:{type,id},contact_id,outcome,codes}], next_before } */
  getHistory({ limit = 50, before } = {}) {
    const p = new URLSearchParams();
    if (limit) p.set('limit', String(limit));
    if (before) p.set('before', before);
    return call(`/history?${p.toString()}`);
  },
  /** Human only. Last N recurring compliance reports (counts and ids only). -> { reports: [{id,period_key,cadence,generated_at,status,delivery_ref,error_code,summary}] } */
  getReports({ limit = 10 } = {}) { return call(`/reports?limit=${encodeURIComponent(String(limit))}`); },
  /** Human only. Multipart field `file` (png, jpeg or webp, up to 2 MB). -> { photo: { has_photo, mime, size, updated_at } } */
  putPhoto(id, file) {
    const form = new FormData();
    form.append('file', file, file.name || 'photo');
    return call(`/contacts/${enc(id)}/photo`, { method: 'PUT', form });
  },
  /** Human only. -> { removed } */
  deletePhoto(id) { return call(`/contacts/${enc(id)}/photo`, { method: 'DELETE' }); },
  /** P5. Human. -> { facts: [{id,key,value,confidence,sensitivity,review_state,expires_at,...}] } */
  getFacts(id) { return call(`/contacts/${enc(id)}/facts`); },
  /** P5. Human. Lands confirmed. body {key,value,confidence?,sensitivity?,expires_at?} -> 201 { fact } */
  addFact(id, body) { return call(`/contacts/${enc(id)}/facts`, { method: 'POST', body }); },
  /** P5. Human. Confirm, reject or edit. body any of {review_state,key,value,confidence,sensitivity,expires_at} -> { fact } */
  updateFact(id, factId, body) { return call(`/contacts/${enc(id)}/facts/${enc(factId)}`, { method: 'PUT', body }); },
};

/** Save JSON as a file in the browser (DSAR, certificate, processing record). */
export function downloadJson(filename, data) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
