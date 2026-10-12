'use strict';

/**
 * QUOX-SECURITY COVERAGE Phase 2: app-port discovery.
 *
 * Phase 1's `url` target type fixed by hand the false-clean where nuclei only
 * hit :80/:443 on a bare host, so a service on :3000 read as clean because it
 * was never probed. This module makes that self-healing: point httpx at a bare
 * host, discover which of a curated set of common web/app ports actually serve
 * HTTP(S), and (optionally) register each serving endpoint as a verified
 * `url` target so future scans hit the real surface.
 *
 * Two pure, dependency-injected pieces, both unit-testable with no live host:
 *  - parseDiscoveredEndpoints: httpx -json lines -> deduped endpoint list.
 *  - discoverAndAddAppPorts: run the capability (policy-gated by the injected
 *    runner), parse, and on add=true create+verify a url target per endpoint.
 *
 * The re-verification is honest, not a rubber stamp: a discovered endpoint is
 * on the SAME host that is already a verified in-scope target, so
 * quoxagent_install fleet membership re-proves control for the new url target
 * exactly as it did for the host it was discovered on.
 */

/**
 * Parse the raw output of the sectest_discover_app_ports capability (httpx
 * -json, one JSON object per live endpoint) into a deduped endpoint list.
 * Accepts an array of JSON strings and/or already-parsed objects (the executor
 * declares output_format 'lines', so each element is typically a JSON string).
 * Never throws on a malformed element: a line that will not parse, or lacks a
 * url, is skipped. Dedupes on the canonical url httpx reported.
 *
 * @param {Array<string|object>} rawOutput
 * @returns {Array<{url:string, port:(number|string|null), scheme:(string|null), status_code:(number|null), title:(string|null)}>}
 */
function parseDiscoveredEndpoints(rawOutput) {
  const out = [];
  const seen = new Set();
  const items = Array.isArray(rawOutput) ? rawOutput : [];

  for (const item of items) {
    let obj = null;
    if (item && typeof item === 'object') {
      obj = item;
    } else if (typeof item === 'string') {
      const trimmed = item.trim();
      if (!trimmed) continue;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue; // malformed line: skip, never throw
      }
    } else {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;

    const url = typeof obj.url === 'string' ? obj.url : null;
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    let port = obj.port;
    if (typeof port === 'string' && port.trim() !== '' && !Number.isNaN(Number(port))) {
      port = Number(port);
    }
    if (port === undefined) port = null;

    const scheme = typeof obj.scheme === 'string' ? obj.scheme : null;
    // httpx has shipped both status_code (current) and status-code (older).
    let status_code = obj.status_code !== undefined ? obj.status_code : obj['status-code'];
    if (status_code === undefined) status_code = null;
    const title = typeof obj.title === 'string' ? obj.title : null;

    out.push({ url, port, scheme, status_code, title });
  }

  return out;
}

/**
 * Run the app-port discovery capability against a bare host, parse the serving
 * endpoints, and optionally register each as a verified url target.
 *
 * The capability run goes through the injected `runCapability` (in production
 * this is executeSecurityCapabilityTool, so it is policy-gated exactly like
 * every other capability: the host must already be a verified in-scope target).
 * On add=true, each discovered endpoint becomes a `url` target
 * (verification_method quoxagent_install) and is verified via the injected
 * checkFleetMembership; an endpoint that already exists as a target is skipped,
 * not errored.
 *
 * @param {{engagementId:string, orgId:string, target:string, add?:boolean}} args
 * @param {{db, runCapability:Function, addTarget:Function, verifyTarget:Function, checkFleetMembership:Function}} deps
 * @returns {Promise<object>}
 */
async function discoverAndAddAppPorts({ engagementId, orgId, target, add }, deps) {
  const { db, runCapability, addTarget, verifyTarget, checkFleetMembership } = deps;

  const result = await runCapability(
    'sectest_discover_app_ports',
    { engagement_id: engagementId, target },
    { orgId }
  );

  if (!result || result.success !== true) {
    // Pass the honest failure through (policy denial, no scan host, etc.),
    // never fabricate a clean discovery.
    return {
      success: false,
      allowed: result ? result.allowed : undefined,
      requiresApproval: result ? result.requiresApproval : undefined,
      error: (result && result.error) || 'app-port discovery failed',
      discovered: [],
      added: [],
      skipped: [],
    };
  }

  const discovered = parseDiscoveredEndpoints(result.output);
  const added = [];
  const skipped = [];

  if (add === true) {
    for (const endpoint of discovered) {
      let created;
      try {
        created = addTarget(
          engagementId,
          orgId,
          { type: 'url', value: endpoint.url, verification_method: 'quoxagent_install' },
          { db }
        );
      } catch (err) {
        // Already in scope: skip, do not error the whole discovery.
        if (/already exists/i.test(err.message || '')) {
          skipped.push(endpoint.url);
          continue;
        }
        throw err;
      }

      const verifiedTarget = await verifyTarget(created.id, orgId, { db, checkFleetMembership });
      added.push({
        targetId: created.id,
        url: endpoint.url,
        verified: verifiedTarget && verifiedTarget.verification_status === 'verified',
      });
    }
  }

  return { success: true, discovered, added, skipped };
}

module.exports = { parseDiscoveredEndpoints, discoverAndAddAppPorts };
