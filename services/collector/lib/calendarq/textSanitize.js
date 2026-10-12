'use strict';

/**
 * Calendar-Q shared text sanitizer (audit fix 2) — strips C0 control chars
 * (0x00-0x1F, except \n and \t), DEL (0x7F), and C1 control chars
 * (0x80-0x9F) from attacker-controlled text before it is stored or rendered.
 *
 * Attacker-controlled text enters Calendar-Q at several points, each with
 * its own calling convention, so this is a single small helper every site
 * applies rather than a shape each site reinvents:
 *   - providers/google.js normalizeEvent: a synced event's title/location,
 *     and the spokenForm template built from them.
 *   - proposals.js createProposal: a human/agent-supplied title/description.
 *   - layers.js adapters: a projected occurrence's title (internal_events,
 *     team_schedules, workflow_cron).
 *   - prep.js: an InboxQ-joined reference's subject/from line.
 *
 * An ANSI escape sequence (ESC + CSI/OSC bytes) is a C0 control char (ESC,
 * 0x1B) followed by printable text — stripping the ESC byte alone already
 * defangs a terminal escape injection into a CLI-rendered spokenForm; the
 * trailing printable bytes are left as inert text, same as any other string.
 *
 * Never mutates in place, never throws, never coerces a non-string — a
 * non-string value is returned unchanged so a caller can apply this
 * unconditionally to an optional field without an extra typeof guard.
 */
const CONTROL_CHARS_RE = /[\x00-\x08\x0B-\x1F\x7F\x80-\x9F]/g;

function sanitizeText(value) {
  if (typeof value !== 'string') return value;
  return value.replace(CONTROL_CHARS_RE, '');
}

module.exports = { sanitizeText };
