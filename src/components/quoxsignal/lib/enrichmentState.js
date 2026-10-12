import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

/**
 * Enrichment produced by the deepen-research step, stored SERVER-SIDE per proposal.
 *
 * This used to live in localStorage as a stated known limitation, because the proposals API
 * had no enrichment field. It now has one (`proposal_enrichments`, quox-signal migration 010),
 * so the exemption is gone: an enrichment is real analysis that cost real money, and the house
 * rule is that anything a customer would expect to survive a browser clear is server-side.
 * A cleared browser, a second device and a colleague's session now all see the same history.
 *
 * APPEND-ONLY end to end. There is no update and no delete route on the server, so re-running
 * deepen-research adds a second entry rather than replacing the first. That is the guarantee
 * the UI already shows the user ("never overwrites the original verdict"), and it is now true
 * at the storage layer rather than only in the copy.
 *
 * Load failures are surfaced rather than swallowed. Enrichment is additive context, so a
 * failed read must not block the proposal from rendering, but silently showing an empty
 * history would be a lie: it reads identically to "this was never enriched".
 */
export function useEnrichments(proposalIds = []) {
  const [byProposal, setByProposal] = useState({});
  const [error, setError] = useState(null);

  /* Same shape as useItemsByIds in ProposalsView: key on the joined ids so the effect reruns
     when the list changes, and fetch only what is missing so switching lanes back and forth
     does not refetch what is already held. Promise.allSettled rather than Promise.all because
     one proposal failing to load its history must not blank out every other proposal's. */
  const key = proposalIds.join(',');
  useEffect(() => {
    let cancelled = false;
    const missing = proposalIds.filter((id) => id && !(id in byProposal));
    if (missing.length === 0) return undefined;
    Promise.allSettled(missing.map((id) => api.listEnrichments(id))).then((results) => {
      if (cancelled) return;
      const failed = results.filter((r) => r.status === 'rejected');
      setError(failed.length ? failed[0].reason?.message || 'could not load enrichments' : null);
      setByProposal((prev) => {
        const next = { ...prev };
        results.forEach((r, i) => {
          /* Re-check against the LATEST state, not the state this effect closed over. An
             append that lands while this fetch is still in flight would otherwise be wiped
             by the slower response, silently losing an enrichment the user just paid for. */
          if (r.status === 'fulfilled' && !(missing[i] in prev)) {
            next[missing[i]] = r.value?.enrichments || [];
          }
        });
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  /* Writes go to the server first and only then into local state: an entry that appears in
     the UI but never persisted is exactly the failure mode this whole change exists to end. */
  const append = useCallback(async (id, entry) => {
    const saved = await api.appendEnrichment(id, {
      kind: entry.kind || 'deepen',
      body: entry.body ?? entry,
      costUsd: entry.cost_usd,
      model: entry.model
    });
    setByProposal((prev) => ({ ...prev, [id]: [...(prev[id] || []), saved] }));
    return saved;
  }, []);

  const forProposal = useCallback((id) => byProposal[id] || [], [byProposal]);

  return { append, forProposal, error };
}
