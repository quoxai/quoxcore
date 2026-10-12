/**
 * CrystalsPage — STUDY-REV-2 / P1.F
 *
 * Read-only explainer page at /docs/crystals.
 * Mounted as a specific Route BEFORE the catch-all /docs/* ExternalRedirect.
 * Composes only global qx-* / glass classes + CSS variables. No bespoke CSS file.
 */

import { Link } from 'react-router-dom'
import EvolutionStagePill from '../../components/automation/EvolutionStagePill'

// ── Inline SVG icons ─────────────────────────────────────────────────────────

const ChatIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

const ObjectiveIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2" />
  </svg>
)

const WorkflowIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="6" height="6" rx="1" />
    <rect x="15" y="3" width="6" height="6" rx="1" />
    <rect x="9" y="15" width="6" height="6" rx="1" />
    <path d="M6 9v3a1 1 0 0 0 1 1h4" />
    <path d="M18 9v3a1 1 0 0 1-1 1h-4" />
  </svg>
)

const CrystalIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3h12l4 6-10 13L2 9Z" />
    <path d="M11 3 8 9l4 13 4-13-3-6" />
    <path d="M2 9h20" />
  </svg>
)

const ArrowRightIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </svg>
)

// ── Progression cards data ────────────────────────────────────────────────────

const PROGRESSION = [
  {
    step: 1,
    label: 'Chat',
    href: '/quoxchat',
    subtitle: 'Talk to QUOX. Highest cost. Highest flexibility.',
    icon: <ChatIcon />,
    isFeatured: false,
  },
  {
    step: 2,
    label: 'Objective',
    href: '/objectives',
    subtitle: 'Goal-bound. Plans then executes once.',
    icon: <ObjectiveIcon />,
    isFeatured: false,
  },
  {
    step: 3,
    label: 'Workflow',
    href: '/workflow-builder',
    subtitle: 'Reusable. Cost per execution.',
    icon: <WorkflowIcon />,
    isFeatured: false,
  },
  {
    step: 4,
    label: 'Crystal',
    href: '/crystals',
    subtitle: 'Crystallised. <1% of agentic cost.',
    icon: <CrystalIcon />,
    isFeatured: true,
  },
]

// ── Sub-components ────────────────────────────────────────────────────────────

function ProgressionCard({ card }) {
  const featuredStyle = card.isFeatured
    ? {
        border: '1.5px solid var(--hal-green, #00ff88)',
        boxShadow: '0 0 18px rgba(0, 255, 136, 0.12)',
        background: 'rgba(0, 255, 136, 0.04)',
      }
    : {}

  return (
    <Link
      to={card.href}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '18px 16px',
        borderRadius: 10,
        background: 'var(--glass-bg, rgba(255,255,255,0.04))',
        border: '1px solid var(--glass-border, rgba(255,255,255,0.1))',
        textDecoration: 'none',
        color: 'inherit',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        cursor: 'pointer',
        ...featuredStyle,
      }}
    >
      {/* Step badge + icon row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: '50%',
            background: card.isFeatured
              ? 'var(--hal-green, #00ff88)'
              : 'var(--glass-border, rgba(255,255,255,0.15))',
            color: card.isFeatured ? '#000' : 'var(--text-muted)',
            fontSize: 11,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {card.step}
        </span>
        <span style={{ color: card.isFeatured ? 'var(--hal-green, #00ff88)' : 'var(--text-secondary)' }}>
          {card.icon}
        </span>
      </div>

      {/* Title */}
      <div style={{
        fontSize: 15,
        fontWeight: 600,
        color: card.isFeatured ? 'var(--hal-green, #00ff88)' : 'var(--text-primary)',
        letterSpacing: '0.01em',
      }}>
        {card.label}
      </div>

      {/* Subtitle */}
      <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, flex: 1 }}>
        {card.subtitle}
      </div>

      {/* Open affordance */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        color: card.isFeatured ? 'var(--hal-green, #00ff88)' : 'var(--text-tertiary)',
        marginTop: 2,
      }}>
        Open <ArrowRightIcon />
      </div>
    </Link>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function CrystalsPage() {
  return (
    <div
      className="qx-page"
      style={{
        maxWidth: 860,
        margin: '0 auto',
        padding: '40px 24px 64px',
        display: 'flex',
        flexDirection: 'column',
        gap: 40,
      }}
    >
      {/* ── Header ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <EvolutionStagePill currentStage="crystal" style={{ marginBottom: 2 }} />

        <h1 style={{
          fontSize: 26,
          fontWeight: 700,
          color: 'var(--text-primary)',
          margin: 0,
          letterSpacing: '-0.01em',
        }}>
          Crystals — Reusable, near-zero-cost automations
        </h1>

        <p style={{
          fontSize: 14,
          color: 'var(--text-secondary)',
          lineHeight: 1.65,
          margin: 0,
          maxWidth: 620,
        }}>
          Crystals are workflows that have proven themselves. They run at less than 1% of
          agentic LLM cost, deterministically, and cache their structure for instant replay.
        </p>
      </div>

      {/* ── Four-step progression ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text-muted)',
          margin: 0,
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
        }}>
          The automation evolution
        </h2>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
        }}>
          {PROGRESSION.map((card) => (
            <ProgressionCard key={card.step} card={card} />
          ))}
        </div>
      </div>

      {/* ── Why crystallise? ── */}
      <div
        className="qx-card"
        style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '24px 22px' }}
      >
        <h2 style={{
          fontSize: 16,
          fontWeight: 600,
          color: 'var(--text-primary)',
          margin: 0,
        }}>
          Why crystallise?
        </h2>

        <p style={{
          fontSize: 13,
          color: 'var(--text-secondary)',
          lineHeight: 1.7,
          margin: 0,
          maxWidth: 660,
        }}>
          Every time an agentic workflow runs, it calls an LLM — paying per token, per turn, per
          decision. A crystallised workflow replaces those calls with a cached, deterministic
          execution plan. The structure was already validated; there is nothing left to reason
          about. The result is the same output at a fraction of the price.
        </p>

        {/* Cost comparison block */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          borderRadius: 8,
          overflow: 'hidden',
          border: '1px solid var(--glass-border, rgba(255,255,255,0.1))',
        }}>
          {/* Row header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            background: 'var(--glass-bg-darker, rgba(255,255,255,0.04))',
            padding: '8px 14px',
          }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Mode
            </span>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Typical cost per execution
            </span>
          </div>

          {/* Agentic row */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            padding: '10px 14px',
            background: 'var(--glass-bg, rgba(255,255,255,0.02))',
            borderTop: '1px solid var(--glass-border, rgba(255,255,255,0.07))',
          }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Agentic LLM call</span>
            <span style={{ fontSize: 13, color: 'var(--hal-red, #ff4444)', fontWeight: 500 }}>
              ~$0.05 – $0.50
            </span>
          </div>

          {/* Crystal row */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            padding: '10px 14px',
            background: 'rgba(0, 255, 136, 0.04)',
            borderTop: '1px solid var(--glass-border, rgba(255,255,255,0.07))',
          }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--hal-green, #00ff88)' }}>
                <CrystalIcon />
              </span>
              Crystal replay
            </span>
            <span style={{ fontSize: 13, color: 'var(--hal-green, #00ff88)', fontWeight: 600 }}>
              ~$0.0005 {'<'}1% of agentic
            </span>
          </div>
        </div>

        <p style={{
          fontSize: 11,
          color: 'var(--text-tertiary)',
          margin: 0,
          fontStyle: 'italic',
        }}>
          Numbers are illustrative — actual savings depend on workflow size and provider rates.
        </p>
      </div>

      {/* ── CTA ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Link
          to="/crystals"
          className="qx-btn qx-btn-primary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}
        >
          View your Crystal Library
          <ArrowRightIcon />
        </Link>
      </div>
    </div>
  )
}
