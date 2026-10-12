/**
 * LocalOnlyNotice
 *
 * Honest indicator for memory panels whose data currently lives ONLY in
 * browser localStorage, with no server-side persistence yet (ZERO-TOLERANCE
 * gap — see MEMORY DATA-LAYER audit). Renders inline (no memory.css changes)
 * so this stays a correctness fix, not a visual redesign.
 */
export function LocalOnlyNotice({ label = 'this data' }) {
  return (
    <div
      role="note"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        color: '#f39c12',
        background: 'rgba(243, 156, 18, 0.08)',
        border: '1px solid rgba(243, 156, 18, 0.25)',
        borderRadius: 6,
        padding: '6px 10px',
        margin: '0 0 12px'
      }}
    >
      <span aria-hidden="true">!</span>
      <span>
        Not yet server-persisted: {label} lives only in this browser and will be lost if you clear
        storage or switch devices.
      </span>
    </div>
  )
}

export default LocalOnlyNotice
