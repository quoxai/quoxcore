/**
 * MATRIX-P4a — Matrix (Synapse) client bridge.
 *
 * Mints a short-lived Quox-signed JWT via /api/matrix/token (requires an
 * authenticated Quox session — csrfFetch sends the auth cookie), exchanges
 * it at Synapse's `org.matrix.login.jwt` login endpoint, and creates a
 * matrix-js-sdk client scoped to an IN-MEMORY store + access token ONLY.
 *
 * HARD RULE: the Matrix access token must never touch localStorage or
 * IndexedDB. The singleton lives in a module-level variable and is re-minted
 * on every page load — closing the tab discards the session, same as any
 * other in-memory credential in this codebase (ZERO TOLERANCE persistence
 * rule does not apply here in reverse: this is a case where NOT persisting
 * is the requirement).
 *
 * M-ISO: the singleton is keyed by the org id it was minted for. Per-org
 * servers return a distinct identity per (user, org), so an org switch must
 * tear down the live client and log in fresh; legacy servers ignore the
 * org_id and keep returning the shared identity, in which case the re-login
 * is merely a fresh session for the same user (harmless, flag-agnostic).
 */

import { createClient, MemoryStore } from 'matrix-js-sdk';
import { csrfFetch } from '../utils/csrfFetch';
import { getAssistant } from './entityRegistry';

let clientPromise = null;
// Org id the live/in-flight clientPromise was minted for (null = no org
// context supplied, i.e. the legacy shared identity).
let clientOrgId = null;

/**
 * QUOXCHAT-PRO Matrix-less handoff: typed error for deployments with no
 * Matrix stack at all. The token mint route 404s there (nothing is mounted
 * behind /api/matrix), which is a configuration state, not a fault:
 * callers (MatrixCommsView) match on `code` and render a friendly
 * "not configured" empty state instead of a red error banner.
 */
export class MatrixNotConfiguredError extends Error {
    constructor(message) {
        super(message || 'Matrix comms is not configured on this deployment.');
        this.name = 'MatrixNotConfiguredError';
        this.code = 'MATRIX_NOT_CONFIGURED';
    }
}

/**
 * Mint a Matrix SSO JWT for the current Quox session.
 * @param {string|null} orgId - current org id; per-org servers require it
 *   (identity becomes `@human.<userId>.<orgId>`), legacy servers ignore it.
 * @returns {Promise<{jwt: string, server_name: string, base_url: string, matrix_user_id: string, display_name: string|null}>}
 */
async function mintMatrixToken(orgId) {
    const res = await csrfFetch('/api/matrix/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId ?? null })
    });
    if (res.status === 404) {
        throw new MatrixNotConfiguredError();
    }
    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
            `Failed to mint Matrix token (${res.status}): ${body?.message || body?.error || 'unknown error'}`
        );
    }
    return res.json();
}

/**
 * Best-effort: set the Matrix profile displayname to the dashboard user's
 * real name (mint route now forwards `display_name` from the authenticated
 * user's `display_name` DB column). Skipped entirely if the token mint
 * didn't carry a name, or if the profile is already correct — a fresh
 * GET avoids hammering Synapse with a write on every page load. Never
 * throws — a profile-naming hiccup must not break the login flow.
 */
async function syncProfileDisplayName(client, desiredName) {
    if (!desiredName) return;
    try {
        const userId = client.getUserId();
        const profile = await client.getProfileInfo(userId);
        if (profile?.displayname === desiredName) return;
        await client.setDisplayName(desiredName);
    } catch (err) {
        console.warn('[matrixClient] Failed to sync Matrix profile displayname:', err.message || err);
    }
}

/**
 * Best-effort: mirror the dashboard profile photo (users.avatar_url, a
 * same-origin /uploads path forwarded by the token mint) onto the Matrix
 * profile, so the human user's avatar renders in every Rooms surface
 * (people panel, timeline) via the normal member-state path. Skipped when
 * the auth profile has no avatar, or when the Matrix profile already has
 * one (uploading on every page load would hammer the media repo). Never
 * throws: an avatar hiccup must not break the login flow.
 *
 * Root-cause note (M-P5 follow-up, 2026-07-20): the Matrix user the
 * dashboard logs in as (`@human.<ulid>:quox`) is a DIFFERENT account from
 * any bridge double-puppet (e.g. the Telegram puppet that carries the
 * owner's real photo). Nothing ever set an avatar on the dashboard
 * identity, so its rows fell back to the monogram while bridged rows had
 * photos. This sync closes that gap at the source.
 */
async function syncProfileAvatar(client, desiredAvatarUrl) {
    if (!desiredAvatarUrl) return;
    try {
        const userId = client.getUserId();
        const profile = await client.getProfileInfo(userId).catch(() => null);
        if (profile?.avatar_url) return;

        // Same-origin fetch of the dashboard avatar (cookie-authed static
        // /uploads path). Relative URLs resolve against the dashboard origin.
        const res = await fetch(desiredAvatarUrl, { credentials: 'include' });
        if (!res.ok) return;
        const blob = await res.blob();
        if (!blob?.size || !blob.type?.startsWith('image/')) return;

        const upload = await client.uploadContent(blob, {
            type: blob.type,
            name: 'avatar'
        });
        const mxc = upload?.content_uri;
        if (typeof mxc === 'string' && mxc.startsWith('mxc://')) {
            await client.setAvatarUrl(mxc);
        }
    } catch (err) {
        console.warn('[matrixClient] Failed to sync Matrix profile avatar:', err.message || err);
    }
}

/**
 * Exchange the Quox-signed JWT for a Matrix access token via Synapse's
 * org.matrix.login.jwt login flow.
 * @param {string} baseUrl - absolute Matrix base URL (window.location.origin + '/matrix')
 * @param {string} jwtToken
 */
async function loginWithJwt(baseUrl, jwtToken) {
    const res = await fetch(`${baseUrl}/_matrix/client/v3/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            type: 'org.matrix.login.jwt',
            token: jwtToken
        })
    });
    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
            `Matrix login failed (${res.status}): ${body?.error || body?.errcode || 'unknown error'}`
        );
    }
    return res.json();
}

/**
 * Build and start a fresh matrix-js-sdk client. In-memory store + in-memory
 * access token only — nothing is written to localStorage/IndexedDB.
 */
async function initMatrixClient(orgId) {
    const { jwt, matrix_user_id: fallbackUserId, display_name: displayName, avatar_url: avatarUrl } = await mintMatrixToken(orgId);
    const baseUrl = `${window.location.origin}/matrix`;
    const loginResult = await loginWithJwt(baseUrl, jwt);

    const client = createClient({
        baseUrl,
        accessToken: loginResult.access_token,
        userId: loginResult.user_id || fallbackUserId,
        deviceId: loginResult.device_id,
        // No `localStorage` option passed — MemoryStore keeps everything
        // (rooms, sync token, tokens) purely in JS heap memory. Nothing is
        // written to localStorage/IndexedDB.
        store: new MemoryStore()
    });

    // Nice-to-have: keep the Matrix profile displayname in sync with the
    // dashboard user's real name so it never falls back to the raw
    // `human.<ulid>` localpart in member lists / timelines. Fire-and-forget
    // relative to sync start — a slow/failed profile write must not delay
    // the room list coming up.
    syncProfileDisplayName(client, displayName);
    syncProfileAvatar(client, avatarUrl);

    await client.startClient({ initialSyncLimit: 20 });

    return client;
}

/**
 * Get the singleton matrix-js-sdk client, creating + logging in if needed.
 * Safe to call multiple times concurrently — all callers share one in-flight
 * init promise.
 *
 * M-ISO: pass the CURRENT org id. If the live client was minted for a
 * different org, it is torn down and a fresh login runs for the requested
 * org. Callers that pass no org id (null/undefined) reuse whatever client is
 * live, or mint one with no org context (legacy shared identity) if none is.
 * @param {string|null} [orgId] - current org id from the caller's workspace context
 * @returns {Promise<import('matrix-js-sdk').MatrixClient>}
 */
export function getMatrixClient(orgId = null) {
    const requestedOrgId = orgId || null;
    // Org switch: the live (or in-flight) client belongs to another org.
    // Tear it down so the init below logs in as the requested org's identity.
    if (clientPromise && requestedOrgId !== null && clientOrgId !== requestedOrgId) {
        resetMatrixClient();
    }
    if (!clientPromise) {
        clientOrgId = requestedOrgId;
        const promise = initMatrixClient(requestedOrgId).catch((err) => {
            // Allow a retry on the next call rather than caching a rejection
            // forever. Guarded so a late rejection from a superseded init
            // (torn down mid-flight by an org switch) cannot clobber the
            // newer org's promise.
            if (clientPromise === promise) clientPromise = null;
            throw err;
        });
        clientPromise = promise;
    }
    return clientPromise;
}

/**
 * Tear down the current client (e.g. on logout). Next getMatrixClient() call
 * will re-mint a fresh token and log in again.
 */
export function resetMatrixClient() {
    if (clientPromise) {
        clientPromise.then((client) => client.stopClient()).catch(() => {});
    }
    clientPromise = null;
    clientOrgId = null;
    clearAuthedMediaBlobCache();
}

// ── Display-name resolution (M-P5 fix) ──────────────────────────────────────
//
// Single resolver used EVERYWHERE a Matrix sender/member is rendered (people
// panel, timeline sender labels, member chips, room header). Never returns a
// raw MXID/localpart for an agent, and only falls back to a clean synthetic
// label (never a full ULID) for humans/bridged users with no real profile
// displayname set yet.

const AGENT_USER_ID_RE = /^@_quoxagent_(.+):quox$/;

function matrixLocalpart(userId) {
    if (typeof userId !== 'string') return '';
    return userId.replace(/^@/, '').split(':')[0];
}

// matrix-js-sdk falls back to the raw userId (or localpart) for
// `RoomMember.rawDisplayName` / `User.displayName` when no m.room.member /
// profile displayname has ever been set — treat that as "no real name yet".
function looksLikeRawId(name, userId) {
    if (!name) return true;
    return name === userId || name === matrixLocalpart(userId);
}

function titleCaseFromId(str) {
    return String(str || '')
        .replace(/[_.\-]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

/**
 * Resolve a clean, human-facing display name for a Matrix user ID.
 * @param {string} userId - full MXID, e.g. `@_quoxagent_sentinel:quox`
 * @param {Object} [opts]
 * @param {import('matrix-js-sdk').RoomMember|null} [opts.member] - room member object, if available (has `.rawDisplayName`)
 * @param {import('matrix-js-sdk').MatrixClient|null} [opts.client] - matrix client, used to read `client.getUser(userId)?.displayName` as a secondary source
 * @returns {string}
 */
export function resolveDisplayName(userId, { member = null, client = null } = {}) {
    if (!userId) return '';

    // 1. Agents — resolve the persona's branded display name from the
    // entity registry (e.g. sentinel -> "WARDEN"). Never show the raw
    // `_quoxagent_<id>` localpart.
    const agentMatch = userId.match(AGENT_USER_ID_RE);
    if (agentMatch) {
        const rawId = agentMatch[1];
        // Custom assistants puppet as `_quoxagent_a_<ULID>` — the `a_` namespace
        // prefix (matrixProvisioner agentLocalpart). getAssistant() is keyed by
        // the bare id, so the prefix must be stripped before lookup or the
        // persona misses and we fall back to surfacing the raw 26-char ULID.
        const bareId = rawId.startsWith('a_') ? rawId.slice(2) : rawId;
        const assistant = getAssistant(bareId) || getAssistant(rawId);
        const name = assistant?.identity?.name || assistant?.name;
        if (name) return name;
        // Registry miss: prefer the puppet's native Matrix profile displayname
        // (the appservice now names every puppet, M-NAMES) over any synthetic
        // fallback below.
        const profileName = member?.rawDisplayName || member?.name
            || client?.getUser?.(userId)?.displayName;
        if (!looksLikeRawId(profileName, userId)) return profileName;
        // A custom (org-scoped) assistant not yet loaded into the sync registry,
        // or a bare ULID id: never surface the raw ULID. A short branded label
        // beats 26 characters of base32. Deliberately broader than the strict
        // Crockford ULID alphabet: real assistant ids contain L/I/O/U (observed
        // live), and those must not leak through as raw 26-char ids.
        if (/^[0-9a-z]{26}$/i.test(bareId)) return 'Assistant';
        return titleCaseFromId(bareId);
    }

    // 2. Humans / bridged users — prefer a real profile displayname if one
    // has been set (room member state, then the SDK's User model).
    const memberName = member?.rawDisplayName || member?.name;
    if (!looksLikeRawId(memberName, userId)) return memberName;

    const sdkName = client?.getUser?.(userId)?.displayName;
    if (!looksLikeRawId(sdkName, userId)) return sdkName;

    // 3. No real displayname anywhere — clean synthetic fallback, never the
    // raw ULID / bridge-network localpart.
    if (userId.startsWith('@human.')) {
        // M-ISO: human localparts come in two shapes, legacy `human.<userId>`
        // and per-org `human.<userId>.<orgId>`. Segment [1] is the userId in
        // both; any trailing org segment is deliberately ignored here.
        const ulidPart = matrixLocalpart(userId).split('.')[1] || '';
        const shortId = ulidPart.slice(0, 6).toUpperCase();
        return shortId ? `Guest ${shortId}` : 'Guest';
    }
    if (userId.startsWith('@telegram_')) return 'Telegram user';
    if (userId.startsWith('@slack_')) return 'Slack user';

    return titleCaseFromId(matrixLocalpart(userId)) || userId;
}

/**
 * Resolve a real avatar image URL for a Matrix user, companion to
 * `resolveDisplayName`. Returns `null` when no real image is available —
 * callers MUST keep their existing monogram-initials fallback for that case
 * (this function never invents a placeholder image).
 *
 * Fallback chain:
 *   1. Agents (`@_quoxagent_<id>:quox`) — the entity registry's branded
 *      avatar image, `assistant.identity.avatar` (e.g.
 *      `/assets/agents/sentinel.svg`, a static public/ asset). Callers that
 *      already looked up the assistant def (e.g. the People-panel roster,
 *      which matches `allAgents.find(a => a.id === agentId)` for the role
 *      sub-label) can pass it via `opts.entity` to skip a second registry
 *      lookup; otherwise this falls back to `getAssistant(agentId)` itself.
 *      Not every core agent has an image file checked in yet (only a few
 *      `public/assets/agents/*.svg` exist today) — the caller's <img onError>
 *      handler is what actually makes the monogram fallback kick in for
 *      those, not this function.
 *   2. Humans / bridged users (`@human.*`, `@telegram_*`, `@slack_*`) — the
 *      Matrix profile avatar. Prefers the room member's per-room avatar
 *      (`member.getAvatarUrl(client.baseUrl, ...)`, which matrix-js-sdk
 *      already resolves to an http(s) thumbnail URL through `client.baseUrl`
 *      — i.e. the existing `/matrix` reverse-proxy, never Synapse directly),
 *      then falls back to the SDK's global User model
 *      (`client.getUser(userId)?.avatarUrl`, a raw `mxc://` URI that this
 *      function converts via `client.mxcUrlToHttp(...)`). Bridge-set avatars
 *      (Telegram/Slack puppets) land in the same field, so this path covers
 *      them for free.
 *
 *      Synapse v1.156 serves this content over AUTHENTICATED media
 *      (MSC3916) — the legacy `/_matrix/media/v3/thumbnail/...` endpoint
 *      404s, and the authed `/_matrix/client/v1/media/thumbnail/...`
 *      replacement 401s for a bare `<img src>` (no way to attach a Bearer
 *      header to an image request). So this function requests the AUTHED
 *      url from the SDK (`useAuthentication: true`) — callers MUST NOT drop
 *      the result straight into an `<img src>`; they need to fetch it with
 *      the client's access token first (see `resolveAuthedMediaBlobUrl` /
 *      `isAuthedMatrixMediaUrl` below) and render the resulting blob object
 *      URL instead. Agent avatars (case 1, static `/assets/agents/*.svg`)
 *      are unaffected — they're plain dashboard assets, not Matrix media.
 *   3. Org / division / department-scoped assistants → org/div/dept logo —
 *      DEFERRED, not wired up. Reason: `resolveDisplayName`/`resolveAvatar`
 *      resolve agent identity via the synchronous `getAssistant(id)`, which
 *      only reads the CORE `DEFAULT_ASSISTANTS` map (see
 *      `src/services/entityRegistry.js`); org-scoped CUSTOM assistants (the
 *      ones carrying `ownership.orgId` / `divisionId` / `homeScopeId`, from
 *      `normalizeApiAssistantEntity`) only exist behind the ASYNC
 *      `getAssistantsAsync({ orgId, authFetch })` / `loadUserEntities(orgId,
 *      authFetch)` path, keyed by an org the Matrix agent ID alone doesn't
 *      carry (the `@_quoxagent_<id>:quox` MXID has no orgId segment, and
 *      there is no server-side appservice code in this repo that maps one).
 *      The org/division/department logo itself lives on the org entity as
 *      `entity.logo_url` (`src/hooks/useScopeData.js`, backing
 *      `src/components/org/*`, `src/contexts/WorkspaceContext.jsx`'s
 *      `currentOrg`), scoped to whichever org/division/department the
 *      assistant belongs to — NOT necessarily the viewer's `currentOrg`.
 *      Wiring this up needs either (a) an org id embedded in the Matrix
 *      agent identity server-side, or (b) a client-side custom-assistant
 *      lookup keyed off the room/org context, plus a fetch for that specific
 *      org/division/department's `logo_url`. Fast-follow, not built here.
 *
 * @param {string} userId - full MXID
 * @param {Object} [opts]
 * @param {import('matrix-js-sdk').RoomMember|null} [opts.member]
 * @param {import('matrix-js-sdk').MatrixClient|null} [opts.client]
 * @param {Object|null} [opts.entity] - pre-resolved assistant entity (skips a registry lookup for agents)
 * @returns {string|null}
 */
export function resolveAvatar(userId, { member = null, client = null, entity = null } = {}) {
    if (!userId) return null;

    // 1. Agents — branded avatar image from the entity registry.
    const agentMatch = userId.match(AGENT_USER_ID_RE);
    if (agentMatch) {
        const agentId = agentMatch[1];
        const assistant = entity || getAssistant(agentId);
        const avatar = assistant?.identity?.avatar || assistant?.avatar;
        if (typeof avatar === 'string' && (avatar.startsWith('/') || avatar.startsWith('http'))) {
            return avatar;
        }
        return null;
    }

    // 2. Humans / bridged users — Matrix profile avatar (per-room member
    // state first, then the SDK's global User model), converted to an
    // AUTHENTICATED thumbnail URL.
    //
    // Root-cause note (M-P5 follow-up, 2026-07-19): we do NOT use the SDK's
    // own `member.getAvatarUrl(...)` / `client.mxcUrlToHttp(...)` for this —
    // both delegate to `getHttpUriForMxc()`, which builds the URL via
    // `new URL('/_matrix/client/v1/media/...', client.baseUrl)`. Because the
    // path argument starts with `/`, the WHATWG URL parser treats it as
    // origin-relative and silently DISCARDS the rest of `client.baseUrl`'s
    // own path — and our `client.baseUrl` is `${origin}/matrix` (the
    // dashboard's `/matrix` reverse-proxy prefix to Synapse), not a bare
    // origin. Confirmed by direct repro:
    //   getHttpUriForMxc('https://host/matrix', 'mxc://quox/<id>', 64, 64,
    //     'crop', false, undefined, true)
    //   -> 'https://host/_matrix/client/v1/media/thumbnail/quox/<id>?...'
    //   (the `/matrix` segment is gone — this URL never reaches the proxy,
    //   so the image request 404s and the row falls back to the monogram
    //   BEFORE the blob-fetch code even runs, since the resulting string
    //   still matches `isAuthedMatrixMediaUrl()` and fetch()es the wrong
    //   host path). `buildAuthedMediaThumbnailUrl()` below builds the same
    //   URL via plain string concatenation instead, which preserves the
    //   `/matrix` prefix.
    if (!client) return null;

    const memberMxc = member?.getMxcAvatarUrl?.();
    const memberAvatarUrl = buildAuthedMediaThumbnailUrl(client, memberMxc);
    if (memberAvatarUrl) return memberAvatarUrl;

    const rawMxc = client.getUser?.(userId)?.avatarUrl;
    return buildAuthedMediaThumbnailUrl(client, rawMxc);
}

/**
 * Build an authenticated Matrix media thumbnail URL for an `mxc://` URI by
 * string-concatenating onto `client.baseUrl` — NOT via `new URL(path, base)`
 * (see the root-cause note in `resolveAvatar` above: that silently drops any
 * path segment already present in `baseUrl`, e.g. our `/matrix` reverse-proxy
 * prefix). Returns `null` for anything that isn't a well-formed `mxc://`
 * URI or if the client has no `baseUrl`.
 * @param {import('matrix-js-sdk').MatrixClient|null} client
 * @param {string|null} mxc
 * @returns {string|null}
 */
function buildAuthedMediaThumbnailUrl(client, mxc) {
    if (!client?.baseUrl || typeof mxc !== 'string' || !mxc.startsWith('mxc://')) return null;
    const rest = mxc.slice('mxc://'.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx <= 0) return null;
    const serverName = rest.slice(0, slashIdx);
    const mediaId = rest.slice(slashIdx + 1);
    if (!mediaId || mediaId.includes('/')) return null;

    const base = client.baseUrl.replace(/\/+$/, '');
    const params = new URLSearchParams({ width: '64', height: '64', method: 'crop', allow_redirect: 'true' });
    return `${base}/_matrix/client/v1/media/thumbnail/${serverName}/${mediaId}?${params.toString()}`;
}

/**
 * Build an authenticated Matrix media DOWNLOAD URL (full content, not a
 * thumbnail) for an `mxc://` URI. Same string-concatenation approach as
 * `buildAuthedMediaThumbnailUrl` above, and for the same reason: `new
 * URL(path, base)` silently drops the `/matrix` reverse-proxy prefix from
 * `client.baseUrl`. The result matches `isAuthedMatrixMediaUrl()` and must be
 * fetched via `resolveAuthedMediaBlobUrl()` (Bearer token), never dropped
 * into a bare `<img src>` / `<video src>`. Used by the Rooms timeline for
 * inline m.image / m.file / m.video attachments (including media relayed by
 * the Telegram/Slack bridges, which arrives as ordinary mxc URIs).
 * @param {import('matrix-js-sdk').MatrixClient|null} client
 * @param {string|null} mxc
 * @returns {string|null}
 */
export function buildAuthedMediaDownloadUrl(client, mxc) {
    if (!client?.baseUrl || typeof mxc !== 'string' || !mxc.startsWith('mxc://')) return null;
    const rest = mxc.slice('mxc://'.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx <= 0) return null;
    const serverName = rest.slice(0, slashIdx);
    const mediaId = rest.slice(slashIdx + 1);
    if (!mediaId || mediaId.includes('/')) return null;

    const base = client.baseUrl.replace(/\/+$/, '');
    return `${base}/_matrix/client/v1/media/download/${serverName}/${mediaId}`;
}

// ── Authenticated media (M-P5 fix) ──────────────────────────────────────────
//
// Synapse v1.156 requires a Bearer token to fetch avatar thumbnails
// (MSC3916 authenticated media). `resolveAvatar` above returns the
// `/_matrix/client/v1/media/thumbnail/...` URL for human/bridged users, but
// a bare `<img src>` can't attach the Authorization header, so it 401s.
// These helpers fetch that URL with the client's access token and hand back
// a `blob:` object URL an `<img>` CAN render, caching per source URL so a
// sender's avatar is fetched once no matter how many timeline rows / people
// rows render it.

// url (the authed thumbnail URL) -> Promise<string|null> (object URL)
const authedMediaBlobCache = new Map();

/**
 * True when `url` is a Matrix authenticated-media endpoint (as produced by
 * `resolveAvatar` for human/bridged users) that needs a Bearer-token fetch,
 * as opposed to a plain dashboard asset path (agent avatars, e.g.
 * `/assets/agents/sentinel.svg`) which loads fine as a bare `<img src>`.
 * @param {string|null} url
 * @returns {boolean}
 */
export function isAuthedMatrixMediaUrl(url) {
    return typeof url === 'string' && url.includes('/_matrix/client/v1/media/');
}

/**
 * Fetch an authenticated Matrix media URL with the client's Bearer access
 * token and resolve to a local `blob:` object URL. Cached per source URL —
 * repeat calls for the same avatar reuse the one in-flight/completed fetch
 * instead of re-requesting it. Returns `null` on any failure; callers MUST
 * keep their existing monogram fallback for that case.
 * @param {import('matrix-js-sdk').MatrixClient|null} client
 * @param {string} url
 * @returns {Promise<string|null>}
 */
export function resolveAuthedMediaBlobUrl(client, url) {
    if (!client || !url) return Promise.resolve(null);
    if (authedMediaBlobCache.has(url)) return authedMediaBlobCache.get(url);

    const promise = (async () => {
        try {
            const token = client.getAccessToken?.();
            const res = await fetch(url, {
                headers: token ? { Authorization: `Bearer ${token}` } : {}
            });
            if (!res.ok) return null;
            const blob = await res.blob();
            return URL.createObjectURL(blob);
        } catch (err) {
            console.warn('[matrixClient] Failed to fetch authenticated media:', err.message || err);
            return null;
        }
    })();

    authedMediaBlobCache.set(url, promise);
    return promise;
}

/**
 * Revoke every cached avatar blob object URL and clear the cache. Called on
 * `resetMatrixClient()` (logout / access-token invalidation) so blob URLs
 * don't leak past the Matrix session that authorized fetching them.
 */
function clearAuthedMediaBlobCache() {
    for (const promise of authedMediaBlobCache.values()) {
        promise.then((objectUrl) => {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        }).catch(() => {});
    }
    authedMediaBlobCache.clear();
}

export default {
    getMatrixClient,
    resetMatrixClient,
    resolveDisplayName,
    resolveAvatar,
    isAuthedMatrixMediaUrl,
    resolveAuthedMediaBlobUrl,
    buildAuthedMediaDownloadUrl
};
