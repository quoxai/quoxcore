/**
 * ET-1 — usePlan hook.
 *
 * Fetches /api/orgs/:orgId/plan and exposes the effective plan
 * state to any component that needs to render tier-aware UI.
 */

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { fetchPlan } from '../services/planClient';

export function usePlan(orgId) {
    const { authFetch } = useAuth();
    const [plan, setPlan] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const refresh = useCallback(async () => {
        if (!orgId || !authFetch) return;
        setLoading(true);
        setError(null);
        try {
            const data = await fetchPlan(orgId, authFetch);
            setPlan(data);
        } catch (err) {
            setError(err);
        } finally {
            setLoading(false);
        }
    }, [orgId, authFetch]);

    useEffect(() => { refresh(); }, [refresh]);

    return {
        plan:     plan?.plan || 'free',
        planRank: plan?.plan_rank ?? 0,
        isTrial:  plan?.is_trial ?? false,
        expired:  plan?.expired ?? false,
        caps:     plan?.caps || {},
        features: plan?.features || [],
        startedAt: plan?.started_at || null,
        expiresAt: plan?.expires_at || null,
        loading,
        error,
        refresh,
    };
}
