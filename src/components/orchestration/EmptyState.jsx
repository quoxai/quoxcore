/**
 * EmptyState — Animated placeholder for empty/loading/error/success states
 *
 * @param {'empty'|'loading'|'error'|'success'} variant
 * @param {string} title
 * @param {string} [description]
 * @param {React.ReactNode} [action] — CTA button
 */

const VARIANTS = {
  empty: { icon: '◎', color: 'rgba(255,255,255,0.3)', animation: 'none' },
  loading: { icon: '◌', color: '#38bdf8', animation: 'emSpin 1.5s linear infinite' },
  error: { icon: '✕', color: '#ef4444', animation: 'emShake 0.4s ease' },
  success: { icon: '✓', color: '#10b981', animation: 'emPop 0.3s ease' },
}

export default function EmptyState({ variant = 'empty', title, description, action }) {
  const cfg = VARIANTS[variant] || VARIANTS.empty

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '48px 24px', textAlign: 'center', minHeight: 200,
    }}>
      <div style={{
        fontSize: 36, color: cfg.color, marginBottom: 12,
        animation: cfg.animation, lineHeight: 1,
      }}>
        {cfg.icon}
      </div>
      {title && (
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--m-text-primary, #f4f4f5)', marginBottom: 6 }}>
          {title}
        </div>
      )}
      {description && (
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', maxWidth: 320, lineHeight: 1.6 }}>
          {description}
        </div>
      )}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}

      <style>{`
        @keyframes emSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes emShake { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }
        @keyframes emPop { 0% { transform: scale(0.5); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
      `}</style>
    </div>
  )
}
