/**
 * #957: the one call every Browser-Q tool makes to ScreenCap /execute.
 *
 * ScreenCap needs 46-56 s to load a real page (quox.ai, 2026-10-15), so the old per-tool 30 s
 * abort failed every read, and each tool's bare catch reported the abort as "service unavailable"
 * while ScreenCap was up and finishing the job. Each failure now says what actually happened.
 */

'use strict';

const SCREENCAP_TIMEOUT_MS = 90000;
// quox#1090: ScreenCap runs Lighthouse in its own Chrome with a 120 s hard timeout, so the collector
// waits past that (to get the honest timeout or result back), and stays inside Browser-Q's 180 s wait.
const LIGHTHOUSE_TIMEOUT_MS = 150000;
// t2-browser-pdf (2026-10-19): a long page's PDF is real render work; ScreenCap gives page.pdf 110 s, so the collector
// waits past that (to get the honest timeout or the file back), and stays inside Browser-Q's 180 s wait.
const PDF_TIMEOUT_MS = 125000;
const toolTimeoutMs = (toolId) => (toolId === 'browser_lighthouse' ? LIGHTHOUSE_TIMEOUT_MS
  : toolId === 'browser_pdf' ? PDF_TIMEOUT_MS : SCREENCAP_TIMEOUT_MS);

async function screencapExecute(toolId, input, { timeoutMs = toolTimeoutMs(toolId) } = {}) {
  const screencapUrl = process.env.SCREENCAP_URL || 'http://screencap:3300';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  let resp;
  try {
    resp = await fetch(`${screencapUrl}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
      body: JSON.stringify({ tool_id: toolId, input, agent_id: 'browser-q' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { success: false, error_code: 'screencap_timeout', error: `ScreenCap took longer than ${Math.round(timeoutMs / 1000)} s for ${toolId}, so this call stopped waiting. ScreenCap may still finish it; nothing was confirmed.` };
    }
    return { success: false, error_code: 'screencap_unavailable', error: `ScreenCap service unavailable for ${toolId}: ${(err && err.cause && err.cause.code) || (err && err.message) || 'request failed'}` };
  }
  if (!resp.ok) return { success: false, error_code: 'screencap_http_error', error: `ScreenCap returned HTTP ${resp.status} for ${toolId}` };
  const data = await resp.json();
  return withoutImageBytes(data.result || data);
}

// quox#1034: this is the one path every Browser-Q tool result takes to a model, on every provider.
// ScreenCap stores images and returns a reference; if bytes ever arrive here anyway (an older
// ScreenCap, a new tool), they are dropped, never passed to the model, and the result is bounded.
const MAX_BROWSER_RESULT_CHARS = 16000;
const MAX_FIELD_CHARS = 6000;
function withoutImageBytes(result) {
  if (!result || typeof result !== 'object' || !('screenshot_base64' in result)) return result;
  // eslint-disable-next-line no-unused-vars
  const { screenshot_base64: _b, screenshot_media_type: _m, ...rest } = result;
  const out = { ...rest, screenshot_summary: rest.screenshot_summary || 'A screenshot was taken; its image bytes were not passed to the model. Call browser_screenshot for a stored copy.' };
  if (JSON.stringify(out).length > MAX_BROWSER_RESULT_CHARS) {
    const cut = [];
    for (const [k, v] of Object.entries(out)) {
      if (typeof v === 'string' && v.length > MAX_FIELD_CHARS) { out[k] = `${v.slice(0, MAX_FIELD_CHARS)}… [cut: ${v.length} chars]`; cut.push(k); }
    }
    if (cut.length) out.truncated_fields = cut;
  }
  return out;
}

module.exports = { screencapExecute, SCREENCAP_TIMEOUT_MS, LIGHTHOUSE_TIMEOUT_MS, PDF_TIMEOUT_MS, toolTimeoutMs, MAX_BROWSER_RESULT_CHARS, withoutImageBytes };
