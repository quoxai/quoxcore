/**
 * AOCL-FULL-4 — L10 audit.writeback.
 *
 * Final layer of the pipeline. Summarises what happened in the run and
 * emits one canonical aocl.layer.L10.complete envelope capturing:
 *   - total envelopes emitted during this run (via aoclCtx.C6 counters)
 *   - layers that ran vs bypassed
 *   - total pipeline duration
 *   - final status (completed / denied / error)
 *
 * L10 is the audit SINK. Upstream layers already emit their own envelopes
 * as they run; L10 just writes the closing stamp so replay / evidence
 * consumers know "this run terminated cleanly" vs "pipeline cut off".
 */

async function runL10(aoclCtx, { pipelineResult } = {}) {
  if (!aoclCtx) return { proceed: true };

  const totalDurationMs = Date.now() - (aoclCtx.startTime || Date.now());
  const layersRun = pipelineResult?.layersRun || [];
  const layersBypassed = pipelineResult?.layersBypassed || [];

  // Stamp audit partition
  aoclCtx.C6.totalEnvelopesEmitted = (aoclCtx.C6.totalEnvelopesEmitted || 0);
  aoclCtx.C6.checkpoints = aoclCtx.C6.checkpoints || [];
  aoclCtx.C6.checkpoints.push({
    layer: 'L10',
    status: aoclCtx.status || 'completed',
    at: new Date().toISOString(),
  });

  return {
    proceed: true,
    extras: {
      total_duration_ms: totalDurationMs,
      layers_run: layersRun,
      layers_bypassed: layersBypassed,
      layer_count: layersRun.length,
      bypass_count: layersBypassed.length,
      status: aoclCtx.status || 'completed',
      denied_at_layer: aoclCtx.deniedAtLayer || null,
      first_denial_reason: aoclCtx.firstDenialReason || null,
      corr: aoclCtx.corr,
    },
  };
}

module.exports = { runL10 };
