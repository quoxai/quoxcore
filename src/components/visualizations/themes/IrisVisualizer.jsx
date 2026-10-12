import { useState, useEffect, useRef, useMemo } from 'react'
import { getAudioEnergy, getStateConfig } from '../core/BaseVisualizer'

/**
 * IrisVisualizer - Hyper-realistic human iris with neural reactivity
 *
 * Uses per-state config for speed, scale, sensitivity, hue
 * Also has iris-specific per-state parameters (pupil size, animations)
 */
function IrisVisualizer({ state = 'idle', audioData = null, config = {} }) {
  const containerRef = useRef(null)
  const [dimensions, setDimensions] = useState({ width: 300, height: 300 })
  const [pupilOffset, setPupilOffset] = useState(0)

  // Get per-state config values
  const stateConfig = useMemo(() => getStateConfig(config, state), [config, state])

  // State-based parameters (uses per-state speed)
  const stateParams = useMemo(() => {
    const baseSpeed = stateConfig.speed || 1
    const params = {
      idle: {
        pupil: 0.30,
        spinDuration: 12 / baseSpeed,
        breathDuration: 7.2 / baseSpeed,
        twitchDuration: 0,
        jitterIntensity: 0
      },
      listening: {
        pupil: 0.38,
        spinDuration: 9 / baseSpeed,
        breathDuration: 4.5 / baseSpeed,
        twitchDuration: 0,
        jitterIntensity: 0.002
      },
      thinking: {
        pupil: 0.22,
        spinDuration: 4.2 / baseSpeed,
        breathDuration: 2.5 / baseSpeed,
        twitchDuration: 0.15 / baseSpeed,
        jitterIntensity: 0.005
      },
      speaking: {
        pupil: 0.28,
        spinDuration: 7 / baseSpeed,
        breathDuration: 3.5 / baseSpeed,
        twitchDuration: 0.08 / baseSpeed,
        jitterIntensity: 0.01
      }
    }
    return params[state] || params.idle
  }, [state, stateConfig.speed])

  // Audio-reactive pupil dilation (uses per-state sensitivity)
  useEffect(() => {
    if (audioData) {
      const energy = getAudioEnergy(audioData)
      setPupilOffset(energy * stateConfig.sensitivity * 0.15)
    } else {
      setPupilOffset(0)
    }
  }, [audioData, stateConfig.sensitivity])

  // Handle resize
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 0 && height > 0) {
          // Use the smaller dimension to maintain aspect ratio
          const size = Math.min(width, height)
          setDimensions({ width: size, height: size })
        }
      }
    })

    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [])

  // Calculate current pupil size
  const pupilSize = stateParams.pupil + pupilOffset
  const clampedPupil = Math.max(0.12, Math.min(0.52, pupilSize))

  // Get hue for current state (per-state)
  const hue = stateConfig.hue

  // Calculate sizing (uses per-state scale)
  const irisSize = Math.min(dimensions.width, dimensions.height) * 0.9 * stateConfig.scale

  return (
    <div
      ref={containerRef}
      className="iris-visualizer"
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden'
      }}
    >
      <div
        className={`iris-container iris-state-${state}`}
        style={{
          '--pupil': clampedPupil,
          '--iris-hue': hue,
          '--spin-duration': `${stateParams.spinDuration}s`,
          '--breath-duration': `${stateParams.breathDuration}s`,
          '--twitch-duration': `${stateParams.twitchDuration}s`,
          '--jitter-intensity': stateParams.jitterIntensity,
          '--iris-size': `${irisSize}px`
        }}
      >
        {/* Sclera (white of eye) */}
        <div className="iris-sclera">
          {/* Iris layers */}
          <div className="iris-outer">
            <div className="iris-fibers" />
            <div className="iris-collarette" />
            <div className="iris-crypts" />

            {/* Pupil */}
            <div className="iris-pupil">
              <div className="iris-pupil-inner" />
            </div>
          </div>

          {/* Glints/reflections */}
          <div className="iris-glints">
            <div className="iris-glint iris-glint-1" />
            <div className="iris-glint iris-glint-2" />
          </div>

          {/* Lid shadow/vignette */}
          <div className="iris-vignette" />
        </div>
      </div>

      <style>{`
        .iris-container {
          --pupil: 0.30;
          --iris-hue: 200;
          --spin-duration: 12s;
          --breath-duration: 7.2s;
          --twitch-duration: 0s;
          --jitter-intensity: 0;
          --iris-size: 300px;

          width: var(--iris-size);
          height: var(--iris-size);
          position: relative;
          border-radius: 50%;
        }

        .iris-sclera {
          width: 100%;
          height: 100%;
          border-radius: 50%;
          background: radial-gradient(
            circle at 50% 50%,
            #f8f4f0 0%,
            #e8e4e0 60%,
            #d0c8c0 85%,
            #a89890 100%
          );
          position: relative;
          overflow: hidden;
          box-shadow:
            inset 0 0 20px rgba(0, 0, 0, 0.3),
            0 0 30px rgba(0, 0, 0, 0.5);
          animation: iris-breathe var(--breath-duration) ease-in-out infinite;
        }

        .iris-outer {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 70%;
          height: 70%;
          border-radius: 50%;
          background: radial-gradient(
            circle at 50% 50%,
            hsl(var(--iris-hue), 45%, 25%) 0%,
            hsl(var(--iris-hue), 55%, 35%) 30%,
            hsl(var(--iris-hue), 60%, 40%) 50%,
            hsl(var(--iris-hue), 50%, 30%) 70%,
            hsl(var(--iris-hue), 40%, 20%) 85%,
            hsl(calc(var(--iris-hue) + 10), 30%, 15%) 100%
          );
          box-shadow:
            inset 0 0 15px rgba(0, 0, 0, 0.5),
            0 0 5px rgba(0, 0, 0, 0.3);
          animation: iris-spin var(--spin-duration) linear infinite;
        }

        /* Iris fiber texture */
        .iris-fibers {
          position: absolute;
          inset: 0;
          border-radius: 50%;
          background:
            repeating-conic-gradient(
              from 0deg at 50% 50%,
              transparent 0deg,
              hsla(var(--iris-hue), 70%, 50%, 0.15) 1deg,
              transparent 2deg,
              hsla(var(--iris-hue), 60%, 60%, 0.1) 3deg,
              transparent 4deg
            );
          animation: iris-spin var(--spin-duration) linear infinite reverse;
          mix-blend-mode: overlay;
        }

        /* Collarette (ring around pupil) */
        .iris-collarette {
          position: absolute;
          inset: 20%;
          border-radius: 50%;
          background: radial-gradient(
            circle at 50% 50%,
            transparent 0%,
            transparent calc(var(--pupil) * 100% + 5%),
            hsla(calc(var(--iris-hue) + 20), 50%, 45%, 0.6) calc(var(--pupil) * 100% + 8%),
            hsla(var(--iris-hue), 40%, 35%, 0.3) calc(var(--pupil) * 100% + 15%),
            transparent calc(var(--pupil) * 100% + 25%)
          );
          mix-blend-mode: soft-light;
        }

        /* Crypts (darker spots in iris) */
        .iris-crypts {
          position: absolute;
          inset: 0;
          border-radius: 50%;
          background:
            radial-gradient(circle at 30% 25%, hsla(var(--iris-hue), 40%, 15%, 0.4) 0%, transparent 8%),
            radial-gradient(circle at 70% 30%, hsla(var(--iris-hue), 45%, 20%, 0.3) 0%, transparent 6%),
            radial-gradient(circle at 25% 60%, hsla(var(--iris-hue), 50%, 18%, 0.35) 0%, transparent 7%),
            radial-gradient(circle at 75% 65%, hsla(var(--iris-hue), 35%, 22%, 0.3) 0%, transparent 5%),
            radial-gradient(circle at 50% 75%, hsla(var(--iris-hue), 40%, 16%, 0.4) 0%, transparent 6%),
            radial-gradient(circle at 40% 40%, hsla(var(--iris-hue), 55%, 25%, 0.25) 0%, transparent 10%),
            radial-gradient(circle at 60% 55%, hsla(var(--iris-hue), 45%, 20%, 0.3) 0%, transparent 8%);
          animation: iris-spin calc(var(--spin-duration) * 1.5) linear infinite;
        }

        /* Pupil */
        .iris-pupil {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: calc(var(--pupil) * 100%);
          height: calc(var(--pupil) * 100%);
          border-radius: 50%;
          background: radial-gradient(
            circle at 45% 45%,
            #1a1a1a 0%,
            #0a0a0a 60%,
            #000000 100%
          );
          box-shadow:
            0 0 10px rgba(0, 0, 0, 0.8),
            inset 0 0 5px rgba(0, 0, 0, 0.9);
          transition: width 0.3s ease-out, height 0.3s ease-out;
          animation: pupil-jitter 0.1s ease-in-out infinite;
        }

        .iris-pupil-inner {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 90%;
          height: 90%;
          border-radius: 50%;
          background: radial-gradient(
            circle at 50% 50%,
            rgba(0, 0, 0, 0) 0%,
            rgba(0, 0, 0, 0.3) 70%,
            rgba(0, 0, 0, 0.6) 100%
          );
        }

        /* Glints/reflections */
        .iris-glints {
          position: absolute;
          inset: 0;
          pointer-events: none;
        }

        .iris-glint {
          position: absolute;
          border-radius: 50%;
          background: radial-gradient(
            circle at 50% 50%,
            rgba(255, 255, 255, 0.95) 0%,
            rgba(255, 255, 255, 0.6) 40%,
            transparent 70%
          );
        }

        .iris-glint-1 {
          top: 18%;
          left: 28%;
          width: 15%;
          height: 12%;
          transform: rotate(-15deg);
        }

        .iris-glint-2 {
          top: 22%;
          left: 40%;
          width: 8%;
          height: 6%;
          opacity: 0.7;
        }

        /* Vignette/lid shadow */
        .iris-vignette {
          position: absolute;
          inset: 0;
          border-radius: 50%;
          background: radial-gradient(
            ellipse 100% 80% at 50% 10%,
            rgba(0, 0, 0, 0.4) 0%,
            transparent 50%
          ),
          radial-gradient(
            ellipse 100% 60% at 50% 100%,
            rgba(0, 0, 0, 0.3) 0%,
            transparent 40%
          ),
          radial-gradient(
            circle at 50% 50%,
            transparent 60%,
            rgba(0, 0, 0, 0.4) 100%
          );
          pointer-events: none;
        }

        /* Animations */
        @keyframes iris-spin {
          from { transform: translate(-50%, -50%) rotate(0deg); }
          to { transform: translate(-50%, -50%) rotate(360deg); }
        }

        @keyframes iris-breathe {
          0%, 100% {
            transform: scale(1);
            box-shadow:
              inset 0 0 20px rgba(0, 0, 0, 0.3),
              0 0 30px rgba(0, 0, 0, 0.5);
          }
          50% {
            transform: scale(1.02);
            box-shadow:
              inset 0 0 25px rgba(0, 0, 0, 0.35),
              0 0 40px rgba(0, 0, 0, 0.4);
          }
        }

        @keyframes iris-twitch {
          0%, 90%, 100% { transform: translate(-50%, -50%); }
          92% { transform: translate(calc(-50% + 2px), calc(-50% - 1px)); }
          95% { transform: translate(calc(-50% - 1px), calc(-50% + 1px)); }
          97% { transform: translate(calc(-50% + 1px), calc(-50% + 2px)); }
        }

        @keyframes pupil-jitter {
          0%, 100% {
            transform: translate(-50%, -50%) translate(0, 0);
          }
          25% {
            transform: translate(-50%, -50%) translate(
              calc(var(--jitter-intensity) * 100px),
              calc(var(--jitter-intensity) * -50px)
            );
          }
          50% {
            transform: translate(-50%, -50%) translate(
              calc(var(--jitter-intensity) * -75px),
              calc(var(--jitter-intensity) * 75px)
            );
          }
          75% {
            transform: translate(-50%, -50%) translate(
              calc(var(--jitter-intensity) * 50px),
              calc(var(--jitter-intensity) * 100px)
            );
          }
        }

        /* State-specific overrides */
        .iris-state-thinking .iris-outer {
          animation:
            iris-spin var(--spin-duration) linear infinite,
            iris-twitch 2s ease-in-out infinite;
        }

        .iris-state-thinking .iris-sclera {
          animation: iris-breathe var(--breath-duration) ease-in-out infinite;
        }

        .iris-state-speaking .iris-outer {
          animation:
            iris-spin var(--spin-duration) linear infinite;
        }

        .iris-state-speaking .iris-pupil {
          animation: pupil-jitter 0.05s ease-in-out infinite;
        }

        .iris-state-speaking .iris-sclera {
          animation: iris-breathe var(--breath-duration) ease-in-out infinite;
        }

        .iris-state-listening .iris-pupil {
          animation: pupil-jitter 0.15s ease-in-out infinite;
        }

        .iris-state-idle .iris-pupil {
          animation: none;
        }

        /* Responsive scaling */
        @media (max-width: 400px) {
          .iris-glint-1 {
            width: 12%;
            height: 10%;
          }
          .iris-glint-2 {
            width: 6%;
            height: 5%;
          }
        }
      `}</style>
    </div>
  )
}

export default IrisVisualizer
