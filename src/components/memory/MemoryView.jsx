import { useState, useEffect, useCallback } from 'react'
import { getMemoryManager, formatContextForPrompt } from '../../services/memoryManager'
import { getMemoryClient } from '../../services/memoryClient'
import { LocalOnlyNotice } from './LocalOnlyNotice'
import './memory.css'

const TABS = ['Profile', 'Episodic', 'Learned', 'Projects', 'Candidates']

export function MemoryView() {
  const [activeTab, setActiveTab] = useState('Profile')
  const [stats, setStats] = useState(null)
  const [profile, setProfile] = useState(null)
  const [projects, setProjects] = useState([])
  const [episodic, setEpisodic] = useState([])
  const [learned, setLearned] = useState({ facts: [], preferences: [], constraints: [] })
  const [candidates, setCandidates] = useState([])
  const [editingItem, setEditingItem] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [notification, setNotification] = useState(null)
  const [confirmDialog, setConfirmDialog] = useState(null)
  const memoryManager = getMemoryManager()

  // Show a temporary notification message
  const showNotification = (message, type = 'info') => {
    setNotification({ message, type })
    setTimeout(() => setNotification(null), 3000)
  }

  // Load all memory data — server first, localStorage fallback
  const loadMemory = useCallback(async () => {
    setStats(memoryManager.getStats())
    setProfile(memoryManager.getProfile())
    setProjects(memoryManager.getAllProjects ? memoryManager.getAllProjects() : [])
    setCandidates(memoryManager.candidateBuffer || [])

    // Load episodic from localStorage (ephemeral, not stored on server)
    const recentKey = 'episodic_recent'
    const recent = localStorage.getItem(recentKey)
    if (recent) {
      const entries = recent.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean).reverse()
      setEpisodic(entries)
    }

    // Load learned items — try server first
    try {
      const client = getMemoryClient()
      const [serverFacts, serverPrefs, serverConstraints] = await Promise.all([
        client.getMemories({ type: 'fact', limit: 200 }),
        client.getMemories({ type: 'preference', limit: 200 }),
        client.getMemories({ type: 'constraint', limit: 200 })
      ])

      if (serverFacts.length > 0 || serverPrefs.length > 0 || serverConstraints.length > 0) {
        setLearned({
          facts: serverFacts.map(m => ({ key: m.id, id: m.id, content: m.content, ...m })),
          preferences: serverPrefs.map(m => ({ key: m.id, id: m.id, content: m.content, ...m })),
          constraints: serverConstraints.map(m => ({ key: m.id, id: m.id, content: m.content, ...m }))
        })
        return
      }
    } catch {
      // Server unavailable — fall through to localStorage
    }

    // Fallback: load learned items from localStorage
    const facts = []
    const preferences = []
    const constraints = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.includes('learned_fact')) {
        try { facts.push({ key, ...JSON.parse(localStorage.getItem(key)) }) } catch {}
      }
      if (key?.includes('learned_preference')) {
        try { preferences.push({ key, ...JSON.parse(localStorage.getItem(key)) }) } catch {}
      }
      if (key?.includes('learned_constraint')) {
        try { constraints.push({ key, ...JSON.parse(localStorage.getItem(key)) }) } catch {}
      }
    }
    setLearned({ facts, preferences, constraints })
  }, [memoryManager])

  useEffect(() => {
    loadMemory()
    // Refresh every 30 seconds
    const interval = setInterval(loadMemory, 30000)
    return () => clearInterval(interval)
  }, [loadMemory])

  // Handle editing
  const startEdit = (type, key, value) => {
    setEditingItem({ type, key, item: value })
    setEditValue(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  }

  // Server-first save — mirrors the load path's server-first pattern.
  // 'learned' items are written via memoryClient (server), never localStorage
  // as the primary store. On server failure we surface an error and keep
  // the edit modal open rather than silently succeeding.
  const saveEdit = async () => {
    if (!editingItem) return

    const { type, key, item } = editingItem

    let data
    try {
      data = (type === 'profile' || type === 'project' || type === 'learned')
        ? JSON.parse(editValue)
        : editValue
    } catch (err) {
      showNotification('Invalid JSON: ' + err.message, 'error')
      return
    }

    if (type === 'profile') {
      memoryManager.saveProfile(data)
    } else if (type === 'project') {
      localStorage.setItem(key, JSON.stringify(data))
    } else if (type === 'learned') {
      const client = getMemoryClient()
      const id = item?.id || key
      const { key: _drop, ...updates } = data
      try {
        const serverOk = await client.checkHealth()
        if (!serverOk) throw new Error('Memory server unavailable')
        await client.updateMemory(id, updates)
      } catch (err) {
        showNotification('Failed to save memory to server: ' + err.message, 'error')
        return
      }
    }

    loadMemory()
    setEditingItem(null)
    setEditValue('')
  }

  const cancelEdit = () => {
    setEditingItem(null)
    setEditValue('')
  }

  // Handle delete with confirmation dialog — 'learned' items are deleted
  // server-first via memoryClient; on server failure we surface an error
  // and do NOT remove the item from view (no silent success).
  const deleteItem = (type, key, item) => {
    setConfirmDialog({
      message: 'Delete this memory item?',
      onConfirm: async () => {
        if (type === 'learned') {
          const client = getMemoryClient()
          const id = item?.id || key
          try {
            const serverOk = await client.checkHealth()
            if (!serverOk) throw new Error('Memory server unavailable')
            await client.deleteMemory(id)
          } catch (err) {
            setConfirmDialog(null)
            showNotification('Failed to delete memory: ' + err.message, 'error')
            return
          }
        } else {
          localStorage.removeItem(key)
        }
        loadMemory()
        setConfirmDialog(null)
        showNotification('Memory item deleted', 'info')
      },
      onCancel: () => setConfirmDialog(null)
    })
  }

  // Process candidates — accepted candidates are persisted server-first via
  // memoryClient.saveMemory. On server failure we surface an error instead
  // of silently writing only to localStorage. 'dismiss' stays client-side
  // (it's just removing the candidate from the local review buffer).
  const processCandidate = async (candidate, action) => {
    if (action === 'accept') {
      const client = getMemoryClient()
      try {
        const serverOk = await client.checkHealth()
        if (!serverOk) throw new Error('Memory server unavailable')
        await client.saveMemory({
          type: candidate.type,
          content: candidate.content,
          tags: ['manual_accept']
        })
      } catch (err) {
        showNotification('Failed to save memory: ' + err.message, 'error')
        return
      }
    }
    // Remove from buffer
    memoryManager.candidateBuffer = memoryManager.candidateBuffer.filter(c => c !== candidate)
    loadMemory()
  }

  // Add new project
  const addProject = () => {
    const name = prompt('Project name:')
    if (!name) return
    memoryManager.addProject({
      name,
      description: '',
      keywords: []
    })
    loadMemory()
  }

  // Filter items by search
  const filterItems = (items, fields) => {
    if (!searchQuery) return items
    const q = searchQuery.toLowerCase()
    return items.filter(item =>
      fields.some(field => {
        const val = item[field]
        return val && String(val).toLowerCase().includes(q)
      })
    )
  }

  return (
    <div className="memory-view">
      {/* Notification toast */}
      {notification && (
        <div className={`mv-notification ${notification.type}`}>
          {notification.message}
        </div>
      )}

      {/* Confirmation dialog */}
      {confirmDialog && (
        <div className="mv-confirm-overlay">
          <div className="mv-confirm-dialog">
            <p>{confirmDialog.message}</p>
            <div className="mv-confirm-actions">
              <button className="mv-btn mv-btn-danger" onClick={confirmDialog.onConfirm}>Delete</button>
              <button className="mv-btn" onClick={confirmDialog.onCancel}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <p className="panel-intro">Your core memory store — profile identity, recent interactions, learned facts, tracked projects, and auto-extracted candidates awaiting review.</p>

      {/* Header with stats */}
      <div className="memory-view-header">
        <h2>Memory System</h2>
        {stats && (
          <div className="memory-view-stats">
            <div className="mv-stat">
              <span className="mv-stat-value">{stats.episodicEntries}</span>
              <span className="mv-stat-label">Events</span>
            </div>
            <div className="mv-stat">
              <span className="mv-stat-value">{stats.learnedFacts + stats.learnedPreferences}</span>
              <span className="mv-stat-label">Learned</span>
            </div>
            <div className="mv-stat">
              <span className="mv-stat-value">{stats.projects}</span>
              <span className="mv-stat-label">Projects</span>
            </div>
            <div className="mv-stat">
              <span className="mv-stat-value">{candidates.length}</span>
              <span className="mv-stat-label">Pending</span>
            </div>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="memory-view-tabs">
        {TABS.map(tab => (
          <button
            key={tab}
            className={`mv-tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
            {tab === 'Candidates' && candidates.length > 0 && (
              <span className="mv-tab-badge">{candidates.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="memory-view-search">
        <input
          type="text"
          placeholder="Search memory..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button className="mv-refresh" onClick={loadMemory}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="memory-view-content">
        {/* Profile Tab */}
        {activeTab === 'Profile' && (
          <div className="mv-profile">
            <LocalOnlyNotice label="your profile" />
            {profile ? (
              <>
                <div className="mv-section">
                  <div className="mv-section-header">
                    <h3>Identity</h3>
                    <button
                      className="mv-edit-btn"
                      onClick={() => startEdit('profile', 'profile', profile)}
                    >
                      Edit
                    </button>
                  </div>
                  <div className="mv-profile-grid">
                    <div className="mv-profile-item">
                      <label>Name</label>
                      <span>{profile.name || 'Not set'}</span>
                    </div>
                    <div className="mv-profile-item">
                      <label>Timezone</label>
                      <span>{profile.timezone || 'Not set'}</span>
                    </div>
                    <div className="mv-profile-item">
                      <label>Role</label>
                      <span>{profile.role || 'Not set'}</span>
                    </div>
                    <div className="mv-profile-item">
                      <label>Experience</label>
                      <span>{profile.experience_level || 'Not set'}</span>
                    </div>
                  </div>
                </div>

                <div className="mv-section">
                  <h3>Preferences</h3>
                  <div className="mv-profile-grid">
                    {profile.preferences && Object.entries(profile.preferences).map(([key, value]) => (
                      <div key={key} className="mv-profile-item">
                        <label>{key}</label>
                        <span>{String(value)}</span>
                      </div>
                    ))}
                    {(!profile.preferences || Object.keys(profile.preferences).length === 0) && (
                      <div className="mv-empty">No preferences set</div>
                    )}
                  </div>
                </div>

                <div className="mv-section">
                  <h3>Constraints</h3>
                  <ul className="mv-constraints-list">
                    {profile.constraints?.map((c, i) => (
                      <li key={i} className="mv-constraint">{c}</li>
                    ))}
                    {(!profile.constraints || profile.constraints.length === 0) && (
                      <li className="mv-empty">No constraints set</li>
                    )}
                  </ul>
                </div>
              </>
            ) : (
              <div className="mv-empty-state">
                <p>No profile configured yet.</p>
                <button
                  className="mv-btn primary"
                  onClick={() => startEdit('profile', 'profile', {
                    name: '',
                    timezone: 'America/Los_Angeles',
                    role: '',
                    experience_level: 'advanced',
                    preferences: {},
                    constraints: []
                  })}
                >
                  Create Profile
                </button>
              </div>
            )}
          </div>
        )}

        {/* Episodic Tab */}
        {activeTab === 'Episodic' && (
          <div className="mv-episodic">
            <LocalOnlyNotice label="episodic interaction history" />
            <div className="mv-section-header">
              <h3>Recent Interactions ({episodic.length})</h3>
            </div>
            <div className="mv-episodic-list">
              {filterItems(episodic, ['query', 'response', 'agent']).map((event, i) => (
                <div key={i} className="mv-episodic-entry">
                  <div className="mv-episodic-header">
                    <span className="mv-episodic-time">
                      {new Date(event.timestamp).toLocaleString()}
                    </span>
                    <span className="mv-episodic-agent">{event.agent}</span>
                    {event.cost && <span className="mv-episodic-cost">${event.cost.toFixed(4)}</span>}
                  </div>
                  <div className="mv-episodic-query">{event.query}</div>
                  {event.response && (
                    <div className="mv-episodic-response">
                      {event.response.substring(0, 200)}
                      {event.response.length > 200 && '...'}
                    </div>
                  )}
                </div>
              ))}
              {episodic.length === 0 && (
                <div className="mv-empty">No interactions recorded yet</div>
              )}
            </div>
          </div>
        )}

        {/* Learned Tab */}
        {activeTab === 'Learned' && (
          <div className="mv-learned">
            <div className="mv-section">
              <div className="mv-section-header">
                <h3>Facts ({learned.facts.length})</h3>
              </div>
              <div className="mv-learned-list">
                {filterItems(learned.facts, ['content']).map((item, i) => (
                  <div key={i} className={`mv-learned-item fact${item.isDummy ? ' mv-demo-item' : ''}`}>
                    <div className="mv-learned-content">
                      {item.isDummy && <span className="mv-demo-badge">DEMO</span>}
                      {item.content}
                    </div>
                    <div className="mv-learned-meta">
                      <span>{new Date(item.learnedAt).toLocaleDateString()}</span>
                      <span className="mv-learned-source">{item.source || 'auto'}</span>
                    </div>
                    <div className="mv-learned-actions">
                      <button onClick={() => startEdit('learned', item.key, item)}>Edit</button>
                      <button onClick={() => deleteItem('learned', item.key, item)}>Delete</button>
                    </div>
                  </div>
                ))}
                {learned.facts.length === 0 && <div className="mv-empty">No facts learned</div>}
              </div>
            </div>

            <div className="mv-section">
              <div className="mv-section-header">
                <h3>Preferences ({learned.preferences.length})</h3>
              </div>
              <div className="mv-learned-list">
                {filterItems(learned.preferences, ['content']).map((item, i) => (
                  <div key={i} className={`mv-learned-item preference${item.isDummy ? ' mv-demo-item' : ''}`}>
                    <div className="mv-learned-content">
                      {item.isDummy && <span className="mv-demo-badge">DEMO</span>}
                      {item.content}
                    </div>
                    <div className="mv-learned-meta">
                      <span>{new Date(item.learnedAt).toLocaleDateString()}</span>
                    </div>
                    <div className="mv-learned-actions">
                      <button onClick={() => startEdit('learned', item.key, item)}>Edit</button>
                      <button onClick={() => deleteItem('learned', item.key, item)}>Delete</button>
                    </div>
                  </div>
                ))}
                {learned.preferences.length === 0 && <div className="mv-empty">No preferences learned</div>}
              </div>
            </div>

            <div className="mv-section">
              <div className="mv-section-header">
                <h3>Constraints ({learned.constraints.length})</h3>
              </div>
              <div className="mv-learned-list">
                {filterItems(learned.constraints, ['content']).map((item, i) => (
                  <div key={i} className={`mv-learned-item constraint${item.isDummy ? ' mv-demo-item' : ''}`}>
                    <div className="mv-learned-content">
                      {item.isDummy && <span className="mv-demo-badge">DEMO</span>}
                      {item.content}
                    </div>
                    <div className="mv-learned-meta">
                      <span>{new Date(item.learnedAt).toLocaleDateString()}</span>
                    </div>
                    <div className="mv-learned-actions">
                      <button onClick={() => startEdit('learned', item.key, item)}>Edit</button>
                      <button onClick={() => deleteItem('learned', item.key, item)}>Delete</button>
                    </div>
                  </div>
                ))}
                {learned.constraints.length === 0 && <div className="mv-empty">No constraints learned</div>}
              </div>
            </div>
          </div>
        )}

        {/* Projects Tab */}
        {activeTab === 'Projects' && (
          <div className="mv-projects">
            <LocalOnlyNotice label="tracked projects" />
            <div className="mv-section-header">
              <h3>Projects ({projects.length})</h3>
              <button className="mv-btn primary" onClick={addProject}>+ Add Project</button>
            </div>
            <div className="mv-projects-list">
              {filterItems(projects, ['name', 'description']).map((project, i) => (
                <div key={i} className="mv-project-card">
                  <div className="mv-project-header">
                    <h4>{project.name}</h4>
                    <div className="mv-project-actions">
                      <button onClick={() => startEdit('project', `quox_project_${project.id}`, project)}>
                        Edit
                      </button>
                      <button onClick={() => deleteItem('project', `quox_project_${project.id}`)}>
                        Delete
                      </button>
                    </div>
                  </div>
                  {project.description && (
                    <p className="mv-project-desc">{project.description}</p>
                  )}
                  {project.keywords?.length > 0 && (
                    <div className="mv-project-keywords">
                      {project.keywords.map((kw, j) => (
                        <span key={j} className="mv-keyword">{kw}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {projects.length === 0 && (
                <div className="mv-empty">No projects tracked yet</div>
              )}
            </div>
          </div>
        )}

        {/* Candidates Tab */}
        {activeTab === 'Candidates' && (
          <div className="mv-candidates">
            <LocalOnlyNotice label="the candidate review buffer" />
            <div className="mv-section-header">
              <h3>Pending Review ({candidates.length})</h3>
              {candidates.length > 0 && (
                <button
                  className="mv-btn"
                  onClick={async () => {
                    const count = await memoryManager.processCandidates()
                    showNotification(`Processed ${count} candidates`)
                    loadMemory()
                  }}
                >
                  Auto-Process All
                </button>
              )}
            </div>
            <p className="mv-candidates-info">
              These memory candidates were extracted from recent interactions.
              Review and accept to store, or dismiss to ignore.
            </p>
            <div className="mv-candidates-list">
              {candidates.map((candidate, i) => (
                <div key={i} className={`mv-candidate-card ${candidate.type}`}>
                  <div className="mv-candidate-header">
                    <span className={`mv-candidate-type ${candidate.type}`}>
                      {candidate.type.toUpperCase()}
                    </span>
                    <span className="mv-candidate-salience">
                      {(candidate.salience * 100).toFixed(0)}% confidence
                    </span>
                  </div>
                  <div className="mv-candidate-content">{candidate.content}</div>
                  <div className="mv-candidate-meta">
                    <span>From: {candidate.agent}</span>
                    <span>{new Date(candidate.timestamp).toLocaleString()}</span>
                  </div>
                  <div className="mv-candidate-actions">
                    <button
                      className="mv-btn primary"
                      onClick={() => processCandidate(candidate, 'accept')}
                    >
                      Accept
                    </button>
                    <button
                      className="mv-btn"
                      onClick={() => processCandidate(candidate, 'dismiss')}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
              {candidates.length === 0 && (
                <div className="mv-empty-state">
                  <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.3">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                  <p>No pending candidates. All caught up!</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Edit Modal */}
      {editingItem && (
        <div className="mv-edit-modal-overlay" onClick={cancelEdit}>
          <div className="mv-edit-modal" onClick={e => e.stopPropagation()}>
            <div className="mv-edit-header">
              <h3>Edit {editingItem.type}</h3>
              <button className="mv-close" onClick={cancelEdit}>×</button>
            </div>
            <textarea
              className="mv-edit-textarea"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              rows={15}
            />
            <div className="mv-edit-actions">
              <button className="mv-btn" onClick={cancelEdit}>Cancel</button>
              <button className="mv-btn primary" onClick={saveEdit}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default MemoryView
