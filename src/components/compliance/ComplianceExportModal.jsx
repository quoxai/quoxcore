/**
 * ComplianceExportModal - Export compliance reports
 *
 * Allows users to select a compliance format, date range, and options,
 * then generates and downloads a compliance report.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  COMPLIANCE_FORMATS,
  generateComplianceReport,
  downloadReport,
  exportAsMarkdown
} from '../../services/compliance/complianceExporter'
import { useComplianceSuiteStatus } from '../../services/aoclPluginService'
import './compliance.css'

export default function ComplianceExportModal({ isOpen, onClose }) {
  const { licensed, loading: licenseLoading } = useComplianceSuiteStatus()
  const [format, setFormat] = useState('json')
  const [period, setPeriod] = useState(() => {
    const end = new Date()
    const start = new Date()
    start.setDate(start.getDate() - 30)
    return {
      start: start.toISOString().split('T')[0],
      end: end.toISOString().split('T')[0]
    }
  })
  const [includeEvidence, setIncludeEvidence] = useState(true)
  const [sampleSize, setSampleSize] = useState(50)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [report, setReport] = useState(null)

  if (!isOpen) return null

  const handleGenerate = async () => {
    setLoading(true)
    setError(null)
    setReport(null)

    try {
      const result = await generateComplianceReport(format, {
        period: {
          start: new Date(period.start).toISOString(),
          end: new Date(period.end).toISOString()
        },
        includeEvidence,
        sampleSize
      })
      setReport(result)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleDownload = async (type) => {
    if (!report) return

    try {
      if (type === 'json') {
        await downloadReport(report, `compliance-${format}-${Date.now()}`)
      } else if (type === 'pdf') {
        await downloadReport(report, `compliance-${format}-${Date.now()}`, { format: 'pdf' })
      } else if (type === 'markdown') {
        const md = exportAsMarkdown(report)
        const blob = new Blob([md], { type: 'text/markdown' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `compliance-${format}-${Date.now()}.md`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      setError(err.message || 'Download failed')
    }
  }

  const isPremiumFormat = format !== 'json'
  const canGenerate = !isPremiumFormat || licensed

  return (
    <div className="compliance-modal-overlay" onClick={onClose}>
      <div className="compliance-modal" onClick={e => e.stopPropagation()}>
        <div className="compliance-modal-header">
          <h2>Export Compliance Report</h2>
          <button className="compliance-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="compliance-modal-body">
          {/* Format Selection */}
          <div className="compliance-field">
            <label>Compliance Format</label>
            <div className="compliance-format-grid">
              {Object.values(COMPLIANCE_FORMATS).map(fmt => (
                <button
                  key={fmt.id}
                  className={`compliance-format-btn ${format === fmt.id ? 'active' : ''} ${!fmt.free && !licensed ? 'locked' : ''}`}
                  onClick={() => setFormat(fmt.id)}
                  disabled={!fmt.free && !licensed}
                >
                  <span className="compliance-format-name">{fmt.name}</span>
                  <span className="compliance-format-desc">{fmt.description}</span>
                  {!fmt.free && (
                    <span className="compliance-format-badge">
                      {licensed ? 'ENT' : '🔒'}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* License Warning */}
          {isPremiumFormat && !licensed && !licenseLoading && (
            <div className="compliance-warning">
              <strong>License Required</strong>
              <p>
                {COMPLIANCE_FORMATS[format]?.name} export requires AOCL Compliance Suite.
                <Link to="/settings#plugins" className="compliance-upgrade-link">Upgrade Now</Link>
              </p>
            </div>
          )}

          {/* Date Range */}
          <div className="compliance-field">
            <label>Report Period</label>
            <div className="compliance-date-range">
              <input
                type="date"
                value={period.start}
                onChange={e => setPeriod(p => ({ ...p, start: e.target.value }))}
              />
              <span>to</span>
              <input
                type="date"
                value={period.end}
                onChange={e => setPeriod(p => ({ ...p, end: e.target.value }))}
              />
            </div>
            <div className="compliance-quick-periods">
              <button onClick={() => {
                const end = new Date()
                const start = new Date()
                start.setDate(start.getDate() - 7)
                setPeriod({ start: start.toISOString().split('T')[0], end: end.toISOString().split('T')[0] })
              }}>Last 7 days</button>
              <button onClick={() => {
                const end = new Date()
                const start = new Date()
                start.setDate(start.getDate() - 30)
                setPeriod({ start: start.toISOString().split('T')[0], end: end.toISOString().split('T')[0] })
              }}>Last 30 days</button>
              <button onClick={() => {
                const end = new Date()
                const start = new Date()
                start.setDate(start.getDate() - 90)
                setPeriod({ start: start.toISOString().split('T')[0], end: end.toISOString().split('T')[0] })
              }}>Last 90 days</button>
            </div>
          </div>

          {/* Options */}
          {format !== 'json' && (
            <div className="compliance-options">
              <div className="compliance-field">
                <label>
                  <input
                    type="checkbox"
                    checked={includeEvidence}
                    onChange={e => setIncludeEvidence(e.target.checked)}
                  />
                  Include evidence samples
                </label>
              </div>

              <div className="compliance-field">
                <label>Sample Size: {sampleSize}</label>
                <input
                  type="range"
                  min="10"
                  max="100"
                  value={sampleSize}
                  onChange={e => setSampleSize(parseInt(e.target.value))}
                />
              </div>
            </div>
          )}

          {/* Error Display */}
          {error && (
            <div className="compliance-error">
              {error}
            </div>
          )}

          {/* Report Preview */}
          {report && (
            <div className="compliance-preview">
              <h3>Report Generated</h3>
              <div className="compliance-preview-stats">
                <div className="compliance-stat">
                  <span className="compliance-stat-value">{report.overallScore}%</span>
                  <span className="compliance-stat-label">Compliance Score</span>
                </div>
                <div className="compliance-stat">
                  <span className="compliance-stat-value">{report.summary?.totalTraces || 0}</span>
                  <span className="compliance-stat-label">Traces</span>
                </div>
                <div className="compliance-stat">
                  <span className="compliance-stat-value">{report.period?.days || 0}</span>
                  <span className="compliance-stat-label">Days</span>
                </div>
              </div>
              <div className="compliance-preview-status" data-status={report.overallStatus}>
                Status: {report.overallStatus?.toUpperCase()}
              </div>
            </div>
          )}
        </div>

        <div className="compliance-modal-footer">
          {!report ? (
            <>
              <button className="compliance-btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                className="compliance-btn-primary"
                onClick={handleGenerate}
                disabled={loading || !canGenerate}
              >
                {loading ? 'Generating...' : 'Generate Report'}
              </button>
            </>
          ) : (
            <>
              <button className="compliance-btn-secondary" onClick={() => setReport(null)}>
                New Report
              </button>
              <button className="compliance-btn-secondary" onClick={() => handleDownload('markdown')}>
                Download MD
              </button>
              <button className="compliance-btn-secondary" onClick={() => handleDownload('json')}>
                Download JSON
              </button>
              <button className="compliance-btn-primary" onClick={() => handleDownload('pdf')}>
                Download PDF
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
