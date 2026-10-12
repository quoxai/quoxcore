/**
 * RouterSettings - Smart Router Configuration Panel
 *
 * Comprehensive settings for the Smart Router including:
 * - Operating mode selection
 * - Global confidence thresholds
 * - Per-pattern configuration
 * - Blocklist/allowlist management
 *
 * Part of the Smart Router visibility enhancement initiative.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  getRouterConfig,
  updateRouterConfig,
  ROUTER_MODES,
  RISK_LEVELS,
  resetRouterConfig
} from '../../services/routerConfig'
import { getPatterns, getRouterStats } from '../../services/quoxRouter'
import SettingsSection from '../settings/SettingsSection'
import SettingsCard, { SettingsGroup } from '../settings/SettingsCard'
import { SettingItem, FormField } from '../ui/Input'
import Button from '../ui/Button'
import { PatternTester } from './PatternTester'
import { RouterAuditLog } from './RouterAuditLog'
import './router.css'

/**
 * RouterSettings Component
 */
export function RouterSettings({ onNotification }) {
  const [config, setConfig] = useState(null)
  const [patterns, setPatterns] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [selectedPattern, setSelectedPattern] = useState(null)
  const [blocklist, setBlocklist] = useState([])
  const [allowlist, setAllowlist] = useState([])
  const [newBlockItem, setNewBlockItem] = useState('')
  const [newAllowItem, setNewAllowItem] = useState('')

  // Load configuration
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const configData = getRouterConfig()
        const patternData = getPatterns()
        const statsData = getRouterStats()

        setConfig(configData)
        setPatterns(patternData)
        setStats(statsData)
        setBlocklist(configData.blocklist || [])
        setAllowlist(configData.allowlist || [])
      } catch (err) {
        console.error('[RouterSettings] Load error:', err)
      } finally {
        setLoading(false)
      }
    }

    loadConfig()
  }, [])

  // Update config helper
  const handleConfigUpdate = useCallback((key, value) => {
    const newConfig = { ...config, [key]: value }
    setConfig(newConfig)
    updateRouterConfig({ [key]: value })
    onNotification?.('Router settings saved', 'success')
  }, [config, onNotification])

  // Update threshold helper
  const handleThresholdUpdate = useCallback((key, value) => {
    const newThresholds = { ...config.thresholds, [key]: value }
    handleConfigUpdate('thresholds', newThresholds)
  }, [config, handleConfigUpdate])

  // Update per-pattern threshold
  const handlePatternThresholdUpdate = useCallback((patternName, value) => {
    const newIntentThresholds = {
      ...config.intentThresholds,
      [patternName]: value
    }
    handleConfigUpdate('intentThresholds', newIntentThresholds)
  }, [config, handleConfigUpdate])

  // Toggle pattern enabled/disabled
  const handlePatternToggle = useCallback((patternName, enabled) => {
    const disabledPatterns = new Set(config.disabledPatterns || [])
    if (enabled) {
      disabledPatterns.delete(patternName)
    } else {
      disabledPatterns.add(patternName)
    }
    handleConfigUpdate('disabledPatterns', [...disabledPatterns])
  }, [config, handleConfigUpdate])

  // Add to blocklist
  const handleAddBlockItem = useCallback(() => {
    if (newBlockItem.trim() && !blocklist.includes(newBlockItem.trim())) {
      const newList = [...blocklist, newBlockItem.trim()]
      setBlocklist(newList)
      handleConfigUpdate('blocklist', newList)
      setNewBlockItem('')
    }
  }, [newBlockItem, blocklist, handleConfigUpdate])

  // Remove from blocklist
  const handleRemoveBlockItem = useCallback((item) => {
    const newList = blocklist.filter(i => i !== item)
    setBlocklist(newList)
    handleConfigUpdate('blocklist', newList)
  }, [blocklist, handleConfigUpdate])

  // Add to allowlist
  const handleAddAllowItem = useCallback(() => {
    if (newAllowItem.trim() && !allowlist.includes(newAllowItem.trim())) {
      const newList = [...allowlist, newAllowItem.trim()]
      setAllowlist(newList)
      handleConfigUpdate('allowlist', newList)
      setNewAllowItem('')
    }
  }, [newAllowItem, allowlist, handleConfigUpdate])

  // Remove from allowlist
  const handleRemoveAllowItem = useCallback((item) => {
    const newList = allowlist.filter(i => i !== item)
    setAllowlist(newList)
    handleConfigUpdate('allowlist', newList)
  }, [allowlist, handleConfigUpdate])

  // Reset to defaults
  const handleReset = useCallback(() => {
    if (confirm('Reset all router settings to defaults?')) {
      resetRouterConfig()
      setConfig(getRouterConfig())
      setBlocklist([])
      setAllowlist([])
      onNotification?.('Router settings reset to defaults', 'info')
    }
  }, [onNotification])

  // Get pattern stats
  const getPatternStats = useCallback((patternName) => {
    return stats?.patternStats?.[patternName] || { count: 0, escalations: 0, reformulations: 0 }
  }, [stats])

  if (loading) {
    return (
      <div className="router-settings-loading">
        Loading router configuration...
      </div>
    )
  }

  const disabledPatterns = new Set(config?.disabledPatterns || [])

  return (
    <div className="router-settings">
      {/* Operating Mode */}
      <SettingsSection
        title="Operating Mode"
        description="Control how aggressively the Smart Router intercepts queries"
      >
        <SettingsCard glass>
          <SettingsGroup>
            <FormField label="Router Mode" htmlFor="router-mode">
              <select
                id="router-mode"
                className="ui-input ui-select"
                value={config?.mode || 'STANDARD'}
                onChange={(e) => handleConfigUpdate('mode', e.target.value)}
              >
                <option value="STANDARD">Standard - Balanced routing</option>
                <option value="CONSERVATIVE">Conservative - Higher thresholds, fewer matches</option>
                <option value="AGGRESSIVE">Aggressive - Lower thresholds, more matches</option>
                <option value="OFF">Off - Disable router entirely</option>
              </select>
            </FormField>

            <div className="router-mode-description">
              {config?.mode === 'STANDARD' && (
                <p>Routes queries when confidence exceeds the minimum threshold. Recommended for most users.</p>
              )}
              {config?.mode === 'CONSERVATIVE' && (
                <p>Only routes queries with very high confidence. More queries will go to Claude.</p>
              )}
              {config?.mode === 'AGGRESSIVE' && (
                <p>Routes more queries with lower confidence thresholds. May increase false positives.</p>
              )}
              {config?.mode === 'OFF' && (
                <p>All queries bypass the router and go directly to Claude.</p>
              )}
            </div>
          </SettingsGroup>
        </SettingsCard>
      </SettingsSection>

      {/* Global Thresholds */}
      <SettingsSection
        title="Confidence Thresholds"
        description="Fine-tune when queries are routed vs passed to Claude"
      >
        <SettingsCard glass>
          <SettingsGroup>
            <div className="router-threshold-slider">
              <label htmlFor="min-confidence">
                Minimum Confidence: {Math.round((config?.thresholds?.confidence || 0.65) * 100)}%
              </label>
              <input
                type="range"
                id="min-confidence"
                min="0.3"
                max="0.9"
                step="0.05"
                value={config?.thresholds?.confidence || 0.65}
                onChange={(e) => handleThresholdUpdate('confidence', parseFloat(e.target.value))}
                className="router-slider"
              />
              <p className="router-threshold-help">
                Queries below this confidence will be passed to Claude
              </p>
            </div>

            <div className="router-threshold-slider">
              <label htmlFor="high-confidence">
                High Confidence: {Math.round((config?.thresholds?.highConfidence || 0.9) * 100)}%
              </label>
              <input
                type="range"
                id="high-confidence"
                min="0.7"
                max="1.0"
                step="0.05"
                value={config?.thresholds?.highConfidence || 0.9}
                onChange={(e) => handleThresholdUpdate('highConfidence', parseFloat(e.target.value))}
                className="router-slider"
              />
              <p className="router-threshold-help">
                Queries above this confidence route immediately without additional checks
              </p>
            </div>

            <div className="router-threshold-slider">
              <label htmlFor="ambiguity">
                Ambiguity Threshold: {Math.round((config?.thresholds?.ambiguity || 0.3) * 100)}%
              </label>
              <input
                type="range"
                id="ambiguity"
                min="0.1"
                max="0.5"
                step="0.05"
                value={config?.thresholds?.ambiguity || 0.3}
                onChange={(e) => handleThresholdUpdate('ambiguity', parseFloat(e.target.value))}
                className="router-slider"
              />
              <p className="router-threshold-help">
                When top patterns are within this gap, ask for clarification
              </p>
            </div>
          </SettingsGroup>
        </SettingsCard>
      </SettingsSection>

      {/* Per-Pattern Configuration */}
      <SettingsSection
        title="Pattern Configuration"
        description="Enable/disable patterns and adjust individual thresholds"
      >
        <SettingsCard glass>
          <div className="router-patterns-list">
            {patterns.map(pattern => {
              const patternStats = getPatternStats(pattern.name)
              const isDisabled = disabledPatterns.has(pattern.name)
              const threshold = config?.intentThresholds?.[pattern.name] || config?.thresholds?.confidence || 0.65

              return (
                <div
                  key={pattern.name}
                  className={`router-pattern-config ${isDisabled ? 'router-pattern-config--disabled' : ''}`}
                >
                  <div className="router-pattern-config-header">
                    <div className="router-pattern-config-info">
                      <span className="router-pattern-config-name">
                        {pattern.name.replace(/_/g, ' ')}
                      </span>
                      <span className="router-pattern-config-desc">
                        {pattern.description}
                      </span>
                    </div>
                    <div className="router-pattern-config-stats">
                      <span title="Total matches">{patternStats.count} matches</span>
                      {patternStats.escalations > 0 && (
                        <span className="router-pattern-config-warning" title="Escalations">
                          {patternStats.escalations} esc
                        </span>
                      )}
                    </div>
                    <label className="router-pattern-toggle">
                      <input
                        type="checkbox"
                        checked={!isDisabled}
                        onChange={(e) => handlePatternToggle(pattern.name, e.target.checked)}
                      />
                      <span className="router-pattern-toggle-slider" />
                    </label>
                  </div>

                  {!isDisabled && selectedPattern === pattern.name && (
                    <div className="router-pattern-config-details">
                      <div className="router-threshold-slider router-threshold-slider--small">
                        <label>
                          Threshold: {Math.round(threshold * 100)}%
                        </label>
                        <input
                          type="range"
                          min="0.3"
                          max="0.95"
                          step="0.05"
                          value={threshold}
                          onChange={(e) => handlePatternThresholdUpdate(pattern.name, parseFloat(e.target.value))}
                          className="router-slider"
                        />
                      </div>
                      <div className="router-pattern-config-regex">
                        <code>{pattern.pattern}</code>
                      </div>
                    </div>
                  )}

                  {!isDisabled && (
                    <button
                      className="router-pattern-expand"
                      onClick={() => setSelectedPattern(selectedPattern === pattern.name ? null : pattern.name)}
                    >
                      {selectedPattern === pattern.name ? 'Hide' : 'Configure'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* Blocklist */}
      <SettingsSection
        title="Query Blocklist"
        description="Queries containing these phrases will NEVER be routed"
      >
        <SettingsCard glass>
          <div className="router-list-manager">
            <div className="router-list-input">
              <input
                type="text"
                className="ui-input"
                placeholder="Enter phrase to block..."
                value={newBlockItem}
                onChange={(e) => setNewBlockItem(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAddBlockItem()}
              />
              <Button onClick={handleAddBlockItem} variant="secondary">Add</Button>
            </div>
            <div className="router-list-items">
              {blocklist.length === 0 ? (
                <p className="router-list-empty">No blocklist entries</p>
              ) : (
                blocklist.map(item => (
                  <span key={item} className="router-list-tag router-list-tag--block">
                    {item}
                    <button onClick={() => handleRemoveBlockItem(item)}>&times;</button>
                  </span>
                ))
              )}
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* Allowlist */}
      <SettingsSection
        title="Query Allowlist"
        description="Queries containing these phrases will ALWAYS be routed (if pattern matches)"
      >
        <SettingsCard glass>
          <div className="router-list-manager">
            <div className="router-list-input">
              <input
                type="text"
                className="ui-input"
                placeholder="Enter phrase to always route..."
                value={newAllowItem}
                onChange={(e) => setNewAllowItem(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAddAllowItem()}
              />
              <Button onClick={handleAddAllowItem} variant="secondary">Add</Button>
            </div>
            <div className="router-list-items">
              {allowlist.length === 0 ? (
                <p className="router-list-empty">No allowlist entries</p>
              ) : (
                allowlist.map(item => (
                  <span key={item} className="router-list-tag router-list-tag--allow">
                    {item}
                    <button onClick={() => handleRemoveAllowItem(item)}>&times;</button>
                  </span>
                ))
              )}
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* Pattern Tester */}
      <SettingsSection
        title="Pattern Tester"
        description="Test queries against router patterns without executing them"
      >
        <SettingsCard glass>
          <PatternTester embedded />
        </SettingsCard>
      </SettingsSection>

      {/* Audit Log */}
      <SettingsSection
        title="Routing Audit Log"
        description="View history of routing decisions"
      >
        <SettingsCard glass>
          <RouterAuditLog />
        </SettingsCard>
      </SettingsSection>

      {/* Reset */}
      <SettingsSection title="Reset">
        <SettingsCard variant="danger" glass>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <Button variant="danger" onClick={handleReset}>
              Reset to Defaults
            </Button>
            <span style={{ color: 'var(--ui-text-muted)', fontSize: '13px' }}>
              This will reset all router settings to their default values.
            </span>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

export default RouterSettings
