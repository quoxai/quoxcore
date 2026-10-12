/**
 * LoginEyeBackdrop — large HAL-eye-style graphic that sits BEHIND the
 * login glass card as the page backdrop.
 *
 * Ported from quox-website's HalEyeHero (src/components/landing/) but:
 *   - HUD text overlays REMOVED ("QUOX-9000", state strings)
 *   - useScrollReveal removed — always visible (no scroll on /login)
 *   - State auto-cycle removed — sits in idle perpetually
 *
 * Pure CSS animation; no canvas, no audio reactivity.
 */

import { useEffect, useState } from 'react'

export default function LoginEyeBackdrop() {
    const [particles, setParticles] = useState([])

    useEffect(() => {
        const make = () => ({
            id: Math.random(),
            x: Math.random() * 100,
            y: Math.random() * 100,
            size: 2 + Math.random() * 4,
            duration: 3 + Math.random() * 4,
            delay: Math.random() * 2,
        })
        setParticles(Array.from({ length: 18 }, make))

        const interval = setInterval(() => {
            setParticles(prev => {
                const next = [...prev]
                next[Math.floor(Math.random() * next.length)] = make()
                return next
            })
        }, 600)
        return () => clearInterval(interval)
    }, [])

    return (
        <div className="login-eye-hero" aria-hidden>
            <div className="login-eye-atmosphere" />
            <div className="login-eye-atmosphere login-eye-atmosphere-2" />

            <div className="login-eye-data-field">
                {particles.map(p => (
                    <div
                        key={p.id}
                        className="login-eye-particle"
                        style={{
                            left: `${p.x}%`,
                            top: `${p.y}%`,
                            width: p.size,
                            height: p.size,
                            animationDuration: `${p.duration}s`,
                            animationDelay: `${p.delay}s`,
                        }}
                    />
                ))}
            </div>

            <div className="login-eye-housing">
                <div className="login-eye-housing-ring" />
                <div className="login-eye-housing-ring login-eye-housing-ring-2" />
                <div className="login-eye-housing-ring login-eye-housing-ring-3" />
                <div className="login-eye-housing-notch" style={{ '--notch-angle': '0deg' }} />
                <div className="login-eye-housing-notch" style={{ '--notch-angle': '90deg' }} />
                <div className="login-eye-housing-notch" style={{ '--notch-angle': '180deg' }} />
                <div className="login-eye-housing-notch" style={{ '--notch-angle': '270deg' }} />
            </div>

            <div className="login-eye-scanner">
                <div className="login-eye-scan-ring" />
                <div className="login-eye-scan-ring login-eye-scan-ring-2" />
                <div className="login-eye-scan-ray" />
                <div className="login-eye-scan-ray login-eye-scan-ray-2" />
            </div>

            <div className="login-eye-main">
                <div className="login-eye-lens-outer">
                    <div className="login-eye-lens-reflection" />
                    <div className="login-eye-lens-reflection login-eye-lens-reflection-2" />
                </div>

                <div className="login-eye-iris">
                    {Array.from({ length: 12 }).map((_, i) => (
                        <div
                            key={i}
                            className="login-eye-iris-segment"
                            style={{ '--segment-angle': `${i * 30}deg` }}
                        />
                    ))}
                    <div className="login-eye-iris-ring" />
                    <div className="login-eye-iris-ring login-eye-iris-ring-2" />
                </div>

                <div className="login-eye-pupil">
                    <div className="login-eye-pupil-inner" />
                    <div className="login-eye-pupil-glow" />
                    <div className="login-eye-pupil-highlight" />
                </div>

                <div className="login-eye-core" />
            </div>

            <svg className="login-eye-diagnostics" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="35" className="login-eye-diag-circle" />
                <circle cx="50" cy="50" r="42" className="login-eye-diag-circle login-eye-diag-circle-2" />
                <line x1="50" y1="5" x2="50" y2="15" className="login-eye-diag-tick" />
                <line x1="50" y1="85" x2="50" y2="95" className="login-eye-diag-tick" />
                <line x1="5" y1="50" x2="15" y2="50" className="login-eye-diag-tick" />
                <line x1="85" y1="50" x2="95" y2="50" className="login-eye-diag-tick" />
            </svg>
        </div>
    )
}
