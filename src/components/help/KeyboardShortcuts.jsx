import { useState, useEffect } from 'react'
import './help.css'

const SHORTCUTS = [
  {
    category: 'Navigation',
    items: [
      { keys: ['1'], description: 'Command Center' },
      { keys: ['2'], description: 'Inbox' },
      { keys: ['3'], description: 'Mission Control' },
      { keys: ['4'], description: 'QuoxAgents' },
      { keys: ['5'], description: 'Agents' },
      { keys: ['6'], description: 'Memory' },
      { keys: ['7'], description: 'Activity' },
      { keys: ['8'], description: 'Files' },
      { keys: ['9'], description: 'Settings' },
      { keys: ['0'], description: 'Dashboard' },
    ]
  },
  {
    category: 'Search',
    items: [
      { keys: ['/'], description: 'Search navigation' },
      { keys: ['Esc'], description: 'Close / clear search' },
    ]
  },
  {
    category: 'Voice',
    items: [
      { keys: ['Space'], description: 'Push-to-talk (hold in chat)' },
      { keys: ['Esc'], description: 'Cancel recording' },
    ]
  },
  {
    category: 'Safety',
    items: [
      { keys: ['Ctrl', 'Shift', 'K'], description: 'Emergency kill switch' },
    ]
  },
  {
    category: 'Help',
    items: [
      { keys: ['?'], description: 'Toggle this panel' },
    ]
  }
]

/** Page-specific shortcuts — keyed by pathname prefix */
export const PAGE_SHORTCUTS = {
  '/inbox': {
    category: 'Inbox',
    items: [
      { keys: ['j'], description: 'Next item' },
      { keys: ['k'], description: 'Previous item' },
      { keys: ['Enter'], description: 'Open item' },
      { keys: ['s'], description: 'Star / unstar' },
      { keys: ['e'], description: 'Archive' },
      { keys: ['a'], description: 'Approve' },
      { keys: ['d'], description: 'Deny' },
      { keys: ['#'], description: 'Delete' },
    ]
  },
  '/mission-control': {
    category: 'Mission Control',
    items: [
      { keys: ['1'], description: 'Objectives tab' },
      { keys: ['2'], description: 'Teams tab' },
      { keys: ['3'], description: 'Schedules tab' },
      { keys: ['4'], description: 'Live tab' },
      { keys: ['j'], description: 'Next objective' },
      { keys: ['k'], description: 'Previous objective' },
      { keys: ['n'], description: 'New objective' },
    ]
  },
  '/cogcore3d': {
    category: 'Cognitive Core 3D',
    items: [
      { keys: ['h'], description: 'Toggle HUD' },
      { keys: ['c'], description: 'Toggle chat' },
      { keys: ['l'], description: 'Cycle layers' },
      { keys: ['t'], description: 'Cycle tours' },
      { keys: ['d'], description: 'Cycle depth' },
      { keys: ['s'], description: 'Toggle simulation' },
      { keys: ['f'], description: 'Fit view' },
      { keys: ['1-9'], description: 'Load bookmark' },
      { keys: ['Ctrl', '1-9'], description: 'Save bookmark' },
    ]
  },
  '/terminal': {
    category: 'Terminal',
    items: [
      { keys: ['Ctrl', '1-4'], description: 'Focus pane' },
      { keys: ['Ctrl', '\\'], description: 'Toggle AI chat' },
      { keys: ['Ctrl', 'Shift', 'L'], description: 'Clear terminal' },
      { keys: ['Ctrl', 'Shift', 'N'], description: 'New workspace' },
      { keys: ['Ctrl', 'Shift', 'V'], description: 'Toggle vim mode' },
    ]
  },
  '/actions': {
    category: 'Actions',
    items: [
      { keys: ['n'], description: 'New action' },
      { keys: ['Esc'], description: 'Close detail' },
    ]
  },
}

export function KeyboardShortcuts({ isOpen, onClose, shortcuts, pathname }) {
  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isOpen) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className="shortcuts-overlay" onClick={onClose}>
      <div className="shortcuts-modal" onClick={e => e.stopPropagation()}>
        <header className="shortcuts-header">
          <h2>Keyboard Shortcuts</h2>
          <button className="shortcuts-close" onClick={onClose} aria-label="Close keyboard shortcuts">×</button>
        </header>

        <div className="shortcuts-content">
          {(() => {
            const all = [...(shortcuts || SHORTCUTS)]
            // Add page-specific shortcuts if current page has them
            if (pathname) {
              for (const [prefix, pageShortcuts] of Object.entries(PAGE_SHORTCUTS)) {
                if (pathname === prefix || pathname.startsWith(prefix + '/')) {
                  all.push(pageShortcuts)
                  break
                }
              }
            }
            return all
          })().map(category => (
            <div key={category.category} className="shortcuts-category">
              <h3>{category.category}</h3>
              <div className="shortcuts-list">
                {category.items.map((item, idx) => (
                  <div key={idx} className="shortcut-item">
                    <div className="shortcut-keys">
                      {item.keys.map((key, kidx) => (
                        <span key={kidx}>
                          <kbd>{key}</kbd>
                          {kidx < item.keys.length - 1 && <span className="key-plus">+</span>}
                        </span>
                      ))}
                    </div>
                    <span className="shortcut-desc">{item.description}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <footer className="shortcuts-footer">
          <span className="shortcuts-hint">Press <kbd>?</kbd> to toggle this panel</span>
        </footer>
      </div>
    </div>
  )
}

export default KeyboardShortcuts
