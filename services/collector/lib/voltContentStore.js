/**
 * EVD-3/EVD-4: Persistent evidence store helpers.
 *
 * Extracted from server.js (2026-04-12) so the real functions can be
 * integration-tested against in-memory SQLite.
 *
 * persistVoltContent(voltStatements, runId, eventId, eventType, parts)
 *   Builds a content record (hash-only by default; redacted plaintext when
 *   QUOX_CONTENT_CAPTURE_ENABLED=true) and writes it to volt_content.
 *
 * autoBundleOnComplete(ctx, runId, state)
 *   Queries events for a completed run, builds a manifest, signs via the
 *   provided signBundleManifest, gets it COUNTERSIGNED by the Quox Verified
 *   control plane (LL-9i4, fail-soft), writes to volt_bundles, witnesses in
 *   WARD.
 */

const crypto = require('crypto');
const { buildContentRecord } = require('./contentRedactor.js');

/**
 * Persist a hash-only (or redacted-plaintext) content record for a VOLT event.
 * Fire-and-forget — never throws, never blocks the caller.
 *
 * @param {object} voltStatements - must expose insertContent prepared statement
 * @param {string} runId
 * @param {string} eventId
 * @param {string} eventType - e.g. 'model.requested', 'tool.call.executed'
 * @param {object} parts - passed to buildContentRecord (system_prompt, user_message, tool_input, tool_output, etc.)
 * @returns {boolean} true if persisted, false if skipped/failed
 */
function persistVoltContent(voltStatements, runId, eventId, eventType, parts) {
  if (!voltStatements || !voltStatements.insertContent || !runId || !eventId) return false;
  try {
    const record = buildContentRecord(parts || {});
    const payload = JSON.stringify(record);
    const contentHash = crypto.createHash('sha256').update(payload, 'utf-8').digest('hex');
    voltStatements.insertContent.run(eventId, runId, eventType, payload, contentHash, 0);
    return true;
  } catch (err) {
    console.warn('[EVD/volt_content] persist failed (non-fatal):', err.message);
    return false;
  }
}

/**
 * Auto-bundle a completed VOLT run. Called from the onRunComplete hook.
 *
 * @param {object} ctx - { voltStatements, signBundleManifest, wardHookVOLT,
 *   countersignVoltBundle }
 * @param {string} runId
 * @param {object} state - { corr, seq, prevHash } from the emitter
 * @returns {Promise<{ ok: boolean, bundleId?: string, signed?: boolean, error?: string }>}
 */
async function autoBundleOnComplete(ctx, runId, state) {
  const { voltStatements, signBundleManifest, wardHookVOLT, countersignVoltBundle } = ctx || {};
  if (!voltStatements || !voltStatements.getRunEvents || !voltStatements.insertBundle) {
    return { ok: false, error: 'voltStatements unavailable' };
  }

  try {
    const events = voltStatements.getRunEvents.all(runId);
    if (!events || events.length === 0) {
      return { ok: false, error: 'no_events' };
    }

    // Extract hash anchors from first/last event data payloads
    let firstEventHash = null;
    let lastEventHash = null;
    try { firstEventHash = JSON.parse(events[0].data)?.hash || null; } catch (_) {}
    try { lastEventHash = JSON.parse(events[events.length - 1].data)?.hash || null; } catch (_) {}

    const bundleId = `BDL_${runId}_${Date.now().toString(36)}`;
    const manifest = {
      volt_version: '0.1',
      bundle_id: bundleId,
      run_id: runId,
      corr: state?.corr || null,
      created_ts: new Date().toISOString(),
      hash_alg: 'sha256',
      event_count: events.length,
      first_event_hash: firstEventHash,
      last_event_hash: lastEventHash,
      bundle_mode: 'manifest_only',
      producer: { name: 'quox-collector', version: '1.0' },
    };

    let sig = null;
    if (typeof signBundleManifest === 'function') {
      try {
        sig = await signBundleManifest(manifest);
      } catch (sigErr) {
        console.warn('[EVD/auto-bundle] signing failed (non-fatal):', sigErr.message);
      }
    }

    // LL-9i4: Quox Verified countersignature. Digest-only, fail-soft — a
    // failed/disabled countersign never blocks the bundle write; the
    // countersignature is additive, never a gate on local evidence (R5). The
    // returned ref (sink_ref-equivalent for bundles) is carried on the bundle.
    let quoxVerifiedRef = null;
    if (typeof countersignVoltBundle === 'function') {
      try {
        const cs = await countersignVoltBundle(manifest);
        if (cs && cs.success && cs.ref) quoxVerifiedRef = cs.ref;
      } catch (csErr) {
        console.warn('[EVD/auto-bundle] countersign failed (non-fatal):', csErr.message);
      }
    }

    const bundleData = JSON.stringify({ manifest, signature: sig, quox_verified: quoxVerifiedRef });
    voltStatements.insertBundle.run(bundleId, runId, manifest.created_ts, bundleData);

    // Witness in WARD — fire-and-forget
    if (typeof wardHookVOLT === 'function') {
      try {
        wardHookVOLT({
          bundle_id: bundleId,
          run_id: runId,
          first_event_hash: firstEventHash,
          last_event_hash: lastEventHash,
          event_count: events.length,
          created_ts: manifest.created_ts,
        });
      } catch (_) { /* non-fatal */ }
    }

    return { ok: true, bundleId, signed: !!sig };
  } catch (err) {
    console.warn('[EVD/auto-bundle] failed (non-fatal):', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  persistVoltContent,
  autoBundleOnComplete,
};
