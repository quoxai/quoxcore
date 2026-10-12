/**
 * LoginSigil — login-only animated brand mark.
 *
 * Pure inline SVG. No canvas, no fillRect, no aura, no ring.
 * Just the horned-Q wordmark with a slowly shifting brand gradient
 * and a subtle scale breath. Nothing paints behind the glyph.
 */

import './LoginSigil.css'

export default function LoginSigil({ size = 140 }) {
    const h = Math.round(size * (740 / 620))
    return (
        <svg
            className="login-sigil"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 620 740"
            width={size}
            height={h}
            aria-hidden
        >
            <defs>
                <linearGradient id="login-sigil-grad" x1="0" y1="0" x2="620" y2="0" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="#38bdf8">
                        <animate attributeName="stop-color" values="#38bdf8;#6366f1;#a855f7;#6366f1;#38bdf8" dur="9s" repeatCount="indefinite" />
                    </stop>
                    <stop offset="55%" stopColor="#6366f1">
                        <animate attributeName="stop-color" values="#6366f1;#a855f7;#38bdf8;#a855f7;#6366f1" dur="9s" repeatCount="indefinite" />
                    </stop>
                    <stop offset="100%" stopColor="#a855f7">
                        <animate attributeName="stop-color" values="#a855f7;#38bdf8;#6366f1;#38bdf8;#a855f7" dur="9s" repeatCount="indefinite" />
                    </stop>
                </linearGradient>
            </defs>
            <g transform="translate(96,30) scale(0.72)">
                <path d="M450.532 359.603L400.532 273C565.532 211.001 473.032 164 488.532 94.5C504.032 25 546.032 0 546.032 0C546.032 0 521.173 49.0536 522.532 85.5C524.38 135.078 577.449 175.548 576.032 227.5C573.947 303.958 450.532 359.603 450.532 359.603Z" fill="url(#login-sigil-grad)" />
                <path d="M125.528 359.603L175.528 273C10.5279 211.001 103.028 164 87.5279 94.5C72.0279 25 30.0279 0 30.0279 0C30.0279 0 54.8869 49.0536 53.5279 85.5C51.6792 135.078 -1.38893 175.548 0.0278679 227.5C2.113 303.958 125.528 359.603 125.528 359.603Z" fill="url(#login-sigil-grad)" />
            </g>
            <g transform="translate(50,200)">
                <path d="M262.181 1.92871C284.097 2.34428 321.484 3.59138 348.179 7.35156C400.234 14.6836 431.354 36.4934 464.679 77.9629C511.474 136.194 506.182 266.278 506.179 266.352H506.035C506.405 278.968 508.307 382.893 472.884 441.409L537.178 497.719L529.178 566.719H427.178L377.932 517.592C368.718 520.411 358.808 522.563 347.994 524.086C321.446 527.825 284.325 529.078 262.361 529.501V529.719C262.361 529.719 258.937 529.716 253.178 529.646C247.426 529.716 244.003 529.719 243.994 529.719V529.501C222.03 529.078 184.909 527.825 158.361 524.086C106.307 516.754 75.1863 494.944 41.8611 453.475C-2.24106 398.594 -0.0773581 279.892 0.320081 266.352H0.181409C0.178448 266.279 -5.11349 136.194 41.6814 77.9629C75.0066 36.4934 106.127 14.6836 158.181 7.35156C184.877 3.59139 222.263 2.34428 244.179 1.92871V1.71875C244.188 1.71875 247.539 1.72075 253.18 1.78809C258.829 1.72067 262.181 1.71875 262.181 1.71875V1.92871ZM253.18 84.8887C211.412 85.2342 162.416 88.5837 138.181 112.352C112.356 137.68 106.629 202.685 106.68 265.086H106.861C106.732 327.871 112.361 393.586 138.361 419.086C162.56 442.819 211.449 446.192 253.178 446.546C269.601 446.407 287.132 445.8 303.832 443.668L234.178 374.181V316.719H330.511L389.933 368.762C395.717 338.812 396.569 301.457 396.494 265.086H396.68C396.771 202.685 394.005 137.68 368.179 112.352C343.945 88.5837 294.949 85.2342 253.18 84.8887Z" fill="url(#login-sigil-grad)" />
            </g>
        </svg>
    )
}
