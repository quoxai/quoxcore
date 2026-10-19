/**
 * A failed tool's result_summary can arrive as the tool's raw output: `error: Exit code 1 { "success": false,
 * "error": "Tool x not granted to this agent" }`. The tool line shows the plain message instead; the raw text is kept
 * (rawSummary) and shown at /verbose full.
 */
const UNESCAPE = { n: ' ', t: ' ', r: ' ', '"': '"', '\\': '\\', '/': '/' };

function messageOf(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of ['error', 'message', 'reason', 'detail', 'msg']) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object') { const inner = messageOf(v); if (inner) return inner; }
  }
  return null;
}

/** -> the plain message, or null when the text is not a JSON-bearing error. */
export function plainToolError(summary) {
  const raw = String(summary ?? '').trim();
  const at = raw.indexOf('{');
  if (at < 0) return null;
  const before = raw.slice(0, at).trim();
  if (before && !/^(error:?\s*)?(exit code \d+:?)?\s*$/i.test(before) && !/^(error|failed)\b[^{]{0,40}$/i.test(before)) return null; // prose before the brace is the message itself
  let msg = null;
  try { msg = messageOf(JSON.parse(raw.slice(at))); } catch { /* truncated JSON: read the field by hand */ }
  if (!msg) {
    const m = /"(?:error|message|reason|detail|msg)"\s*:\s*"((?:[^"\\]|\\.)*)"?/.exec(raw.slice(at));
    if (m) msg = m[1].replace(/\\(.)/g, (_, c) => UNESCAPE[c] ?? c).trim();
  }
  if (!msg) return null;
  msg = msg.replace(/^Tool\s+[\w.:-]+\s+(?:is\s+|was\s+)?/i, '').replace(/^Error:\s*/i, '').trim();
  return msg || null;
}

/** The text the tool line shows: `error: <plain message>` for a JSON error, else the summary untouched; raw at verbose full. */
export function toolResultText(summary, verbose = 'on') {
  if (summary == null || verbose === 'full') return summary;
  const plain = plainToolError(summary);
  return plain ? `error: ${plain}` : summary;
}
