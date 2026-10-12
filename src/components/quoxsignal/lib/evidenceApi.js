/**
 * SIGNAL-P4: fetches the AEE/WARD evidence bundle for one proposal's corr.
 *
 * Hits the collector's shared AEE bundle endpoint directly (not through
 * /collector/api/v1/signal — that namespace is the QuoxSignal-server proxy
 * only; this is a general collector endpoint, same one WitnessPanel.jsx
 * already uses for VOLT/WARD receipts). Auth is the session cookie, same as
 * every other quoxsignal/lib/api.js call.
 */

/**
 * @param {string} corr
 * @returns {Promise<object|null>} the bundle response, or null if the
 *   corr doesn't exist yet, the request fails, or times out. Never throws —
 *   callers treat null as "nothing recorded", which is itself meaningful
 *   (see lib/evidenceTrail.js's MISSING handling).
 */
export async function fetchEvidenceBundle(corr) {
  if (!corr) return null;
  try {
    const res = await fetch(`/collector/aee/conversation/${encodeURIComponent(corr)}/bundle`, {
      credentials: 'include',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
