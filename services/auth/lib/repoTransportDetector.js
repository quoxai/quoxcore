/**
 * POWERS-TEMPLATES-HARDEN Fix 3 — MCP server transport detection.
 *
 * Detects whether a GitHub-hosted MCP server uses HTTP transport (e.g. Uvicorn,
 * FastAPI, Hypercorn) or stdio, BEFORE the user commits to a deploy.
 *
 * Strategy: static file scan via raw.githubusercontent.com.
 * - Primary signal: Dockerfile (most reliable — explicitly declares runtime).
 * - No runtime probing: we don't start the server to detect transport.
 *
 * Returns: { transport: 'stdio'|'http'|'unknown', confidence: 'high'|'medium'|'low', signals: string[] }
 *
 * High-confidence HTTP signals (any one → http/high):
 *   - EXPOSE 8000 / EXPOSE 8080 / EXPOSE 443 in Dockerfile
 *   - CMD or ENTRYPOINT containing: uvicorn, hypercorn, gunicorn, fastapi,
 *     --transport sse, --transport http, --http, serve(transport=
 *
 * Low-confidence: Node CMD with no EXPOSE, no stdio keywords → unknown/low.
 *
 * NOTE: does NOT auto-route — surface the hint and let the user decide.
 * The recommendation field is for wizard UI consumption.
 */

const GITHUB_REPO_RE = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(\.git)?\/?$/;

/**
 * Dockerfile lines that indicate HTTP transport.
 * Checked case-insensitively.
 */
const HTTP_SIGNALS = [
  // Explicit port exposure
  { pattern: /^\s*EXPOSE\s+(8000|8080|8888|9000)\b/im, label: 'EXPOSE http-port', weight: 'high' },
  // HTTP server runtimes
  { pattern: /\buvicorn\b/i, label: 'uvicorn', weight: 'high' },
  { pattern: /\bhypercorn\b/i, label: 'hypercorn', weight: 'high' },
  { pattern: /\bgunicorn\b/i, label: 'gunicorn', weight: 'high' },
  { pattern: /\bfastapi\b/i, label: 'fastapi', weight: 'high' },
  // Explicit transport flags — matches both shell form and JSON array form:
  // shell: --transport sse   JSON: "--transport", "sse"
  { pattern: /--transport[",\s]+(sse|http)\b/i, label: '--transport sse/http', weight: 'high' },
  { pattern: /--http\b/i, label: '--http flag', weight: 'high' },
  // serve(transport= pattern (some Python MCP libs)
  { pattern: /serve\s*\(\s*transport\s*=/i, label: 'serve(transport=', weight: 'high' },
];

/**
 * Fetch raw file from GitHub, returning null on 404 or network error.
 * Always checks response.ok — does NOT silently treat non-2xx as empty.
 *
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function fetchRaw(url) {
  let resp;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    // Network error, DNS failure, timeout
    console.log('[repoTransportDetector] fetch error for %s: %s', url, err.message);
    return null;
  }

  if (!resp.ok) {
    // 404 is normal (file doesn't exist); other errors are worth noting
    if (resp.status !== 404) {
      console.warn('[repoTransportDetector] unexpected status %d for %s', resp.status, url);
    }
    return null;
  }

  try {
    return await resp.text();
  } catch (err) {
    console.warn('[repoTransportDetector] failed to read response body for %s: %s', url, err.message);
    return null;
  }
}

/**
 * Scan a Dockerfile's content for HTTP transport signals.
 *
 * @param {string} content
 * @returns {{ signals: string[], confidence: 'high'|'medium'|'low' }}
 */
function scanDockerfile(content) {
  const signals = [];
  let topWeight = 'low';

  for (const { pattern, label, weight } of HTTP_SIGNALS) {
    if (pattern.test(content)) {
      signals.push(label);
      if (weight === 'high') {
        topWeight = 'high';
      } else if (weight === 'medium' && topWeight === 'low') {
        topWeight = 'medium';
      }
    }
  }

  return { signals, confidence: topWeight };
}

/**
 * Detect transport type for a GitHub MCP server repo.
 *
 * @param {string} repoUrl - e.g. 'https://github.com/cr7258/elasticsearch-mcp-server'
 * @returns {Promise<{
 *   transport: 'stdio'|'http'|'unknown',
 *   confidence: 'high'|'medium'|'low',
 *   signals: string[],
 *   recommendation?: string
 * }>}
 */
export async function detectTransport(repoUrl) {
  const unknown = { transport: 'unknown', confidence: 'low', signals: [] };

  // Only GitHub repos supported for static-file scan
  const match = repoUrl.match(GITHUB_REPO_RE);
  if (!match) {
    return unknown;
  }

  const owner = match[1];
  const repo = match[2];

  // Try Dockerfile at repo root first (most reliable signal source)
  const dockerfileUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/Dockerfile`;
  const dockerfileContent = await fetchRaw(dockerfileUrl);

  if (dockerfileContent) {
    const { signals, confidence } = scanDockerfile(dockerfileContent);

    if (signals.length > 0 && (confidence === 'high' || confidence === 'medium')) {
      return {
        transport: 'http',
        confidence,
        signals,
        recommendation:
          'Use mcp_endpoint deploy flow — this MCP server uses HTTP transport, not stdio. ' +
          'mcp_hosted only supports stdio MCPs.',
      };
    }

    // Dockerfile found but no HTTP signals — likely stdio
    if (signals.length === 0) {
      return { transport: 'unknown', confidence: 'low', signals };
    }
  }

  // No Dockerfile (or fetch failed) → unknown
  return unknown;
}
