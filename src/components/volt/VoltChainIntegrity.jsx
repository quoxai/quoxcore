/**
 * VoltChainIntegrity — Visual hash chain integrity indicator
 *
 * Horizontal row of connected dots:
 * - Green = valid link (events[i+1].prev_hash === events[i].hash)
 * - Red = broken link (pulse animation)
 * Summary: "N/M links valid" with progress bar.
 * Compact: ~40px height.
 */

import { useMemo } from 'react'

export default function VoltChainIntegrity({ events = [] }) {
  const { links, validCount, totalLinks } = useMemo(() => {
    if (events.length < 2) return { links: [], validCount: 0, totalLinks: 0 }

    const computed = []
    for (let i = 0; i < events.length - 1; i++) {
      const valid = events[i + 1].prev_hash === events[i].hash
      computed.push({ fromSeq: events[i].seq, toSeq: events[i + 1].seq, valid })
    }

    return {
      links: computed,
      validCount: computed.filter(l => l.valid).length,
      totalLinks: computed.length,
    }
  }, [events])

  if (events.length < 2) return null

  const pct = Math.round((validCount / totalLinks) * 100)
  const allValid = validCount === totalLinks

  return (
    <div className="volt-chain-integrity" role="status" aria-label={`Chain integrity: ${validCount} of ${totalLinks} links valid`}>
      {/* Dot chain */}
      <div className="volt-chain-integrity__dots">
        {events.map((evt, i) => {
          const linkBefore = i > 0 ? links[i - 1] : null
          const linkAfter = i < links.length ? links[i] : null
          const isValid = (linkBefore === null || linkBefore.valid) && (linkAfter === null || linkAfter.valid)

          return (
            <div key={evt.event_id} className="volt-chain-integrity__node">
              {i > 0 && (
                <div className={`volt-chain-integrity__connector${links[i - 1].valid ? '' : ' volt-chain-integrity__connector--broken'}`} />
              )}
              <div
                className={`volt-chain-integrity__dot${isValid ? ' volt-chain-integrity__dot--valid' : ' volt-chain-integrity__dot--broken'}`}
                title={`#${evt.seq}`}
              />
            </div>
          )
        })}
      </div>

      {/* Summary */}
      <div className="volt-chain-integrity__summary">
        <span className={`volt-chain-integrity__text${allValid ? ' volt-chain-integrity__text--valid' : ' volt-chain-integrity__text--broken'}`}>
          {validCount}/{totalLinks} links valid
        </span>
        <div className="volt-chain-integrity__bar">
          <div
            className="volt-chain-integrity__fill"
            style={{
              width: `${pct}%`,
              background: allValid ? '#34d399' : '#ef4444',
            }}
          />
        </div>
      </div>
    </div>
  )
}
