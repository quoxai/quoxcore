/**
 * AgentPicker - Lightweight dropdown for selecting agents
 *
 * Used in forms and workflows where a specific agent needs to be selected.
 * Shows agent icon, name, and domain.
 *
 * H7 fix: Added keyboard accessibility (ARIA, arrow keys, Escape)
 * H8 fix: Extracted styles to AgentPicker.css
 * H9 fix: Fixed filter prop causing infinite re-render
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { getAllAgents } from '../../config/agentRegistry'
import './AgentPicker.css'

export default function AgentPicker({
  value,
  onChange,
  placeholder = 'Select agent...',
  filter = null,
  disabled = false,
  showDomain = true,
  excludeOrchestrator = false,
  size = 'medium' // small, medium, large
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [agents, setAgents] = useState([])
  const [focusedIndex, setFocusedIndex] = useState(-1)  // H7 fix: Keyboard navigation
  const dropdownRef = useRef(null)
  const listRef = useRef(null)

  // H9 fix: Load agents only when excludeOrchestrator changes (not on filter change)
  useEffect(() => {
    let allAgents = getAllAgents()

    // Optionally exclude orchestrator (QUOX)
    if (excludeOrchestrator) {
      allAgents = allAgents.filter(a => a.id !== 'quox')
    }

    setAgents(allAgents)
  }, [excludeOrchestrator])

  // H9 fix: Apply filter during render using useMemo instead of useEffect
  const filteredByProp = useMemo(() => {
    if (!filter || typeof filter !== 'function') return agents
    return agents.filter(filter)
  }, [agents, filter])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false)
        setFocusedIndex(-1)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Reset focus when opening
  useEffect(() => {
    if (isOpen) {
      setFocusedIndex(-1)
    }
  }, [isOpen])

  // Scroll focused option into view
  useEffect(() => {
    if (focusedIndex >= 0 && listRef.current) {
      const options = listRef.current.querySelectorAll('.ap-option')
      if (options[focusedIndex]) {
        options[focusedIndex].scrollIntoView({ block: 'nearest' })
      }
    }
  }, [focusedIndex])

  const selectedAgent = filteredByProp.find(a => a.id === value)

  const filteredAgents = search
    ? filteredByProp.filter(a =>
        a.name.toLowerCase().includes(search.toLowerCase()) ||
        a.id.toLowerCase().includes(search.toLowerCase()) ||
        (a.domain && a.domain.toLowerCase().includes(search.toLowerCase()))
      )
    : filteredByProp

  const handleSelect = useCallback((agent) => {
    onChange(agent.id)
    setIsOpen(false)
    setSearch('')
    setFocusedIndex(-1)
  }, [onChange])

  // H7 fix: Keyboard navigation handler
  const handleKeyDown = useCallback((e) => {
    if (disabled) return

    if (!isOpen) {
      // Open dropdown on Enter, Space, or ArrowDown
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        setIsOpen(true)
        setFocusedIndex(0)
      }
      return
    }

    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        setIsOpen(false)
        setFocusedIndex(-1)
        break
      case 'ArrowDown':
        e.preventDefault()
        setFocusedIndex(i => Math.min(i + 1, filteredAgents.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setFocusedIndex(i => Math.max(i - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        if (focusedIndex >= 0 && filteredAgents[focusedIndex]) {
          handleSelect(filteredAgents[focusedIndex])
        }
        break
      case 'Home':
        e.preventDefault()
        setFocusedIndex(0)
        break
      case 'End':
        e.preventDefault()
        setFocusedIndex(filteredAgents.length - 1)
        break
      default:
        break
    }
  }, [disabled, isOpen, focusedIndex, filteredAgents, handleSelect])

  const sizeClasses = {
    small: 'ap-small',
    medium: 'ap-medium',
    large: 'ap-large'
  }

  return (
    <div
      className={`agent-picker ${sizeClasses[size]} ${disabled ? 'ap-disabled' : ''}`}
      ref={dropdownRef}
    >
      <button
        type="button"
        className="ap-trigger"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={selectedAgent ? `Selected agent: ${selectedAgent.name}` : placeholder}
      >
        {selectedAgent ? (
          <span className="ap-selected">
            <span className="ap-icon" aria-hidden="true">{selectedAgent.icon || '🤖'}</span>
            <span className="ap-name">{selectedAgent.name}</span>
            {showDomain && selectedAgent.domain && (
              <span className="ap-domain">{selectedAgent.domain}</span>
            )}
          </span>
        ) : (
          <span className="ap-placeholder">{placeholder}</span>
        )}
        <svg className="ap-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
        </svg>
      </button>

      {isOpen && (
        <div
          className="ap-dropdown"
          role="listbox"
          aria-label="Select an agent"
          onKeyDown={handleKeyDown}
        >
          {filteredByProp.length > 5 && (
            <div className="ap-search">
              <input
                type="text"
                placeholder="Search agents..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setFocusedIndex(0)
                }}
                onKeyDown={handleKeyDown}
                autoFocus
                aria-label="Search agents"
              />
            </div>
          )}
          <div className="ap-list" ref={listRef}>
            {filteredAgents.length === 0 ? (
              <div className="ap-empty" role="option" aria-disabled="true">No agents found</div>
            ) : (
              filteredAgents.map((agent, index) => (
                <button
                  key={agent.id}
                  type="button"
                  className={`ap-option ${value === agent.id ? 'ap-selected' : ''} ${index === focusedIndex ? 'ap-focused' : ''}`}
                  onClick={() => handleSelect(agent)}
                  onMouseEnter={() => setFocusedIndex(index)}
                  role="option"
                  aria-selected={value === agent.id}
                  tabIndex={-1}
                >
                  <span className="ap-icon" aria-hidden="true">{agent.icon || '🤖'}</span>
                  <span className="ap-info">
                    <span className="ap-name">{agent.name}</span>
                    {showDomain && agent.domain && (
                      <span className="ap-domain">{agent.domain}</span>
                    )}
                  </span>
                  {agent.level !== undefined && (
                    <span className="ap-level">L{agent.level}</span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
