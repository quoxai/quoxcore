/**
 * StepIndicator — Multi-step progress indicator with connected nodes
 *
 * Adapted from quox-remotion/src/visuals-arsenal/StepIndicator.jsx for production use.
 * All Remotion dependencies removed. Uses CSS transitions and keyframe animations.
 *
 * Props:
 *   steps      — [{label, status}] where status = "completed"|"active"|"pending"|"error"
 *   activeStep — index of active step (overrides step status if set)
 *   variant    — "horizontal" | "vertical" | "compact"
 */
import React, { useState, useEffect } from 'react';

const FONT = "Inter, system-ui, sans-serif";

const STATUS_COLORS = {
  completed: '#30ff90',
  active:    '#38bdf8',
  pending:   '#52525b',
  error:     '#ef4444',
};

// SVG checkmark for completed steps
const Checkmark = ({ color, size }) => (
  <svg width={size} height={size} viewBox="0 0 20 20">
    <polyline
      points="5,10 9,14 15,6"
      fill="none"
      stroke={color}
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// Error X mark
const ErrorMark = ({ color, size }) => (
  <svg width={size} height={size} viewBox="0 0 20 20">
    <line x1="6" y1="6" x2="14" y2="14" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
    <line x1="14" y1="6" x2="6" y2="14" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
  </svg>
);

// Inject pulse keyframes once
const PULSE_KEYFRAMES = `
@keyframes stepIndicatorPulse {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 1; }
}
@keyframes stepIndicatorGlow {
  0%, 100% { transform: scale(1); opacity: 0.3; }
  50% { transform: scale(1.15); opacity: 0.5; }
}
`;

let injected = false;
function injectKeyframes() {
  if (injected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = PULSE_KEYFRAMES;
  document.head.appendChild(style);
  injected = true;
}

const StepIndicator = ({
  steps = [],
  activeStep,
  variant = 'horizontal',
}) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    injectKeyframes();
    const t = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(t);
  }, []);

  if (steps.length === 0) return null;

  // Resolve step statuses if activeStep is provided
  const resolvedSteps = steps.map((step, i) => {
    if (activeStep !== undefined) {
      if (i < activeStep) return { ...step, status: 'completed' };
      if (i === activeStep) return { ...step, status: 'active' };
      return { ...step, status: 'pending' };
    }
    return step;
  });

  // Compact variant — minimal inline
  if (variant === 'compact') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {resolvedSteps.map((step, i) => {
          const sc = STATUS_COLORS[step.status] || STATUS_COLORS.pending;
          const isActive = step.status === 'active';
          return (
            <div
              key={i}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                opacity: visible ? 1 : 0,
                transition: `opacity 0.3s ease-out ${i * 0.06}s`,
              }}
            >
              <div style={{
                width: isActive ? 10 : 7,
                height: isActive ? 10 : 7,
                borderRadius: '50%',
                backgroundColor: sc,
                opacity: isActive ? 1 : step.status === 'pending' ? 0.6 : 0.8,
                boxShadow: isActive ? `0 0 8px ${sc}40` : 'none',
                animation: isActive ? 'stepIndicatorPulse 2s ease-in-out infinite' : 'none',
                transition: 'width 0.2s, height 0.2s',
              }} />
              <span style={{
                fontSize: 11,
                fontFamily: FONT,
                color: isActive ? sc : 'rgba(255,255,255,0.6)',
                fontWeight: isActive ? 600 : 400,
              }}>
                {step.label}
              </span>
              {i < resolvedSteps.length - 1 && (
                <div style={{
                  width: 12, height: 1,
                  backgroundColor: 'rgba(255,255,255,0.1)',
                  margin: '0 2px',
                }} />
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // Step node renderer for horizontal / vertical
  const renderStepNode = (step, index) => {
    const sc = STATUS_COLORS[step.status] || STATUS_COLORS.pending;
    const nodeSize = 32;
    const iconSize = 16;
    const isActive = step.status === 'active';
    const isCompleted = step.status === 'completed';
    const isError = step.status === 'error';
    const isPending = step.status === 'pending';

    return (
      <div
        key={index}
        style={{
          display: 'flex',
          flexDirection: variant === 'horizontal' ? 'column' : 'row',
          alignItems: 'center',
          gap: 8,
          opacity: visible ? 1 : 0,
          transition: `opacity 0.4s ease-out ${index * 0.08}s`,
        }}
      >
        {/* Node circle + connector */}
        <div style={{
          display: 'flex',
          flexDirection: variant === 'horizontal' ? 'row' : 'column',
          alignItems: 'center',
        }}>
          {/* Connector before (not for first) */}
          {index > 0 && (
            <div style={{
              width: variant === 'horizontal' ? 40 : 2,
              height: variant === 'horizontal' ? 2 : 28,
              background: resolvedSteps[index - 1].status === 'completed'
                ? `linear-gradient(${variant === 'horizontal' ? 'to right' : 'to bottom'}, ${STATUS_COLORS.completed}60, ${sc}40)`
                : 'rgba(255,255,255,0.08)',
              borderRadius: 1,
              transition: 'background 0.3s',
            }} />
          )}

          {/* Node */}
          <div style={{ position: 'relative' }}>
            {/* Active glow ring */}
            {isActive && (
              <div style={{
                position: 'absolute',
                inset: -4,
                borderRadius: '50%',
                border: `1.5px solid ${sc}30`,
                animation: 'stepIndicatorGlow 2s ease-in-out infinite',
              }} />
            )}
            <div style={{
              width: nodeSize,
              height: nodeSize,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: `2px solid ${sc}`,
              background: isCompleted ? `${sc}15` : isActive ? `${sc}10` : 'transparent',
              boxShadow: isActive ? `0 0 12px ${sc}25` : 'none',
              animation: isActive ? 'stepIndicatorPulse 2s ease-in-out infinite' : 'none',
              transition: 'all 0.3s',
            }}>
              {isCompleted && <Checkmark color={sc} size={iconSize} />}
              {isActive && (
                <div style={{
                  width: 8, height: 8, borderRadius: '50%',
                  backgroundColor: sc,
                  boxShadow: `0 0 6px ${sc}50`,
                }} />
              )}
              {isError && <ErrorMark color={sc} size={iconSize} />}
              {isPending && (
                <div style={{
                  width: 6, height: 6, borderRadius: '50%',
                  backgroundColor: sc, opacity: 0.6,
                }} />
              )}
            </div>
          </div>

          {/* Connector after (not for last) */}
          {index < resolvedSteps.length - 1 && (
            <div style={{
              width: variant === 'horizontal' ? 40 : 2,
              height: variant === 'horizontal' ? 2 : 28,
              background: step.status === 'completed'
                ? `linear-gradient(${variant === 'horizontal' ? 'to right' : 'to bottom'}, ${sc}60, ${STATUS_COLORS[resolvedSteps[index + 1].status] || '#52525b'}40)`
                : 'rgba(255,255,255,0.08)',
              borderRadius: 1,
              transition: 'background 0.3s',
            }} />
          )}
        </div>

        {/* Label */}
        <span style={{
          fontSize: 12,
          fontFamily: FONT,
          fontWeight: isActive ? 600 : 400,
          color: isActive ? sc : isCompleted ? `${sc}cc` : 'rgba(255,255,255,0.6)',
          whiteSpace: 'nowrap',
          textAlign: variant === 'horizontal' ? 'center' : 'left',
          marginTop: variant === 'horizontal' ? 4 : 0,
          minWidth: variant === 'vertical' ? 80 : undefined,
          transition: 'color 0.3s',
        }}>
          {step.label}
        </span>
      </div>
    );
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: variant === 'horizontal' ? 'row' : 'column',
      alignItems: variant === 'horizontal' ? 'flex-start' : 'flex-start',
      justifyContent: variant === 'horizontal' ? 'center' : 'flex-start',
      gap: 0,
    }}>
      {resolvedSteps.map((step, i) => renderStepNode(step, i))}
    </div>
  );
};

export default StepIndicator;
