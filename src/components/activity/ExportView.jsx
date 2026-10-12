/**
 * ExportView — Dedicated audit export page
 *
 * Enterprise-grade export builder with scope selection,
 * format options, and preview. Supports single conversation
 * or full filtered export.
 */

import { useState } from 'react'
import {
  getConversation,
  getConversations,
  getEnvelopeSummary,
  AOCL_LAYERS
} from '../../lib/aee'

const EXPORT_FORMATS = [
  {
    id: 'json',
    label: 'JSON',
    desc: 'Full structured data. Best for programmatic analysis and re-import.',
    ext: '.json',
    mime: 'application/json',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
      </svg>
    )
  },
  {
    id: 'csv',
    label: 'CSV',
    desc: 'Spreadsheet-compatible. Best for Excel, Google Sheets, and BI tools.',
    ext: '.csv',
    mime: 'text/csv',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>
      </svg>
    )
  },
  {
    id: 'markdown',
    label: 'Markdown',
    desc: 'Human-readable report format. Best for documentation and reviews.',
    ext: '.md',
    mime: 'text/markdown',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
      </svg>
    )
  },
  {
    id: 'ndjson',
    label: 'NDJSON',
    desc: 'Newline-delimited JSON. Best for streaming ingestion and log pipelines.',
    ext: '.ndjson',
    mime: 'application/x-ndjson',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
        <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
      </svg>
    )
  }
]

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function formatCSV(messages) {
  const header = 'Timestamp,Type,From,To,Intent,Layer,Content,Correlation ID,Envelope ID\n'
  const rows = messages.map(msg => {
    const text = (msg.payload?.text || msg.payload?.command || msg.payload?.error_message || '')
      .replace(/"/g, '""').replace(/\n/g, ' ')
    const layer = msg.payload?.layer || ''
    return `"${msg.ts}","${msg.type}","${msg.from}","${msg.to}","${msg.intent}","${layer}","${text}","${msg.corr}","${msg.id}"`
  })
  return header + rows.join('\n')
}

function formatMarkdown(messages, title) {
  let md = `# Audit Export: ${title}\n\n`
  md += `**Exported:** ${new Date().toLocaleString()}\n`
  md += `**Records:** ${messages.length}\n\n---\n\n`
  for (const msg of messages) {
    const time = new Date(msg.ts).toLocaleTimeString()
    const sender = msg.from?.split('.').slice(1).join('.') || msg.from || 'unknown'
    if (msg.intent?.startsWith('aocl.')) {
      md += `**[${time}] AOCL ${msg.payload?.layer || ''}** ${msg.payload?.status || ''}`
      if (msg.payload?.duration_ms) md += ` (${msg.payload.duration_ms}ms)`
      md += '\n\n'
    } else {
      const content = msg.payload?.text || msg.payload?.content || JSON.stringify(msg.payload)
      md += `**[${time}] ${sender}:**\n${content}\n\n`
    }
  }
  return md
}

export default function ExportView({ conversations, selectedConv, selectedMessages, filters, onBack }) {
  const [scope, setScope] = useState(selectedConv ? 'selected' : 'filtered')
  const [format, setFormat] = useState('json')
  const [exporting, setExporting] = useState(false)
  const [lastExport, setLastExport] = useState(null)

  const selectedConvData = conversations?.find(c => c.corr === selectedConv)
  const filteredCount = conversations?.length || 0

  const scopeOptions = [
    ...(selectedConv ? [{
      id: 'selected',
      label: 'Selected Conversation',
      desc: selectedConvData ? getEnvelopeSummary(selectedConvData.firstMessage).slice(0, 60) : selectedConv,
      count: selectedMessages?.length || 0
    }] : []),
    {
      id: 'filtered',
      label: 'All Filtered Conversations',
      desc: `Currently ${filteredCount} conversations matching your filters`,
      count: null
    },
    {
      id: 'full',
      label: 'Full Audit Trail',
      desc: 'Every envelope in the AEE database (complete compliance export)',
      count: null
    }
  ]

  const handleExport = async () => {
    setExporting(true)
    try {
      let messages = []
      let title = 'AEE Audit Trail'

      if (scope === 'selected' && selectedMessages?.length) {
        messages = selectedMessages
        title = selectedConvData ? getEnvelopeSummary(selectedConvData.firstMessage).slice(0, 40) : selectedConv
      } else if (scope === 'full') {
        const allConvs = await getConversations({ limit: 200 })
        for (const conv of allConvs) {
          const msgs = await getConversation(conv.corr)
          messages.push(...msgs)
        }
        messages.sort((a, b) => a.ts.localeCompare(b.ts))
        title = 'Full Audit Trail'
      } else {
        for (const conv of (conversations || [])) {
          const msgs = await getConversation(conv.corr)
          messages.push(...msgs)
        }
        messages.sort((a, b) => a.ts.localeCompare(b.ts))
        title = `Filtered Export (${filteredCount} conversations)`
      }

      const timestamp = new Date().toISOString().slice(0, 10)
      const fmt = EXPORT_FORMATS.find(f => f.id === format)
      let content, filename

      switch (format) {
        case 'json':
          content = JSON.stringify(messages, null, 2)
          filename = `aee-audit-${timestamp}${fmt.ext}`
          break
        case 'csv':
          content = formatCSV(messages)
          filename = `aee-audit-${timestamp}${fmt.ext}`
          break
        case 'markdown':
          content = formatMarkdown(messages, title)
          filename = `aee-audit-${timestamp}${fmt.ext}`
          break
        case 'ndjson':
          content = messages.map(m => JSON.stringify(m)).join('\n')
          filename = `aee-audit-${timestamp}${fmt.ext}`
          break
        default:
          return
      }

      downloadFile(content, filename, fmt.mime)
      setLastExport({ filename, count: messages.length, time: new Date() })
    } catch (err) {
      console.error('Export failed:', err)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="export-view">
      <div className="export-view-header">
        <button className="export-back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Back
        </button>
        <div className="export-view-title">
          <h2>Export Audit Data</h2>
          <p>Generate compliance reports and data exports from your AEE audit trail</p>
        </div>
      </div>

      <div className="export-view-body">
        {/* Scope Selection */}
        <section className="export-section">
          <h3 className="export-section-title">
            <span className="export-section-num">1</span>
            What to export
          </h3>
          <div className="export-scope-cards">
            {scopeOptions.map(opt => (
              <button
                key={opt.id}
                className={`export-scope-card ${scope === opt.id ? 'active' : ''}`}
                onClick={() => setScope(opt.id)}
              >
                <span className="scope-card-label">{opt.label}</span>
                <span className="scope-card-desc">{opt.desc}</span>
                {opt.count != null && (
                  <span className="scope-card-count">{opt.count} envelopes</span>
                )}
              </button>
            ))}
          </div>
        </section>

        {/* Format Selection */}
        <section className="export-section">
          <h3 className="export-section-title">
            <span className="export-section-num">2</span>
            Export format
          </h3>
          <div className="export-format-cards">
            {EXPORT_FORMATS.map(fmt => (
              <button
                key={fmt.id}
                className={`export-format-card ${format === fmt.id ? 'active' : ''}`}
                onClick={() => setFormat(fmt.id)}
              >
                <span className="format-card-icon">{fmt.icon}</span>
                <span className="format-card-label">{fmt.label}</span>
                <span className="format-card-desc">{fmt.desc}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Export Action */}
        <section className="export-section export-action-section">
          <button
            className="export-execute-btn"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? (
              <>
                <span className="export-spinner" />
                Exporting...
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Export {EXPORT_FORMATS.find(f => f.id === format)?.label}
              </>
            )}
          </button>
          {lastExport && (
            <div className="export-last-result">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
              Exported {lastExport.count} envelopes as <strong>{lastExport.filename}</strong>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
