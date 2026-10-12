/**
 * AssistantSettings — Main settings panel for managing all agents/assistants.
 *
 * Two-category view: Agents (tool/workflow-focused specialists) and
 * Assistants (orchestrators/managers focused on delegation).
 * Grid view of cards with search/filter, plus hierarchy view.
 */

import React, { useState, useMemo } from 'react'
import { listAssistants, resetAllAssistants } from '../../services/entityRegistry'
import AssistantCard from './AssistantCard'
import AssistantEditor from '../assistant-editor/AssistantEditorV2'
import AssistantHierarchy from './AssistantHierarchy'
import './assistant-settings.css'

// Agents = specialists + analysts (tool-focused)
// Assistants = orchestrators + managers (delegation-focused)
const AGENT_ROLES = ['specialist', 'analyst']
const ASSISTANT_ROLES = ['orchestrator', 'manager']

// UI-11: some entity JSONs (action-q, browser-q, meshnet, roady) still use
// the old/flat schema with `role` at the top level instead of nested under
// `hierarchy`. Reading `.hierarchy.role` directly threw "Cannot read
// properties of undefined" and crashed the /settings#assistants page.
function getEntityRole(entity) {
  return entity?.hierarchy?.role || entity?.role || 'specialist'
}

function isAgentRole(role) {
  return AGENT_ROLES.includes(role)
}

export default function AssistantSettings({ onVisualizerChange, onNavigateToStore, initialEditAgent = null, initialEditTab = null }) {
  const [selectedId, setSelectedId] = useState(null)
  const [editingId, setEditingId] = useState(initialEditAgent)
  const [category, setCategory] = useState('agents')
  const [viewMode, setViewMode] = useState('grid')
  const [searchQuery, setSearchQuery] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  const allEntities = useMemo(() => listAssistants({ sortBy: 'level' }), [refreshKey])

  const filteredEntities = useMemo(() => {
    const targetRoles = category === 'agents' ? AGENT_ROLES : ASSISTANT_ROLES
    let list = allEntities.filter(a => targetRoles.includes(getEntityRole(a)))

    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      list = list.filter(a =>
        a.identity.name.toLowerCase().includes(q) ||
        a.identity.tagline.toLowerCase().includes(q) ||
        a.identity.description.toLowerCase().includes(q) ||
        a.capabilities.domains.some(d => d.includes(q))
      )
    }

    return list
  }, [category, searchQuery, refreshKey, allEntities])

  // Counts for category tabs
  const agentCount = useMemo(() => allEntities.filter(a => isAgentRole(getEntityRole(a))).length, [allEntities])
  const assistantCount = useMemo(() => allEntities.filter(a => !isAgentRole(getEntityRole(a))).length, [allEntities])

  const handleSave = () => setRefreshKey(k => k + 1)

  const handleResetAll = () => {
    if (confirm('Reset ALL to default settings? This cannot be undone.')) {
      resetAllAssistants()
      setRefreshKey(k => k + 1)
      setEditingId(null)
    }
  }

  // Get entity role for editor context
  const editingEntity = editingId ? allEntities.find(a => a.id === editingId) : null
  const editingEntityType = editingEntity ? (isAgentRole(getEntityRole(editingEntity)) ? 'agent' : 'assistant') : null

  return (
    <div className="assistant-settings">
      <div className="settings-header">
        <div className="header-title">
          <h2>{category === 'agents' ? 'Agent Configuration' : 'Assistant Configuration'}</h2>
          <p>
            {category === 'agents'
              ? 'Configure tools, workflows, visualiser, and voice for specialist agents'
              : 'Configure delegation, visualiser, and voice for orchestrators and managers'}
          </p>
        </div>
        <div className="header-controls">
          {!editingId && (
            <>
              <div className="view-toggle">
                <button
                  className={viewMode === 'grid' ? 'active' : ''}
                  onClick={() => setViewMode('grid')}
                >
                  Grid
                </button>
                <button
                  className={viewMode === 'hierarchy' ? 'active' : ''}
                  onClick={() => setViewMode('hierarchy')}
                >
                  Hierarchy
                </button>
              </div>
              <button className="reset-all-btn" onClick={handleResetAll}>
                Reset All
              </button>
            </>
          )}
        </div>
      </div>

      {/* Category toggle: Agents / Assistants */}
      {!editingId && (
        <div className="category-bar">
          <div className="category-toggle">
            <button
              className={`category-btn ${category === 'agents' ? 'category-btn--active' : ''}`}
              onClick={() => { setCategory('agents'); setSearchQuery('') }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
              </svg>
              Agents
              <span className="category-count">{agentCount}</span>
            </button>
            <button
              className={`category-btn ${category === 'assistants' ? 'category-btn--active' : ''}`}
              onClick={() => { setCategory('assistants'); setSearchQuery('') }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'currentColor' }}>
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              Assistants
              <span className="category-count">{assistantCount}</span>
            </button>
          </div>

          {viewMode === 'grid' && (
            <input
              type="text"
              placeholder={`Search ${category}...`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="search-input"
            />
          )}
        </div>
      )}

      <div className="settings-content">
        {editingId ? (
          <AssistantEditor
            assistantId={editingId}
            entityType={editingEntityType}
            initialTab={editingId === initialEditAgent ? initialEditTab : null}
            onClose={() => setEditingId(null)}
            onSave={handleSave}
            onVisualizerChange={onVisualizerChange}
            onNavigateToStore={onNavigateToStore}
          />
        ) : viewMode === 'grid' ? (
          <div className="assistant-grid" role="list" aria-label={category === 'agents' ? 'Agents' : 'Assistants'}>
            {filteredEntities.map(entity => (
              <AssistantCard
                key={entity.id}
                assistant={entity}
                entityType={isAgentRole(getEntityRole(entity)) ? 'agent' : 'assistant'}
                selected={selectedId === entity.id}
                onSelect={setSelectedId}
                onEdit={setEditingId}
              />
            ))}
            {filteredEntities.length === 0 && (
              <div className="no-results" role="status" aria-live="polite">
                <div className="no-results__icon">?</div>
                <h3 className="no-results__title">No {category} found</h3>
                <p className="no-results__description">
                  {searchQuery
                    ? `No ${category} match "${searchQuery}"`
                    : `No ${category} have been configured yet`}
                </p>
                {searchQuery && (
                  <button
                    className="no-results__clear"
                    onClick={() => setSearchQuery('')}
                  >
                    Clear Search
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <AssistantHierarchy
            onSelect={setSelectedId}
            onEdit={setEditingId}
          />
        )}
      </div>
    </div>
  )
}
