/**
 * AdvancedMemoryFeatureCard Component
 *
 * Premium featured card for the Advanced Memory plugin.
 * Designed to showcase the plugin as the flagship memory upgrade.
 *
 * "Give Your AI a Brain" - Transform stateless chatbots into
 * intelligent assistants that truly remember.
 */

import React from 'react'

// Feature icons as simple SVG components
const icons = {
  brain: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 4.5c-1.5-1.5-4-1.5-5.5 0s-1.5 4 0 5.5c-2 1-3 3.5-2 5.5s3.5 3 5.5 2c1.5 1.5 4 1.5 5.5 0s1.5-4 0-5.5c2-1 3-3.5 2-5.5s-3.5-3-5.5-2z"/>
      <path d="M12 4.5v15"/>
      <path d="M6.5 10h11"/>
      <path d="M8 15h8"/>
    </svg>
  ),
  infinity: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.739-8-4.781 0-4.781 8 0 8 5.606 0 7.644-8 12.74-8z"/>
    </svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="11" cy="11" r="8"/>
      <path d="m21 21-4.35-4.35"/>
    </svg>
  ),
  palette: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10"/>
      <circle cx="12" cy="8" r="1.5" fill="currentColor"/>
      <circle cx="8" cy="12" r="1.5" fill="currentColor"/>
      <circle cx="16" cy="12" r="1.5" fill="currentColor"/>
      <circle cx="12" cy="16" r="1.5" fill="currentColor"/>
    </svg>
  ),
  upload: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17,8 12,3 7,8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="20,6 9,17 4,12"/>
    </svg>
  ),
  sparkles: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/>
      <path d="M5 19l.5 1.5L7 21l-1.5.5L5 23l-.5-1.5L3 21l1.5-.5L5 19z"/>
      <path d="M19 13l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5.5-1.5z"/>
    </svg>
  )
}

const highlightFeatures = [
  { icon: 'infinity', label: 'Unlimited Memory', desc: 'No more 10-item limit' },
  { icon: 'search', label: 'Semantic Search', desc: 'Find by meaning' },
  { icon: 'palette', label: 'Style Learning', desc: 'AI adapts to you' },
  { icon: 'upload', label: 'ChatGPT Import', desc: 'Bring your history' }
]

export default function AdvancedMemoryFeatureCard({
  onActivate,
  onGetTrial,
  isLicensed = false,
  isEnabled = false,
  daysRemaining = null
}) {
  return (
    <div className="amfc-container">
      {/* Badge */}
      <div className="amfc-badge">
        <span className="amfc-badge-icon">{icons.sparkles}</span>
        <span>MOST POPULAR</span>
      </div>

      {/* Header */}
      <div className="amfc-header">
        <div className="amfc-icon-wrapper">
          <div className="amfc-icon">{icons.brain}</div>
          <div className="amfc-icon-glow" />
        </div>
        <div className="amfc-title-group">
          <h2 className="amfc-title">Advanced Memory</h2>
          <p className="amfc-tagline">Give Your AI a Brain</p>
        </div>
        <div className="amfc-price-group">
          <span className="amfc-price">$99</span>
          <span className="amfc-price-note">one-time</span>
        </div>
      </div>

      {/* Description */}
      <p className="amfc-description">
        Transform your AI from a stateless chatbot into a truly intelligent assistant
        that remembers everything. Bring together memories from all your LLMs into one unified brain.
      </p>

      {/* Feature Grid */}
      <div className="amfc-features">
        {highlightFeatures.map((feat, i) => (
          <div key={i} className="amfc-feature">
            <div className="amfc-feature-icon">{icons[feat.icon]}</div>
            <div className="amfc-feature-content">
              <span className="amfc-feature-label">{feat.label}</span>
              <span className="amfc-feature-desc">{feat.desc}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Comparison */}
      <div className="amfc-comparison">
        <div className="amfc-compare-col free">
          <div className="amfc-compare-header">Free</div>
          <ul className="amfc-compare-list">
            <li><span className="limit">10</span> memories</li>
            <li><span className="limit">3</span> preferences</li>
            <li><span className="limit">500</span> token context</li>
            <li className="disabled">Keyword search only</li>
          </ul>
        </div>
        <div className="amfc-compare-col premium">
          <div className="amfc-compare-header">Premium</div>
          <ul className="amfc-compare-list">
            <li><span className="unlimited">{icons.check} Unlimited</span> memories</li>
            <li><span className="unlimited">{icons.check} Unlimited</span> preferences</li>
            <li><span className="unlimited">{icons.check} 4000+</span> token context</li>
            <li className="highlight">Semantic AI search</li>
          </ul>
        </div>
      </div>

      {/* CTA */}
      <div className="amfc-cta">
        {isLicensed && isEnabled ? (
          <div className="amfc-active-status">
            <span className="amfc-active-dot" />
            <span>Active</span>
            {daysRemaining && <span className="amfc-days">({daysRemaining} days left)</span>}
          </div>
        ) : isLicensed ? (
          <button className="amfc-btn enable" onClick={onActivate}>
            Enable Plugin
          </button>
        ) : (
          <>
            <button className="amfc-btn primary" onClick={onActivate}>
              Purchase - $99
            </button>
            <button className="amfc-btn secondary" onClick={onGetTrial}>
              Try Free for 30 Days
            </button>
          </>
        )}
      </div>

      {/* Post-activation guidance */}
      {isLicensed && isEnabled && (
        <div className="amfc-guidance">
          <div className="amfc-guidance-header">
            <span className="amfc-guidance-icon">{icons.sparkles}</span>
            <span>Getting Started</span>
          </div>
          <div className="amfc-guidance-content">
            <p>Advanced Memory is now active. Here's how to get the most out of it:</p>
            <ul className="amfc-guidance-list">
              <li>
                <strong>Configure visualizers:</strong>{' '}
                <span className="amfc-nav-path">Assistants → Configure → Visualiser</span>
              </li>
              <li>
                <strong>Import ChatGPT:</strong>{' '}
                <span className="amfc-nav-path">Memory → Import → ChatGPT Export</span>
              </li>
              <li>
                <strong>View your memory:</strong>{' '}
                <span className="amfc-nav-path">Memory dashboard</span> now shows unlimited items
              </li>
            </ul>
          </div>
        </div>
      )}

      <style>{`
        .amfc-container {
          position: relative;
          background: linear-gradient(
            135deg,
            rgba(157, 78, 221, 0.15) 0%,
            rgba(255, 107, 107, 0.08) 50%,
            rgba(255, 191, 105, 0.05) 100%
          );
          border: 1px solid rgba(157, 78, 221, 0.3);
          border-radius: 16px;
          padding: 28px;
          overflow: hidden;
          backdrop-filter: blur(12px);
          transition: all 0.3s ease;
        }

        .amfc-container::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 1px;
          background: linear-gradient(
            90deg,
            transparent,
            rgba(157, 78, 221, 0.5),
            rgba(255, 191, 105, 0.5),
            transparent
          );
        }

        .amfc-container:hover {
          border-color: rgba(157, 78, 221, 0.5);
          box-shadow:
            0 8px 32px rgba(157, 78, 221, 0.15),
            0 0 0 1px rgba(157, 78, 221, 0.1);
        }

        .amfc-badge {
          position: absolute;
          top: 16px;
          right: 16px;
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          background: linear-gradient(135deg, #9d4edd, #a78bfa);
          border-radius: 100px;
          font-size: 0.65rem;
          font-weight: 700;
          letter-spacing: 0.1em;
          color: white;
          text-transform: uppercase;
        }

        .amfc-badge-icon {
          width: 14px;
          height: 14px;
        }

        .amfc-badge-icon svg {
          width: 100%;
          height: 100%;
        }

        .amfc-header {
          display: flex;
          align-items: center;
          gap: 16px;
          margin-bottom: 20px;
        }

        .amfc-icon-wrapper {
          position: relative;
          flex-shrink: 0;
        }

        .amfc-icon {
          width: 56px;
          height: 56px;
          padding: 12px;
          background: linear-gradient(135deg, rgba(157, 78, 221, 0.3), rgba(255, 107, 107, 0.2));
          border: 1px solid rgba(157, 78, 221, 0.4);
          border-radius: 14px;
          color: #c084fc;
          position: relative;
          z-index: 1;
        }

        .amfc-icon svg {
          width: 100%;
          height: 100%;
        }

        .amfc-icon-glow {
          position: absolute;
          inset: -8px;
          background: radial-gradient(circle, rgba(157, 78, 221, 0.4), transparent 70%);
          border-radius: 20px;
          filter: blur(8px);
          opacity: 0.6;
          animation: pulse 3s ease-in-out infinite;
        }

        @keyframes pulse {
          0%, 100% { opacity: 0.4; transform: scale(1); }
          50% { opacity: 0.7; transform: scale(1.05); }
        }

        .amfc-title-group {
          flex: 1;
        }

        .amfc-title {
          margin: 0;
          font-size: 1.5rem;
          font-weight: 700;
          color: #f5f5f5;
          letter-spacing: -0.02em;
        }

        .amfc-tagline {
          margin: 4px 0 0;
          font-size: 0.9rem;
          color: #c084fc;
          font-weight: 500;
        }

        .amfc-price-group {
          text-align: right;
        }

        .amfc-price {
          display: block;
          font-size: 2rem;
          font-weight: 800;
          background: linear-gradient(135deg, #c084fc, #ffbf69);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }

        .amfc-price-note {
          font-size: 0.75rem;
          color: #71717a;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .amfc-description {
          margin: 0 0 24px;
          font-size: 0.95rem;
          line-height: 1.6;
          color: #a1a1aa;
        }

        .amfc-features {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 12px;
          margin-bottom: 24px;
        }

        .amfc-feature {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 14px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 10px;
          transition: all 0.2s ease;
        }

        .amfc-feature:hover {
          background: rgba(157, 78, 221, 0.1);
          border-color: rgba(157, 78, 221, 0.2);
        }

        .amfc-feature-icon {
          width: 32px;
          height: 32px;
          padding: 6px;
          background: rgba(157, 78, 221, 0.2);
          border-radius: 8px;
          color: #c084fc;
          flex-shrink: 0;
        }

        .amfc-feature-icon svg {
          width: 100%;
          height: 100%;
        }

        .amfc-feature-content {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .amfc-feature-label {
          font-size: 0.85rem;
          font-weight: 600;
          color: #e4e4e7;
        }

        .amfc-feature-desc {
          font-size: 0.75rem;
          color: #71717a;
        }

        .amfc-comparison {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
          margin-bottom: 24px;
        }

        .amfc-compare-col {
          padding: 16px;
          border-radius: 12px;
        }

        .amfc-compare-col.free {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.06);
        }

        .amfc-compare-col.premium {
          background: linear-gradient(135deg, rgba(157, 78, 221, 0.15), rgba(255, 191, 105, 0.08));
          border: 1px solid rgba(157, 78, 221, 0.25);
        }

        .amfc-compare-header {
          font-size: 0.75rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          margin-bottom: 12px;
          color: #71717a;
        }

        .amfc-compare-col.premium .amfc-compare-header {
          color: #c084fc;
        }

        .amfc-compare-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .amfc-compare-list li {
          font-size: 0.8rem;
          color: #a1a1aa;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .amfc-compare-list li.disabled {
          color: #52525b;
        }

        .amfc-compare-list li.highlight {
          color: #c084fc;
          font-weight: 500;
        }

        .amfc-compare-list .limit {
          color: #71717a;
          font-weight: 600;
        }

        .amfc-compare-list .unlimited {
          color: #34d399;
          font-weight: 600;
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }

        .amfc-compare-list .unlimited svg {
          width: 14px;
          height: 14px;
        }

        .amfc-cta {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
        }

        .amfc-btn {
          flex: 1;
          min-width: 140px;
          padding: 14px 24px;
          border-radius: 10px;
          font-size: 0.9rem;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s ease;
          border: none;
        }

        .amfc-btn.primary {
          background: linear-gradient(135deg, #9d4edd, #c084fc);
          color: white;
          box-shadow: 0 4px 16px rgba(157, 78, 221, 0.3);
        }

        .amfc-btn.primary:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 24px rgba(157, 78, 221, 0.4);
        }

        .amfc-btn.secondary {
          background: rgba(255, 255, 255, 0.05);
          color: #a1a1aa;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .amfc-btn.secondary:hover {
          background: rgba(255, 255, 255, 0.08);
          color: #e4e4e7;
        }

        .amfc-btn.enable {
          background: rgba(52, 211, 153, 0.1);
          color: #34d399;
          border: 1px solid rgba(52, 211, 153, 0.3);
        }

        .amfc-btn.enable:hover {
          background: rgba(52, 211, 153, 0.2);
        }

        .amfc-active-status {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px 20px;
          background: rgba(52, 211, 153, 0.1);
          border: 1px solid rgba(52, 211, 153, 0.3);
          border-radius: 10px;
          color: #34d399;
          font-weight: 600;
          font-size: 0.9rem;
        }

        .amfc-active-dot {
          width: 8px;
          height: 8px;
          background: #34d399;
          border-radius: 50%;
          box-shadow: 0 0 8px rgba(52, 211, 153, 0.6);
          animation: blink 2s ease-in-out infinite;
        }

        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        .amfc-days {
          color: #71717a;
          font-weight: 400;
        }

        /* Post-activation guidance */
        .amfc-guidance {
          margin-top: 20px;
          padding: 18px;
          background: rgba(52, 211, 153, 0.06);
          border: 1px solid rgba(52, 211, 153, 0.2);
          border-radius: 12px;
        }

        .amfc-guidance-header {
          display: flex;
          align-items: center;
          gap: 8px;
          font-weight: 600;
          color: #34d399;
          margin-bottom: 12px;
          font-size: 0.9rem;
        }

        .amfc-guidance-header span:first-child {
          width: 18px;
          height: 18px;
        }

        .amfc-guidance-header svg {
          width: 100%;
          height: 100%;
        }

        .amfc-guidance-content p {
          margin: 0 0 12px;
          font-size: 0.85rem;
          color: #a1a1aa;
        }

        .amfc-guidance-list {
          margin: 0;
          padding: 0;
          list-style: none;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .amfc-guidance-list li {
          font-size: 0.85rem;
          color: #a1a1aa;
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }

        .amfc-guidance-list li strong {
          color: #e4e4e7;
        }

        .amfc-nav-path {
          display: inline-flex;
          align-items: center;
          padding: 3px 10px;
          background: rgba(157, 78, 221, 0.15);
          border: 1px solid rgba(157, 78, 221, 0.25);
          border-radius: 6px;
          font-size: 0.8rem;
          color: #c084fc;
          font-family: ui-monospace, SFMono-Regular, monospace;
        }

        @media (max-width: 600px) {
          .amfc-features {
            grid-template-columns: 1fr;
          }

          .amfc-comparison {
            grid-template-columns: 1fr;
          }

          .amfc-header {
            flex-wrap: wrap;
          }

          .amfc-price-group {
            width: 100%;
            text-align: left;
            margin-top: 12px;
          }
        }
      `}</style>
    </div>
  )
}
