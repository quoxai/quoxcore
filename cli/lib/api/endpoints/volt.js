/**
 * 'volt.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const volt = {
  'volt.cert.get': {
    method: 'GET',
    service: 'collector',
    path: ({ certId }) => `/volt/cert/${certId}`,
    tags: ['live-safe'],
  },
  'volt.cert.run.get': {
    method: 'GET',
    service: 'collector',
    path: ({ runId }) => `/volt/cert/run/${runId}`,
    tags: ['live-safe'],
  },
  'volt.certify': {
    method: 'POST',
    service: 'collector',
    path: () => `/volt/certify`,
    tags: ['live-write'],
  },
  'volt.certs.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/volt/certs`,
    tags: ['live-safe'],
  },
  'volt.certs.stats.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/volt/certs/stats`,
    tags: ['live-safe'],
  },
  // 2026-08-19 (proof-loop): these two routes existed on the collector with no
  // CLI verb reaching them, so `quox volt verify` — which only accepts a local
  // FILE — could not be pointed at real product evidence. The chain
  // run -> bundle -> verify was broken at exactly the step a customer needs to
  // check a receipt themselves, which is the whole "keep the receipt" pitch.
  'volt.run.bundle.get': {
    method: 'GET',
    service: 'collector',
    path: ({ runId }) => `/volt/runs/${runId}/bundle`,
    tags: ['live-safe'],
  },
  'volt.bundle.download': {
    method: 'GET',
    service: 'collector',
    path: ({ bundleId }) => `/volt/bundles/${bundleId}/download`,
    tags: ['live-safe'],
  },
  // fleet #447: the bundle persisted per-run at completion is manifest_only
  // (no events_ndjson, see voltContentStore.js), so `quox volt fetch` writing
  // it straight to disk gave `quox volt verify` a file it could never
  // chain-verify (bare MISSING_EVENTS). This is the missing verb: build the
  // full bundle (manifest + events_ndjson) from the run's stored events on
  // demand, then `volt.bundle.download` above fetches it.
  'volt.bundle.create': {
    method: 'POST',
    service: 'collector',
    path: () => `/volt/bundles/create`,
    tags: ['live-write'],
  },
  // SEO-MOAT (owner ruling 2026-09-03): minimal witnessed acceptance verdict.
  // The evidence chain proves what happened; this records whether it WORKED —
  // an attestation by a human or calling system, witnessed as its own VOLT
  // run pinning the target's head_hash. actor_type is credential-derived
  // server-side, never self-asserted.
  'volt.run.acceptance.post': {
    method: 'POST',
    service: 'collector',
    path: ({ runId }) => `/volt/runs/${runId}/acceptance`,
    tags: ['live-write'],
  },
  'volt.run.acceptance.get': {
    method: 'GET',
    service: 'collector',
    path: ({ runId }) => `/volt/runs/${runId}/acceptance`,
    tags: ['live-safe'],
  },
};
