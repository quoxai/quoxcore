/**
 * QUOXON-STEPUP dashboard client. A human session proves a login, not a person at the keyboard, so the server
 * demands a short-lived step-up token (minted from the user's PIN) to approve agent-raised or high-risk items.
 *
 * stepUpFetch(authFetch, askPin)(url, init) behaves like authFetch, but on 403 `step_up_required` it asks the
 * person for their PIN once (askPin), trades it for a token at POST /api/auth/me/step-up, and retries the same
 * request with `X-Step-Up-Token`. Tokens are cached per org+scope until they expire (10 min), so a bulk action
 * across items asks once. The PIN is passed straight into the request body: never stored, never logged.
 */
export const STEP_UP_HEADER = 'X-Step-Up-Token';

export function createStepUpClient({ authFetch, askPin, settle = () => {}, now = () => Date.now() }) {
    const tokens = new Map();   // `${orgId}|${scope}` -> { token, until }
    const inflight = new Map(); // same key -> Promise<string|null>, so concurrent 403s share one prompt

    const orgOf = (url) => (/\/orgs\/([^/]+)\//.exec(String(url)) || [])[1] || null;
    const live = (key) => { const t = tokens.get(key); if (t && t.until > now()) return t.token; tokens.delete(key); return null; };

    async function mint(orgId, scope, subject, info) {
        const key = `${orgId}|${scope}`;
        if (live(key)) return live(key);
        if (inflight.has(key)) return inflight.get(key);
        const p = (async () => {
            if (info.pinSet === false) { await askPin({ orgId, scope, subject, problem: 'no_pin' }); return null; }
            let attempt = info;
            for (;;) {
                const pin = await askPin({ orgId, scope, subject, ...attempt }); // string | null (cancelled)
                if (pin == null) return null;
                const res = await authFetch('/api/auth/me/step-up', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pin, org_id: orgId || undefined, scopes: [scope] }),
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok && data.step_up_token) {
                    tokens.set(key, { token: data.step_up_token, until: Date.parse(data.expires_at) || now() + 9 * 60 * 1000 });
                    settle({ ok: true });
                    return data.step_up_token;
                }
                if (res.status === 409) { await askPin({ orgId, scope, subject, problem: 'no_pin' }); return null; }
                if (res.status === 423) { await askPin({ orgId, scope, subject, problem: 'locked' }); return null; }
                if (res.status === 403 && data.error === 'step_up_human_only') { await askPin({ orgId, scope, subject, problem: 'agent' }); return null; }
                attempt = { problem: 'wrong', triesLeft: data.tries_left };
            }
        })().finally(() => inflight.delete(key));
        inflight.set(key, p);
        return p;
    }

    return async function stepUpFetch(url, init = {}, { scope = 'approve', subject = null } = {}) {
        const key = `${orgOf(url)}|${scope}`;
        const pre = live(key);
        const withTok = (tok) => ({ ...init, headers: { ...(init.headers || {}), ...(tok ? { [STEP_UP_HEADER]: tok } : {}) } });
        let res = await authFetch(url, withTok(pre));
        if (res?.status !== 403) return res;
        const body = await res.clone().json().catch(() => ({}));
        if (body?.error !== 'step_up_required') return res;
        tokens.delete(key);
        const tok = await mint(orgOf(url), scope, subject, { pinSet: body.pin_set !== false });
        if (!tok) return res; // cancelled or impossible: hand back the original 403
        res = await authFetch(url, withTok(tok));
        return res;
    };
}
