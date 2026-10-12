/**
 * docsRepobrainProxy.js — DEVSUITE-DOCS Phase 2, search proxy to the real
 * RepoBrain HTTP service.
 *
 * No parallel search index here — this proxies to RepoBrain the same way
 * `/opt/quoxcore/bin/repobrain`'s `query` verb does, re-implemented against
 * Node's `fetch` (not by shelling out to the bash script). Base-URL
 * resolution mirrors that script's `resolve_api()` exactly: an explicit
 * `REPOBRAIN_API` env override wins outright; otherwise the two real
 * endpoints (the v2 host, then the local container) are health-probed in
 * order with a 1s timeout against `${base}/targets`, and the first one that
 * answers OK wins. If neither answers, the historical default
 * (http://192.0.2.127/api) is returned anyway so the caller's error names
 * a real endpoint, same as the bash script's fallback.
 *
 * The query call itself mirrors the script's non-cross-repo branch exactly:
 * `POST ${base}/targets/${target}/query` with body
 * `{ question, max_snippets }`. RepoBrain's real response JSON is returned
 * as-is (`{ snippets: [...], notes: [...] }` per the bash script's parser) —
 * never reshaped into an invented contract.
 */

'use strict';

const RESOLVE_TIMEOUT_MS = 1000;
// 20s was shorter than the job. A real query against the quox-dashboard
// target took 25.8s measured on 2026-08-19, so every search aborted at 20s and
// reported "repobrain_unreachable" — blaming the network for a budget problem,
// while RepoBrain answered 200 the whole time.
//
// This is the same shape as the backup stale-marker found the same night
// (30-minute window over a 31-minute job): a timeout tuned to a hope rather
// than to a measurement, and an error message that names the wrong cause.
//
// Raised with real headroom and made overridable, because query time scales
// with index size and will drift. NOT a fix for the 25s itself: a docs search
// that takes half a minute is a poor experience and belongs to RepoBrain
// performance, tracked separately. Working slowly beats failing quickly.
const QUERY_TIMEOUT_MS = Number(process.env.REPOBRAIN_QUERY_TIMEOUT_MS) > 0
  ? Number(process.env.REPOBRAIN_QUERY_TIMEOUT_MS)
  : 60000;
// 2026-08-19: the dev-suite hub's "Search docs via RepoBrain" box was dead.
// Every search returned 502 repobrain_unreachable after a 20s timeout, and the
// message was wrong twice over: RepoBrain was healthy the whole time (200 in
// 166ms from inside the collector), and the failure was configuration, not
// reachability.
//
// TWO causes, both here:
//   1. This module reads REPOBRAIN_API. The collector is configured with
//      REPOBRAIN_URL (docker-compose). Different name, so the override was
//      silently ignored and resolution always fell through to the defaults.
//   2. Both defaults are unreachable FROM THE COLLECTOR CONTAINER.
//      192.0.2.127 is the v2 host (not routable from here), and
//      127.0.0.1:3105 is the container's OWN loopback — RepoBrain runs in a
//      different container, so localhost is the one address guaranteed to be
//      wrong inside Docker.
//
// The service name is now first: http://repobrain:3105/api answers 200 with
// the real target list. The old bases are kept as later fallbacks so a
// non-Docker deployment still resolves.
const DEFAULT_BASES = [
  'http://repobrain:3105/api',
  'http://192.0.2.127/api',
  'http://127.0.0.1:3105/api',
];

// Accept BOTH names. REPOBRAIN_API is this module's historical override;
// REPOBRAIN_URL is what the collector's compose file actually sets. Reading
// only one of them is how a configured value got ignored for weeks.
function envBase(env) {
  const raw = env.REPOBRAIN_API || env.REPOBRAIN_URL;
  if (!raw) return null;
  // REPOBRAIN_URL is set as a bare origin (http://repobrain:3105) while this
  // module's paths are rooted at /api, so normalise rather than 404 on
  // /targets — which is exactly what a bare origin produced when tried.
  const trimmed = raw.replace(/\/+$/, '');
  return /\/api$/.test(trimmed) ? trimmed : `${trimmed}/api`;
}

async function probeBase(base, { fetchImpl }) {
  try {
    const res = await fetchImpl(`${base}/targets`, { signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS) });
    return !!(res && res.ok);
  } catch {
    return false;
  }
}

// Same resolution order as bin/repobrain's resolve_api(): env override,
// then health-probe the v2 host, then the local container. Falls back to
// the historical default (the v2 host) if nothing answered, so a caller
// still gets a real endpoint name in any resulting error.
async function resolveRepobrainBase(deps = {}) {
  const { env = process.env, fetchImpl = fetch, bases = DEFAULT_BASES } = deps;
  const fromEnv = envBase(env);
  if (fromEnv) return fromEnv;
  for (const base of bases) {
    if (await probeBase(base, { fetchImpl })) return base;
  }
  return bases[0];
}

// Mirrors bin/repobrain's `query` verb (single-target branch, no `-x`
// cross-repo list): POST ${base}/targets/${target}/query with
// { question, max_snippets }.
async function queryRepobrain({ question, target = 'quox-dashboard', maxSnippets = 5 }, deps = {}) {
  const { fetchImpl = fetch } = deps;
  const base = await resolveRepobrainBase(deps);
  const url = `${base}/targets/${encodeURIComponent(target)}/query`;

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, max_snippets: maxSnippets }),
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  return { status: res.status, ok: res.ok, body, base };
}

function createDocsSearchHandler(deps = {}) {
  return async function docsSearchHandler(req, res) {
    const q = req.query && req.query.q;
    const repo = (req.query && req.query.repo) || 'quox-dashboard';

    if (!q || typeof q !== 'string') {
      return res.status(400).json({ error: 'missing_query', detail: 'q is required' });
    }

    try {
      const result = await queryRepobrain({ question: q, target: repo }, deps);
      if (!result.ok || !result.body) {
        return res.status(502).json({ error: 'repobrain_query_failed', status: result.status, base: result.base });
      }
      // Real RepoBrain response shape passed through as-is, not reshaped.
      return res.json(result.body);
    } catch (err) {
      return res.status(502).json({ error: 'repobrain_unreachable', detail: err.message });
    }
  };
}

module.exports = {
  resolveRepobrainBase,
  queryRepobrain,
  createDocsSearchHandler,
};
