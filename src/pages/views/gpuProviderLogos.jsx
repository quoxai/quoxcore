/**
 * gpuProviderLogos — small inline-SVG brand marks for the GPU rental
 * deep-link cards in GpuSetupView's Match step.
 *
 * Inline SVG only (no external images / no hotlinking — CSP + offline-safe).
 * TODO: swap these for OFFICIAL brand SVGs — the marks below are recognizable
 * approximations, NOT exact reproductions of the providers' trademarks.
 * Official assets to drop in here:
 *   RunPod  — https://www.runpod.io/brandkit
 *   Lambda  — https://brandfetch.com/lambdalabs.com  (or lambda.ai)
 *   Vast.ai — no public brand kit; request the SVG from the provider
 * Paste each provider's official <path>/viewBox in, keeping the {size}/{title}
 * props + <title> for a11y.
 */

export function RunPodLogo({ size = 20, title = 'RunPod' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" role="img" aria-label={title}>
      <title>{title}</title>
      <path
        d="M12 2 L20 7 L20 17 L12 22 L4 17 L4 7 Z"
        stroke="#8b5cf6"
        strokeWidth="1.6"
        strokeLinejoin="round"
        fill="rgba(139,92,246,0.16)"
      />
      <path d="M12 6.5 L16.5 9.2 L16.5 14.8 L12 17.5 L7.5 14.8 L7.5 9.2 Z" fill="#8b5cf6" />
    </svg>
  )
}

export function LambdaLogo({ size = 20, title = 'Lambda' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" role="img" aria-label={title}>
      <title>{title}</title>
      <path
        d="M6 4 H10.4 L18 20 H14.4 L11 12.9 L7.6 20 H4 L9.2 9.4 L6 4 Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function VastLogo({ size = 20, title = 'Vast.ai' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" role="img" aria-label={title}>
      <title>{title}</title>
      <circle cx="12" cy="12" r="9" stroke="#38bdf8" strokeWidth="1.6" fill="rgba(56,189,248,0.1)" />
      <path d="M8 15 L12 8 L16 15" stroke="#38bdf8" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M9.5 12.5 H14.5" stroke="#38bdf8" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
