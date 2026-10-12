'use strict';

/**
 * Calendar-Q contracts — the versioned payload shapes Calendar-Q's store,
 * api, and (later) sync/brief surfaces pass between themselves.
 *
 * Phase L2-C0 is the data-contract phase: before any provider sync, write
 * path, or UI surface exists, the shapes those paths will share are pinned
 * here with STRICT validators. "Strict" means an unknown extra field is
 * itself an error, not a tolerated extra — a payload that quietly grew a
 * field nobody pinned is exactly the failure mode this phase exists to
 * catch before store.js or api.js get built on top of an assumed shape.
 *
 * Dependency-free, same reason as lib/lensContract.js: no JSON Schema
 * validator is a collector dependency, so each validateX(obj) here is a
 * small hand-rolled structural check returning { ok, errors: string[] }.
 * Validators never mutate or coerce a payload — they report, they do not
 * repair.
 */

// --- primitive checks -------------------------------------------------------

function isPlainObject(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function isString(v) { return typeof v === 'string'; }
function isNonEmptyString(v) { return isString(v) && v.trim().length > 0; }
function isBoolean(v) { return typeof v === 'boolean'; }
function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }
function isNonNegativeInt(v) { return Number.isInteger(v) && v >= 0; }
function isArray(v) { return Array.isArray(v); }

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
function isDateOnly(v) { return isString(v) && DATE_ONLY_RE.test(v); }

/** A checker that requires an exact literal value (e.g. the 'v' version tag). */
function equals(expected) {
  return (v) => v === expected;
}

/** A checker that requires v to be one of `list`. */
function oneOf(list) {
  return (v) => list.includes(v);
}

/** Wrap a checker so `null` is also accepted (nullable field). */
function nullable(check) {
  return (v, path, errors) => (v === null ? true : check(v, path, errors));
}

/**
 * Wrap a per-item checker into an array checker. Pushes its own, specific
 * errors (length bound + per-item) directly into `errors` and always
 * returns true/false where false means "already reported, do not also add
 * the generic checkShape fallback message" — see checkShape below for how
 * that contract is honoured.
 */
function arrayOf(itemCheck, { minLength = 0, maxLength = Infinity } = {}) {
  return (v, path, errors) => {
    if (!isArray(v)) return false; // no specific message yet; checkShape adds the generic one
    if (v.length < minLength) {
      errors.push(`${path} must have at least ${minLength} item(s)`);
      return true; // already reported
    }
    if (v.length > maxLength) {
      errors.push(`${path} must have at most ${maxLength} item(s)`);
      return true; // already reported
    }
    v.forEach((item, i) => {
      const before = errors.length;
      const itemOk = itemCheck(item, `${path}[${i}]`, errors);
      if (itemOk === false && errors.length === before) errors.push(`${path}[${i}] is invalid`);
    });
    return true; // per-item errors (if any) already recorded above
  };
}

/** Wrap a nested-object field definition (checkShape fields array) into a checker. */
function objectShape(fields) {
  return (v, path, errors) => {
    checkShape(v, fields, path, errors);
    return true; // checkShape already recorded any errors (incl. "must be an object")
  };
}

/**
 * Validate `value` against `fields` (an array of [name, required, check]),
 * pushing one error string per problem into `errors` (prefixed with `path`).
 * Strict: any key on `value` not named in `fields` is itself an error.
 *
 * `check(fieldValue, fieldPath, errors)` may return true (valid), false (a
 * generic "<fieldPath> is invalid" is appended), or push its own specific
 * error(s) into `errors` directly and return anything other than exactly
 * `false` paired with no new errors (see arrayOf/objectShape above).
 */
function checkShape(value, fields, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path || '(root)'} must be an object`);
    return;
  }
  const known = new Set(fields.map(([name]) => name));
  for (const key of Object.keys(value)) {
    if (!known.has(key)) errors.push(`${path}.${key} is not a recognised field`);
  }
  for (const [name, required, check] of fields) {
    const fieldPath = `${path}.${name}`;
    if (!Object.prototype.hasOwnProperty.call(value, name)) {
      if (required) errors.push(`${fieldPath} is required`);
      continue;
    }
    const before = errors.length;
    const result = check(value[name], fieldPath, errors);
    if (result === false && errors.length === before) errors.push(`${fieldPath} is invalid`);
  }
}

/** Run checkShape at the named root and wrap the result as { ok, errors }. */
function validate(rootName, value, fields) {
  const errors = [];
  checkShape(value, fields, rootName, errors);
  return { ok: errors.length === 0, errors };
}

// --- shared enums ------------------------------------------------------------

const COVERAGE_STATES = ['empty', 'partial', 'stale', 'complete', 'disconnected', 'unavailable'];
const OCCURRENCE_STATUSES = ['confirmed', 'tentative', 'cancelled'];
const RESPONSE_STATUSES = ['accepted', 'declined', 'needsAction', 'tentative'];
const VISIBILITIES = ['default', 'private', 'busy-only'];
const NOTIFY_POLICIES = ['none', 'attendees'];
const REFERENCE_RELATIONS = ['explicit', 'participant', 'contextual'];
const LAYER_KINDS = ['provider', 'internal_events', 'team_schedules', 'workflow_cron', 'actionq'];
const LAYER_SCOPES = ['org', 'user'];
const CLASH_CLASSES = ['human_double_book', 'resource', 'declared_constraint'];

// --- CalendarCoverageV1 -------------------------------------------------------

const omissionFields = [
  ['kind', true, isNonEmptyString],
  ['detail', true, isNonEmptyString],
];

const coverageFields = [
  ['v', true, equals('1')],
  ['orgId', true, isNonEmptyString],
  ['connectionId', true, isNonEmptyString],
  ['resourceId', true, isNonEmptyString],
  ['windowStartLocalDate', true, isDateOnly],
  ['windowEndLocalDateExclusive', true, isDateOnly],
  ['timezone', true, isNonEmptyString],
  ['generationId', true, isNonEmptyString],
  ['complete', true, isBoolean],
  ['watermarkTs', true, isFiniteNumber],
  ['freshnessTs', true, isFiniteNumber],
  ['omissions', true, arrayOf(objectShape(omissionFields))],
  ['state', true, oneOf(COVERAGE_STATES)],
];

function validateCalendarCoverageV1(obj) {
  return validate('CalendarCoverageV1', obj, coverageFields);
}

// --- CalendarAgendaV1 ---------------------------------------------------------

// L2-C4: an occurrence's own attendee list (distinct from the proposal's
// attendeeFields above — this is read-from-the-provider data, so each
// attendee carries its own per-person responseStatus, not the viewer's
// single responseStatus already captured on the occurrence). OPTIONAL and
// ADDITIVE: absent means "unknown", not "no attendees" — the
// internal_events layer adapter never sets it, and older/unsynced
// occurrences simply omit the field. Capped at 50 per occurrence.
const occurrenceAttendeeFields = [
  ['email', true, isNonEmptyString],
  ['responseStatus', true, nullable(oneOf(RESPONSE_STATUSES))],
];

const occurrenceFields = [
  ['occurrenceKey', true, isNonEmptyString],
  ['seriesId', true, nullable(isNonEmptyString)],
  ['providerEventId', true, isNonEmptyString],
  ['sourceVersion', true, isNonEmptyString],
  ['title', true, isString],
  ['startTs', true, isFiniteNumber],
  ['endTs', true, isFiniteNumber],
  ['allDay', true, isBoolean],
  ['dateOnlyStart', true, nullable(isDateOnly)],
  ['timezone', true, isNonEmptyString],
  ['status', true, oneOf(OCCURRENCE_STATUSES)],
  ['responseStatus', true, nullable(oneOf(RESPONSE_STATUSES))],
  ['busy', true, isBoolean],
  ['visibility', true, oneOf(VISIBILITIES)],
  ['location', true, nullable(isString)],
  ['joinUrl', true, nullable(isString)],
  ['layerId', true, isNonEmptyString],
  ['spokenForm', true, isString],
  ['attendees', false, arrayOf(objectShape(occurrenceAttendeeFields), { maxLength: 50 })],
];

const agendaFields = [
  ['v', true, equals('1')],
  ['orgId', true, isNonEmptyString],
  ['coverage', true, objectShape(coverageFields)],
  ['occurrences', true, arrayOf(objectShape(occurrenceFields))],
];

function validateCalendarAgendaV1(obj) {
  return validate('CalendarAgendaV1', obj, agendaFields);
}

// --- CalendarCreateProposalV1 -------------------------------------------------

const attendeeFields = [
  ['email', true, isNonEmptyString],
];

const preconditionsFields = [
  ['conflictCheckedAt', true, isFiniteNumber],
  ['knownOverlapKeys', true, arrayOf(isNonEmptyString)],
];

const proposalFields = [
  ['v', true, equals('1')],
  ['orgId', true, isNonEmptyString],
  ['proposalId', true, isNonEmptyString],
  ['opId', true, isNonEmptyString],
  ['connectionId', true, isNonEmptyString],
  ['resourceId', true, isNonEmptyString],
  ['effectDigest', true, isNonEmptyString],
  ['title', true, isString],
  ['startTs', true, isFiniteNumber],
  ['endTs', true, isFiniteNumber],
  ['timezone', true, isNonEmptyString],
  ['allDay', true, isBoolean],
  ['attendees', true, arrayOf(objectShape(attendeeFields))],
  ['notifyPolicy', true, oneOf(NOTIFY_POLICIES)],
  ['visibility', true, oneOf(VISIBILITIES)],
  ['description', true, nullable(isString)],
  ['preconditions', true, objectShape(preconditionsFields)],
  ['expiresAt', true, isFiniteNumber],
  ['state', true, equals('proposed')],
];

function validateCalendarCreateProposalV1(obj) {
  return validate('CalendarCreateProposalV1', obj, proposalFields);
}

// --- MeetingPrepV1 -------------------------------------------------------------

const referenceFields = [
  ['kind', true, equals('inboxq_thread')],
  ['ref', true, isNonEmptyString],
  ['relation', true, oneOf(REFERENCE_RELATIONS)],
];

const meetingPrepFields = [
  ['v', true, equals('1')],
  ['orgId', true, isNonEmptyString],
  ['occurrenceKey', true, isNonEmptyString],
  ['eventSourceVersion', true, isNonEmptyString],
  // Max 3 references per the Calendar-Q contract: meeting prep is a short
  // briefing, not a full thread dump.
  ['references', true, arrayOf(objectShape(referenceFields), { maxLength: 3 })],
  ['summary', true, isString],
  ['missingContext', true, arrayOf(isString)],
  ['generatedAt', true, isFiniteNumber],
];

function validateMeetingPrepV1(obj) {
  return validate('MeetingPrepV1', obj, meetingPrepFields);
}

// --- CalendarBriefInputV1 -----------------------------------------------------

const receiptsFields = [
  ['proposed', true, isNonNegativeInt],
  ['confirmed', true, isNonNegativeInt],
  ['outcomeUnknown', true, isNonNegativeInt],
];

const briefInputFields = [
  ['v', true, equals('1')],
  ['orgId', true, isNonEmptyString],
  ['workday', true, isDateOnly],
  ['scheduleVersion', true, isNonEmptyString],
  ['coverage', true, arrayOf(objectShape(coverageFields))],
  ['upcoming', true, arrayOf(isNonEmptyString)],
  // changes/clashes are deliberately unconstrained arrays at this contract
  // layer (the spec gives them no item shape) — only their array-ness is
  // pinned here.
  ['changes', true, isArray],
  ['clashes', true, isArray],
  ['receipts', true, objectShape(receiptsFields)],
];

function validateCalendarBriefInputV1(obj) {
  return validate('CalendarBriefInputV1', obj, briefInputFields);
}

// --- ActionQIntakeV1 -----------------------------------------------------------

const actionQIntakeFields = [
  ['v', true, equals('1')],
  ['orgId', true, isNonEmptyString],
  ['idempotencyKey', true, isNonEmptyString],
  ['title', true, isNonEmptyString],
  ['sourceRefs', true, arrayOf(isNonEmptyString)],
  ['owner', true, isNonEmptyString],
  ['deadlineTs', true, nullable(isFiniteNumber)],
  ['deadlineEvidence', true, nullable(isString)],
];

function validateActionQIntakeV1(obj) {
  return validate('ActionQIntakeV1', obj, actionQIntakeFields);
}

// --- CalendarLayerV1 -----------------------------------------------------------

const layerFields = [
  ['v', true, equals('1')],
  ['orgId', true, isNonEmptyString],
  ['layerId', true, isNonEmptyString],
  ['kind', true, oneOf(LAYER_KINDS)],
  ['sourceRef', true, isNonEmptyString],
  ['displayName', true, isNonEmptyString],
  ['color', true, isNonEmptyString],
  ['visible', true, isBoolean],
  ['scope', true, oneOf(LAYER_SCOPES)],
  ['coverage', true, nullable(objectShape(coverageFields))],
];

function validateCalendarLayerV1(obj) {
  return validate('CalendarLayerV1', obj, layerFields);
}

// --- CalendarClashV1 -----------------------------------------------------------

const clashFields = [
  ['v', true, equals('1')],
  ['orgId', true, isNonEmptyString],
  ['clashId', true, isNonEmptyString],
  ['class', true, oneOf(CLASH_CLASSES)],
  // A clash is, by definition, between two or more occurrences.
  ['occurrenceKeys', true, arrayOf(isNonEmptyString, { minLength: 2 })],
  ['layerIds', true, arrayOf(isNonEmptyString)],
  ['windowCoverageStatement', true, isNonEmptyString],
  ['detectedAt', true, isFiniteNumber],
];

function validateCalendarClashV1(obj) {
  return validate('CalendarClashV1', obj, clashFields);
}

module.exports = {
  validateCalendarCoverageV1,
  validateCalendarAgendaV1,
  validateCalendarCreateProposalV1,
  validateMeetingPrepV1,
  validateCalendarBriefInputV1,
  validateActionQIntakeV1,
  validateCalendarLayerV1,
  validateCalendarClashV1,
};
