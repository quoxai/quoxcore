/**
 * AEE client for the auth service.
 *
 * Fire-and-forget envelope emission to the collector's /aee/store endpoint.
 * Never blocks the auth request on an audit write — failures are logged and
 * swallowed so a collector outage can't break login / vault reads / etc.
 *
 * AEE-CORE-3 (auth bridge): enables quox.auth.* and quox.vault.* envelopes
 * from the auth service which lives in its own container and has no direct
 * envelope infrastructure.
 */

const COLLECTOR_URL =
  process.env.COLLECTOR_URL ||
  process.env.QUOX_COLLECTOR_URL ||
  'http://collector:9848';

// SEC-PLUGIN-TRUST H2: /aee/store is now gated (see collector
// utils/httpAuth.js requireAeeAuth). This client previously sent no auth at
// all; add the internal service key so it keeps working once the collector
// flips AEE_ENDPOINT_AUTH_ENFORCE=true.
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

function generateEnvelopeId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `ENV_${timestamp}_${random}`.toUpperCase();
}

/**
 * Send an envelope to the collector for AEE storage.
 *
 * @param {object} envelope
 * @param {string} envelope.from      e.g. 'human.<userId>' or 'system.auth'
 * @param {string} envelope.to        e.g. 'audit.system'
 * @param {string} envelope.intent    fully-qualified intent string
 * @param {string} envelope.corr      correlation id
 * @param {object} envelope.payload   intent-specific data
 * @param {string} [envelope.type='event']
 * @param {string} [envelope.reply_to]
 * @param {string} [envelope.priority='normal']
 */
function emitEnvelope(envelope) {
  if (!envelope || !envelope.intent) return;
  const now = new Date().toISOString();
  const full = {
    id: generateEnvelopeId(),
    v: '1',
    ts: now,
    type: envelope.type || 'event',
    from: envelope.from,
    to: envelope.to,
    intent: envelope.intent,
    corr: envelope.corr,
    reply_to: envelope.reply_to || null,
    payload: envelope.payload || {},
    priority: envelope.priority || 'normal',
    // fleet #438: carry org context as a FIRST-CLASS field. The collector's
    // deriveEnvelopeOrgId does fall back to payload.org_id, but relying on
    // that meant a caller who knew the org still produced an untagged row
    // whenever the payload shape drifted. Only ever a real value: never
    // invent one, because a fabricated org in an audit trail is worse than
    // an honest NULL (see the note in utils/audit.js).
    org_id: typeof envelope.org_id === 'string' && envelope.org_id.trim() !== ''
      ? envelope.org_id
      : null,
  };

  // Fire-and-forget — swallow all errors.
  try {
    const url = `${COLLECTOR_URL}/aee/store`;
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_SERVICE_KEY ? { 'x-service-key': INTERNAL_SERVICE_KEY } : {}),
      },
      body: JSON.stringify(full),
      signal: AbortSignal.timeout(3000),
    }).catch(err => {
      if (process.env.AEE_CLIENT_DEBUG) {
        console.warn('[AEE client] emit failed:', err.message);
      }
    });
  } catch (err) {
    if (process.env.AEE_CLIENT_DEBUG) {
      console.warn('[AEE client] emit threw:', err.message);
    }
  }
}

export { emitEnvelope, generateEnvelopeId };
