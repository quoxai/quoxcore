'use strict';

/**
 * Calendar-Q meeting prep (L2-C3 U1).
 *
 * getPrep resolves ONE occurrence (by occurrenceKey, exact key only — fuzzy
 * time-reference resolution, e.g. "my 3pm", is the calling AGENT's job, not
 * this API's) from the latest PUBLISHED generation of whichever of the org's
 * connections holds it, then joins it against the org's own InboxQ store
 * IN-PROCESS to surface up to 3 relevant threads.
 *
 * AUTHORIZATION BOUNDARY (v1, single-operator): the join always reuses the
 * SAME orgId the occurrence itself was resolved under — there is no
 * cross-org reach anywhere in this file (see the two-tenant pin test).
 * Today's Calendar-Q/InboxQ org model is single-operator (one human per org
 * owns both the calendar and every connected mailbox), so "org-scoped" IS
 * the authorization boundary in this phase. contracts.js's referenceFields
 * is a STRICT shape with only {kind, ref, relation} (see contracts.js) —
 * there is no sourceAcl field to carry on a reference, so this comment is
 * the record of that invariant instead: every reference a caller receives
 * from a MeetingPrepV1 inherits the SAME org-level authorization the
 * occurrenceKey itself was resolved under, never a wider one.
 *
 * ZERO LLM CALLS: every reference and every summary line below is built from
 * plain string/array operations over already-stored data. Subjects, event
 * titles, and sender addresses are ATTACKER-CONTROLLED TEXT (an email
 * subject or an event title an attacker can set) — they are read here only
 * as inert string data (membership checks, length checks, token overlap),
 * NEVER concatenated into an instruction, NEVER fetched as a URL, NEVER used
 * to dereference an attachment. There is no network call anywhere in this
 * file.
 *
 * L2-C4: providers/google.js's normalizeEvent now carries the raw event's
 * attendee list (email + per-attendee responseStatus, capped at 50) onto a
 * stored occurrence (contracts.js's occurrenceFields.attendees, OPTIONAL and
 * additive — absent still means "unknown", not "no attendees"). The
 * participant join below reads `occurrence.attendees` defensively (an array
 * of {email, responseStatus}) so a real synced event with a populated
 * attendee list now genuinely matches senders by address; an occurrence
 * with no attendees field (an older generation, or a synthetic
 * internal_events/team_schedules/workflow_cron layer, which never carries
 * one) still degrades honestly to zero participant matches, reported via
 * missingContext rather than silently assumed. Contextual (title/subject
 * token overlap) remains the fallback lane either way.
 *
 * A second, related limitation: lib/inboxq/store.js's inboxq_messages table
 * has no "to" column (no stored recipient list) — so "from/to addresses" in
 * the participant join is, today, from_addr only. Both are read-only facts
 * about data this phase inherited, not bugs introduced here.
 */

const store = require('./store');
const inboxqStore = require('../inboxq/store');
const { validateMeetingPrepV1 } = require('./contracts');
const { sanitizeText } = require('./textSanitize');

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_REFERENCES = 3;
const MAX_SCAN_MESSAGES = 500; // the widest single read lib/inboxq/store.js's listMessages exposes

// A short, deliberately narrow stopword list — just enough to stop generic
// scheduling nouns ("meeting", "sync", "weekly") from inflating a token
// overlap count on their own. Not a general-purpose NLP stopword list.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'about',
  'into', 'over', 'have', 'will', 'meeting', 'call', 'sync', 'weekly',
  'update', 'review', 'check', 'reply', 'please', 'team',
]);

function titleTokens(text) {
  if (!text) return new Set();
  const words = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  return new Set(words.filter((w) => w.length >= 4 && !STOPWORDS.has(w)));
}

function tokenOverlapCount(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/**
 * Resolve one occurrence by key across every connection in this org's
 * latest PUBLISHED generations. occurrenceKey is only actually unique per
 * (connection, generation) — it genuinely is not found anywhere when no
 * connection's latest published generation carries it (e.g. it belongs to a
 * synthetic internal_events/team_schedules/workflow_cron layer, which has
 * no generation concept at all — see layers.js's syntheticCoverage).
 */
function resolveOccurrence(orgId, occurrenceKey) {
  const connections = store.listConnections(orgId);
  for (const conn of connections) {
    const published = store.readPublishedOccurrences(orgId, conn.id);
    if (!published) continue;
    const row = published.occurrences.find((o) => o.occurrenceKey === occurrenceKey);
    if (row) return row;
  }
  return null;
}

function attendeeEmailSet(occurrence) {
  const attendees = Array.isArray(occurrence.attendees) ? occurrence.attendees : [];
  const emails = attendees
    .map((a) => (a && typeof a.email === 'string' ? a.email.trim().toLowerCase() : null))
    .filter(Boolean);
  return new Set(emails);
}

/** Human-readable "from X: "subject" (age)" one-liner for the summary digest.
 * Audit fix 2: fromAddr/fromName/subject are attacker-controlled text (a
 * message sender sets all three) — strip control chars/ANSI before they
 * reach this digest line. */
function describeReference(message, nowMs) {
  const ageMs = Math.max(0, nowMs - (message.dateTs || nowMs));
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  const ageText = ageDays <= 0 ? 'today' : ageDays === 1 ? '1 day ago' : `${ageDays} days ago`;
  const from = sanitizeText(message.fromAddr || message.fromName || 'unknown sender');
  const subject = sanitizeText(message.subject || '(no subject)');
  return `From ${from}: "${subject}" (${ageText})`;
}

/**
 * @param {string} orgId
 * @param {object} opts { occurrenceKey, nowMs }
 * @returns {object} a validated MeetingPrepV1 payload
 * @throws Error('occurrence_not_found') when occurrenceKey does not resolve
 *   in any of this org's connections' latest published generations.
 */
function getPrep(orgId, { occurrenceKey, nowMs = Date.now() } = {}) {
  if (!orgId) throw new Error('getPrep requires orgId');
  if (!occurrenceKey) throw new Error('getPrep requires occurrenceKey');

  const row = resolveOccurrence(orgId, occurrenceKey);
  if (!row) throw new Error('occurrence_not_found');

  const occurrence = row.payload || {};
  const missingContext = [];

  // --- (a) explicit links: none exist yet in this phase — Calendar-Q has no
  // "attach this thread to this event" write path, so this lane is always
  // empty. Nothing to join, so nothing honest to report as missing either.

  const accounts = inboxqStore.listAccounts(orgId);
  if (accounts.length === 0) {
    missingContext.push('no InboxQ account connected for this organisation');
    const prep = {
      v: '1', orgId, occurrenceKey, eventSourceVersion: row.sourceVersion,
      references: [],
      summary: 'No InboxQ account is connected, so no related email threads could be checked for this meeting.',
      missingContext, generatedAt: nowMs,
    };
    const validated = validateMeetingPrepV1(prep);
    if (!validated.ok) throw new Error(`getPrep produced an invalid MeetingPrepV1: ${validated.errors.join('; ')}`);
    return prep;
  }

  const attendeeEmails = attendeeEmailSet(occurrence);
  if (attendeeEmails.size === 0) {
    missingContext.push('no attendee data is available for this event, so sender matching could not run');
  }

  const sinceMs = nowMs - NINETY_DAYS_MS;
  // (b)+(c): the widest org-scoped read lib/inboxq/store.js exposes —
  // listMessages with no accountId filter scans every connected account in
  // this org, newest first, capped at the store's own hard limit (500).
  // Filtered to the 90-day scan window in-process below (read-only
  // consumption of inboxq/store.js — never modified by this phase).
  const recent = inboxqStore.listMessages(orgId, { limit: MAX_SCAN_MESSAGES })
    .filter((m) => typeof m.dateTs === 'number' && m.dateTs >= sinceMs);

  const eventTokens = titleTokens(occurrence.title);

  const participantHits = [];
  const contextualHits = [];
  for (const m of recent) {
    const fromAddr = (m.fromAddr || '').trim().toLowerCase();
    if (attendeeEmails.size > 0 && fromAddr && attendeeEmails.has(fromAddr)) {
      participantHits.push(m);
      continue; // a participant match never ALSO counts as contextual
    }
    if (eventTokens.size > 0) {
      const subjectTokens = titleTokens(m.subject);
      if (tokenOverlapCount(eventTokens, subjectTokens) >= 2) contextualHits.push(m);
    }
  }

  // Newest first within each lane (listMessages already returns date_ts
  // DESC, so this is a no-op in practice — made explicit rather than
  // relying on an upstream ordering accident).
  const byNewest = (a, b) => (b.dateTs || 0) - (a.dateTs || 0);
  participantHits.sort(byNewest);
  contextualHits.sort(byNewest);

  // Participant beats contextual; cap 3 total.
  const selected = [
    ...participantHits.map((m) => ({ message: m, relation: 'participant' })),
    ...contextualHits.map((m) => ({ message: m, relation: 'contextual' })),
  ].slice(0, MAX_REFERENCES);

  if (selected.length === 0) {
    missingContext.push('no relevant authorized thread found');
  }

  const references = selected.map(({ message, relation }) => ({
    kind: 'inboxq_thread',
    ref: message.id,
    relation,
  }));

  // relation 'contextual' is a SUGGESTION, never a confirmed link — marked
  // both machine-readably (the relation field itself) and in the
  // human-readable summary line below.
  const summaryLines = selected.map(({ message, relation }) =>
    `${relation === 'participant' ? 'Participant' : 'Possibly related (suggestion)'} — ${describeReference(message, nowMs)}`);
  const summary = summaryLines.length > 0
    ? summaryLines.join(' | ')
    : 'No related email threads were found for this meeting in the last 90 days.';

  const prep = {
    v: '1',
    orgId,
    occurrenceKey,
    eventSourceVersion: row.sourceVersion,
    references,
    summary,
    missingContext,
    generatedAt: nowMs,
  };

  const validated = validateMeetingPrepV1(prep);
  if (!validated.ok) {
    throw new Error(`getPrep produced an invalid MeetingPrepV1: ${validated.errors.join('; ')}`);
  }
  return prep;
}

module.exports = { getPrep };
