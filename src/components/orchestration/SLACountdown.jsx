/**
 * SLACountdown — Deadline countdown with color state (green/yellow/red)
 *
 * Adapted from quox-remotion/src/visuals-hitl/SLACountdown.jsx for production use.
 * All Remotion dependencies removed. Uses setInterval for live countdown.
 *
 * Props:
 *   deadline      — Date object or ISO string
 *   label         — optional label text (default "SLA")
 *   size          — "sm" | "md" | "lg"
 *   variant       — "clock" | "bar" | "badge"
 *   totalMinutes  — total SLA duration in minutes (for progress bar calc)
 */
import React, { useState, useEffect, useRef } from 'react';

const MONO = "'JetBrains Mono', 'Fira Code', monospace";
const FONT = "Inter, system-ui, sans-serif";

const SIZE_CONFIG = {
  sm: { fontSize: 14, padding: '4px 10px', barHeight: 4, barWidth: 180 },
  md: { fontSize: 24, padding: '8px 16px', barHeight: 6, barWidth: 300 },
  lg: { fontSize: 36, padding: '12px 24px', barHeight: 8, barWidth: 420 },
};

// Inject blink keyframes once
const BLINK_KEYFRAMES = `
@keyframes slaCountdownBlink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
@keyframes slaCountdownFlash {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}
`;

let injected = false;
function injectKeyframes() {
  if (injected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = BLINK_KEYFRAMES;
  document.head.appendChild(style);
  injected = true;
}

function getColourForPct(pct) {
  if (pct <= 0.05) return { color: '#ef4444', flashing: true };
  if (pct <= 0.2) return { color: '#ef4444', flashing: false };
  if (pct <= 0.5) return { color: '#f59e0b', flashing: false };
  return { color: '#10b981', flashing: false };
}

function formatCountdown(remainingMs) {
  if (remainingMs <= 0) return { h: '00', m: '00', s: '00', expired: true };
  const totalSec = Math.floor(remainingMs / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return { h, m, s, expired: false };
}

const SLACountdown = ({
  deadline = null,
  label = 'SLA',
  size = 'md',
  variant = 'clock',
  totalMinutes = 60,
}) => {
  const [now, setNow] = useState(Date.now());
  const [visible, setVisible] = useState(false);
  const intervalRef = useRef(null);

  useEffect(() => {
    injectKeyframes();
    requestAnimationFrame(() => setVisible(true));
    // Tick every second for live countdown
    intervalRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(intervalRef.current);
  }, []);

  if (!deadline) return null;

  const sizeConf = SIZE_CONFIG[size] || SIZE_CONFIG.md;
  const deadlineMs = deadline instanceof Date ? deadline.getTime() : new Date(deadline).getTime();
  const totalMs = totalMinutes * 60 * 1000;
  const remainingMs = Math.max(deadlineMs - now, 0);
  const pct = totalMs > 0 ? Math.max(remainingMs / totalMs, 0) : 0;
  const { color, flashing } = getColourForPct(pct);
  const time = formatCountdown(remainingMs);

  // Badge variant
  if (variant === 'badge') {
    const minsLeft = Math.max(Math.ceil(remainingMs / 60000), 0);
    const badgeText = time.expired
      ? 'EXPIRED'
      : minsLeft >= 60
        ? `${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m left`
        : `${minsLeft}m left`;

    return (
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: sizeConf.padding,
        borderRadius: 100,
        background: `${color}15`,
        border: `1px solid ${color}30`,
        fontFamily: MONO,
        fontSize: sizeConf.fontSize * 0.5,
        fontWeight: 700,
        color,
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.4s ease-out',
        letterSpacing: '0.5px',
        animation: flashing ? 'slaCountdownFlash 1s ease-in-out infinite' : 'none',
      }}>
        {label && (
          <span style={{ opacity: 0.7, fontSize: sizeConf.fontSize * 0.4 }}>
            {label}
          </span>
        )}
        <span>{badgeText}</span>
        {flashing && (
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            backgroundColor: color,
            animation: 'slaCountdownBlink 1s ease-in-out infinite',
          }} />
        )}
      </div>
    );
  }

  // Bar variant
  if (variant === 'bar') {
    const minsLeft = Math.max(Math.ceil(remainingMs / 60000), 0);

    return (
      <div style={{
        width: sizeConf.barWidth, maxWidth: '100%',
        fontFamily: FONT,
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.4s ease-out',
      }}>
        {label && (
          <div style={{
            display: 'flex', justifyContent: 'space-between', marginBottom: 6,
          }}>
            <span style={{
              fontSize: 10, fontFamily: MONO, fontWeight: 700,
              color: 'rgba(255,255,255,0.6)', letterSpacing: '1px',
            }}>
              {label.toUpperCase()} DEADLINE
            </span>
            <span style={{
              fontSize: 10, fontFamily: MONO, fontWeight: 600, color,
              animation: flashing ? 'slaCountdownFlash 1s ease-in-out infinite' : 'none',
            }}>
              {time.expired ? 'EXPIRED' : `${time.h}:${time.m}:${time.s}`}
            </span>
          </div>
        )}

        {/* Bar track */}
        <div style={{
          width: '100%', height: sizeConf.barHeight,
          borderRadius: sizeConf.barHeight,
          background: 'rgba(255,255,255,0.06)', overflow: 'hidden',
        }}>
          <div style={{
            width: `${Math.min(pct * 100, 100)}%`,
            height: '100%',
            borderRadius: sizeConf.barHeight,
            background: color,
            transition: 'width 1s linear, background 0.3s',
          }} />
        </div>

        {/* Time markers */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
          <span style={{ fontSize: 8, fontFamily: MONO, color: 'rgba(255,255,255,0.6)' }}>
            0m
          </span>
          <span style={{ fontSize: 8, fontFamily: MONO, color: 'rgba(255,255,255,0.6)' }}>
            {totalMinutes}m
          </span>
        </div>
      </div>
    );
  }

  // Clock variant (default)
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
      fontFamily: MONO,
      opacity: visible ? 1 : 0,
      transition: 'opacity 0.4s ease-out',
    }}>
      {label && (
        <div style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '2px',
          color: 'rgba(255,255,255,0.6)',
        }}>
          {label.toUpperCase()} COUNTDOWN
        </div>
      )}

      <div style={{
        display: 'flex', alignItems: 'center', gap: 2,
        padding: sizeConf.padding,
        borderRadius: 12,
        background: time.expired ? `${color}10` : 'rgba(255,255,255,0.02)',
        border: `1px solid ${color}25`,
        animation: flashing ? 'slaCountdownFlash 1s ease-in-out infinite' : 'none',
      }}>
        {/* Hours */}
        <div style={{
          fontSize: sizeConf.fontSize, fontWeight: 700, color,
          minWidth: sizeConf.fontSize * 1.4, textAlign: 'center',
        }}>
          {time.expired ? '--' : time.h}
        </div>
        <div style={{
          fontSize: sizeConf.fontSize * 0.8, color, fontWeight: 700, opacity: 0.7,
          animation: !time.expired ? 'slaCountdownBlink 1s ease-in-out infinite' : 'none',
        }}>
          :
        </div>

        {/* Minutes */}
        <div style={{
          fontSize: sizeConf.fontSize, fontWeight: 700, color,
          minWidth: sizeConf.fontSize * 1.4, textAlign: 'center',
        }}>
          {time.expired ? '--' : time.m}
        </div>
        <div style={{
          fontSize: sizeConf.fontSize * 0.8, color, fontWeight: 700, opacity: 0.7,
          animation: !time.expired ? 'slaCountdownBlink 1s ease-in-out infinite' : 'none',
        }}>
          :
        </div>

        {/* Seconds */}
        <div style={{
          fontSize: sizeConf.fontSize, fontWeight: 700, color,
          minWidth: sizeConf.fontSize * 1.4, textAlign: 'center',
        }}>
          {time.expired ? '--' : time.s}
        </div>
      </div>

      {/* Percent remaining */}
      <div style={{
        fontSize: 10, color: 'rgba(255,255,255,0.6)', letterSpacing: '0.5px',
      }}>
        {time.expired ? 'DEADLINE BREACHED' : `${Math.round(pct * 100)}% remaining`}
      </div>
    </div>
  );
};

export default SLACountdown;
