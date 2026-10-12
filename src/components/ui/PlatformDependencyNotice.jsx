export default function PlatformDependencyNotice({
  issue,
  compact = false,
  onDismiss,
  style,
}) {
  if (!issue) return null

  const titleSize = compact ? 13 : 14
  const bodySize = compact ? 12 : 13
  const padding = compact ? '12px 14px' : '14px 16px'

  return (
    <div
      role="alert"
      style={{
        padding,
        borderRadius: 10,
        background: 'rgba(245, 158, 11, 0.08)',
        border: '1px solid rgba(245, 158, 11, 0.22)',
        color: 'var(--m-text-secondary, #d4d4d8)',
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? 8 : 10,
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: '#fbbf24', fontSize: titleSize, fontWeight: 700, marginBottom: 4 }}>
            {issue.title}
          </div>
          <div style={{ fontSize: bodySize, lineHeight: 1.55 }}>
            {issue.summary}
          </div>
        </div>
        {typeof onDismiss === 'function' && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss notice"
            style={{
              background: 'none',
              border: 'none',
              color: '#fbbf24',
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: 0,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        )}
      </div>

      {Array.isArray(issue.checks) && issue.checks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: bodySize, lineHeight: 1.45 }}>
          {issue.checks.map((check) => (
            <div key={check} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <span style={{ color: '#fbbf24', flexShrink: 0, marginTop: 1 }}>•</span>
              <span>{check}</span>
            </div>
          ))}
        </div>
      )}

      {issue.detail && (
        <div
          style={{
            padding: compact ? '8px 10px' : '10px 12px',
            borderRadius: 8,
            background: 'rgba(0,0,0,0.18)',
            border: '1px solid rgba(255,255,255,0.06)',
            color: 'var(--m-text-tertiary, #a1a1aa)',
            fontSize: compact ? 11 : 12,
            lineHeight: 1.45,
            fontFamily: "'SF Mono', 'JetBrains Mono', monospace",
            wordBreak: 'break-word',
          }}
        >
          {issue.detail}
        </div>
      )}
    </div>
  )
}

