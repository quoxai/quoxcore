/**
 * /feedback: tell the Quox team something, through the public quox.ai feedback API
 * (POST https://api.quox.ai/api/feedback, anonymous, 5 per hour per IP; lands in the quox.ai admin feedback view).
 * /gripe stays the GitHub path. What is sent is type + message (the CLI version is appended to the message)
 * and nothing else: no name, email, org, profile or token. The user sees the exact payload and says y first.
 */
export const FEEDBACK_URL = 'https://api.quox.ai/api/feedback';
const MIN = 5, MAX = 5000; // the endpoint refuses outside these (api/routes/feedback.js in quox-website)
const TIMEOUT_MS = 15000;

/** -> { type:'feedback', message } | null when the endpoint would refuse it. */
export function feedbackPayload(text, version) {
  const body = String(text || '').trim();
  if (body.length < MIN) return null;
  const message = `${body}\n\n(sent with /feedback from quox CLI ${version || 'unknown'})`;
  if (message.length > MAX) return null;
  return { type: 'feedback', message };
}

/** The lines shown before asking: where it goes and exactly what is in the body. */
export function feedbackPreview(payload, url = FEEDBACK_URL) {
  return [
    `POST ${url}  (the Quox team at quox.ai, not your Quox server)`,
    'type: feedback',
    'message:',
    ...String(payload.message).split('\n').map(l => `  ${l}`),
    'Nothing else: no name, email, org or token.',
  ];
}

/** -> { ok:true, id, url } | { ok:false, message }. Status is checked before the body is trusted. */
export async function sendFeedback(payload, { fetchImpl = globalThis.fetch, url = FEEDBACK_URL, version = null, timeoutMs = TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': `quox-cli/${version || 'unknown'}` },
      body: JSON.stringify({ type: payload.type, message: payload.message }),
      signal: ctl.signal,
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}: ${(data && data.error) || 'the feedback API refused it'}` };
    if (!data || data.success !== true) return { ok: false, message: `HTTP ${res.status} but the reply did not confirm it was stored` };
    return { ok: true, id: data.id ?? null, url };
  } catch (e) {
    return { ok: false, message: e?.name === 'AbortError' ? `no answer from ${url} within ${Math.round(timeoutMs / 1000)} s` : (e?.message || 'failed') };
  } finally { clearTimeout(t); }
}
