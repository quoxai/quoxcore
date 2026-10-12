/**
 * useInstanceConfig — SET-IA Phase 4 shared plumbing.
 *
 * Loads a slice of /api/admin/config and exposes a typed value map
 * plus a save(partialUpdates) action. Each declared key has a `type`
 * that controls parsing on load and serialisation on save:
 *
 *   number   → parseInt; serialise via String(n)
 *   boolean  → 'true'|'1'|true → true; serialise via String(b)
 *   json     → JSON.parse on load; JSON.stringify on save
 *   string   → passthrough
 *
 * Usage:
 *   const cfg = useInstanceConfig([
 *     { key: 'retention.default_days', type: 'number', default: 90 },
 *     { key: 'retention.cleanup_enabled', type: 'boolean', default: true },
 *   ]);
 *   cfg.values['retention.default_days']  // 90
 *   await cfg.save({ 'retention.default_days': 30 });
 */

import { useEffect, useState, useCallback } from 'react';
import { csrfFetch } from '../utils/csrfFetch';

const AUTH_API = '/api';

function parseValue(raw, type, fallback) {
    if (raw === undefined || raw === null) return fallback;
    switch (type) {
        case 'number': {
            const n = Number.parseInt(raw, 10);
            return Number.isFinite(n) ? n : fallback;
        }
        case 'boolean':
            return raw === true || raw === 'true' || raw === 1 || raw === '1';
        case 'json':
            try { return JSON.parse(raw); }
            catch { return fallback; }
        default:
            return raw;
    }
}

function serialiseValue(value, type) {
    switch (type) {
        case 'number':  return String(Number.parseInt(value, 10) || 0);
        case 'boolean': return String(!!value);
        case 'json':    return JSON.stringify(value);
        default:        return String(value ?? '');
    }
}

export function useInstanceConfig(spec) {
    const [values, setValues] = useState(() => {
        const out = {};
        for (const s of spec) out[s.key] = s.default;
        return out;
    });
    const [loading, setLoading] = useState(true);
    const [error, setError]     = useState(null);
    const [savedAt, setSavedAt] = useState(null);
    const [saving, setSaving]   = useState(false);

    useEffect(() => {
        let live = true;
        (async () => {
            try {
                const res = await fetch(`${AUTH_API}/admin/config`, { credentials: 'include' });
                if (!res.ok) throw new Error(`Failed to load config (${res.status})`);
                const { config = [] } = await res.json();
                if (!live) return;
                const lookup = Object.fromEntries(config.map(c => [c.key, c.value]));
                const next = {};
                for (const s of spec) {
                    next[s.key] = parseValue(lookup[s.key], s.type, s.default);
                }
                setValues(next);
                setError(null);
            } catch (err) {
                if (live) setError(err.message);
            } finally {
                if (live) setLoading(false);
            }
        })();
        return () => { live = false; };
    // spec is treated as static — re-running on every render would
    // refetch indefinitely. Callers should provide a stable spec.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const save = useCallback(async (updates) => {
        setSaving(true);
        setError(null);
        setSavedAt(null);
        try {
            const writes = Object.entries(updates).map(([key, value]) => {
                const s = spec.find(x => x.key === key);
                if (!s) throw new Error(`Unknown config key: ${key}`);
                return csrfFetch(`${AUTH_API}/admin/config/${key}`, {
                    method:  'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ value: serialiseValue(value, s.type) }),
                }).then(async (res) => {
                    if (!res.ok) {
                        const data = await res.json().catch(() => ({}));
                        throw new Error(data.message || data.error || `PATCH ${key} failed (${res.status})`);
                    }
                });
            });
            await Promise.all(writes);
            setValues(prev => ({ ...prev, ...updates }));
            setSavedAt(new Date());
        } catch (err) {
            setError(err.message);
            throw err;
        } finally {
            setSaving(false);
        }
    }, [spec]);

    return { values, setValues, loading, error, saving, savedAt, save };
}
