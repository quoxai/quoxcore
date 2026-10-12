/**
 * WARD-EXT-4: WardTipCard — displays a tip with parsed sink_ref badges
 */

import QuoxVerifiedBadge, { parseCountersignature } from './QuoxVerifiedBadge'

const SINK_DISPLAY = {
  tsa: { label: 'TSA', color: '#30ff90' },
  webhook: { label: 'Webhook', color: '#38bdf8' },
  gitea: { label: 'Gitea', color: '#a855f7' },
  github: { label: 'GitHub', color: '#e5e5e5' },
  gitlab: { label: 'GitLab', color: '#fc6d26' },
  s3: { label: 'S3', color: '#f59e0b' },
}

function parseSinkRefs(sinkRef) {
  if (!sinkRef) return []
  return sinkRef.split(',').map(ref => {
    const colonIdx = ref.indexOf(':')
    if (colonIdx === -1) return { type: 'unknown', raw: ref }
    const type = ref.slice(0, colonIdx)
    const rest = ref.slice(colonIdx + 1)
    const hashIdx = rest.indexOf('#')
    const identifier = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest
    return { type, identifier, raw: ref }
  })
}

function truncHash(hash) {
  if (!hash) return '—'
  return hash.length > 12 ? hash.slice(0, 12) + '...' : hash
}

function timeAgo(ts) {
  if (!ts) return '—'
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

export default function WardTipCard({ tip }) {
  if (!tip) return null

  // The dedicated Quox Verified badge owns the quox-verified ref, so it is
  // excluded from the generic sink chips below to avoid a duplicate display.
  const sinkRefs = parseSinkRefs(tip.sink_ref).filter(ref => ref.type !== 'quox-verified')
  const countersignature = parseCountersignature(tip.sink_ref, tip.countersignature)

  return (
    <div className="ward-tip-card">
      <div className="ward-tip-card__header">
        <span className="ward-tip-card__seq">Tip @ seq {tip.tip_seq}</span>
        <span className="ward-tip-card__time">{timeAgo(tip.created_at)}</span>
      </div>
      <div className="ward-tip-card__hash" title={tip.tip_chain_hash}>
        {truncHash(tip.tip_chain_hash)}
      </div>
      <div className="ward-tip-card__meta">
        <span>{tip.entry_count} entries</span>
        {tip.sig && <span className="ward-tip-card__signed">Signed</span>}
      </div>

      {/* Sink publication status */}
      <div className="ward-tip-card__sinks">
        {sinkRefs.length > 0 ? (
          sinkRefs.map((ref, i) => {
            const display = SINK_DISPLAY[ref.type] || { label: ref.type, color: '#64748b' }
            return (
              <span
                key={i}
                className="ward-tip-card__sink-badge"
                style={{ color: display.color, borderColor: `${display.color}40` }}
                title={ref.raw}
              >
                {display.label}: {ref.identifier}
              </span>
            )
          })
        ) : (
          <span className="ward-tip-card__unpublished">Unpublished</span>
        )}
      </div>

      {/* Quox Verified countersignature — additive, never a gate. */}
      <div className="ward-tip-card__quox-verified">
        <QuoxVerifiedBadge countersignature={countersignature} />
      </div>
    </div>
  )
}
