/**
 * SettingDependencyTree — renders the upstream/downstream dependency
 * graph for a setting so REGULA can show "what depends on X" inline
 * in the chat sidebar or on a settings panel.
 *
 * Phase 4 of SET-REGULA. Reads from settingsRegistry.getDependencyGraph().
 */

import { explainSetting, getDependencyGraph } from '../../config/settingsRegistry'
import './setting-dependency-tree.css'

function SeverityBadge({ destructive, hitlRequired }) {
  if (destructive) {
    return <span className="sdt__badge sdt__badge--destructive">destructive</span>
  }
  if (hitlRequired) {
    return <span className="sdt__badge sdt__badge--hitl">HITL</span>
  }
  return null
}

function DependencyNode({ setting, direction, onSelect }) {
  const arrow = direction === 'upstream' ? '↑' : '↓'
  return (
    <li className="sdt__node">
      <button
        type="button"
        className="sdt__node-btn"
        onClick={() => onSelect && onSelect(setting.id)}
        title={`Jump to ${setting.label}`}
      >
        <span className="sdt__arrow" aria-hidden="true">{arrow}</span>
        <span className="sdt__node-label">{setting.label}</span>
        <span className="sdt__node-section">{setting.section}</span>
      </button>
    </li>
  )
}

export function SettingDependencyTree({ settingId, onSelectSetting, compact = false }) {
  const explanation = explainSetting(settingId)
  if (!explanation) {
    return (
      <div className="sdt sdt--empty">
        <p className="sdt__empty-text">No registry entry for <code>{settingId}</code>.</p>
      </div>
    )
  }

  const { upstream, downstream } = explanation.dependencies
  const hasDeps = upstream.length > 0 || downstream.length > 0

  return (
    <div className={`sdt ${compact ? 'sdt--compact' : ''}`}>
      <header className="sdt__header">
        <div className="sdt__title-row">
          <h4 className="sdt__title">{explanation.label}</h4>
          <SeverityBadge
            destructive={explanation.destructive}
            hitlRequired={explanation.hitlRequired}
          />
        </div>
        <div className="sdt__meta">
          <span className="sdt__section">{explanation.section}</span>
          <span className="sdt__sep">·</span>
          <span className="sdt__type">{explanation.type}</span>
        </div>
        <p className="sdt__summary">{explanation.summary}</p>
      </header>

      {!compact && (
        <div className="sdt__explanation">
          <p>{explanation.explanation}</p>
        </div>
      )}

      {!hasDeps && (
        <p className="sdt__no-deps">No dependencies recorded.</p>
      )}

      {upstream.length > 0 && (
        <section className="sdt__section-block">
          <h5 className="sdt__section-title">
            Affected by <span className="sdt__count">({upstream.length})</span>
          </h5>
          <ul className="sdt__list">
            {upstream.map(s => (
              <DependencyNode key={s.id} setting={s} direction="upstream" onSelect={onSelectSetting} />
            ))}
          </ul>
        </section>
      )}

      {downstream.length > 0 && (
        <section className="sdt__section-block">
          <h5 className="sdt__section-title">
            Affects <span className="sdt__count">({downstream.length})</span>
          </h5>
          <ul className="sdt__list">
            {downstream.map(s => (
              <DependencyNode key={s.id} setting={s} direction="downstream" onSelect={onSelectSetting} />
            ))}
          </ul>
        </section>
      )}

      {explanation.sideEffects.length > 0 && (
        <section className="sdt__section-block">
          <h5 className="sdt__section-title">
            Side effects <span className="sdt__count">({explanation.sideEffects.length})</span>
          </h5>
          <ul className="sdt__effects">
            {explanation.sideEffects.map((effect, i) => (
              <li key={i} className="sdt__effect">
                <span className="sdt__effect-dot" aria-hidden="true" />
                {effect}
              </li>
            ))}
          </ul>
        </section>
      )}

      {explanation.allowedValues && (
        <section className="sdt__section-block">
          <h5 className="sdt__section-title">Allowed values</h5>
          <ul className="sdt__allowed">
            {explanation.allowedValues.map(v => (
              <li key={v.value} className="sdt__allowed-row">
                <span className="sdt__allowed-label">{v.label}</span>
                {v.description && <span className="sdt__allowed-desc">{v.description}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

export function walkDependencyChain(settingId, { maxDepth = 3 } = {}) {
  if (!getDependencyGraph(settingId).upstream.length && !getDependencyGraph(settingId).downstream.length) {
    // Still run — might be unknown. Registry returns empty arrays for unknowns.
  }
  const chain = []

  function walk(id, depth, direction, visited) {
    if (depth > maxDepth || visited.has(id)) return
    visited.add(id)
    const graph = getDependencyGraph(id)
    const next = direction === 'upstream' ? graph.upstream : graph.downstream
    for (const node of next) {
      chain.push({ from: id, to: node.id, depth, direction })
      walk(node.id, depth + 1, direction, visited)
    }
  }

  walk(settingId, 1, 'downstream', new Set())
  walk(settingId, 1, 'upstream', new Set())
  return chain
}

export default SettingDependencyTree
