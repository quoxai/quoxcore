/**
 * Tabs Component
 *
 * Tab navigation for switching between views.
 *
 * @example
 * // Controlled tabs
 * <Tabs value={activeTab} onChange={setActiveTab}>
 *   <Tab value="overview">Overview</Tab>
 *   <Tab value="details">Details</Tab>
 *   <Tab value="settings">Settings</Tab>
 * </Tabs>
 *
 * // Pill style
 * <Tabs variant="pill" value={activeTab} onChange={setActiveTab}>
 *   <Tab value="all">All</Tab>
 *   <Tab value="running">Running</Tab>
 *   <Tab value="stopped">Stopped</Tab>
 * </Tabs>
 */

import { createContext, useContext } from 'react'

const TabsContext = createContext({ value: null, onChange: () => {} })

/**
 * Tabs - Tab container
 *
 * Props:
 * - value: string - Currently active tab value
 * - onChange: function(value) - Called when tab changes
 * - variant: 'default' | 'pill' - Visual style
 * - size: 'sm' | 'md' | 'lg'
 * - className: string
 */
export function Tabs({
  value,
  onChange,
  variant = 'default',
  size = 'md',
  className = '',
  children
}) {
  const classes = [
    'ui-tabs',
    variant === 'pill' && 'ui-tabs-pill',
    className
  ].filter(Boolean).join(' ')

  return (
    <TabsContext.Provider value={{ value, onChange, size }}>
      <div className={classes} role="tablist">
        {children}
      </div>
    </TabsContext.Provider>
  )
}

/**
 * Tab - Individual tab button
 *
 * Props:
 * - value: string - Tab identifier
 * - icon: ReactNode - Optional icon
 * - disabled: boolean
 * - className: string
 */
export function Tab({
  value,
  icon,
  disabled = false,
  className = '',
  children
}) {
  const { value: activeValue, onChange, size } = useContext(TabsContext)
  const isActive = value === activeValue

  const classes = [
    'ui-tab',
    isActive && 'ui-tab-active',
    disabled && 'ui-tab-disabled',
    className
  ].filter(Boolean).join(' ')

  const handleClick = () => {
    if (!disabled && onChange) {
      onChange(value)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleClick()
    }
  }

  return (
    <button
      className={classes}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="tab"
      aria-selected={isActive}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      style={{
        padding: size === 'sm' ? 'var(--ui-space-1) var(--ui-space-2)' : undefined
      }}
    >
      {icon && <span className="ui-tab-icon">{icon}</span>}
      {children}
    </button>
  )
}

/**
 * TabPanel - Content panel for a tab
 *
 * Props:
 * - value: string - Associated tab value
 * - activeValue: string - Currently active tab
 * - className: string
 */
export function TabPanel({
  value,
  activeValue,
  className = '',
  children
}) {
  if (value !== activeValue) return null

  return (
    <div
      className={`ui-tab-panel ${className}`}
      role="tabpanel"
      aria-labelledby={`tab-${value}`}
    >
      {children}
    </div>
  )
}

/**
 * TabsWithPanels - Complete tabs with content panels
 *
 * @example
 * <TabsWithPanels
 *   tabs={[
 *     { value: 'tab1', label: 'Tab 1', content: <Tab1Content /> },
 *     { value: 'tab2', label: 'Tab 2', content: <Tab2Content /> },
 *   ]}
 *   defaultValue="tab1"
 * />
 */
export function TabsWithPanels({
  tabs,
  defaultValue,
  value: controlledValue,
  onChange: controlledOnChange,
  variant = 'default',
  className = ''
}) {
  // Support both controlled and uncontrolled modes
  const [internalValue, setInternalValue] = useState(defaultValue || tabs[0]?.value)

  const value = controlledValue !== undefined ? controlledValue : internalValue
  const onChange = controlledOnChange || setInternalValue

  return (
    <div className={`ui-tabs-container ${className}`}>
      <Tabs value={value} onChange={onChange} variant={variant}>
        {tabs.map(tab => (
          <Tab
            key={tab.value}
            value={tab.value}
            icon={tab.icon}
            disabled={tab.disabled}
          >
            {tab.label}
          </Tab>
        ))}
      </Tabs>
      <div className="ui-tab-panels">
        {tabs.map(tab => (
          <TabPanel key={tab.value} value={tab.value} activeValue={value}>
            {tab.content}
          </TabPanel>
        ))}
      </div>
    </div>
  )
}

// Need useState for TabsWithPanels
import { useState } from 'react'

export default Tabs
