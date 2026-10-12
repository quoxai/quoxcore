/**
 * ProxmoxBackups — Backup overview dashboard panel.
 *
 * Shows: recent backup tasks (success/fail), per-VM backup coverage,
 * backup schedule overview, and storage usage by backups.
 * Data from Proxmox API: /cluster/backup, /cluster/tasks, /nodes/{n}/storage/{s}/content.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  getBackupSchedules,
  getBackupTasks,
  getBackupContent,
  getBackupStorages,
  formatBytes,
} from '../../services/proxmoxClient'
import './proxmox-backups.css'

const BACKUP_REFRESH = 60000 // 60s

function timeAgo(epoch) {
  if (!epoch) return '--'
  const diff = Math.floor(Date.now() / 1000) - epoch
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '--'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

function formatSchedule(schedule) {
  if (!schedule) return '--'
  // Proxmox format: "4,19:30" means day-of-week 4, 19:30
  // or "sat 02:00" or "*-*-* 19:30:00"
  return schedule
}

function healthColor(pct) {
  if (pct >= 90) return '#ff5555'
  if (pct >= 75) return '#ffb030'
  return '#30ff90'
}

/** Storage usage bar */
function StorageBar({ storage }) {
  const pct = parseFloat(storage.usedPercent) || 0
  const color = healthColor(pct)
  return (
    <div className="pxb-storage">
      <div className="pxb-storage__header">
        <div className="pxb-storage__name">
          <span className="pxb-storage__icon">
            {storage.plugintype === 'pbs' ? '◈' : '◫'}
          </span>
          <span>{storage.storage}</span>
          {storage.shared && <span className="pxb-storage__shared">SHARED</span>}
        </div>
        <div className="pxb-storage__usage">
          <span style={{ color }}>{pct}%</span>
          <span className="pxb-storage__detail">
            {formatBytes(storage.disk)} / {formatBytes(storage.maxdisk)}
          </span>
        </div>
      </div>
      <div className="pxb-storage__track">
        <div
          className="pxb-storage__fill"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <div className="pxb-storage__meta">
        <span>{storage.plugintype?.toUpperCase() || 'DIR'}</span>
        <span>{storage.node}</span>
      </div>
    </div>
  )
}

/** Recent task row */
function TaskRow({ task }) {
  const ok = task.status === 'OK'
  return (
    <div className={`pxb-task ${ok ? '' : 'pxb-task--failed'}`}>
      <span className={`pxb-task__dot ${ok ? 'pxb-task__dot--ok' : 'pxb-task__dot--fail'}`} />
      <span className="pxb-task__node">{task.node}</span>
      <span className="pxb-task__time">{timeAgo(task.starttime)}</span>
      <span className="pxb-task__duration">{formatDuration(task.duration)}</span>
      <span className={`pxb-task__status ${ok ? 'pxb-task__status--ok' : 'pxb-task__status--fail'}`}>
        {ok ? 'OK' : task.status?.replace(/^WARNINGS: /, 'WARN: ') || 'FAIL'}
      </span>
    </div>
  )
}

/** Schedule card */
function ScheduleCard({ schedule }) {
  return (
    <div className={`pxb-sched ${schedule.enabled ? '' : 'pxb-sched--disabled'}`}>
      <div className="pxb-sched__header">
        <span className={`pxb-sched__dot ${schedule.enabled ? 'pxb-sched__dot--on' : 'pxb-sched__dot--off'}`} />
        <span className="pxb-sched__node">{schedule.node}</span>
        {!schedule.enabled && <span className="pxb-sched__badge">DISABLED</span>}
      </div>
      <div className="pxb-sched__details">
        <div className="pxb-sched__row">
          <span className="pxb-sched__label">Schedule</span>
          <span className="pxb-sched__value">{formatSchedule(schedule.schedule)}</span>
        </div>
        <div className="pxb-sched__row">
          <span className="pxb-sched__label">Storage</span>
          <span className="pxb-sched__value">{schedule.storage}</span>
        </div>
        <div className="pxb-sched__row">
          <span className="pxb-sched__label">Mode</span>
          <span className="pxb-sched__value">{schedule.mode}</span>
        </div>
        <div className="pxb-sched__row">
          <span className="pxb-sched__label">Scope</span>
          <span className="pxb-sched__value">{schedule.all ? 'All guests' : 'Selected'}</span>
        </div>
        {schedule.nextRun && (
          <div className="pxb-sched__row">
            <span className="pxb-sched__label">Next run</span>
            <span className="pxb-sched__value">{timeAgo(schedule.nextRun).replace(' ago', '')}</span>
          </div>
        )}
        {schedule.pruneBackups && (
          <div className="pxb-sched__row">
            <span className="pxb-sched__label">Retention</span>
            <span className="pxb-sched__value">
              {Object.entries(schedule.pruneBackups).map(([k, v]) => `${k}: ${v}`).join(', ')}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

/** Coverage row — per-VM backup status */
function CoverageRow({ vmid, name, backups, allItems }) {
  const latest = backups[0] // sorted newest first
  const count = backups.length
  const totalSize = backups.reduce((s, b) => s + (b.size || 0), 0)
  const ageSeconds = latest ? Math.floor(Date.now() / 1000) - latest.ctime : Infinity
  const ageDays = Math.floor(ageSeconds / 86400)
  const stale = ageDays > 3
  const veryStale = ageDays > 7

  // Check if VM is still running in cluster
  const vmItem = allItems?.find(i => i.vmid === vmid)
  const isActive = !!vmItem

  return (
    <div className={`pxb-cov ${veryStale ? 'pxb-cov--danger' : stale ? 'pxb-cov--warn' : ''}`}>
      <span className="pxb-cov__vmid">{vmid}</span>
      <span className="pxb-cov__name" title={name}>{name || '--'}</span>
      <span className="pxb-cov__count">{count}</span>
      <span className="pxb-cov__age" style={{ color: veryStale ? '#ff5555' : stale ? '#ffb030' : 'rgba(255,255,255,0.6)' }}>
        {timeAgo(latest?.ctime)}
      </span>
      <span className="pxb-cov__size">{formatBytes(totalSize)}</span>
      <span className={`pxb-cov__active ${isActive ? 'pxb-cov__active--yes' : ''}`}>
        {isActive ? '●' : '○'}
      </span>
    </div>
  )
}

export function ProxmoxBackups({ cluster, allItems = [] }) {
  const [tasks, setTasks] = useState([])
  const [schedules, setSchedules] = useState([])
  const [storages, setStorages] = useState([])
  const [backupContent, setBackupContent] = useState([])
  const [loading, setLoading] = useState(true)
  const [section, setSection] = useState('tasks') // tasks | coverage | schedules | storage
  const mountedRef = useRef(true)

  const nodes = useMemo(() => cluster?.nodes || [], [cluster])

  const fetchData = useCallback(async (isBackground = false) => {
    if (!isBackground) setLoading(true)

    try {
      // Fetch all data in parallel
      const [taskData, schedData, storData] = await Promise.all([
        getBackupTasks(),
        getBackupSchedules(),
        getBackupStorages(),
      ])

      if (!mountedRef.current) return

      setTasks(taskData)
      setSchedules(schedData)
      setStorages(storData)

      // Fetch backup content from the first backup-capable storage we find
      // Use first online node with backup storage
      if (storData.length > 0) {
        const stor = storData[0]
        const node = stor.shared
          ? (nodes.find(n => n.online === 1)?.name || stor.node)
          : stor.node
        const content = await getBackupContent(node, stor.storage)
        if (mountedRef.current) setBackupContent(content)
      }
    } catch (err) {
      console.error('[ProxmoxBackups] Fetch error:', err)
    }

    if (mountedRef.current) setLoading(false)
  }, [nodes])

  useEffect(() => {
    mountedRef.current = true
    fetchData()
    const interval = setInterval(() => fetchData(true), BACKUP_REFRESH)
    return () => {
      mountedRef.current = false
      clearInterval(interval)
    }
  }, [fetchData])

  // Aggregate backup content by vmid
  const coverageMap = useMemo(() => {
    const map = new Map()
    for (const b of backupContent) {
      if (!map.has(b.vmid)) map.set(b.vmid, { name: b.notes, backups: [] })
      map.get(b.vmid).backups.push(b)
    }
    // Sort backups newest first within each VM
    for (const [, entry] of map) {
      entry.backups.sort((a, b) => b.ctime - a.ctime)
    }
    return map
  }, [backupContent])

  // Summary stats
  const summary = useMemo(() => {
    const totalTasks = tasks.length
    const okTasks = tasks.filter(t => t.status === 'OK').length
    const failedTasks = totalTasks - okTasks
    const totalVMs = coverageMap.size
    const now = Math.floor(Date.now() / 1000)
    let staleCount = 0
    for (const [, entry] of coverageMap) {
      const latest = entry.backups[0]
      if (latest && (now - latest.ctime) > 3 * 86400) staleCount++
    }
    const totalSize = backupContent.reduce((s, b) => s + (b.size || 0), 0)
    // VMs in cluster with no backups
    const backedUpVmids = new Set(coverageMap.keys())
    const unbackedVMs = allItems.filter(i => !backedUpVmids.has(i.vmid))

    return { totalTasks, okTasks, failedTasks, totalVMs, staleCount, totalSize, unbackedCount: unbackedVMs.length }
  }, [tasks, coverageMap, backupContent, allItems])

  if (loading && tasks.length === 0) {
    return (
      <div className="pxb">
        <div className="pxb-loading">Loading backup data...</div>
      </div>
    )
  }

  return (
    <div className="pxb">
      {/* Summary strip */}
      <div className="pxb-summary">
        <div className="pxb-summary__item">
          <span className="pxb-summary__value" style={{ color: summary.failedTasks > 0 ? '#ff5555' : '#30ff90' }}>
            {summary.okTasks}/{summary.totalTasks}
          </span>
          <span className="pxb-summary__label">tasks OK</span>
        </div>
        <div className="pxb-summary__sep" />
        <div className="pxb-summary__item">
          <span className="pxb-summary__value" style={{ color: 'rgba(255,255,255,0.85)' }}>
            {summary.totalVMs}
          </span>
          <span className="pxb-summary__label">VMs backed up</span>
        </div>
        <div className="pxb-summary__sep" />
        <div className="pxb-summary__item">
          <span className="pxb-summary__value" style={{ color: summary.staleCount > 0 ? '#ffb030' : '#30ff90' }}>
            {summary.staleCount}
          </span>
          <span className="pxb-summary__label">stale (&gt;3d)</span>
        </div>
        <div className="pxb-summary__sep" />
        <div className="pxb-summary__item">
          <span className="pxb-summary__value" style={{ color: summary.unbackedCount > 0 ? '#ffb030' : '#30ff90' }}>
            {summary.unbackedCount}
          </span>
          <span className="pxb-summary__label">no backup</span>
        </div>
        <div className="pxb-summary__sep" />
        <div className="pxb-summary__item">
          <span className="pxb-summary__value" style={{ color: 'rgba(255,255,255,0.7)' }}>
            {formatBytes(summary.totalSize)}
          </span>
          <span className="pxb-summary__label">total</span>
        </div>
      </div>

      {/* Section tabs */}
      <div className="pxb-tabs">
        {[
          { id: 'tasks', label: `Recent Tasks (${tasks.length})` },
          { id: 'coverage', label: `Coverage (${summary.totalVMs})` },
          { id: 'schedules', label: `Schedules (${schedules.length})` },
          { id: 'storage', label: `Storage (${storages.length})` },
        ].map(tab => (
          <button
            key={tab.id}
            className={`pxb-tab ${section === tab.id ? 'pxb-tab--active' : ''}`}
            onClick={() => setSection(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="pxb-content">
        {section === 'tasks' && (
          <div className="pxb-tasks">
            <div className="pxb-task pxb-task--header">
              <span className="pxb-task__dot" />
              <span className="pxb-task__node">Node</span>
              <span className="pxb-task__time">When</span>
              <span className="pxb-task__duration">Duration</span>
              <span className="pxb-task__status">Status</span>
            </div>
            {tasks.length === 0 && (
              <div className="pxb-empty">No recent backup tasks</div>
            )}
            {tasks.map((task, i) => (
              <TaskRow key={task.upid || i} task={task} />
            ))}
          </div>
        )}

        {section === 'coverage' && (
          <div className="pxb-coverage">
            <div className="pxb-cov pxb-cov--header">
              <span className="pxb-cov__vmid">VMID</span>
              <span className="pxb-cov__name">Name</span>
              <span className="pxb-cov__count">#</span>
              <span className="pxb-cov__age">Last</span>
              <span className="pxb-cov__size">Size</span>
              <span className="pxb-cov__active">Live</span>
            </div>
            {[...coverageMap.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([vmid, entry]) => (
                <CoverageRow
                  key={vmid}
                  vmid={vmid}
                  name={entry.name}
                  backups={entry.backups}
                  allItems={allItems}
                />
              ))
            }
            {coverageMap.size === 0 && (
              <div className="pxb-empty">No backup content found</div>
            )}
          </div>
        )}

        {section === 'schedules' && (
          <div className="pxb-schedules">
            {schedules.map(sched => (
              <ScheduleCard key={sched.id} schedule={sched} />
            ))}
            {schedules.length === 0 && (
              <div className="pxb-empty">No backup schedules configured</div>
            )}
          </div>
        )}

        {section === 'storage' && (
          <div className="pxb-storages">
            {storages.map(stor => (
              <StorageBar key={stor.storage} storage={stor} />
            ))}
            {storages.length === 0 && (
              <div className="pxb-empty">No backup storage found</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default ProxmoxBackups
