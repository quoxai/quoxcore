/**
 * hostAuthContext - the host-side snapshot of who is acting, for non-React callers.
 *
 * The plugin frame mediator (pluginFrameHost.createHostMediator) needs the current
 * user id, org id, role and tier OUTSIDE a React tree. The real sources are
 * AuthContext (user) and WorkspaceContext (current org + membership role). WorkspaceContext
 * publishes into this module whenever they change. Nothing here is ever readable by, or
 * settable from, a plugin: the frame is an opaque origin and only the host RPC mediator
 * reads this. NEVER store tokens or credentials here.
 *
 * (Replaces the dead `quox-auth-state` localStorage key, which nothing wrote: #770.)
 */

let snapshot = { userId: null, orgId: null, role: 'viewer', tier: 'free' };

export function setHostAuthContext({ userId, orgId, role, tier } = {}) {
    snapshot = {
        userId: userId || null,
        orgId: orgId || null,
        role: role || 'viewer',
        tier: tier || 'free',
    };
}

export function clearHostAuthContext() {
    setHostAuthContext({});
}

export function getHostAuthContext() {
    return { ...snapshot };
}
