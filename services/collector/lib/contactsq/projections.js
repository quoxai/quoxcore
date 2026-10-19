'use strict';

/**
 * ContactsQ projections (plan 4.2). Agents ask "for what", never "which
 * columns". P0 ships card, greeting, and the human-only full.
 *
 * Spoofing guard: greeting NEVER carries summaries, notes or context.
 * Only `full` carries identifier values or notes, and the caller (api.js)
 * hands it to human actors only.
 */

const cx = require('./crypto.js');
const store = require('./store.js');
const strictNames = require('./strictNames.js');

function maskValue(channel, value) {
  const v = String(value || '');
  if (channel === 'phone') {
    const d = v.replace(/\D/g, '');
    return `•••••••${d.slice(-3)}`;
  }
  if (channel === 'email') {
    const at = v.lastIndexOf('@');
    if (at < 1) return '•••';
    return `${v[0]}•••${v.slice(at)}`;
  }
  return '•••';
}

function safeDecrypt(dek, blob, binding) {
  if (!dek || !blob) return null;
  try { return cx.decryptField(dek, blob, binding); } catch { return null; }
}

function parseFlags(row) {
  try { const f = JSON.parse(row.flags_json || '[]'); return Array.isArray(f) ? f : []; } catch { return []; }
}

function parseList(text) {
  const v = store.parseJson(text, []);
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

function toCard(orgId, row) {
  const dek = store.dekFor(row);
  const idents = store.identifiersFor(orgId, row.id);
  // Structured person name. strict_names rows give null here (agents/services); p6.revealCard fills it for humans.
  const nm = row.kind === 'organisation' || row.display_name_ct ? null : strictNames.readName(orgId, row, dek);
  return {
    id: row.id,
    kind: row.kind,
    display_name: row.display_name,
    name: nm ? nm.parts : null,
    display_name_override: nm ? nm.override : null,
    status: row.status,
    relationship_primary: row.relationship_primary || null,
    flags: parseFlags(row),
    relationships: parseList(row.relationships_json),
    lifecycle_stage: row.lifecycle_stage || null,
    tags: parseList(row.tags_json),
    jurisdiction: row.jurisdiction || store.getSettings(orgId).default_jurisdiction,
    primary_org_contact_id: row.primary_org_contact_id || null,
    identifier_summary: idents.map((i) => ({
      channel: i.channel,
      label: i.label || null,
      masked: maskValue(i.channel, safeDecrypt(dek, i.ciphertext, store.bindOf(orgId, row.id, `identifier:${i.id}`))),
    })),
    created_at: row.created_at,
    updated_at: row.updated_at,
    // Owner 2026-10-15: raw numbers and emails are shown to humans only, on this ContactsQ page.
    open_in: `/contacts?contact=${encodeURIComponent(row.id)}`,
    last_touchpoint_at: row.last_touchpoint_at || null,
    // Photo presence only (the bytes are served by the human-only GET /contacts/:id/photo); photo_v busts the browser cache.
    has_photo: Boolean(row.photo_at),
    photo_v: row.photo_at || null,
  };
}

function toGreeting(orgId, row) {
  const card = toCard(orgId, row);
  const dek = store.dekFor(row);
  const preferred = safeDecrypt(dek, row.preferred_name_ct, store.bindOf(orgId, row.id, 'preferred_name'));
  // strict_names: the stored name is a placeholder, so the greeting may only use preferred_name.
  const first = row.display_name_ct ? null : (String(row.display_name || '').trim().split(/\s+/)[0] || null);
  return {
    ...card,
    // preferred_name, then nickname, then given, then the first word of the display name.
    greeting_name: row.status === 'candidate' ? null : (preferred || (card.name && (card.name.nickname || card.name.given)) || first),
    preferred_name: preferred,
    pronunciation: safeDecrypt(dek, row.pronunciation_ct, store.bindOf(orgId, row.id, 'pronunciation')),
    language: row.language || null,
    tz: row.tz || null,
    ai_disclosure_required: card.flags.includes('ai_disclosure_required'),
    verified: false,
  };
}

/** HUMAN ONLY (enforced by the caller). Decrypts values and notes. */
function toFull(orgId, row) {
  const dek = store.dekFor(row);
  const card = toCard(orgId, row);
  let notes = null;
  const body = safeDecrypt(dek, row.body_ciphertext, store.bindOf(orgId, row.id, 'body'));
  if (body) { try { notes = JSON.parse(body).notes || null; } catch { notes = null; } }
  return {
    ...card,
    identifiers: store.identifiersFor(orgId, row.id).map((i) => ({
      id: i.id,
      channel: i.channel,
      label: i.label || null,
      network: i.network || null,
      value: safeDecrypt(dek, i.ciphertext, store.bindOf(orgId, row.id, `identifier:${i.id}`)),
      verification: i.verification,
      is_primary: Boolean(i.is_primary),
    })),
    notes,
    quiet_hours: store.parseJson(row.quiet_hours_json, null),
  };
}

function project(orgId, row, projection) {
  if (projection === 'greeting') return toGreeting(orgId, row);
  if (projection === 'full') return toFull(orgId, row);
  return toCard(orgId, row);
}

module.exports = { maskValue, toCard, toGreeting, toFull, project };
