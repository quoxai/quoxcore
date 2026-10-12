/**
 * EvolutionStagePill — STUDY-REV-2 / P1.D
 *
 * Horizontal four-dot indicator visualising the automation evolution:
 *   chat → objective → workflow → crystal
 *
 * Styling: global CSS vars only (--hal-red, --status-green, --text-muted,
 * --text-secondary, --text-tertiary). No bespoke CSS file.
 */

const STAGES = [
  {
    key: 'chat',
    label: 'chat',
    tooltip: 'Conversational mode — every turn calls an LLM. Highest cost.',
  },
  {
    key: 'objective',
    label: 'objective',
    tooltip: 'Goal-bound — plans then executes. Cost per run.',
  },
  {
    key: 'workflow',
    label: 'workflow',
    tooltip: 'Reusable — same steps every time. Cost per execution.',
  },
  {
    key: 'crystal',
    label: 'crystal',
    tooltip: 'Crystallised — runs at <1% of agentic LLM cost. Cached + deterministic.',
  },
]

const STAGE_ORDER = STAGES.map((s) => s.key)

// Dot appearance variants
const DOT_SIZE = 10
const DOT_SIZE_COMPACT = 7
const LINE_W = 28
const LINE_W_COMPACT = 16

function getDotStyle(rel) {
  if (rel === 'current') {
    return {
      width: DOT_SIZE,
      height: DOT_SIZE,
      borderRadius: '50%',
      background: 'var(--hal-red)',
      boxShadow: '0 0 6px var(--hal-red-glow)',
      border: '2px solid var(--hal-red)',
      flexShrink: 0,
    }
  }
  if (rel === 'done') {
    return {
      width: DOT_SIZE,
      height: DOT_SIZE,
      borderRadius: '50%',
      background: 'var(--status-green)',
      opacity: 0.55,
      border: '2px solid var(--status-green)',
      flexShrink: 0,
    }
  }
  // future
  return {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: '50%',
    background: 'transparent',
    border: '2px solid var(--text-muted)',
    flexShrink: 0,
  }
}

function getDotStyleCompact(rel) {
  const base = getDotStyle(rel)
  return { ...base, width: DOT_SIZE_COMPACT, height: DOT_SIZE_COMPACT }
}

function getLineStyle(rel) {
  const done = rel === 'done' || rel === 'current'
  return {
    height: 1,
    width: LINE_W,
    background: done ? 'var(--status-green)' : 'var(--text-muted)',
    opacity: done ? 0.45 : 0.25,
    flexShrink: 0,
  }
}

function getLineStyleCompact(rel) {
  const base = getLineStyle(rel)
  return { ...base, width: LINE_W_COMPACT }
}

function getLabelStyle(rel) {
  if (rel === 'current') {
    return { color: 'var(--hal-red)', fontWeight: 600, fontSize: 10, letterSpacing: '0.02em' }
  }
  if (rel === 'done') {
    return { color: 'var(--status-green)', opacity: 0.65, fontSize: 10 }
  }
  return { color: 'var(--text-tertiary)', fontSize: 10 }
}

export default function EvolutionStagePill({ currentStage, className = '', compact = false, style = {} }) {
  const currentIdx = STAGE_ORDER.indexOf(currentStage)

  const dotStyleFn = compact ? getDotStyleCompact : getDotStyle
  const lineStyleFn = compact ? getLineStyleCompact : getLineStyle

  return (
    <div
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0,
        userSelect: 'none',
        ...style,
      }}
      aria-label={`Automation stage: ${currentStage}`}
    >
      {STAGES.map((stage, i) => {
        const rel = i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'future'
        const isLast = i === STAGES.length - 1

        // Line rel: line after dot[i] reflects whether dot[i] is done/current
        const lineRel = i < currentIdx ? 'done' : 'future'

        return (
          <span key={stage.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 0 }}>
            {/* Dot + optional label */}
            <span
              style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}
              title={stage.tooltip}
            >
              <span style={dotStyleFn(rel)} />
              {!compact && (
                <span style={getLabelStyle(rel)}>{stage.label}</span>
              )}
            </span>

            {/* Connecting line (not after last) */}
            {!isLast && (
              <span
                style={{
                  ...lineStyleFn(lineRel),
                  // push line up to align with dot centre, not label
                  marginBottom: compact ? 0 : 14,
                }}
              />
            )}
          </span>
        )
      })}
    </div>
  )
}
