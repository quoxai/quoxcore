/**
 * ET-6D.3 — guest invite flow state machine.
 *
 * Pure helpers used by GuestInvitePage + GuestLandingView. Broken out
 * so the component stays thin and the state transitions can be
 * unit-tested without rendering React.
 */

export const GUEST_FLOW_STATES = ['need_login', 'accepting', 'accepted', 'error'];

export function resolveGuestFlowState({ user, token, acceptResult, error } = {}) {
    if (error)             return 'error';
    if (!token)            return 'error';
    if (!user)             return 'need_login';
    if (acceptResult?.user_id && acceptResult?.target_scope_id) return 'accepted';
    return 'accepting';
}

export function buildLoginReturnUrl(token) {
    if (!token) return '/login';
    return `/login?return_to=${encodeURIComponent(`/invite/guest/${token}`)}`;
}
