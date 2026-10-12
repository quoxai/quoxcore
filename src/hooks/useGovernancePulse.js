/**
 * useGovernancePulse — real VOLT + WARD counts for the dashboard radial's
 * optional governance ring.
 *
 * Server-authoritative (the collector is the source of truth, per the
 * VoltStatusBadge / WARDStatusBadge pattern). We mirror those badges exactly:
 * poll /collector/volt/stats and /collector/ward/{stats,chains} every 30s,
 * check res.ok BEFORE parsing (an error body is not data), and treat a
 * failed/timed-out probe as UNKNOWN — never as "down". The radial paints
 * unknown/zero as dim grey, never red, so a flaky probe can't fabricate an
 * outage.
 */
import { useEffect, useState } from 'react';

const EMPTY = {
  volt: { status: 'unknown', runs: null, events: null, bundles: null },
  ward: { status: 'unknown', entries: null, chains: null, witness: null },
  loading: true,
};

export default function useGovernancePulse(pollMs = 30000) {
  const [data, setData] = useState(EMPTY);

  useEffect(() => {
    let alive = true;

    const load = async () => {
      // VOLT — { runs, events, bundles }
      let volt = { status: 'unknown', runs: null, events: null, bundles: null };
      try {
        const res = await fetch('/collector/volt/stats', { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const s = await res.json();
          const events = Number(s?.events || 0);
          volt = {
            status: events > 0 ? 'active' : 'quiet',
            runs: Number(s?.runs || 0),
            events,
            bundles: Number(s?.bundles || 0),
          };
        }
      } catch { /* unknown stays unknown */ }

      // WARD — stats { total_entries, witness.total_entries } + chains[]
      let ward = { status: 'unknown', entries: null, chains: null, witness: null };
      try {
        const [statsRes, chainsRes] = await Promise.all([
          fetch('/collector/ward/stats', { signal: AbortSignal.timeout(5000) }),
          fetch('/collector/ward/chains', { signal: AbortSignal.timeout(5000) }),
        ]);
        let entries = null; let witness = null; let chains = null;
        if (statsRes.ok) {
          const s = await statsRes.json();
          entries = Number(s?.stats?.total_entries ?? s?.total_entries ?? 0);
          witness = Number(s?.witness?.total_entries ?? 0);
        }
        if (chainsRes.ok) {
          const c = await chainsRes.json();
          const list = Array.isArray(c) ? c : (c?.chains || []);
          chains = list.length;
        }
        if (entries != null || chains != null) {
          const has = (entries || 0) > 0 || (chains || 0) > 0;
          ward = { status: has ? 'active' : 'quiet', entries, chains, witness };
        }
      } catch { /* unknown stays unknown */ }

      if (alive) setData({ volt, ward, loading: false });
    };

    load();
    const t = setInterval(load, pollMs);
    return () => { alive = false; clearInterval(t); };
  }, [pollMs]);

  return data;
}
