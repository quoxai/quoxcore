/**
 * POL-HIST: Per-policy history drawer
 *
 * Drops in where a policy row is clicked — shows the last N mutations
 * with actor, operation, timestamp, and field-level diff. Uses the
 * existing glass-primitives to match the Compliance tab vocabulary.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  GlassPanel,
  GlassPill,
  SectionHeader,
  COLORS,
  M,
  F,
} from './glass-primitives'
import { listHistoryForPolicy } from '../../services/policyHistoryClient'

const OPERATION_COLORS = {
  created: COLORS.green,
  updated: COLORS.cyan,
  deleted: COLORS.red,
  enabled: COLORS.green,
  disabled: COLORS.amber,
  approved: COLORS.green,
  rejected: COLORS.red,
  approval_requested: COLORS.purple,
}

function formatTs(iso) {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function DiffRows({ diff }) {
  if (!diff || typeof diff !== 'object') return null
  const entries = Object.entries(diff)
  if (entries.length === 0) return null
  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {entries.map(([field, { before, after }]) => (
        <div
          key={field}
          style={{
            fontFamily: M,
            fontSize: 9,
            color: COLORS.subtleText,
            background: 'rgba(255,255,255,0.02)',
            borderRadius: 4,
            padding: '4px 6px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          <span style={{ color: '#fff', fontWeight: 600 }}>{field}</span>
          <span>: </span>
          <span style={{ color: COLORS.red, textDecoration: 'line-through' }}>
            {JSON.stringify(before)}
          </span>
          <span> → </span>
          <span style={{ color: COLORS.green }}>{JSON.stringify(after)}</span>
        </div>
      ))}
    </div>
  )
}

export default function PolicyHistoryDrawer({ policyId, policyName, onClose }) {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const reload = useCallback(async () => {
    if (!policyId) return
    try {
      setLoading(true)
      setError(null)
      const { data } = await listHistoryForPolicy(policyId, { limit: 50 })
      setEntries(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err.message || 'Failed to load history')
    } finally {
      setLoading(false)
    }
  }, [policyId])

  useEffect(() => { reload() }, [reload])

  if (!policyId) return null

  return (
    <GlassPanel style={{ minWidth: 360 }}>
      <SectionHeader
        title="Change history"
        subtitle={policyName || policyId}
        action={
          onClose ? (
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '4px 10px',
                borderRadius: 6,
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: '#fff',
                fontFamily: M,
                fontSize: 9,
                cursor: 'pointer',
                letterSpacing: 0.5,
                fontWeight: 600,
              }}
            >
              CLOSE
            </button>
          ) : null
        }
      />

      {error ? (
        <div style={{ fontFamily: F, fontSize: 12, color: COLORS.red }}>{error}</div>
      ) : loading ? (
        <div style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText }}>
          Loading history…
        </div>
      ) : entries.length === 0 ? (
        <div style={{
          padding: '16px 4px',
          fontFamily: F,
          fontSize: 12,
          color: COLORS.subtleText,
          textAlign: 'center',
        }}>
          No history recorded — this policy hasn't been modified since the
          change-log was introduced.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {entries.map((e) => {
            const colour = OPERATION_COLORS[e.operation] || COLORS.subtleText
            return (
              <div
                key={e.id}
                style={{
                  padding: 10,
                  borderRadius: 8,
                  borderLeft: `3px solid ${colour}`,
                  background: 'rgba(255,255,255,0.03)',
                }}
              >
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                }}>
                  <GlassPill color={colour}>{e.operation.replace('_', ' ')}</GlassPill>
                  <span style={{
                    fontFamily: M,
                    fontSize: 9,
                    color: COLORS.subtleText,
                  }}>
                    v{e.version_before ?? '—'} → v{e.version_after}
                  </span>
                </div>
                <div style={{
                  marginTop: 6,
                  fontFamily: F,
                  fontSize: 11,
                  color: '#fff',
                }}>
                  <span style={{ fontWeight: 600 }}>{e.actor_label || e.actor_id}</span>
                  <span style={{ color: COLORS.subtleText }}>
                    {' · '}{e.actor_source}
                    {' · '}{formatTs(e.created_at)}
                  </span>
                </div>
                {e.reason && (
                  <div style={{
                    marginTop: 4,
                    fontFamily: F,
                    fontSize: 11,
                    color: COLORS.subtleText,
                  }}>
                    “{e.reason}”
                  </div>
                )}
                <DiffRows diff={e.diff_json} />
                {e.approval_state === 'pending' && (
                  <div style={{
                    marginTop: 6,
                    fontFamily: M,
                    fontSize: 9,
                    color: COLORS.amber,
                  }}>
                    PENDING SECOND APPROVER
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </GlassPanel>
  )
}
