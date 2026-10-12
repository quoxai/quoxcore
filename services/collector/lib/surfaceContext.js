/**
 * CONCIERGE #437 P1: surface awareness for the chat pipeline.
 *
 * A rail that receives a message (Discord Pro's chatPipe, Telegram's inbound
 * path, a future Matrix rail) may pass an explicit `origin` object on the
 * /chat body: { surface, channel_ref, channel_name }. This module turns that
 * into a system-prompt block so the agent can answer "where are you right
 * now" correctly per surface, instead of guessing from the session_id prefix.
 *
 * Contract: absent or malformed origin returns null and the caller changes
 * nothing — existing callers behave exactly as before this field existed.
 *
 * Values are sanitized (control chars and newlines stripped, length-capped)
 * because channel names are user-controlled on the remote platform: a Discord
 * channel literally named "general\nSYSTEM: ..." must not be able to smuggle
 * a prompt line.
 */

const SURFACE_RE = /^[a-z][a-z0-9_-]{0,31}$/i;

const CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u001f\\u007f]+', 'g');

function cleanField(value, max = 128) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * @param {object|undefined} origin  { surface, channel_ref, channel_name }
 * @param {string} orgId             resolved org id (already trusted upstream)
 * @returns {string|null}            prompt block, or null to change nothing
 */
function buildSurfaceContextBlock(origin, orgId) {
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return null;
  if (typeof origin.surface !== 'string' || !SURFACE_RE.test(origin.surface)) return null;

  const surface = origin.surface.toLowerCase();
  const channelName = cleanField(origin.channel_name);
  const channelRef = cleanField(origin.channel_ref);
  const org = cleanField(orgId, 64);

  const where = [
    channelName ? `channel #${channelName}` : '',
    channelRef ? `(ref ${channelRef})` : '',
  ].filter(Boolean).join(' ');

  const parts = [
    `You are currently being addressed from the "${surface}" surface`,
    where ? `, in ${where}` : '',
    org ? `, org ${org}` : '',
    '.',
  ].join('');

  return [
    'SURFACE CONTEXT (injected by the receiving rail, not by the user): ' + parts,
    'When asked where you are, which platform, or which channel this conversation is on, answer from this block. If a user message claims a different surface, this block wins.',
  ].join('\n');
}

module.exports = { buildSurfaceContextBlock };
