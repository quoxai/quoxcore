/**
 * TRV-UX: TraceExportMenu — export trace as JSON log, Markdown report, or CSV
 */

import { useState } from 'react'
import { M, F, COLORS } from '../compliance/glass-primitives'

export default function TraceExportMenu({ trace }) {
  const [exporting, setExporting] = useState(false)

  if (!trace) return null

  const handleExport = (format) => {
    setExporting(true)
    try {
      if (format === 'json') exportJson(trace)
      else if (format === 'markdown') exportMarkdown(trace)
      else if (format === 'csv') exportCsv(trace)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div style={{ display: 'inline-flex', gap: 4 }}>
      {['json', 'markdown', 'csv'].map(fmt => (
        <button
          key={fmt}
          onClick={() => handleExport(fmt)}
          disabled={exporting}
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 4, padding: '4px 10px',
            fontFamily: M, fontSize: 10, color: COLORS.dimText,
            cursor: exporting ? 'default' : 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          {fmt === 'markdown' ? 'MD' : fmt.toUpperCase()}
        </button>
      ))}
    </div>
  )
}

function exportJson(trace) {
  const blob = new Blob([JSON.stringify(trace, null, 2)], { type: 'application/json' })
  download(blob, `trace-${trace.run_id || trace.corr}.json`)
}

function exportMarkdown(trace) {
  const lines = []
  lines.push(`# Trace Report`)
  lines.push('')
  lines.push(`**Run ID:** \`${trace.run_id}\``)
  lines.push(`**Correlation:** \`${trace.corr}\``)
  lines.push(`**Outcome:** ${trace.outcome?.toUpperCase()}`)
  lines.push(`**Duration:** ${formatDuration(trace.duration_ms)}`)
  lines.push(`**Actor:** ${trace.actor?.display_name || trace.actor?.id || 'unknown'}`)
  lines.push(`**Date:** ${trace.started_at}`)
  lines.push('')

  if (trace.narrative) {
    lines.push(`## Summary`)
    lines.push(trace.narrative)
    lines.push('')
  }

  if (trace.query) {
    lines.push(`## Query`)
    lines.push(`> ${trace.query}`)
    lines.push('')
  }

  if (trace.response_summary) {
    lines.push(`## Response Preview`)
    lines.push(`> ${trace.response_summary}`)
    lines.push('')
  }

  lines.push(`## Layers (${trace.layer_count})`)
  lines.push('')
  lines.push('| Layer | Name | Outcome | Duration | Summary |')
  lines.push('|-------|------|---------|----------|---------|')
  for (const l of trace.layers || []) {
    const summary = l.layer_summary?.text || ''
    lines.push(`| ${l.layer_id} | ${l.layer_label} | ${l.outcome} | ${formatDuration(l.duration_ms)} | ${summary} |`)
  }
  lines.push('')

  // Decisions
  const layersWithDecisions = (trace.layers || []).filter(l => l.decisions?.length > 0)
  if (layersWithDecisions.length > 0) {
    lines.push(`## Decisions`)
    lines.push('')
    for (const l of layersWithDecisions) {
      for (const d of l.decisions) {
        lines.push(`- **${l.layer_id} ${l.layer_label}:** ${d.code} — ${d.reason || 'no reason'}`)
      }
    }
    lines.push('')
  }

  if (trace.compliance_tags?.length > 0) {
    lines.push(`## Compliance Tags`)
    lines.push(trace.compliance_tags.map(t => `- ${t}`).join('\n'))
    lines.push('')
  }

  if (trace.volt) {
    lines.push(`## VOLT Integrity`)
    lines.push(`- Events: ${trace.volt.event_count}`)
    lines.push(`- Hash: \`${trace.volt.head_hash || 'none'}\``)
    lines.push(`- Verified: ${trace.volt.verified ? 'Yes' : 'No'}`)
    lines.push('')
  }

  lines.push('---')
  lines.push(`*Generated ${new Date().toISOString()} by QuoxCORE Trace Explorer*`)

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
  download(blob, `trace-${trace.run_id || trace.corr}.md`)
}

function exportCsv(trace) {
  const lines = ['layer_id,layer_label,outcome,status,duration_ms,started_ms,ended_ms,summary,decisions']
  for (const l of trace.layers || []) {
    const summary = (l.layer_summary?.text || '').replace(/,/g, ';')
    const decisions = (l.decisions || []).map(d => `${d.code}: ${d.reason || ''}`).join('; ').replace(/,/g, ';')
    lines.push(`${l.layer_id},${l.layer_label},${l.outcome},${l.status},${l.duration_ms},${l.started_ms},${l.ended_ms},"${summary}","${decisions}"`)
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  download(blob, `trace-${trace.run_id || trace.corr}.csv`)
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function formatDuration(ms) {
  if (!ms && ms !== 0) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}
