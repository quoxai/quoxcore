/**
 * FilesQ Mockup — AssistantQ Bundle Redesign
 *
 * Production-quality mockup components for the Files plugin redesign.
 * Matches BrowserQ visual quality with amber/gold accent.
 * Glass design system compliant — zero grey text, full glass treatment.
 *
 * NOT wired to real data — static mockup for design review.
 * Import at /files-q-mockup route for preview.
 *
 * Theme: Amber #f59e0b → Red #ef4444 gradient (ARCHIVIST brand)
 */

import { useState, useRef, useCallback } from 'react'
import './files-q-mockup.css'

// ─── Mock Data ──────────────────────────────────────────────────────

const MOCK_FOLDERS = [
  { id: 'f1', name: 'Infrastructure', count: 12, icon: '🏗' },
  { id: 'f2', name: 'Reports', count: 8, icon: '📊' },
  { id: 'f3', name: 'Runbooks', count: 23, icon: '📓' },
  { id: 'f4', name: 'Screenshots', count: 45, icon: '📸' },
  { id: 'f5', name: 'Contracts', count: 3, icon: '📝' },
]

const MOCK_FILES = [
  { id: '1', name: 'docker-compose.yml', type: 'text', size: 4280, date: '2m ago', category: 'document', ext: 'yml' },
  { id: '2', name: 'architecture-v3.png', type: 'image', size: 2841600, date: '1h ago', category: 'image', ext: 'png', hasThumb: true },
  { id: '3', name: 'Q1-incident-report.pdf', type: 'pdf', size: 1524000, date: '3h ago', category: 'document', ext: 'pdf' },
  { id: '4', name: 'api-endpoints.json', type: 'json', size: 12400, date: '5h ago', category: 'document', ext: 'json' },
  { id: '5', name: 'deployment-notes.md', type: 'md', size: 8900, date: '1d ago', category: 'document', ext: 'md' },
  { id: '6', name: 'network-topology.png', type: 'image', size: 3200000, date: '2d ago', category: 'image', ext: 'png', hasThumb: true },
  { id: '7', name: 'security-audit.pdf', type: 'pdf', size: 4500000, date: '3d ago', category: 'document', ext: 'pdf' },
  { id: '8', name: 'fleet-inventory.json', type: 'json', size: 45000, date: '4d ago', category: 'document', ext: 'json' },
  { id: '9', name: 'grafana-dashboard.png', type: 'image', size: 1800000, date: '5d ago', category: 'image', ext: 'png', hasThumb: true },
  { id: '10', name: 'onboarding-guide.md', type: 'md', size: 22000, date: '1w ago', category: 'document', ext: 'md' },
]

const MOCK_ACTIVITY = [
  { type: 'upload', text: 'Uploaded architecture-v3.png', time: '1h ago' },
  { type: 'skill', text: 'ARCHIVIST summarized Q1 report', time: '2h ago' },
  { type: 'move', text: 'Moved 3 files to Runbooks/', time: '4h ago' },
  { type: 'upload', text: 'Uploaded docker-compose.yml', time: '5h ago' },
  { type: 'rename', text: 'Renamed topology.png → network-topology.png', time: '1d ago' },
  { type: 'delete', text: 'Deleted old-config-backup.json', time: '2d ago' },
]

const TABS = [
  { id: 'browse', label: 'Browse' },
  { id: 'recent', label: 'Recent' },
  { id: 'skills', label: 'Skills' },
  { id: 'search', label: 'Search' },
  { id: 'storage', label: 'Storage' },
]

const FILE_SKILLS = [
  { id: 'summarize', name: 'Summarize', desc: 'AI summary with key points', icon: '📋', premium: false },
  { id: 'compare', name: 'Compare', desc: 'Diff two files semantically', icon: '🔀', premium: false },
  { id: 'extract', name: 'Extract', desc: 'Structured data to JSON', icon: '🧬', premium: true },
  { id: 'analyze', name: 'Deep Analyze', desc: 'Themes, insights, patterns', icon: '🔬', premium: true },
  { id: 'contradict', name: 'Find Conflicts', desc: 'Cross-file inconsistencies', icon: '⚡', premium: true },
  { id: 'quiz', name: 'Generate Quiz', desc: 'Create Q&A from content', icon: '🎓', premium: true },
]

const WELCOME_CHIPS = [
  { label: 'Upload a document', prompt: 'I want to upload and organize some files' },
  { label: 'Summarize a PDF', prompt: 'Summarize the key points from a PDF document' },
  { label: 'Compare two files', prompt: 'Compare two documents and find differences' },
  { label: 'Search my files', prompt: 'Search across all my uploaded documents' },
  { label: 'Extract data from invoice', prompt: 'Extract structured data from an invoice PDF' },
  { label: 'Organize my files', prompt: 'Help me organize my uploaded files into folders' },
]

// ─── Helpers ────────────────────────────────────────────────────────

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

function fileTypeIcon(type) {
  switch (type) {
    case 'pdf': return { emoji: '📄', cls: 'pdf' }
    case 'json': return { emoji: '{ }', cls: 'json' }
    case 'md': return { emoji: '📝', cls: 'md' }
    case 'image': return { emoji: '🖼', cls: 'image' }
    default: return { emoji: '📃', cls: 'text' }
  }
}

// ─── SVG Icons (inline, 16px) ───────────────────────────────────────

function IconFolder({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
    </svg>
  )
}

function IconUpload({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  )
}

function IconSearch({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  )
}

function IconGrid({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
    </svg>
  )
}

function IconList({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
      <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
    </svg>
  )
}

function IconEye({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
    </svg>
  )
}

function IconDownload({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  )
}

function IconTrash({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </svg>
  )
}

function IconX({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  )
}

function IconMessageSquare({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  )
}

function IconChevronRight({ size = 10 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  )
}

function IconSort({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>
    </svg>
  )
}

function IconCheck({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  )
}

// ─── Shimmer Layer ──────────────────────────────────────────────────

function Shimmer() {
  return (
    <div style={{
      position: 'absolute', inset: 0, borderRadius: 'inherit', pointerEvents: 'none',
      background: 'linear-gradient(105deg, rgba(255,255,255,0.05) 0%, transparent 35%, transparent 65%, rgba(255,255,255,0.01) 100%)'
    }} />
  )
}

// ─── Skeleton Loader ────────────────────────────────────────────────

function Skeleton({ width, height = 16, style }) {
  return (
    <div
      className="fqm-skeleton"
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: `${height}px`,
        borderRadius: 4,
        ...style
      }}
    />
  )
}

// ─── Error Banner ───────────────────────────────────────────────────

function ErrorBanner({ message, onRetry }) {
  return (
    <div className="fqm-error-banner">
      <span style={{ flex: 1 }}>⚠ {message}</span>
      {onRetry && (
        <button className="fqm-error-banner__retry" onClick={onRetry}>Retry</button>
      )}
    </div>
  )
}

// ─── Empty State ────────────────────────────────────────────────────

function EmptyState({ icon, text, sub }) {
  return (
    <div className="fqm-empty">
      <div className="fqm-empty__icon">{icon}</div>
      <div className="fqm-empty__text">{text}</div>
      {sub && <div className="fqm-empty__sub">{sub}</div>}
    </div>
  )
}

// ─── Toolbar ────────────────────────────────────────────────────────

function Toolbar({ sidebarOpen, onToggleSidebar, storagePercent = 34 }) {
  return (
    <div className="fqm-toolbar">
      {/* Identity */}
      <div className="fqm-toolbar__identity">
        <div className="fqm-toolbar__icon">
          <IconFolder size={14} />
        </div>
        <span className="fqm-toolbar__name">FILES-Q</span>
        <span className="fqm-toolbar__badge">Document Intelligence</span>
      </div>

      {/* Server status */}
      <div className="fqm-toolbar__server">
        <div className="fqm-toolbar__server-dot" />
        <span className="fqm-toolbar__server-label">SERVER ONLINE</span>
      </div>

      <div className="fqm-toolbar__spacer" />

      {/* Storage bar */}
      <div className="fqm-toolbar__storage">
        <div className="fqm-toolbar__storage-bar">
          <div className="fqm-toolbar__storage-fill" style={{ width: `${storagePercent}%` }} />
        </div>
        <span className="fqm-toolbar__storage-text">17 MB / 50 MB</span>
      </div>

      {/* Primary action */}
      <button className="fqm-toolbar__btn fqm-toolbar__btn--primary">
        <IconUpload size={12} />
        Upload
      </button>

      {/* Sidebar toggle */}
      <button
        className={`fqm-sidebar-toggle ${sidebarOpen ? 'active' : ''}`}
        onClick={onToggleSidebar}
      >
        <IconMessageSquare size={12} />
        ARCHIVIST
      </button>
    </div>
  )
}

// ─── Stats Strip ────────────────────────────────────────────────────

function StatsStrip() {
  return (
    <div className="fqm-stats-strip">
      <div className="fqm-stat-item">
        <span className="fqm-stat-item__value">91</span>
        <span className="fqm-stat-item__label">files</span>
      </div>
      <div className="fqm-stat-divider" />
      <div className="fqm-stat-item">
        <span className="fqm-stat-item__value">5</span>
        <span className="fqm-stat-item__label">folders</span>
      </div>
      <div className="fqm-stat-divider" />
      <div className="fqm-stat-item">
        <span className="fqm-stat-item__value">34</span>
        <span className="fqm-stat-item__label">images</span>
      </div>
      <div className="fqm-stat-divider" />
      <div className="fqm-stat-item">
        <span className="fqm-stat-item__value">12</span>
        <span className="fqm-stat-item__label">PDFs</span>
      </div>
      <div className="fqm-stat-divider" />
      <div className="fqm-stat-item">
        <span className="fqm-stat-item__value">7</span>
        <span className="fqm-stat-item__label">skills run</span>
      </div>
    </div>
  )
}

// ─── Breadcrumb ─────────────────────────────────────────────────────

function Breadcrumb({ path = ['Root', 'Infrastructure'] }) {
  return (
    <div className="fqm-breadcrumb">
      {path.map((item, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {i > 0 && <span className="fqm-breadcrumb__sep"><IconChevronRight /></span>}
          <span className={`fqm-breadcrumb__item ${i === path.length - 1 ? 'fqm-breadcrumb__item--current' : ''}`}>
            {i === 0 && <IconFolder size={12} />} {item}
          </span>
        </span>
      ))}
    </div>
  )
}

// ─── File Card (Grid View) ──────────────────────────────────────────

function FileCard({ file, selected, onSelect }) {
  const { emoji, cls } = fileTypeIcon(file.type)

  return (
    <div
      className={`fqm-file-card ${selected ? 'fqm-file-card--selected' : ''}`}
      onClick={() => onSelect?.(file.id)}
    >
      <Shimmer />

      {/* Preview area */}
      <div className="fqm-file-card__preview">
        {file.hasThumb ? (
          <div style={{
            width: '100%', height: '100%',
            background: `linear-gradient(135deg, rgba(245,158,11,0.06), rgba(99,102,241,0.04))`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 28, opacity: 0.6
          }}>
            🖼
          </div>
        ) : (
          <div className={`fqm-file-card__type-icon fqm-file-card__type-icon--${cls}`}>
            {file.type === 'json' ? '{ }' : emoji}
          </div>
        )}
      </div>

      {/* Hover actions */}
      <div className="fqm-file-card__actions">
        <button className="fqm-file-card__action-btn" title="Preview">
          <IconEye size={12} />
        </button>
        <button className="fqm-file-card__action-btn" title="Download">
          <IconDownload size={12} />
        </button>
        <button className="fqm-file-card__action-btn" title="Delete">
          <IconTrash size={12} />
        </button>
      </div>

      {/* Selected check */}
      {selected && (
        <div className="fqm-file-card__check">
          <IconCheck size={12} />
        </div>
      )}

      {/* Info */}
      <div className="fqm-file-card__info">
        <div className="fqm-file-card__name">{file.name}</div>
        <div className="fqm-file-card__meta">
          <span className="fqm-file-card__size">{formatSize(file.size)}</span>
          <span className="fqm-file-card__date">{file.date}</span>
        </div>
      </div>
    </div>
  )
}

// ─── File Row (List View) ───────────────────────────────────────────

function FileRow({ file, selected, onSelect }) {
  const { emoji, cls } = fileTypeIcon(file.type)

  return (
    <div
      className={`fqm-file-row ${selected ? 'fqm-file-row--selected' : ''}`}
      onClick={() => onSelect?.(file.id)}
    >
      <div className={`fqm-file-row__icon fqm-file-card__type-icon--${cls}`}
        style={{ background: undefined }}>
        <span style={{ fontSize: 16 }}>{file.type === 'json' ? '{ }' : emoji}</span>
      </div>
      <div className="fqm-file-row__info">
        <div className="fqm-file-row__name">{file.name}</div>
        <div className="fqm-file-row__detail">{formatSize(file.size)} · {file.date} · .{file.ext}</div>
      </div>
      <div className="fqm-file-row__actions">
        <button className="fqm-file-card__action-btn" title="Preview"><IconEye size={12} /></button>
        <button className="fqm-file-card__action-btn" title="Download"><IconDownload size={12} /></button>
        <button className="fqm-file-card__action-btn" title="Delete"><IconTrash size={12} /></button>
      </div>
    </div>
  )
}

// ─── Folder Card ────────────────────────────────────────────────────

function FolderCard({ folder }) {
  return (
    <div className="fqm-folder-card">
      <Shimmer />
      <span className="fqm-folder-card__icon">{folder.icon}</span>
      <div className="fqm-folder-card__info">
        <div className="fqm-folder-card__name">{folder.name}</div>
        <div className="fqm-folder-card__count">{folder.count} files</div>
      </div>
    </div>
  )
}

// ─── Drop Zone ──────────────────────────────────────────────────────

function DropZone({ active }) {
  return (
    <div className={`fqm-dropzone ${active ? 'fqm-dropzone--active' : ''}`}>
      <Shimmer />
      <div className="fqm-dropzone__icon">
        <IconUpload size={32} />
      </div>
      <div className="fqm-dropzone__title">Drop files here or click to browse</div>
      <div className="fqm-dropzone__subtitle">Max 5 MB per file · 50 MB total (free tier)</div>
      <div className="fqm-dropzone__formats">
        {['PNG', 'JPG', 'PDF', 'TXT', 'MD', 'JSON'].map(f => (
          <span key={f} className="fqm-dropzone__format-badge">{f}</span>
        ))}
      </div>
    </div>
  )
}

// ─── Upload Progress ────────────────────────────────────────────────

function UploadProgress({ name = 'architecture-v4.png', percent = 67 }) {
  return (
    <div className="fqm-upload-progress">
      <div className="fqm-upload-progress__bar" style={{ width: `${percent}%` }} />
      <div className="fqm-upload-progress__name">{name}</div>
      <div className="fqm-upload-progress__status">Uploading... {percent}%</div>
    </div>
  )
}

// ─── Quick Stats (Overview) ─────────────────────────────────────────

function QuickStats() {
  const stats = [
    { label: 'Total Files', value: '91', sub: '+4 this week', color: '#f59e0b' },
    { label: 'Storage Used', value: '17.2', sub: 'MB of 50 MB', color: '#30ff90' },
    { label: 'Skills Run', value: '7', sub: 'Summaries, extracts', color: '#a855f7' },
    { label: 'Shared', value: '3', sub: 'Chat attachments', color: '#38bdf8' },
  ]

  return (
    <div className="fqm-quick-stats">
      {stats.map((s, i) => (
        <div key={i} className="fqm-quick-stat">
          <Shimmer />
          <div className="fqm-quick-stat__accent" style={{ background: s.color }} />
          <div className="fqm-quick-stat__label">{s.label}</div>
          <div className="fqm-quick-stat__value">{s.value}</div>
          <div className="fqm-quick-stat__sub">{s.sub}</div>
        </div>
      ))}
    </div>
  )
}

// ─── Recent Activity ────────────────────────────────────────────────

function RecentActivity() {
  return (
    <div>
      <div className="fqm-section-label">Recent Activity</div>
      <div className="fqm-activity-list">
        {MOCK_ACTIVITY.map((item, i) => (
          <div key={i} className="fqm-activity-item">
            <div className={`fqm-activity-item__dot fqm-activity-item__dot--${item.type}`} />
            <span className="fqm-activity-item__text">{item.text}</span>
            <span className="fqm-activity-item__time">{item.time}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Skills Panel ───────────────────────────────────────────────────

function SkillsPanel() {
  return (
    <div>
      <div className="fqm-section-label">ARCHIVIST File Skills</div>
      <div style={{ fontSize: 12, color: '#ffffff', marginBottom: 12 }}>
        Select files, then run a skill. ARCHIVIST analyzes your documents with AI.
      </div>
      <div className="fqm-skills">
        {FILE_SKILLS.map(skill => (
          <div key={skill.id} className="fqm-skill-card">
            <Shimmer />
            {skill.premium && <span className="fqm-skill-card__premium">PRO</span>}
            <div className="fqm-skill-card__icon">{skill.icon}</div>
            <div className="fqm-skill-card__name">{skill.name}</div>
            <div className="fqm-skill-card__desc">{skill.desc}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Storage Tab ────────────────────────────────────────────────────

function StorageTab() {
  const categories = [
    { name: 'Images', size: '8.4 MB', percent: 49, color: '#30ff90' },
    { name: 'PDFs', size: '5.8 MB', percent: 34, color: '#ef4444' },
    { name: 'Text/Markdown', size: '1.2 MB', percent: 7, color: '#38bdf8' },
    { name: 'JSON', size: '1.1 MB', percent: 6, color: '#6366f1' },
    { name: 'Other', size: '0.7 MB', percent: 4, color: '#f59e0b' },
  ]

  return (
    <div>
      <div className="fqm-section-label">Storage Breakdown</div>

      {/* Big storage arc placeholder */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '20px 0', marginBottom: 16
      }}>
        <div style={{
          width: 140, height: 140, borderRadius: '50%',
          border: '4px solid rgba(255,255,255,0.06)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', position: 'relative'
        }}>
          {/* Fill arc indicator */}
          <div style={{
            position: 'absolute', inset: -4, borderRadius: '50%',
            border: '4px solid transparent',
            borderTopColor: '#f59e0b', borderRightColor: '#30ff90',
            transform: 'rotate(-45deg)'
          }} />
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 28,
            fontWeight: 700, color: '#ffffff', fontVariantNumeric: 'tabular-nums'
          }}>34%</span>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>17.2 / 50 MB</span>
        </div>
      </div>

      {/* Category bars */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {categories.map(cat => (
          <div key={cat.name}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              marginBottom: 4
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#ffffff' }}>{cat.name}</span>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
                color: 'rgba(255,255,255,0.6)'
              }}>{cat.size}</span>
            </div>
            <div style={{
              height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden'
            }}>
              <div style={{
                height: '100%', width: `${cat.percent}%`, borderRadius: 3,
                background: cat.color, transition: 'width 0.5s ease'
              }} />
            </div>
          </div>
        ))}
      </div>

      {/* Upgrade prompt */}
      <div style={{
        marginTop: 20, padding: '14px 16px', borderRadius: 10,
        background: 'linear-gradient(145deg, rgba(168,85,247,0.06), rgba(56,189,248,0.03))',
        border: '1px solid rgba(168,85,247,0.15)',
        display: 'flex', alignItems: 'center', gap: 12
      }}>
        <span style={{ fontSize: 24 }}>💎</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#ffffff', marginBottom: 3 }}>
            Upgrade to Premium
          </div>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>
            200 MB storage, semantic search, AI analysis skills
          </div>
        </div>
        <button style={{
          padding: '5px 12px', borderRadius: 6, fontSize: 10, fontWeight: 600,
          background: 'linear-gradient(135deg, #a855f7, #38bdf8)',
          border: 'none', color: '#fff', cursor: 'pointer'
        }}>
          Upgrade
        </button>
      </div>
    </div>
  )
}

// ─── Welcome State ──────────────────────────────────────────────────

function WelcomeState() {
  return (
    <div className="fqm-welcome">
      <div className="fqm-welcome__icon">
        <IconFolder size={32} />
      </div>
      <h2 className="fqm-welcome__title">Files-Q</h2>
      <p className="fqm-welcome__desc">
        Upload, organize, and analyze your documents with AI-powered intelligence.
        ARCHIVIST can summarize, compare, extract data, and find contradictions.
      </p>
      <button className="fqm-toolbar__btn fqm-toolbar__btn--primary" style={{ marginBottom: 24 }}>
        <IconUpload size={14} />
        Upload Your First File
      </button>
      <div className="fqm-section-label" style={{ marginBottom: 10 }}>Or try a quick start</div>
      <div className="fqm-welcome__chips">
        {WELCOME_CHIPS.map((chip, i) => (
          <button key={i} className="fqm-welcome__chip">{chip.label}</button>
        ))}
      </div>
    </div>
  )
}

// ─── Search Tab ─────────────────────────────────────────────────────

function SearchTab() {
  return (
    <div>
      <div className="fqm-search">
        <span className="fqm-search__icon"><IconSearch size={14} /></span>
        <input
          className="fqm-search__input"
          placeholder="Search files by name, content, or meaning..."
          readOnly
        />
      </div>

      {/* Semantic search toggle */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16,
        padding: '8px 12px', borderRadius: 8,
        background: 'rgba(168,85,247,0.04)',
        border: '1px solid rgba(168,85,247,0.1)'
      }}>
        <div style={{
          width: 32, height: 18, borderRadius: 9, background: 'rgba(168,85,247,0.3)',
          position: 'relative', cursor: 'pointer'
        }}>
          <div style={{
            width: 14, height: 14, borderRadius: 7,
            background: '#a855f7', position: 'absolute',
            top: 2, left: 16, transition: 'left 0.15s',
            boxShadow: '0 0 6px rgba(168,85,247,0.4)'
          }} />
        </div>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#ffffff' }}>Semantic Search</span>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 7,
          fontWeight: 700, padding: '1px 5px', borderRadius: 3,
          background: 'rgba(168,85,247,0.15)', border: '1px solid rgba(168,85,247,0.3)',
          color: '#a855f7', textTransform: 'uppercase', letterSpacing: '0.05em'
        }}>PRO</span>
      </div>

      <EmptyState
        icon="🔍"
        text="Search across all your files"
        sub="Type a query to search by filename, content, or semantic meaning"
      />
    </div>
  )
}

// ─── Preview Modal ──────────────────────────────────────────────────

function PreviewModal({ file, onClose }) {
  if (!file) return null

  return (
    <div className="fqm-preview-overlay" onClick={onClose}>
      <div className="fqm-preview-modal" onClick={e => e.stopPropagation()}>
        <Shimmer />
        <div className="fqm-preview-modal__header">
          <div className={`fqm-file-card__type-icon fqm-file-card__type-icon--${fileTypeIcon(file.type).cls}`}
            style={{ width: 28, height: 28, borderRadius: 7, fontSize: 14, flexShrink: 0 }}>
            {file.type === 'json' ? '{ }' : fileTypeIcon(file.type).emoji}
          </div>
          <span className="fqm-preview-modal__title">{file.name}</span>
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
            color: 'rgba(255,255,255,0.6)'
          }}>{formatSize(file.size)}</span>
          <button className="fqm-preview-modal__close" onClick={onClose}>
            <IconX size={14} />
          </button>
        </div>
        <div className="fqm-preview-modal__body">
          {file.type === 'image' ? (
            <div style={{
              width: '100%', height: 400,
              background: 'linear-gradient(135deg, rgba(245,158,11,0.04), rgba(99,102,241,0.03))',
              borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 48, border: '1px solid rgba(255,255,255,0.04)'
            }}>
              🖼
            </div>
          ) : (
            <div style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
              color: '#ffffff', lineHeight: 1.6,
              padding: 16, borderRadius: 8,
              background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.04)'
            }}>
              <div style={{ color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>
                # {file.name}
              </div>
              <div>Preview content would render here...</div>
              <div style={{ marginTop: 8, color: 'rgba(255,255,255,0.6)' }}>
                File size: {formatSize(file.size)} · Uploaded: {file.date}
              </div>
            </div>
          )}
        </div>
        <div className="fqm-preview-modal__footer">
          <button className="fqm-toolbar__btn">
            <IconDownload size={12} />
            Download
          </button>
          <button className="fqm-toolbar__btn">
            <IconMessageSquare size={12} />
            Attach to Chat
          </button>
          <div className="fqm-toolbar__spacer" />
          <button className="fqm-toolbar__btn" style={{ color: '#ef4444' }}>
            <IconTrash size={12} />
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Context Menu ───────────────────────────────────────────────────

function ContextMenuDemo() {
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <div className="fqm-context-menu" style={{ position: 'relative' }}>
        <button className="fqm-context-menu__item">
          <IconEye size={14} /> Preview
        </button>
        <button className="fqm-context-menu__item">
          <IconDownload size={14} /> Download
        </button>
        <button className="fqm-context-menu__item">
          <IconFolder size={14} /> Move to...
        </button>
        <button className="fqm-context-menu__item">
          <IconMessageSquare size={14} /> Attach to Chat
        </button>
        <div className="fqm-context-menu__divider" />
        <button className="fqm-context-menu__item">
          📋 Summarize (ARCHIVIST)
        </button>
        <button className="fqm-context-menu__item">
          🧬 Extract Data (ARCHIVIST)
        </button>
        <div className="fqm-context-menu__divider" />
        <button className="fqm-context-menu__item fqm-context-menu__item--danger">
          <IconTrash size={14} /> Delete
        </button>
      </div>
    </div>
  )
}

// ─── Sidebar (ARCHIVIST Chat) ───────────────────────────────────────

function SidebarMockup() {
  const suggestions = [
    'Summarize this file',
    'Extract key data',
    'Compare two files',
    'Find contradictions',
    'What is this about?',
  ]

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'rgba(0,0,0,0.15)'
    }}>
      {/* Sidebar header */}
      <div style={{
        padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)',
        display: 'flex', alignItems: 'center', gap: 8
      }}>
        <div style={{
          width: 24, height: 24, borderRadius: 6,
          background: 'linear-gradient(135deg, #f59e0b, #ef4444)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12
        }}>📂</div>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#ffffff', letterSpacing: '0.04em' }}>
          ARCHIVIST
        </span>
        <span style={{
          fontSize: 9, fontWeight: 500, color: 'rgba(255,255,255,0.6)',
          marginLeft: 'auto'
        }}>File Intelligence</span>
      </div>

      {/* Suggestion chips */}
      <div style={{
        padding: '8px 14px', display: 'flex', flexWrap: 'wrap', gap: 6,
        borderBottom: '1px solid rgba(255,255,255,0.03)'
      }}>
        {suggestions.map((s, i) => (
          <button key={i} style={{
            padding: '3px 8px', borderRadius: 5, fontSize: 10, fontWeight: 500,
            background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.12)',
            color: '#ffffff', cursor: 'pointer', transition: 'all 0.15s'
          }}>{s}</button>
        ))}
      </div>

      {/* Chat messages mock */}
      <div style={{ flex: 1, padding: 14, overflowY: 'auto' }}>
        {/* User message */}
        <div style={{
          padding: '10px 12px', borderRadius: '10px 10px 4px 10px',
          background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.12)',
          marginBottom: 12, marginLeft: 40, fontSize: 12, color: '#ffffff'
        }}>
          Summarize the Q1 incident report
        </div>

        {/* ARCHIVIST response */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <div style={{
            width: 24, height: 24, borderRadius: 6, flexShrink: 0,
            background: 'linear-gradient(135deg, #f59e0b, #ef4444)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11
          }}>📂</div>
          <div style={{
            padding: '10px 12px', borderRadius: '10px 10px 10px 4px',
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.06)',
            fontSize: 12, color: '#ffffff', lineHeight: 1.5
          }}>
            <div style={{ fontWeight: 600, color: '#f59e0b', fontSize: 10, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Summary: Q1-incident-report.pdf
            </div>
            The Q1 incident report covers 3 major outages affecting the production cluster.
            Key findings include DNS resolution failures on docker03 and certificate expiry on the load balancer.
            <div style={{
              marginTop: 8, padding: '6px 8px', borderRadius: 6,
              background: 'rgba(48,255,144,0.04)', border: '1px solid rgba(48,255,144,0.1)',
              fontSize: 10, color: 'rgba(255,255,255,0.6)'
            }}>
              <span style={{ color: '#30ff90', fontWeight: 600 }}>3 key points</span> extracted ·
              <span style={{ color: '#38bdf8', fontWeight: 600 }}> 2 action items</span> identified
            </div>
          </div>
        </div>
      </div>

      {/* Input area */}
      <div style={{
        padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,0.04)',
        display: 'flex', gap: 8
      }}>
        <input
          style={{
            flex: 1, padding: '8px 12px', borderRadius: 8, fontSize: 12,
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.08)',
            color: '#ffffff', outline: 'none'
          }}
          placeholder="Ask ARCHIVIST about your files..."
          readOnly
        />
        <button style={{
          width: 32, height: 32, borderRadius: 8,
          background: 'linear-gradient(135deg, #f59e0b, #ef4444)',
          border: 'none', color: '#fff', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// MAIN MOCKUP VIEW — Assembles everything
// ═══════════════════════════════════════════════════════════════════

export default function FilesQMockup() {
  const [activeTab, setActiveTab] = useState('browse')
  const [viewMode, setViewMode] = useState('grid')
  const [selectedFiles, setSelectedFiles] = useState(new Set(['2', '6']))
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [previewFile, setPreviewFile] = useState(null)
  const [showWelcome, setShowWelcome] = useState(false)

  const toggleFile = useCallback((id) => {
    setSelectedFiles(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  // ─── Tab content renderer ──────────────────────

  function renderTabContent() {
    if (showWelcome) return <WelcomeState />

    switch (activeTab) {
      case 'browse':
        return (
          <div>
            {/* Action bar */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12
            }}>
              <div className="fqm-search" style={{ flex: 1, marginBottom: 0 }}>
                <span className="fqm-search__icon"><IconSearch size={14} /></span>
                <input className="fqm-search__input" placeholder="Filter files..." readOnly />
              </div>

              <div className="fqm-view-toggle">
                <button
                  className={`fqm-view-toggle__btn ${viewMode === 'grid' ? 'fqm-view-toggle__btn--active' : ''}`}
                  onClick={() => setViewMode('grid')}
                ><IconGrid size={14} /></button>
                <button
                  className={`fqm-view-toggle__btn ${viewMode === 'list' ? 'fqm-view-toggle__btn--active' : ''}`}
                  onClick={() => setViewMode('list')}
                ><IconList size={14} /></button>
              </div>

              <div className="fqm-sort-dropdown">
                <button className="fqm-sort-dropdown__trigger">
                  <IconSort size={12} />
                  Date
                </button>
              </div>

              {selectedFiles.size > 0 && (
                <span style={{
                  fontSize: 10, fontWeight: 600, color: '#a855f7',
                  padding: '3px 8px', borderRadius: 4,
                  background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.2)'
                }}>
                  {selectedFiles.size} selected
                </span>
              )}
            </div>

            {/* Folders */}
            <div className="fqm-section-label">Folders</div>
            <div className="fqm-folder-grid">
              {MOCK_FOLDERS.map(f => <FolderCard key={f.id} folder={f} />)}
            </div>

            {/* Files */}
            <div className="fqm-section-label" style={{ marginTop: 8 }}>Files</div>
            {viewMode === 'grid' ? (
              <div className="fqm-file-grid">
                {MOCK_FILES.map(f => (
                  <FileCard
                    key={f.id}
                    file={f}
                    selected={selectedFiles.has(f.id)}
                    onSelect={toggleFile}
                  />
                ))}
              </div>
            ) : (
              <div className="fqm-file-list">
                {MOCK_FILES.map(f => (
                  <FileRow
                    key={f.id}
                    file={f}
                    selected={selectedFiles.has(f.id)}
                    onSelect={toggleFile}
                  />
                ))}
              </div>
            )}
          </div>
        )

      case 'recent':
        return (
          <div>
            <UploadProgress />
            <QuickStats />
            <RecentActivity />
          </div>
        )

      case 'skills':
        return <SkillsPanel />

      case 'search':
        return <SearchTab />

      case 'storage':
        return <StorageTab />

      default:
        return null
    }
  }

  return (
    <div className="fqm">
      {/* ── Main Area ── */}
      <div className="fqm-main">
        <Toolbar
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        />
        <StatsStrip />
        <Breadcrumb />

        {/* Tabs */}
        <div className="fqm-tabs">
          {TABS.map(tab => (
            <button
              key={tab.id}
              className={`fqm-tab ${activeTab === tab.id ? 'fqm-tab--active' : ''}`}
              onClick={() => { setActiveTab(tab.id); setShowWelcome(false) }}
            >
              {tab.label}
            </button>
          ))}
          <div className="fqm-toolbar__spacer" />
          <button
            className={`fqm-tab ${showWelcome ? 'fqm-tab--active' : ''}`}
            onClick={() => setShowWelcome(!showWelcome)}
            style={{ fontSize: 10, opacity: 0.8 }}
          >
            Welcome
          </button>
        </div>

        {/* Content */}
        <div className="fqm-content">
          {renderTabContent()}
        </div>
      </div>

      {/* ── Sidebar (ARCHIVIST) ── */}
      <div className={`fqm-sidebar ${sidebarOpen ? '' : 'collapsed'}`}>
        <SidebarMockup />
      </div>

      {/* ── Preview Modal ── */}
      <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// COMPONENT GALLERY — Standalone showcase of individual components
// ═══════════════════════════════════════════════════════════════════

export function FilesQComponentGallery() {
  return (
    <div style={{
      padding: 24, maxWidth: 1000, margin: '0 auto',
      display: 'flex', flexDirection: 'column', gap: 32,
      fontFamily: "'Inter', system-ui, sans-serif", color: '#ffffff'
    }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '0.05em' }}>
        FILES-Q Component Gallery
      </h1>
      <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginTop: -20 }}>
        AssistantQ bundle redesign mockup — Glass design system compliant
      </p>

      {/* Drop Zone */}
      <section>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Drop Zone</h3>
        <DropZone />
      </section>

      {/* Upload Progress */}
      <section>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Upload Progress</h3>
        <UploadProgress name="infrastructure-diagram-v4.png" percent={42} />
        <div style={{ height: 8 }} />
        <UploadProgress name="fleet-audit-2026.pdf" percent={89} />
      </section>

      {/* Quick Stats */}
      <section>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Quick Stats</h3>
        <QuickStats />
      </section>

      {/* File Cards Grid */}
      <section>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>File Cards (Grid)</h3>
        <div className="fqm-file-grid">
          {MOCK_FILES.slice(0, 4).map(f => (
            <FileCard key={f.id} file={f} selected={f.id === '2'} onSelect={() => {}} />
          ))}
        </div>
      </section>

      {/* File Rows */}
      <section>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>File Rows (List)</h3>
        <div className="fqm-file-list">
          {MOCK_FILES.slice(0, 4).map(f => (
            <FileRow key={f.id} file={f} selected={f.id === '3'} onSelect={() => {}} />
          ))}
        </div>
      </section>

      {/* Folder Cards */}
      <section>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Folder Cards</h3>
        <div className="fqm-folder-grid">
          {MOCK_FOLDERS.map(f => <FolderCard key={f.id} folder={f} />)}
        </div>
      </section>

      {/* Skills Panel */}
      <section>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>ARCHIVIST Skills</h3>
        <SkillsPanel />
      </section>

      {/* Context Menu */}
      <section>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Context Menu</h3>
        <ContextMenuDemo />
      </section>

      {/* Activity */}
      <section>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Recent Activity</h3>
        <RecentActivity />
      </section>

      {/* Error Banner */}
      <section>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Error Banner</h3>
        <ErrorBanner message="File server unreachable. Files will be stored locally." onRetry={() => {}} />
      </section>

      {/* Empty State */}
      <section>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Empty State</h3>
        <EmptyState icon="📂" text="No files yet" sub="Upload a file to get started" />
      </section>

      {/* Welcome */}
      <section>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Welcome State</h3>
        <WelcomeState />
      </section>

      {/* Storage */}
      <section>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Storage Breakdown</h3>
        <StorageTab />
      </section>
    </div>
  )
}
