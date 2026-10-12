/**
 * useInstanceAdmin — SET-IA Phase 1.
 *
 * Probes /api/admin/stats once per session to discover whether the
 * current user is an instance admin and at what role tier. Cached
 * in module state so multiple consumers do not refetch.
 *
 * Returns { loading, role, isAdmin, refresh }.
 *   role     — 'superadmin' | 'admin' | 'readonly' | null
 *   isAdmin  — true when role is non-null
 *
 * CLARITY-CONSOLE-7: when the user object (from /api/auth/me) already
 * carries instance_admin_role, that value is used directly and the
 * /api/admin/stats probe is skipped entirely for non-admins.
 * The probe still fires for users whose instance_admin_role is non-null
 * (to pick up the x-instance-admin-role header with the exact tier).
 *
 * Future: when /api/auth/me starts returning instance_admin_role
 * (planned alongside Phase 2), drop this hook and read from useAuth().
 */

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';

const AUTH_API = '/api';

let cache = { loaded: false, role: null };

async function probeInstanceAdmin() {
    try {
        const res = await fetch(`${AUTH_API}/admin/stats`, { credentials: 'include' });
        if (!res.ok) return null;
        // Stats endpoint requires readonly+; presence of an admin header
        // would be authoritative but is not exposed today, so we infer:
        // if /stats works, user is at least readonly.
        const headerRole = res.headers.get('x-instance-admin-role');
        return headerRole || 'readonly';
    } catch {
        return null;
    }
}

export function useInstanceAdmin() {
    const { user, loading: authLoading } = useAuth();

    // CLARITY-CONSOLE-7: if auth is loaded and the user object carries
    // instance_admin_role === null, the server has already confirmed this
    // user is not an instance admin — skip the probe entirely.
    const serverRole = user?.instance_admin_role;
    const authReady = !authLoading && user !== undefined;
    const confirmedNonAdmin = authReady && serverRole === null;

    const [state, setState] = useState(() => {
        if (cache.loaded) return { loading: false, role: cache.role };
        // If we already know from auth context the user isn't an admin,
        // resolve immediately without waiting for the probe.
        if (authReady && confirmedNonAdmin) return { loading: false, role: null };
        return { loading: true, role: null };
    });

    const refresh = useCallback(async () => {
        setState({ loading: true, role: null });
        const role = await probeInstanceAdmin();
        cache = { loaded: true, role };
        setState({ loading: false, role });
    }, []);

    useEffect(() => {
        if (cache.loaded) return;

        // Wait until auth is ready before deciding whether to probe.
        if (!authReady) return;

        // CLARITY-CONSOLE-7: confirmed non-admin — skip the probe.
        if (confirmedNonAdmin) {
            cache = { loaded: true, role: null };
            setState({ loading: false, role: null });
            return;
        }

        // User is either a confirmed instance admin (serverRole non-null)
        // or auth/me doesn't carry instance_admin_role yet (undefined).
        // In both cases, run the probe to get the exact tier.
        refresh();
    }, [authReady, confirmedNonAdmin, refresh]);

    return {
        loading: state.loading,
        role:    state.role,
        isAdmin: !!state.role,
        refresh,
    };
}

// Test helper — resets the module cache so unit tests can re-probe.
export function _resetInstanceAdminCacheForTests() {
    cache = { loaded: false, role: null };
}
