'use strict';

/**
 * AGH-CHAIN-5: Federated honesty stats aggregator.
 *
 * Computes integer-only, cross-install honesty counts bucketed by category.
 * NO agent IDs, NO org IDs, NO envelopes, NO conversation IDs in output.
 *
 * Opt-in: AGH_CHAIN_FEDERATE_STATS env flag must be 'true'.
 * k-anonymity floor: if any category count < 5, Laplace noise (scale=1)
 * is applied to ALL counts so individual customers aren't identifiable.
 */

const WINDOW_MS = {
  '24h': 24 * 3600e3,
  '7d':  7  * 24 * 3600e3,
  '30d': 30 * 24 * 3600e3,
};

const VALID_WINDOWS = Object.keys(WINDOW_MS);

/**
 * Apply Laplace noise (scale=1) to all count fields when k-anonymity floor is breached.
 * @param {object} counts
 * @returns {object}
 */
function applyKAnonymity(counts) {
  // Flatten all category counts (response + chain)
  const flat = [
    ...Object.values(counts.response_contract_fires),
    ...Object.values(counts.chain_verification_fires),
  ];
  const minCount = Math.min(...flat);
  if (minCount >= 5) return { ...counts, k_anon_applied: false };

  // Apply Laplace noise (scale=1) to ALL counts, then floor at 0
  const laplaceNoise = () => {
    const u = Math.random() - 0.5;
    return Math.round(-Math.sign(u) * Math.log(1 - 2 * Math.abs(u)));
  };
  const noiseField = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = Math.max(0, v + laplaceNoise());
    }
    return out;
  };
  const noised = {
    ...counts,
    response_contract_fires: noiseField(counts.response_contract_fires),
    chain_verification_fires: noiseField(counts.chain_verification_fires),
    k_anon_applied: true,
  };
  // Recompute total_fires from noised values
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  noised.total_fires = sum(noised.response_contract_fires) + sum(noised.chain_verification_fires);
  return noised;
}

/**
 * createFederatedStatsAggregator({ voltDb })
 *
 * Returns an object with:
 *   computeStats(window) → stats payload
 */
function createFederatedStatsAggregator({ voltDb }) {
  /**
   * computeStats(window)
   * window ∈ '24h' | '7d' | '30d'
   *
   * Returns:
   * {
   *   response_contract_fires: { phantom_email_claims, phantom_task_claims,
   *     phantom_workflow_claims, phantom_subagent_claims, phantom_hitl_claims,
   *     phantom_crystal_claims },
   *   chain_verification_fires: { phantom_past_action, phantom_cross_agent, phantom_cross_org },
   *   total_fires: int,
   *   window: string,
   *   k_anon_applied: boolean,
   *   schema_version: 'agh-chain-stats-v1'
   * }
   */
  function computeStats(window) {
    if (!VALID_WINDOWS.includes(window)) {
      throw new Error(`Invalid window: ${window}. Must be one of ${VALID_WINDOWS.join(', ')}`);
    }

    const windowMs = WINDOW_MS[window];
    const sinceTs = Date.now() - windowMs;
    const sinceIso = new Date(sinceTs).toISOString();

    const rcFires = {
      phantom_email_claims:     0,
      phantom_task_claims:      0,
      phantom_workflow_claims:  0,
      phantom_subagent_claims:  0,
      phantom_hitl_claims:      0,
      phantom_crystal_claims:   0,
    };

    const cvFires = {
      phantom_past_action:  0,
      phantom_cross_agent:  0,
      phantom_cross_org:    0,
    };

    // Single SELECT — no agent or org grouping (intentionally cross-install aggregate)
    const rows = voltDb.prepare(`
      SELECT event_type, data, ts
      FROM volt_events
      WHERE ts >= ?
        AND event_type IN ('response_contract_applied', 'chain_verification_applied')
    `).all(sinceIso);

    for (const row of rows) {
      let data;
      try {
        data = JSON.parse(row.data || '{}');
      } catch {
        // Malformed row — skip; don't crash
        continue;
      }

      if (row.event_type === 'response_contract_applied') {
        // Look for claims_stripped array under response_contract.verify_claimed_actions
        const claimsStripped = data?.response_contract?.verify_claimed_actions?.claims_stripped;
        if (Array.isArray(claimsStripped)) {
          for (const label of claimsStripped) {
            switch (label) {
              case 'email':
                rcFires.phantom_email_claims++;
                break;
              case 'task':
                rcFires.phantom_task_claims++;
                break;
              case 'workflow':
                rcFires.phantom_workflow_claims++;
                break;
              case 'subagent':
                rcFires.phantom_subagent_claims++;
                break;
              case 'hitl':
              case 'hitl_routed_to_sentinel_instead':
                rcFires.phantom_hitl_claims++;
                break;
              case 'crystal':
                rcFires.phantom_crystal_claims++;
                break;
              // Unknown labels are silently ignored
            }
          }
        }
      } else if (row.event_type === 'chain_verification_applied') {
        const cv = data?.chain_verification;
        if (cv) {
          if (cv.verify_promise_kept?.applied === true) {
            cvFires.phantom_past_action++;
          }
          if (cv.verify_cross_agent_claim?.applied === true) {
            cvFires.phantom_cross_agent++;
          }
          if (cv.verify_cross_org_claim?.applied === true) {
            cvFires.phantom_cross_org++;
          }
        }
      }
    }

    const sumObj = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    const rawTotalFires = sumObj(rcFires) + sumObj(cvFires);

    const rawCounts = {
      response_contract_fires: rcFires,
      chain_verification_fires: cvFires,
      total_fires: rawTotalFires,
      window,
      k_anon_applied: false,
      schema_version: 'agh-chain-stats-v1',
    };

    return applyKAnonymity(rawCounts);
  }

  return { computeStats };
}

module.exports = { createFederatedStatsAggregator };
