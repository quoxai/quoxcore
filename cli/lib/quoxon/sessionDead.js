/**
 * Is this error a dead session (sign in again) rather than a transient failure? Pure, so the
 * headless client (api.js, `quox --print`) can ask without loading signin.js, which pulls
 * React + Ink (~2 s cold) (QUOXON-LATENCY). signin.js re-exports it for the interactive client.
 */
export function isSessionDead(e) {
  if (!e || e.transient) return false;
  if (e.code === 'session_expired') return true;
  return /session expired|No refresh token|please login again|no authentication token|valid jwt or service key|not signed in/i.test(e.message || '');
}

/** One line for "this window's sign-in is stale" (a command the palette tagged "(sign in)"). */
export const SESSION_EXPIRED_LINE = "This window's sign-in expired. /login signs in again without leaving.";
/** What to say when a palette row is chosen but cannot run: the sign-in line, or "<name> is <reason>." */
export function signedOutNotice(name, reason) {
  return reason === '(sign in)' ? SESSION_EXPIRED_LINE : `${name} is ${reason}.`;
}
