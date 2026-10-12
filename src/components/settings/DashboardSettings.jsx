/**
 * DashboardSettings — toggle which /dashboard tabs show and reorder them.
 *
 * Reads/writes `uiSettings.dashboardTabs = { enabled: string[]|null, order: string[]|null }`
 * (null = default: all tabs on, registry order — see src/config/dashboardTabs.js).
 * DashboardView consumes the same config via computeVisibleTabs().
 */

import { useUISettings } from '../../services/uiSettings'
import { getAllDashboardTabs } from '../../config/dashboardTabs'
import SettingsSection from './SettingsSection'
import SettingsCard, { SettingsGroup } from './SettingsCard'
import { SettingItem } from '../ui/Input'
import { IconButton } from '../ui/Button'

function ChevronUpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  )
}

function ChevronDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

export default function DashboardSettings() {
  const [ui, updateUISetting] = useUISettings()
  const all = getAllDashboardTabs()
  const allIds = all.map(t => t.id)
  const byId = new Map(all.map(t => [t.id, t]))
  const cfg = ui.dashboardTabs || {}

  const order = (() => {
    const base = Array.isArray(cfg.order) && cfg.order.length
      ? cfg.order.filter(id => byId.has(id))
      : [...allIds]
    const missing = allIds.filter(id => !base.includes(id))
    return [...base, ...missing]
  })()

  const enabledSet = cfg.enabled == null ? new Set(allIds) : new Set(cfg.enabled)

  const persist = (nextEnabledSet, nextOrder) => {
    updateUISetting('dashboardTabs', { enabled: [...nextEnabledSet], order: [...nextOrder] })
  }

  const handleToggle = (id, checked) => {
    const next = new Set(enabledSet)
    if (checked) {
      next.add(id)
    } else {
      // Never allow disabling the last enabled tab.
      if (next.size <= 1) return
      next.delete(id)
    }
    persist(next, order)
  }

  const move = (index, direction) => {
    const target = index + direction
    if (target < 0 || target >= order.length) return
    const next = [...order]
    ;[next[index], next[target]] = [next[target], next[index]]
    persist(enabledSet, next)
  }

  return (
    <div>
      <SettingsSection
        title="Dashboard"
        description="Choose which tabs appear on your dashboard and their order. Saved to your account."
      >
        <SettingsCard glass>
          <SettingsGroup>
            {order.map((id, index) => {
              const tab = byId.get(id)
              if (!tab) return null
              const isOnlyEnabled = enabledSet.has(id) && enabledSet.size <= 1

              return (
                <div key={id} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <IconButton
                      variant="ghost"
                      size="xs"
                      aria-label={`Move ${tab.label} up`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ChevronUpIcon />
                    </IconButton>
                    <IconButton
                      variant="ghost"
                      size="xs"
                      aria-label={`Move ${tab.label} down`}
                      disabled={index === order.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ChevronDownIcon />
                    </IconButton>
                  </div>
                  <div style={{ flex: 1 }}>
                    <SettingItem
                      label={tab.label}
                      description={isOnlyEnabled ? 'At least one tab must stay enabled.' : undefined}
                      checked={enabledSet.has(id)}
                      disabled={isOnlyEnabled}
                      onChange={(e) => handleToggle(id, e.target.checked)}
                    />
                  </div>
                </div>
              )
            })}
          </SettingsGroup>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
