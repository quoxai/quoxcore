// Stream QMH (QuoxMind Honest) — endpoint convention helper.
//
// Every implant exposes GET /api/engine/<implant>/stats and the response shape
// is shared so the frontend can consume them through one client.
//
// Shape:
//   {
//     implant: 'quox-temporal',
//     healthScore: 0..100,
//     primaryMetric: { value, unit, label },   // what shows on the topology card
//     fields: { ... },                          // implant-specific extras
//     sourceVersion: 'qmh-1',                   // bump when shape changes
//     generatedAt: '2026-04-27T12:34:56.789Z',
//   }
//
// Fail-honest values for unimplemented or data-sparse states:
//   { healthScore: null, primaryMetric: { value: null, label: 'Collecting' }, ... }
// The UI renders null healthScore as "◐ Collecting" instead of "DOWN".

const SOURCE_VERSION = 'qmh-1'

export function implantStatsResponse({
  implant,
  healthScore = null,
  primaryMetric = null,
  fields = {},
  failureReason = null,
}) {
  if (!implant) throw new Error('implantStatsResponse: implant id required')
  if (healthScore !== null && (typeof healthScore !== 'number' || healthScore < 0 || healthScore > 100)) {
    throw new Error(`implantStatsResponse: healthScore must be null or 0..100 (got ${healthScore})`)
  }
  return {
    implant,
    healthScore,
    primaryMetric,
    fields,
    failureReason,
    sourceVersion: SOURCE_VERSION,
    generatedAt: new Date().toISOString(),
  }
}

// Sentinel responses for the three honest non-healthy states (used by QMH-5 UX phase).
export function implantStatsCollecting(implant, label = 'Collecting') {
  return implantStatsResponse({
    implant,
    healthScore: null,
    primaryMetric: { value: null, label },
    failureReason: null,
  })
}

export function implantStatsLicenseRequired(implant, requiredPlugin) {
  return implantStatsResponse({
    implant,
    healthScore: null,
    primaryMetric: { value: null, label: 'Premium feature' },
    failureReason: { code: 'LICENSE_REQUIRED', requiredPlugin },
  })
}

export function implantStatsUnreachable(implant, service, err) {
  return implantStatsResponse({
    implant,
    healthScore: null,
    primaryMetric: { value: null, label: `Service unreachable: ${service}` },
    failureReason: { code: 'SERVICE_UNREACHABLE', service, message: err?.message || String(err) },
  })
}
