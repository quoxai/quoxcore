'use strict';

/**
 * Fail-soft loader for the ContactsQ identity helper. InboxQ and CalendarQ require THIS, never
 * identity.js directly: if ContactsQ (or one of its dependencies) cannot load, they get
 * pass-through no-ops and behave exactly as before P3b.
 */

let impl;
try { impl = require('./identity.js'); } catch (e) {
  console.warn('[contactsq] identity helper unavailable, InboxQ/CalendarQ run without contact enrichment:', e && e.message);
  impl = null;
}

const same = (_org, v) => v;
module.exports = {
  enrichMessages: impl ? impl.enrichMessages : same,
  enrichMessage: impl ? impl.enrichMessage : same,
  enrichOccurrences: impl ? impl.enrichOccurrences : same,
  enrichOccurrence: impl ? impl.enrichOccurrence : same,
  recordInbound: impl ? impl.recordInbound : () => false,
  recordSent: impl ? impl.recordSent : () => 0,
};
