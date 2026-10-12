/**
 * QUOXSOUND-P1.5: macOS/desktop notifications for new inbox items, via the
 * browser Notifications API (tab open but in the background; NOT web push).
 *
 * - Fires only when the tab is hidden or unfocused (a visible, focused tab
 *   already has the toast and chime).
 * - Approvals (kind approval / override_required): "Approval needed", body is
 *   the item title plus the Reason line when the item's approval context can
 *   be fetched within a short timeout; requireInteraction true.
 * - Other kinds only when the user enables "Also notify for other items".
 * - tag = item id, so the OS never shows a duplicate. Dedupe by first-seen
 *   is owned by the shared inbox tracker (quoxSoundInbox).
 * - Independent of the Sound Profile: Silent does not suppress these.
 * - Permission is requested ONLY from a user click (requestDesktopPermission).
 *
 * Settings persist server-side via the `desktopNotify` preferences namespace;
 * localStorage is only the hydrated cache.
 */

import { syncPreferenceToServer } from './userPreferences';
import { HITL_KINDS } from './quoxSoundInbox';

export const DESKTOP_NOTIFY_STORAGE_KEY = 'quox-desktop-notify';
export const DESKTOP_NOTIFY_SERVER_NAMESPACE = 'desktopNotify';
export const DEFAULT_DESKTOP_NOTIFY = Object.freeze({ enabled: false, other: false });
export const CONTEXT_TIMEOUT_MS = 1500;
const ICON = '/logo-quox-icon.png';

export function normalizeDesktopNotify(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return { enabled: src.enabled === true, other: src.other === true };
}

export function getDesktopNotifySettings() {
    try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(DESKTOP_NOTIFY_STORAGE_KEY) : null;
        return normalizeDesktopNotify(raw ? JSON.parse(raw) : null);
    } catch {
        return normalizeDesktopNotify(null);
    }
}

export function saveDesktopNotifySettings(next) {
    const normalized = normalizeDesktopNotify(next);
    try { localStorage.setItem(DESKTOP_NOTIFY_STORAGE_KEY, JSON.stringify(normalized)); } catch { /* quota */ }
    try { syncPreferenceToServer(DESKTOP_NOTIFY_SERVER_NAMESPACE, normalized); } catch { /* best effort */ }
    return normalized;
}

/** 'granted' | 'denied' | 'default' | 'unsupported' */
export function getDesktopPermission() {
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission;
}

/** Must be called from a user click handler. */
export async function requestDesktopPermission() {
    if (typeof Notification === 'undefined') return 'unsupported';
    try {
        const r = await Notification.requestPermission();
        return r || Notification.permission;
    } catch {
        return Notification.permission;
    }
}

export function isPageInBackground() {
    if (typeof document === 'undefined') return false;
    return document.hidden || !document.hasFocus();
}

async function fetchReason(item, authFetch) {
    if (!authFetch || item?.id == null) return null;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), CONTEXT_TIMEOUT_MS);
    try {
        const call = authFetch(`/api/inbox/items/${encodeURIComponent(item.id)}`, ctrl ? { signal: ctrl.signal } : undefined);
        const res = await Promise.race([
            call,
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), CONTEXT_TIMEOUT_MS)),
        ]);
        if (!res || !res.ok) return null;
        const data = await res.json();
        const it = data?.item || data;
        const text = it?.payload?.approval_context?.reason?.text;
        return typeof text === 'string' && text.trim() ? text.trim() : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function openNotification(title, options, onActivate) {
    const n = new Notification(title, options);
    n.onclick = () => {
        try { window.focus(); } catch { /* ignore */ }
        try { onActivate && onActivate(); } catch { /* ignore */ }
        try { n.close(); } catch { /* ignore */ }
    };
    return n;
}

/**
 * Show a desktop notification for a NEW inbox item, if enabled, permitted
 * and the page is in the background. Returns the Notification or null.
 */
export async function notifyInboxItem(item, { authFetch = null, navigate = null, settings = getDesktopNotifySettings() } = {}) {
    try {
        if (!item || typeof item !== 'object') return null;
        const s = normalizeDesktopNotify(settings);
        if (!s.enabled) return null;
        if (getDesktopPermission() !== 'granted') return null;
        if (!isPageInBackground()) return null;
        const isApproval = HITL_KINDS.has(item.kind);
        if (!isApproval && !s.other) return null;

        let body = item.title || (isApproval ? 'An approval is waiting for you' : 'New inbox item');
        if (isApproval) {
            const reason = await fetchReason(item, authFetch);
            if (reason) body = `${body}\nReason: ${reason}`;
            // Focus may have returned while we fetched.
            if (!isPageInBackground()) return null;
        }
        const title = isApproval ? 'Approval needed' : (item.title ? 'Quox notification' : 'Quox');
        return openNotification(
            title,
            {
                body: isApproval ? body : (item.title || body),
                tag: item.id != null ? String(item.id) : undefined,
                requireInteraction: isApproval,
                icon: ICON,
            },
            () => { if (navigate) navigate(item.id != null ? `/inbox/${item.id}` : '/inbox'); },
        );
    } catch {
        return null;
    }
}

export const TEST_SHOW_TIMEOUT_MS = 3000;

export const INSECURE_CONTEXT_MESSAGE = 'Page is not a secure context (self-signed certificate). Notifications need a trusted HTTPS origin or localhost.';
export const NO_SHOW_MESSAGE = 'Blocked by the OS or browser (no show event). On macOS: quit Chrome fully (Cmd+Q) and reopen after enabling it in System Settings > Notifications.';

export function isSecureContextNow() {
    return typeof window !== 'undefined' ? window.isSecureContext === true : false;
}

/** One-line human text for a diagnostic result from sendTestDesktopNotification. */
export function describeDesktopTestResult(r) {
    if (!r) return '';
    if (r.ok) return r.method === 'serviceWorker' ? 'Shown (via service worker)' : 'Shown';
    switch (r.reason) {
        case 'unsupported': return 'Not shown: this browser does not support desktop notifications.';
        case 'permission-not-granted': return `Not shown: permission is ${r.permission}.`;
        case 'insecure-context': return `Not shown: ${INSECURE_CONTEXT_MESSAGE}`;
        case 'no-show-event': return `Not shown: ${NO_SHOW_MESSAGE}`;
        case 'constructor-error': return `Not shown: ${r.error || 'the browser refused to create the notification'}`;
        default: return `Not shown: ${r.error || r.reason || 'unknown reason'}`;
    }
}

async function getServiceWorkerRegistration() {
    try {
        if (typeof navigator === 'undefined' || !navigator.serviceWorker || !navigator.serviceWorker.getRegistration) return null;
        return (await navigator.serviceWorker.getRegistration()) || null;
    } catch {
        return null;
    }
}

/**
 * Settings "Send test": shows regardless of focus. Resolves to a diagnostic
 * object {ok, reason, permission, secureContext, method, shown, error}.
 * `shown` is true only once the Notification 'show' event fired (within
 * timeoutMs). Falls back to ServiceWorkerRegistration.showNotification when
 * the constructor throws or never shows, if the app has a registration.
 */
export async function sendTestDesktopNotification({ navigate = null, timeoutMs = TEST_SHOW_TIMEOUT_MS } = {}) {
    const result = {
        ok: false, reason: null, permission: getDesktopPermission(),
        secureContext: isSecureContextNow(), method: 'constructor', shown: false, error: null,
    };
    if (result.permission === 'unsupported') return { ...result, reason: 'unsupported' };
    if (result.permission !== 'granted') return { ...result, reason: 'permission-not-granted' };

    const options = { body: 'This is a test. Real approvals will look like this.', tag: 'quox-desktop-test', icon: ICON };
    const onActivate = () => { if (navigate) navigate('/inbox'); };

    const viaConstructor = () => new Promise((resolve) => {
        let n;
        let done = false;
        let timer = null;
        const finish = (shown, error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ shown, error });
        };
        try {
            n = openNotification('Approval needed', options, onActivate);
        } catch (e) {
            result.constructorThrew = true;
            finish(false, e?.message || String(e));
            return;
        }
        n.onshow = () => finish(true, null);
        n.onerror = (e) => finish(false, e?.message || 'Notification error event');
        timer = setTimeout(() => finish(false, null), timeoutMs);
    });

    const first = await viaConstructor();
    const threw = result.constructorThrew === true;
    delete result.constructorThrew;
    if (first.shown) return { ...result, ok: true, reason: 'shown', shown: true };

    const failReason = threw ? 'constructor-error' : (result.secureContext ? 'no-show-event' : 'insecure-context');
    const reg = await getServiceWorkerRegistration();
    if (reg && typeof reg.showNotification === 'function') {
        try {
            await reg.showNotification('Approval needed', options);
            return { ...result, ok: true, reason: 'shown', method: 'serviceWorker', shown: true, error: first.error };
        } catch (e) {
            return { ...result, method: 'serviceWorker', reason: failReason, error: e?.message || first.error || String(e) };
        }
    }
    return {
        ...result,
        reason: threw && result.secureContext ? 'constructor-error' : failReason,
        error: first.error,
    };
}
