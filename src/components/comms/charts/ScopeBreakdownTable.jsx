/**
 * ScopeBreakdownTable — Ranked table of top scopes by notification volume.
 * Shows a mini inline bar proportional to the max count.
 *
 * Props:
 *   data: [{ scope_id, scope_name, scope_type, total }]
 */

const SCOPE_TYPE_COLORS = {
  org: 'var(--ui-blue, #3b82f6)',
  division: 'var(--ui-green, #10b981)',
  department: 'var(--ui-amber, #f59e0b)',
  team: 'var(--ui-purple, #8b5cf6)'
}

export default function ScopeBreakdownTable({ data = [] }) {
  if (!data.length) {
    return (
      <div className="comms-chart comms-chart--empty">
        <span>No scope data</span>
      </div>
    )
  }

  const maxTotal = Math.max(...data.map(d => d.total), 1)

  return (
    <div className="comms-scope-table">
      <table className="comms-delivery-log__table">
        <thead>
          <tr>
            <th>#</th>
            <th>Scope</th>
            <th>Type</th>
            <th>Volume</th>
            <th style={{ width: '40%' }}></th>
          </tr>
        </thead>
        <tbody>
          {data.map((d, i) => {
            const pct = (d.total / maxTotal) * 100
            const color = SCOPE_TYPE_COLORS[d.scope_type] || 'var(--ui-blue, #3b82f6)'

            return (
              <tr key={d.scope_id || i}>
                <td style={{ color: 'var(--ui-text-muted, #666)', fontVariantNumeric: 'tabular-nums' }}>
                  {i + 1}
                </td>
                <td style={{ fontWeight: 500 }}>
                  {d.scope_name || d.scope_id || 'Unknown'}
                </td>
                <td>
                  <span className={`comms-badge comms-badge--neutral`}>
                    {d.scope_type || '—'}
                  </span>
                </td>
                <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                  {d.total}
                </td>
                <td>
                  <div
                    style={{
                      height: 8,
                      borderRadius: 4,
                      background: 'rgba(255, 255, 255, 0.04)',
                      overflow: 'hidden'
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        borderRadius: 4,
                        background: color,
                        opacity: 0.7,
                        transition: 'width 0.3s ease'
                      }}
                    />
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
