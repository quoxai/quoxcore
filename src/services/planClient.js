/**
 * ET-1 frontend — plan info client.
 *
 * Pure helpers + a thin fetchPlan wrapper over authFetch. Kept
 * framework-free so tests don't need React.
 */

export const PLAN_COLORS = {
    free:       '#38bdf8',   // sky — welcoming default
    starter:    '#a78bfa',   // purple
    team:       '#4ade80',   // green
    enterprise: '#fbbf24',   // amber
};

export const PLAN_LABELS = {
    free:       'Free',
    starter:    'Starter',
    team:       'Team',
    enterprise: 'Enterprise',
};

/**
 * Capitalise a plan name for display. Unknown / missing → "Free".
 */
export function formatPlanName(plan) {
    if (!plan || typeof plan !== 'string') return PLAN_LABELS.free;
    const key = plan.toLowerCase();
    return PLAN_LABELS[key] || PLAN_LABELS.free;
}

/**
 * Check if a features array includes a given key. Safe on null /
 * undefined / non-array input.
 */
export function hasFeature(features, key) {
    if (!Array.isArray(features)) return false;
    return features.includes(key);
}

/**
 * Fetch the effective plan for an org.
 *
 * @param {string} orgId
 * @param {function} authFetch  — app's authFetch from useAuth()
 * @returns {Promise<object | null>}  plan object, or null for 402/404
 * @throws on non-404/402 errors
 */
export async function fetchPlan(orgId, authFetch) {
    if (!orgId) throw new Error('fetchPlan: orgId is required');
    const response = await authFetch(`/api/orgs/${orgId}/plan`);
    if (response.status === 404 || response.status === 402) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`fetchPlan: ${response.status}`);
    }
    return response.json();
}
