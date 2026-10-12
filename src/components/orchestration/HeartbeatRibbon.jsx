/**
 * HeartbeatRibbon — Full-width thin strip that pulses based on heartbeat state
 *
 * 4px tall. Green=fresh, amber=warming, red=stale/dead, grey=idle.
 *
 * @param {'fresh'|'warming'|'stale'|'dead'|'idle'} state
 */

const STATE_STYLES = {
  fresh:   { color: '#10b981', animation: 'hbBreathing 2s ease-in-out infinite' },
  warming: { color: '#f59e0b', animation: 'hbBreathing 1s ease-in-out infinite' },
  stale:   { color: '#ef4444', animation: 'none' },
  dead:    { color: '#ef4444', animation: 'hbBlink 0.5s step-end infinite' },
  idle:    { color: '#52525b', animation: 'none' },
}

export default function HeartbeatRibbon({ state = 'idle' }) {
  const s = STATE_STYLES[state] || STATE_STYLES.idle

  return (
    <>
      <div style={{
        width: '100%',
        height: 4,
        background: s.color,
        opacity: state === 'idle' ? 0.3 : 0.7,
        animation: s.animation,
        borderRadius: 2,
      }} />
      <style>{`
        @keyframes hbBreathing {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 1; }
        }
        @keyframes hbBlink {
          0%, 49% { opacity: 1; }
          50%, 100% { opacity: 0.3; }
        }
      `}</style>
    </>
  )
}
