/**
 * Twitter/X Connector
 *
 * P1 scope: read-only credential verification only (verify_credentials).
 *
 * X-PLUGIN P4 (2026-09-11) adds four more read-only tools: get_tweet,
 * get_user_tweets, search_recent, get_mentions. Every one of these calls a
 * pay-per-use X API endpoint (roughly $0.005/read at time of writing — X has
 * no free-tier read allowance the way it does for a limited number of
 * posts), so each call is checked against and recorded on the durable,
 * org-scoped read-budget ledger in xPostingStore.js (CONFIG.dailyReadLimit,
 * default 200/day) via checkAndRecordRead() before the X API is ever called.
 * A refused read never reaches the network and never consumes budget.
 *
 * Write tools deliberately absent here too: outbound posting is natively
 * registered behind withApprovalGate (X-PLUGIN P2, lib/xTools.js); the
 * connector bridge has no approval gate. A posting tool defined here would be
 * an ungoverned side door around that gate.
 *
 * CRITICAL OAuth1 signing detail for these GET reads: every query parameter
 * MUST be part of the OAuth 1.0a signature base (RFC 5849 §3.4.1.3) or X
 * returns 401 on an otherwise-correctly-signed request. buildOAuth1Header's
 * `params` input exists for exactly this. twitterFetch() below builds the
 * request URL's query string from the SAME params object it hands to
 * buildOAuth1Header, so the values that get signed and the values that get
 * sent over the wire are always identical — see oauth1.js's own params-merge
 * logic and test/oauth1ParamsSigning.test.js for the signer-level proof.
 *
 * Requires: api_key, api_secret, access_token, access_secret (OAuth 1.0a
 * User Context — see oauth1.js for the signer).
 *
 * API docs: https://docs.x.com/x-api/introduction
 */

const { buildOAuth1Header } = require('../oauth1.js');
const xPostingStore = require('../../xPostingStore.js');

const TWITTER_API = 'https://api.x.com/2';
const MAX_RESULTS_CAP = 20;
const DEFAULT_MAX_RESULTS = 10;

// X-PLUGIN P4: the read-budget ledger lives on the SAME db handle xTools.js
// already wires at collector boot (server.js's existing `xTools.setDatabase
// (voltDb)` call — unchanged, P2). Reusing xTools.getDatabase() here avoids
// adding a second, redundant db-wiring call site in server.js for this one
// connector module; it is a read-only accessor (no xTools write path is
// invoked from here). If db isn't wired yet (boot ordering), budget
// enforcement degrades to "allow, log a warning" — the same fail-open
// posture x_post/x_thread already use when getDatabase() returns null.
function getSharedDatabase() {
  try {
    return require('../../xTools.js').getDatabase();
  } catch {
    return null;
  }
}

async function twitterFetch(path, credentials, options = {}) {
  const { method = 'GET', params = null } = options;
  let url = path.startsWith('http') ? path : `${TWITTER_API}${path}`;

  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams();
    for (const key of Object.keys(params)) {
      if (params[key] === undefined || params[key] === null) continue;
      qs.set(key, String(params[key]));
    }
    const qsString = qs.toString();
    if (qsString) url += (url.includes('?') ? '&' : '?') + qsString;
  }

  const authHeader = buildOAuth1Header(
    { method, url, params: params || {} },
    {
      apiKey: credentials.api_key,
      apiSecret: credentials.api_secret,
      accessToken: credentials.access_token,
      accessSecret: credentials.access_secret,
    }
  );

  const resp = await fetch(url, {
    ...options,
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    if (resp.status === 401) {
      throw new Error(`Twitter/X API 401: Access token expired or invalid. Re-authenticate via vault.`);
    }
    if (resp.status === 429) {
      throw new Error(`Twitter/X API 429: Rate limit exceeded. Try again later.`);
    }
    throw new Error(`Twitter/X API ${resp.status}: ${body.slice(0, 300)}`);
  }

  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

/** X-PLUGIN P4: check-and-record the org's daily read budget before making a
 * paid X API call. Throws (same error-surfacing convention verify_credentials
 * already uses) when the budget is exhausted — the caller never reaches
 * twitterFetch in that case. No-ops (fail-open, with a warning) when no db is
 * wired yet or ctx carries no orgId — mirrors x_post's `db ? ... : null`
 * fail-open posture in xTools.js rather than hard-blocking every read tool on
 * a boot-ordering gap. */
function chargeRead(ctx, toolName) {
  const db = getSharedDatabase();
  const orgId = ctx && ctx.orgId ? ctx.orgId : null;
  if (!db) return;
  if (!orgId) {
    console.warn(`[twitter connector] ${toolName}: no orgId in call context — read budget not enforced for this call`);
    return;
  }
  const result = xPostingStore.checkAndRecordRead(db, orgId, { tool: toolName });
  if (!result.ok) throw new Error(result.error);
}

/** Resolve the authenticated user's own numeric id via /users/me. Used
 * internally by get_user_tweets (when no user_id is given) and get_mentions
 * (X's mentions endpoint is keyed by user id, not username). This is a
 * SEPARATE X API call from the tool's own read, but is not separately
 * budget-charged — the budget models "one agent-visible read tool call",
 * not raw HTTP requests. */
async function resolveOwnUserId(creds) {
  const result = await twitterFetch('/users/me', creds, { params: { 'user.fields': 'id' } });
  const id = result?.data?.id;
  if (!id) throw new Error('Twitter/X did not return an authenticated user id');
  return id;
}

function validateMaxResults(maxResults) {
  if (maxResults === undefined || maxResults === null) return DEFAULT_MAX_RESULTS;
  const n = Number(maxResults);
  if (!Number.isInteger(n) || n < 1 || n > MAX_RESULTS_CAP) {
    throw new Error(`max_results must be an integer between 1 and ${MAX_RESULTS_CAP} (got ${maxResults})`);
  }
  return n;
}

/* X enforces per-endpoint MINIMUMS on max_results (search/recent: 10, user
 * timeline: 5) and 400s below them — found live 2026-09-12 when a
 * max_results:5 search came back "value [5] is not between 10 and 100". The
 * tool contract stays 1-20: widen the API request to the endpoint's minimum
 * and slice the response back down to what the caller asked for. One read is
 * charged either way, so the caller's cost is unchanged. */
function apiWindow(capped, apiMinimum) {
  return Math.max(capped, apiMinimum);
}

/** Maps a v2 tweets-search-style response's `includes.users` array into an
 * id -> username lookup, so mention/tweet objects can carry a human-readable
 * author_username instead of a bare author_id. Never throws on a missing/
 * malformed includes block — degrades to an empty map. */
function buildUserLookup(result) {
  const users = result?.includes?.users;
  const map = {};
  if (Array.isArray(users)) {
    for (const u of users) if (u && u.id) map[u.id] = u.username;
  }
  return map;
}

function getTools(credentials) {
  return [
    {
      name: 'verify_credentials',
      description: 'Verify the connected Twitter/X credentials and return the authenticated account (id, username, name).',
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async (input, creds, context = {}) => {
        const result = await twitterFetch('/users/me?user.fields=username,name,id', creds);
        const user = result?.data;

        if (!user?.id) {
          throw new Error('Twitter/X did not return an authenticated user');
        }

        // X-PLUGIN UI: this is the ONLY place the org's own handle is ever
        // learnt, and learning it costs a real X API request. Cache it
        // server-side so the dashboard can render "Connected as @handle"
        // for free, from any browser, instead of re-buying it on mount.
        // Best-effort: a cache write must never fail a good verify.
        try {
          const db = getSharedDatabase();
          if (db && context.orgId) {
            xPostingStore.saveAccountIdentity(db, {
              orgId: context.orgId,
              userId: user.id,
              username: user.username,
              name: user.name,
            });
          }
        } catch (err) {
          console.warn('[twitter] could not cache account identity:', err.message);
        }

        return {
          id: user.id,
          username: user.username,
          name: user.name,
        };
      },
    },
    {
      name: 'get_tweet',
      description: 'Read a single X (Twitter) post by id, including public metrics (likes/retweets/replies) and creation time. Reads cost pay-per-use credits on X\'s API (roughly $0.005 each) — do not loop this casually; a single lookup answers "what does this post say / how is it performing".',
      input_schema: {
        type: 'object',
        properties: {
          tweet_id: { type: 'string', description: 'The id of the tweet to read' },
        },
        required: ['tweet_id'],
      },
      execute: async ({ tweet_id } = {}, creds, ctx = {}) => {
        if (!tweet_id || typeof tweet_id !== 'string') {
          throw new Error('tweet_id is required and must be a string');
        }
        chargeRead(ctx, 'get_tweet');
        const result = await twitterFetch(`/tweets/${encodeURIComponent(tweet_id)}`, creds, {
          params: { 'tweet.fields': 'public_metrics,created_at' },
        });
        const tweet = result?.data;
        if (!tweet?.id) throw new Error(`Twitter/X did not return a tweet for id ${tweet_id}`);
        return {
          id: tweet.id,
          text: tweet.text,
          created_at: tweet.created_at,
          public_metrics: tweet.public_metrics || null,
        };
      },
    },
    {
      name: 'get_user_tweets',
      description: 'Read recent posts from an X (Twitter) user\'s timeline (max 20 per call). Omit user_id to read the CONNECTED account\'s own timeline. Reads cost pay-per-use credits on X\'s API (roughly $0.005 each) — do not loop this casually to build a large history; use a single call with the max_results you actually need.',
      input_schema: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'Optional: id of the user whose timeline to read. Defaults to the connected account.' },
          max_results: { type: 'integer', description: 'Max posts to return, 1-20 (default 10).' },
        },
        required: [],
      },
      execute: async ({ user_id, max_results } = {}, creds, ctx = {}) => {
        const capped = validateMaxResults(max_results);
        chargeRead(ctx, 'get_user_tweets');
        const resolvedUserId = user_id || await resolveOwnUserId(creds);
        const result = await twitterFetch(`/users/${encodeURIComponent(resolvedUserId)}/tweets`, creds, {
          params: { max_results: apiWindow(capped, 5), 'tweet.fields': 'public_metrics,created_at' },
        });
        const tweets = (Array.isArray(result?.data) ? result.data : []).slice(0, capped);
        return {
          user_id: resolvedUserId,
          tweets: tweets.map((t) => ({
            id: t.id,
            text: t.text,
            created_at: t.created_at,
            public_metrics: t.public_metrics || null,
          })),
        };
      },
    },
    {
      name: 'search_recent',
      description: 'Search recent X (Twitter) posts (last ~7 days) matching a query, max 20 results per call. Reads cost pay-per-use credits on X\'s API (roughly $0.005 each) — do not loop this casually across many queries; use X search operators in a single well-formed query where possible.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'X search query (supports X search operators).' },
          max_results: { type: 'integer', description: 'Max posts to return, 1-20 (default 10).' },
        },
        required: ['query'],
      },
      execute: async ({ query, max_results } = {}, creds, ctx = {}) => {
        if (!query || typeof query !== 'string' || !query.trim()) {
          throw new Error('query is required and must be non-empty');
        }
        const capped = validateMaxResults(max_results);
        chargeRead(ctx, 'search_recent');
        const result = await twitterFetch('/tweets/search/recent', creds, {
          params: { query, max_results: apiWindow(capped, 10), 'tweet.fields': 'public_metrics,created_at' },
        });
        const tweets = (Array.isArray(result?.data) ? result.data : []).slice(0, capped);
        return {
          query,
          tweets: tweets.map((t) => ({
            id: t.id,
            text: t.text,
            created_at: t.created_at,
            public_metrics: t.public_metrics || null,
          })),
        };
      },
    },
    {
      name: 'get_mentions',
      description: 'Read recent mentions of the CONNECTED X (Twitter) account, optionally only those newer than since_id. Reads cost pay-per-use credits on X\'s API (roughly $0.005 each) — do not loop this casually; the inbound mention poller already calls this on a schedule for HITL inbox items, so an agent typically only needs this for an on-demand check.',
      input_schema: {
        type: 'object',
        properties: {
          since_id: { type: 'string', description: 'Optional: only return mentions newer than this tweet id.' },
        },
        required: [],
      },
      execute: async ({ since_id } = {}, creds, ctx = {}) => {
        chargeRead(ctx, 'get_mentions');
        const ownUserId = await resolveOwnUserId(creds);
        const result = await twitterFetch(`/users/${encodeURIComponent(ownUserId)}/mentions`, creds, {
          params: {
            ...(since_id ? { since_id } : {}),
            'tweet.fields': 'public_metrics,created_at',
            expansions: 'author_id',
            'user.fields': 'username',
          },
        });
        const userLookup = buildUserLookup(result);
        const mentions = Array.isArray(result?.data) ? result.data : [];
        return {
          user_id: ownUserId,
          mentions: mentions.map((m) => ({
            id: m.id,
            text: m.text,
            created_at: m.created_at,
            author_id: m.author_id || null,
            author_username: m.author_id ? (userLookup[m.author_id] || null) : null,
            public_metrics: m.public_metrics || null,
          })),
          meta: result?.meta || {},
        };
      },
    },
  ];
}

module.exports = { getTools };
