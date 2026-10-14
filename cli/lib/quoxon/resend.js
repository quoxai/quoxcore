/**
 * QUOXON-FW3: a message typed while the server is restarting is kept, not dropped (pure helpers).
 * A send is only retried when the connection failed BEFORE any event arrived (so no turn started and
 * nothing can run twice); the caller enforces that.
 */
export const SERVER_RESTARTING = "Quox server is restarting. I'll send this when it is back. Esc cancels.";
export const MAX_WAIT_MS = 180000;

/** True for "could not reach the server at all" (refused / fetch failed), never for an HTTP answer. */
export function isServerDown(e) {
  if (!e || e.status) return false;
  const code = e.cause?.code || e.code || '';
  const msg = String(e.message || '');
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET/.test(String(code)) || /Could not connect to|fetch failed|ECONNREFUSED/i.test(msg);
}

/** 1s, 2s, 4s, 8s, then 10s (capped). */
export const backoffMs = (i) => Math.min(10000, 1000 * 2 ** i);

const sleepFor = (ms, signal) => new Promise((r) => {
  if (signal?.aborted) return r();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener?.('abort', done); r(); }
  signal?.addEventListener?.('abort', done, { once: true });
});

/**
 * Poll health with backoff until it answers 2xx. -> 'up' | 'cancelled' | 'timeout'.
 * delays: optional array (tests); else backoffMs. Total waiting is bounded by maxMs of scheduled sleep.
 */
export async function waitForServer({ health, signal, delays = null, maxMs = MAX_WAIT_MS }) {
  let waited = 0;
  for (let i = 0; ; i++) {
    if (signal?.aborted) return 'cancelled';
    const d = delays ? delays[Math.min(i, delays.length - 1)] : backoffMs(i);
    if (waited >= maxMs || (delays && i >= delays.length * 4)) return 'timeout';
    await sleepFor(d, signal);
    waited += d;
    if (signal?.aborted) return 'cancelled';
    let r = null;
    try { r = await health(3000); } catch { r = null; }
    if (r?.ok) return 'up';
  }
}

/**
 * QUOXON-FW4: a stream that died mid-turn ("terminated" is undici's wording) gets a cause and a way
 * forward instead of a bare word. Returns null when the error is not a transport/timeout failure.
 */
export function explainTermination(e) {
  if (!e || e.status) return null;
  const msg = String(e.message || '');
  const code = String(e.cause?.code || e.code || '');
  if (e.name === 'TimeoutError' || /timed? ?out|ETIMEDOUT|UND_ERR_(HEADERS|BODY)_TIMEOUT/i.test(`${msg} ${code}`)) return `The turn timed out before the server finished.`;
  if (/^terminated$/i.test(msg.trim()) || /ECONNRESET|UND_ERR_SOCKET|other side closed|premature close|aborted/i.test(`${msg} ${code}`)) {
    return `The connection to the server was cut mid-turn (likely a server restart, proxy timeout or provider error).`;
  }
  return null;
}

/** The second line after a cut turn: the message is kept, and what to do next. */
export const RETRY_HINT = 'Your message is kept: press Up to recall it, then Enter to resend. Anything it started may or may not have finished; check before repeating it.';
