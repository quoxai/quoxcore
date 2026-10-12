import { useState, useEffect } from 'react'
import { getMemoryManager } from '../../services/memoryManager'
import './memory.css'

export function MemoryPanel({ onOpenWizard }) {
  const [stats, setStats] = useState(null)
  const memoryManager = getMemoryManager()

  useEffect(() => {
    setStats(memoryManager.getStats())
  }, [])

  const handleExport = () => {
    const data = memoryManager.exportMemory()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `quox-memory-${new Date().toISOString().split('T')[0]}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImport = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = e.target.files[0]
      if (!file) return
      try {
        const text = await file.text()
        const data = JSON.parse(text)
        if (memoryManager.importMemory(data)) {
          setStats(memoryManager.getStats())
          alert('Memory imported successfully')
        }
      } catch (err) {
        alert('Failed to import memory: ' + err.message)
      }
    }
    input.click()
  }

  const handleClear = () => {
    if (confirm('Are you sure you want to clear all memory? This cannot be undone.')) {
      memoryManager.clearMemory()
      setStats(memoryManager.getStats())
    }
  }

  return (
    <div className="memory-panel">
      <div className="memory-panel-header">
        <h3>
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><circle cx="12" cy="12" r="10"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          Memory System
        </h3>
        <button className="memory-btn" onClick={onOpenWizard}>
          Setup
        </button>
      </div>

      {stats && (
        <div className="memory-stats">
          <div className="memory-stat">
            <div className="memory-stat-value">{stats.episodicEntries}</div>
            <div className="memory-stat-label">Events</div>
          </div>
          <div className="memory-stat">
            <div className="memory-stat-value">{stats.learnedFacts + stats.learnedPreferences}</div>
            <div className="memory-stat-label">Learned</div>
          </div>
          <div className="memory-stat">
            <div className="memory-stat-value">{stats.projects}</div>
            <div className="memory-stat-label">Projects</div>
          </div>
        </div>
      )}

      <div className="memory-actions">
        <button className="memory-btn" onClick={handleExport}>Export</button>
        <button className="memory-btn" onClick={handleImport}>Import</button>
        <button className="memory-btn danger" onClick={handleClear}>Clear</button>
      </div>
    </div>
  )
}

export default MemoryPanel
