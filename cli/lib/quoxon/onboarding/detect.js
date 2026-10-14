/**
 * Should bare `quox` open Getting started instead of the chat client?
 *
 * Yes only when nothing says a server exists: no profile is signed in (human or resident), no profile points
 * anywhere but the built-in default URL, no QUOX_URL, and the user did not ask for a specific profile or for
 * the ambient service key. Anyone who has ever configured a server keeps today's honest "Not signed in"
 * message instead (they need `quox login`, not an installer).
 */
export const DEFAULT_URL = 'http://localhost:3000';

export function needsGettingStarted({ profiles = [], residents = [], profileArg = null, env = process.env, serviceKeyFlag = false, journey = null } = {}) {
  if (profileArg) return false;
  if (env.QUOX_URL) return false;
  if ((serviceKeyFlag || env.QUOX_FORCE_SERVICE_KEY) && env.QUOX_SERVICE_KEY) return false;
  if (residents.length) return false;
  if (profiles.some(p => p.loggedIn)) return false;
  // A journey this guide started (install or finish under way) keeps it here, even after the
  // finish step pointed the profile at the new instance: nobody is signed in yet.
  if (journey?.installStage || journey?.step === 'owner' || journey?.step === 'finishing') return true;
  if (profiles.some(p => p.url && p.url.replace(/\/+$/, '') !== DEFAULT_URL)) return false;
  return true;
}
