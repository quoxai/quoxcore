'use strict';

/**
 * Calendar-Q create-event proposals (L2-C2 U1) — the first half of the
 * "approved single non-recurring event creation" trust-critical phase.
 *
 * createProposal has NO external effect: it validates, discloses conflicts,
 * and persists a 'proposed' operation. Nothing is sent to a provider here —
 * execute.js (U2) is the only place a provider is ever called, and only
 * after a human approves.
 *
 * opId is generated in Google's event-id charset (base32hex lowercase,
 * length >= 26) because the SAME id becomes the provider event id at create
 * time (events.insert body.id) — Google requires this exact charset for a
 * client-supplied event id.
 *
 * effectDigest is a sha256 over the canonical effect fields (title, start,
 * end, tz, allDay, resourceId, sorted attendee emails, notifyPolicy,
 * visibility, description). It exists so ANY drift between "what a human
 * approved" and "what is about to execute" is mechanically detectable —
 * see execute.js's revalidation step and store.js's approval_bound_digest
 * column for how the two halves of that check fit together.
 */

const crypto = require('crypto');
const store = require('./store');
const { validateCalendarCreateProposalV1 } = require('./contracts');
const { sanitizeText } = require('./textSanitize');

const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

// Google Calendar event ids: lowercase base32hex (0-9a-v), 5-1024 chars.
// length chosen well above the 26-char floor the phase brief calls for, high
// enough entropy that a dummy/forged opId can never collide with a real one.
const OPID_ALPHABET = '0123456789abcdefghijklmnopqrstuv';
const OPID_LENGTH = 26;

function generateOpId() {
  const bytes = crypto.randomBytes(OPID_LENGTH);
  let out = '';
  for (let i = 0; i < OPID_LENGTH; i++) out += OPID_ALPHABET[bytes[i] % OPID_ALPHABET.length];
  return out;
}

function generateProposalId() {
  return `calprop_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
}

/** Lowercased, trimmed, de-duplicated, sorted attendee emails — the stable
 * shape both the propose-time digest and the execute-time recompute hash. */
function canonicalAttendeeEmails(attendees) {
  const emails = (attendees || [])
    .map((a) => (a && typeof a.email === 'string' ? a.email.trim().toLowerCase() : null))
    .filter(Boolean);
  return Array.from(new Set(emails)).sort();
}

/**
 * sha256 of the canonical effect fields. Exported so execute.js recomputes
 * the IDENTICAL hash from a (possibly later-read) proposal — any disagreement
 * between the two calls means the effect fields changed in between.
 */
function computeEffectDigest(effect) {
  const canonical = {
    title: effect.title || '',
    startTs: effect.startTs,
    endTs: effect.endTs,
    timezone: effect.timezone,
    allDay: Boolean(effect.allDay),
    resourceId: effect.resourceId,
    attendees: canonicalAttendeeEmails(effect.attendees),
    notifyPolicy: effect.notifyPolicy,
    visibility: effect.visibility,
    description: effect.description || null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// Any of these on the input means "this is a recurring thing" — rejected
// outright. This phase is single-event creation only.
const RECURRENCE_INPUT_FIELDS = ['recurrence', 'rrule', 'recurrenceRule', 'recurringEventId'];

function hasRecurrenceFields(input) {
  return RECURRENCE_INPUT_FIELDS.some((f) => input[f] !== undefined && input[f] !== null);
}

/** One UTC midnight-anchored day, from a 'YYYY-MM-DD' dateOnly string — the
 * same anchor providers/google.js's normalizeEvent uses for an all-day event
 * so a round trip through Calendar-Q never shifts an all-day date. */
function dateOnlyToTs(dateOnly) {
  return Date.parse(`${dateOnly}T00:00:00.000Z`);
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate `input` against the propose contract and, if valid, resolve it
 * into the {startTs, endTs, allDay} triple the stored effect carries.
 * Returns { errors: string[] } (empty when valid) plus the resolved fields.
 */
function validateAndResolveEffect(input) {
  const errors = [];
  if (!input || typeof input !== 'object') return { errors: ['input must be an object'] };

  if (!input.connectionId) errors.push('connectionId is required');
  if (typeof input.title !== 'string' || !input.title.trim()) errors.push('title is required');
  if (!input.timezone) errors.push('timezone is required');
  if (hasRecurrenceFields(input)) errors.push('recurring events are not supported in this phase; propose a single occurrence');

  const allDay = Boolean(input.allDay);
  let startTs = null;
  let endTs = null;

  if (allDay) {
    if (!input.dateOnly || !DATE_ONLY_RE.test(input.dateOnly)) {
      errors.push("allDay proposals require dateOnly in 'YYYY-MM-DD' form");
    } else {
      startTs = dateOnlyToTs(input.dateOnly);
      endTs = startTs + 24 * 60 * 60 * 1000;
    }
  } else {
    if (!Number.isFinite(input.startTs)) errors.push('startTs is required (or allDay + dateOnly)');
    if (!Number.isFinite(input.endTs)) errors.push('endTs is required (or allDay + dateOnly)');
    if (Number.isFinite(input.startTs) && Number.isFinite(input.endTs)) {
      if (input.endTs <= input.startTs) errors.push('endTs must be after startTs');
      startTs = input.startTs;
      endTs = input.endTs;
    }
  }

  const attendees = Array.isArray(input.attendees) ? input.attendees : [];
  if (input.attendees !== undefined && !Array.isArray(input.attendees)) errors.push('attendees must be an array');
  for (const a of attendees) {
    if (!a || typeof a.email !== 'string' || !a.email.includes('@')) {
      errors.push('every attendee needs a valid email address');
      break;
    }
  }

  const notifyPolicy = input.notifyPolicy || 'none';
  if (!['none', 'attendees'].includes(notifyPolicy)) errors.push("notifyPolicy must be 'none' or 'attendees'");

  const visibility = input.visibility || 'default';
  if (!['default', 'private', 'busy-only'].includes(visibility)) errors.push("visibility must be 'default', 'private', or 'busy-only'");

  if (input.description !== undefined && input.description !== null && typeof input.description !== 'string') {
    errors.push('description must be a string');
  }

  return {
    errors,
    allDay,
    startTs,
    endTs,
    attendees: attendees.map((a) => ({ email: a.email.trim() })),
    notifyPolicy,
    visibility,
    // Audit fix 2: description is free-text, attacker/agent-supplied —
    // strip control chars/ANSI before it is ever stored or shown on an
    // approval card.
    description: sanitizeText(input.description) || null,
  };
}

/**
 * Overlap check against the LATEST PUBLISHED generation's busy, non-cancelled
 * occurrences. A conflict never blocks proposing — it is disclosed (both in
 * the stored preconditions.knownOverlapKeys and the richer `overlaps` array
 * returned alongside the proposal for a human-readable summary).
 */
function findOverlaps(occurrences, { startTs, endTs }) {
  return (occurrences || [])
    .filter((o) => o.payload && o.payload.busy && o.payload.status !== 'cancelled')
    .filter((o) => o.payload.startTs < endTs && o.payload.endTs > startTs)
    .map((o) => ({ occurrenceKey: o.occurrenceKey, title: o.payload.title, startTs: o.payload.startTs, endTs: o.payload.endTs }));
}

/**
 * @param {string} orgId
 * @param {object} input see validateAndResolveEffect above for the accepted shape
 * @param {object} [opts] { nowMs }
 * @returns {{ok:true, proposal:object, overlaps:object[]}|{ok:false, errors:string[]}}
 */
function createProposal(orgId, input, { nowMs = Date.now() } = {}) {
  if (!orgId) throw new Error('createProposal requires orgId');

  const resolved = validateAndResolveEffect(input || {});
  if (resolved.errors.length > 0) return { ok: false, errors: resolved.errors };

  const connection = store.getConnection(orgId, input.connectionId);
  if (!connection) return { ok: false, errors: ['connection not found'] };

  const resourceId = input.resourceId || connection.resourceId;
  if (resourceId !== connection.resourceId) {
    return { ok: false, errors: ['resourceId must match the connected calendar\'s resourceId'] };
  }

  const effect = {
    // Audit fix 2: title is attacker/agent-supplied text — strip control
    // chars/ANSI before it is ever stored or shown on an approval card.
    title: sanitizeText(input.title.trim()),
    startTs: resolved.startTs,
    endTs: resolved.endTs,
    timezone: input.timezone,
    allDay: resolved.allDay,
    resourceId,
    attendees: resolved.attendees,
    notifyPolicy: resolved.notifyPolicy,
    visibility: resolved.visibility,
    description: resolved.description,
  };

  const published = store.readPublishedOccurrences(orgId, input.connectionId);
  const overlaps = findOverlaps(published ? published.occurrences : [], effect);

  const proposal = {
    v: '1',
    orgId,
    proposalId: generateProposalId(),
    opId: generateOpId(),
    connectionId: input.connectionId,
    resourceId,
    effectDigest: computeEffectDigest(effect),
    title: effect.title,
    startTs: effect.startTs,
    endTs: effect.endTs,
    timezone: effect.timezone,
    allDay: effect.allDay,
    attendees: effect.attendees,
    notifyPolicy: effect.notifyPolicy,
    visibility: effect.visibility,
    description: effect.description,
    preconditions: {
      conflictCheckedAt: nowMs,
      knownOverlapKeys: overlaps.map((o) => o.occurrenceKey),
    },
    expiresAt: nowMs + PROPOSAL_TTL_MS,
    state: 'proposed',
  };

  const validated = validateCalendarCreateProposalV1(proposal);
  if (!validated.ok) {
    throw new Error(`createProposal produced an invalid CalendarCreateProposalV1: ${validated.errors.join('; ')}`);
  }

  store.createOperation({ orgId, opId: proposal.opId, kind: 'create_event', proposalJson: proposal });

  return { ok: true, proposal, overlaps };
}

/** List every create_event proposal still in state 'proposed' for this org
 * (not yet sent for approval, not yet expired-and-failed). */
function listProposals(orgId) {
  if (!orgId) throw new Error('listProposals requires orgId');
  return store.listOperations(orgId, { state: 'proposed' })
    .filter((op) => op.kind === 'create_event')
    .map((op) => op.proposal);
}

/** Find the operation carrying this human-facing proposalId. O(n) over the
 * org's operations — Calendar-Q's write volume never justifies a dedicated
 * index for this phase; opId (the provider-facing id) stays the primary key. */
function findOperationByProposalId(orgId, proposalId) {
  if (!orgId) throw new Error('findOperationByProposalId requires orgId');
  if (!proposalId) throw new Error('findOperationByProposalId requires proposalId');
  return store.listOperations(orgId).find((op) => op.proposal && op.proposal.proposalId === proposalId) || null;
}

/** Human-readable one-liner for an agent/CLI response: who gets notified and
 * how, so "exactly who would be notified" is never left implicit. */
function describeNotify(proposal) {
  if (proposal.notifyPolicy === 'none' || proposal.attendees.length === 0) {
    return 'No one will be notified by this action.';
  }
  const emails = proposal.attendees.map((a) => a.email).join(', ');
  return `${proposal.attendees.length} attendee(s) will be emailed an invite: ${emails}.`;
}

/** Human-readable conflict summary for a propose-time response. */
function describeConflicts(overlaps) {
  if (!overlaps || overlaps.length === 0) return 'No conflicts found against the latest synced calendar data.';
  const lines = overlaps.map((o) => `"${o.title}" (${new Date(o.startTs).toISOString()} - ${new Date(o.endTs).toISOString()})`);
  return `${overlaps.length} overlapping event(s) disclosed, proposing anyway (a conflict never blocks a proposal): ${lines.join('; ')}.`;
}

module.exports = {
  createProposal,
  listProposals,
  findOperationByProposalId,
  computeEffectDigest,
  canonicalAttendeeEmails,
  findOverlaps,
  describeNotify,
  describeConflicts,
  generateOpId,
  PROPOSAL_TTL_MS,
};
