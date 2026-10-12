/**
 * QSKL-12 Slice 3 — quoxflow: per-turn persona fetcher
 *
 * Fetches agent persona content from the collector's
 * GET /api/internal/personas/:agent_id endpoint.
 *
 * Design decisions:
 * - No module-level cache: each call hits the endpoint fresh.
 *   The collector's persona files can be updated at runtime; caching here
 *   would defeat the hot-reload guarantee established in slices 1–2.
 * - 2-second AbortController timeout: prevents a slow/dead collector from
 *   stalling every LLM turn in the executor loop.
 * - Graceful degradation: any fetch error, network error, or non-2xx
 *   response returns null rather than throwing. The caller appends nothing.
 */

const FETCH_TIMEOUT_MS = 2000;

export interface FetchPersonaOptions {
  /** Base URL of the collector service (e.g. http://collector:9848) */
  collectorUrl: string;
  /** Agent ID to fetch persona for (e.g. 'sentinel') */
  agentId: string;
  /**
   * Service key for the collector default-deny auth gate (COLLECTOR-AUTH #52).
   * Sent as `X-Service-Key`. Falls back to `process.env.INTERNAL_SERVICE_KEY`.
   */
  serviceKey?: string;
}

/**
 * Fetch the persona text for an agent from the collector.
 *
 * @returns The persona markdown content, or null if unavailable.
 *   Never throws — all errors are logged and swallowed.
 */
export async function fetchPersona(opts: FetchPersonaOptions): Promise<string | null> {
  const { collectorUrl, agentId } = opts;
  const url = `${collectorUrl}/api/internal/personas/${encodeURIComponent(agentId)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  const serviceKey = opts.serviceKey ?? process.env.INTERNAL_SERVICE_KEY;
  const headers: Record<string, string> = serviceKey ? { 'X-Service-Key': serviceKey } : {};

  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as { agent_id: string; content: string | null };
    return data.content ?? null;
  } catch (err) {
    // Network error, timeout, parse error — degrade gracefully.
    // Log for observability but do not propagate.
    console.error(`[persona-fetcher] failed to fetch persona for ${agentId}:`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
