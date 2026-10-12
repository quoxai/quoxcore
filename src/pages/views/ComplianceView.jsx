/**
 * ComplianceView — Compliance Command Center
 *
 * CRP-1: Glass redesign of the /compliance page. Tabbed layout with
 * server-side data from CRP-BE endpoints. No IndexedDB dependency.
 *
 * Tabs (CRP_TABS): Posture | Frameworks | Reports | Evidence | Certification |
 * ISO 27001 | AI Act | Privacy Impact | Auditor Portal | Live Monitor |
 * Incidents | Glossary
 */

import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useComplianceData } from '../../hooks/useComplianceData'
import { useComplianceSuiteStatus } from '../../services/aoclPluginService'
import {
  generateComplianceReport,
  downloadReport,
  cancelScheduledJob,
} from '../../services/compliance/complianceExporter'
import { FRAMEWORKS } from '../../services/compliance/evidenceMapping'
import { useSoAAssessment } from '../../hooks/useSoAAssessment'
import { useRiskClassification } from '../../hooks/useRiskClassification'
import { useDPIA } from '../../hooks/useDPIA'
import { useAuditorEngagement } from '../../hooks/useAuditorEngagement'
import {
  ComplianceCommandCenter,
  PostureDashboard,
  FrameworksPanel,
  ReportsPanel,
  EvidenceExplorer,
  CertificationTracker,
} from '../../components/compliance/CRPComponents'
import {
  GlassPanel,
  GlassPill,
  GlassTabBar,
  GlassSkeleton,
  GlassError,
  COLORS,
  M,
  F,
} from '../../components/compliance/glass-primitives'
import AuditusSidebar from '../../components/compliance/AuditusSidebar'

const SoABuilder = lazy(() => import('../../components/compliance/SoABuilder'))
const RiskClassificationWizard = lazy(() => import('../../components/compliance/RiskClassificationWizard'))
const DPIAForm = lazy(() => import('../../components/compliance/DPIAForm'))
const EvidenceExplorerV2 = lazy(() => import('../../components/compliance/EvidenceExplorerV2'))
const AuditorPortal = lazy(() => import('../../components/compliance/AuditorPortal'))
const ComplianceGlossary = lazy(() => import('../../components/compliance/ComplianceGlossary'))
const ComplianceMonitorPanel = lazy(() => import('../../components/compliance/ComplianceMonitorPanel'))
const GovernanceIncidents = lazy(() => import('../../components/compliance/GovernanceIncidents'))

function EnterpriseGate({ licensed, feature, children }) {
  if (licensed) return children
  return (
    <GlassPanel style={{ textAlign: 'center', padding: 40 }}>
      <div style={{ fontSize: 28, opacity: 0.3, marginBottom: 12 }}>◈</div>
      <div style={{ fontFamily: "'Inter',system-ui,sans-serif", fontSize: 14, fontWeight: 600, color: '#fff' }}>
        {feature} requires the AOCL Compliance Suite
      </div>
      <div style={{ fontFamily: "'Inter',system-ui,sans-serif", fontSize: 12, color: 'rgba(255,255,255,0.75)', marginTop: 8, maxWidth: 400, margin: '8px auto 0' }}>
        Upgrade to enterprise to access the full auditor experience — SoA Builder, DPIA Studio, Auditor Portal, and more.
      </div>
      <GlassPill color={COLORS.purple} style={{ marginTop: 16, cursor: 'pointer', padding: '6px 16px' }}>
        View Compliance Suite
      </GlassPill>
    </GlassPanel>
  )
}

const TAB_INTROS = {
  soa: {
    title: 'ISO 27001 Statement of Applicability',
    description: 'Review all 93 security controls from the ISO 27001:2022 standard. For each control, decide if it applies to your organisation, mark its implementation status, and add justification. Technical controls (A.8) are auto-detected from your governance data. When you are done, export the completed SoA for your auditor.',
    glossary: { 'SoA': 'Statement of Applicability — a document listing every ISO 27001 control and whether it applies to your organisation', 'Annex A': 'The section of ISO 27001 containing the 93 security controls', 'Applicable': 'The control is relevant to your organisation and must be implemented', 'Not Applicable': 'The control does not apply (you must justify why)', 'Inherited': 'Another part of your organisation or a third-party service handles this control' },
  },
  classification: {
    title: 'EU AI Act Risk Classification',
    description: 'Answer a few questions about your AI system to determine its risk classification under the EU AI Act. The wizard guides you through prohibited practices, safety components, high-risk use cases, and transparency obligations. The result is a classification memo you can share with your legal team.',
    glossary: { 'Prohibited': 'AI practices banned outright by the EU AI Act (e.g. social scoring)', 'High-Risk': 'AI systems in sensitive areas (employment, law enforcement, etc.) that must comply with strict requirements', 'GPAI': 'General-Purpose AI — foundation models like Claude, GPT, or Gemini', 'Limited Risk': 'AI systems with transparency obligations (must tell users they are interacting with AI)' },
  },
  dpia: {
    title: 'Data Protection Impact Assessment (GDPR)',
    description: 'A DPIA is required by GDPR Article 35 when your data processing is likely to result in a high risk to individuals. This form guides you through the 6 mandatory sections: describe the processing, assess necessity, identify risks, plan mitigations, consult your DPO, and record the outcome.',
    glossary: { 'DPIA': 'Data Protection Impact Assessment — a structured risk assessment for personal data processing', 'DPO': 'Data Protection Officer — the person responsible for GDPR compliance in your organisation', 'Legal Basis': 'The lawful reason you are allowed to process personal data (consent, contract, etc.)', 'Prior Consultation': 'When residual risk is too high, you must consult your data protection authority before proceeding' },
  },
  auditor: {
    title: 'Auditor Portal',
    description: 'Invite your external auditor to a time-bounded, read-only workspace. They can browse evidence linked to specific controls, auto-match their PBC (Prepared by Client) request list against your evidence, and use pre-populated working paper templates. All access is scoped to the audit engagement and expires automatically.',
    glossary: { 'PBC List': 'Prepared by Client — the list of documents and evidence your auditor needs from you', 'Working Papers': 'The auditor\'s documentation of what they tested and what they found', 'Engagement': 'A formal audit relationship with a specific scope, timeline, and auditor' },
  },
}

function TabIntro({ tabId }) {
  const intro = TAB_INTROS[tabId]
  if (!intro) return null
  const [showGlossary, setShowGlossary] = useState(false)

  return (
    <GlassPanel style={{ marginBottom: 10, padding: '14px 18px' }}>
      <div style={{ fontFamily: "'Inter',system-ui,sans-serif", fontSize: 14, fontWeight: 700, color: '#fff' }}>
        {intro.title}
      </div>
      <div style={{ fontFamily: "'Inter',system-ui,sans-serif", fontSize: 11, color: 'rgba(255,255,255,0.75)', marginTop: 6, lineHeight: 1.6 }}>
        {intro.description}
      </div>
      {intro.glossary && (
        <div style={{ marginTop: 8 }}>
          <button
            onClick={() => setShowGlossary(!showGlossary)}
            style={{ fontFamily: "'JetBrains Mono','Fira Code',monospace", fontSize: 9, color: COLORS.cyan, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            {showGlossary ? '▼' : '▶'} Glossary — what do these terms mean?
          </button>
          {showGlossary && (
            <div style={{ marginTop: 6, padding: '8px 12px', borderRadius: 6, background: 'rgba(56,189,248,0.04)', border: '1px solid rgba(56,189,248,0.08)' }}>
              {Object.entries(intro.glossary).map(([term, def]) => (
                <div key={term} style={{ padding: '3px 0' }}>
                  <span style={{ fontFamily: "'JetBrains Mono','Fira Code',monospace", fontSize: 10, color: COLORS.cyan, fontWeight: 600 }}>{term}</span>
                  <span style={{ fontFamily: "'Inter',system-ui,sans-serif", fontSize: 10, color: 'rgba(255,255,255,0.75)', marginLeft: 6 }}>— {def}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </GlassPanel>
  )
}

const CRP_TABS = [
  { id: 'posture', label: 'Posture', icon: '◈' },
  { id: 'frameworks', label: 'Frameworks', icon: '⬡' },
  { id: 'reports', label: 'Reports', icon: '▣' },
  { id: 'evidence', label: 'Evidence', icon: '◉' },
  { id: 'certification', label: 'Certification', icon: '★' },
  { id: 'soa', label: 'ISO 27001', icon: '▦' },
  { id: 'classification', label: 'AI Act', icon: '⬢' },
  { id: 'dpia', label: 'Privacy Impact', icon: '◇' },
  { id: 'auditor', label: 'Auditor Portal', icon: '⊞' },
  { id: 'monitor', label: 'Live Monitor', icon: '◎' },
  { id: 'incidents', label: 'Incidents', icon: '⚠' },
  { id: 'glossary', label: 'Glossary', icon: '?' },
]

export default function ComplianceView() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { licensed } = useComplianceSuiteStatus()
  const { posture, frameworks, reports, scheduledJobs, evidence, certification, loading, error, refresh } = useComplianceData()
  const activeTab = searchParams.get('tab') || 'posture'
  const setActiveTab = useCallback((tab) => {
    setSearchParams(prev => { prev.set('tab', tab); return prev }, { replace: true })
  }, [setSearchParams])

  // AUD-UX hooks — only activate when their tab is selected
  const soaHook = useSoAAssessment('')
  const classHook = useRiskClassification('')
  const dpiaHook = useDPIA('')
  const auditorHook = useAuditorEngagement('')

  // SoA control definitions (fetched once)
  const [soaDefs, setSoaDefs] = useState([])
  useEffect(() => {
    if (activeTab !== 'soa' || soaDefs.length > 0) return
    fetch('/collector/api/v1/compliance/soa/definitions', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.controls) setSoaDefs(data.controls) })
      .catch(() => {})
  }, [activeTab, soaDefs.length])

  // Auto-create SoA assessment if none exists
  useEffect(() => {
    if (activeTab !== 'soa' || soaHook.loading) return
    if (soaHook.assessments.length === 0 && !soaHook.assessment) {
      soaHook.createAssessment()
    } else if (soaHook.assessments.length > 0 && !soaHook.assessment) {
      soaHook.fetchAssessment(soaHook.assessments[0].id)
    }
  }, [activeTab, soaHook.loading, soaHook.assessments.length, soaHook.assessment])

  // Auto-create DPIA if none exists
  useEffect(() => {
    if (activeTab !== 'dpia' || dpiaHook.loading) return
    if (dpiaHook.dpias.length === 0 && !dpiaHook.dpia) {
      dpiaHook.createDpia('AI Processing Assessment')
    } else if (dpiaHook.dpias.length > 0 && !dpiaHook.dpia) {
      dpiaHook.fetchDpia(dpiaHook.dpias[0].id)
    }
  }, [activeTab, dpiaHook.loading, dpiaHook.dpias.length, dpiaHook.dpia])

  const [generating, setGenerating] = useState(null)
  const [genError, setGenError] = useState(null)
  const [genSuccess, setGenSuccess] = useState(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [exportingPack, setExportingPack] = useState(false)
  const [packError, setPackError] = useState(null)
  const [packSuccess, setPackSuccess] = useState(null)
  // Assurance pack period picker, defaults to the last 30 days
  const [packFrom, setPackFrom] = useState(() =>
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
  const [packTo, setPackTo] = useState(() => new Date().toISOString().slice(0, 10))

  const protocolHealth = posture ? {
    AEE: { status: posture.protocols?.AEE?.status === 'active' ? 'active' : 'down', count: posture.protocols?.AEE?.envelopes || 0 },
    AOCL: { status: posture.protocols?.AOCL?.status === 'active' ? 'active' : 'down', count: posture.protocols?.AOCL?.decisions || 0 },
    VOLT: { status: posture.protocols?.VOLT?.status === 'active' ? 'active' : 'down', count: posture.protocols?.VOLT?.runs || 0 },
    WARD: { status: posture.protocols?.WARD?.status === 'active' ? 'active' : 'down', count: posture.protocols?.WARD?.witnesses || 0, chainIntact: posture.protocols?.WARD?.chainIntact },
  } : null

  // cc-auditor-portal: real engagement + stats, sourced from the collector
  // (auditor_engagements table) and the same posture/evidence data the
  // Posture/Evidence tabs use — no fabricated numbers.
  const auditorEngagement = useMemo(() => {
    const list = auditorHook.engagements || []
    return list.find(e => e.status === 'active') || list[0] || null
  }, [auditorHook.engagements])

  const auditorFrameworkMeta = useMemo(() => {
    if (!auditorEngagement?.framework) return null
    return frameworks.find(f => f.id === auditorEngagement.framework) || null
  }, [frameworks, auditorEngagement])

  const auditorStats = useMemo(() => ({
    controlCount: auditorFrameworkMeta?.controlsTotal || 0,
    evidenceCount: evidence?.envelopes?.length || 0,
    chainIntact: posture?.protocols?.WARD?.chainIntact ?? false,
    bundleCount: posture?.protocols?.VOLT?.bundles || 0,
  }), [auditorFrameworkMeta, evidence, posture])

  const pbcFileInputRef = useRef(null)
  const handleUploadPbc = useCallback(() => {
    pbcFileInputRef.current?.click()
  }, [])
  const handlePbcFileChange = useCallback(async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const text = await file.text()
    const items = text.split('\n').map(l => l.trim()).filter(Boolean)
    if (items.length > 0) await auditorHook.matchPbc(items)
  }, [auditorHook])

  const handleGenerateReport = useCallback(async (format) => {
    setGenerating(format)
    setGenError(null)
    setGenSuccess(null)
    try {
      const report = await generateComplianceReport(format, {})
      downloadReport(report)
      setGenSuccess(`${format.toUpperCase()} report generated and downloaded.`)
      refresh()
    } catch (err) {
      console.error('[Compliance] Report generation failed:', err)
      setGenError(err.message || 'Report generation failed')
    } finally {
      setGenerating(null)
    }
  }, [refresh])

  const handleDownloadReport = useCallback(async (report) => {
    try {
      const res = await fetch(`/collector/compliance/reports/${report.id}`, { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to fetch report')
      const data = await res.json()
      if (data.report?.report_data) {
        downloadReport(data.report.report_data, `compliance-${report.format}-${report.id}`)
      }
    } catch (err) {
      console.error('[Compliance] Download failed:', err)
    }
  }, [])

  // AUD-WS-5: export signed assurance pack (WARD chain + VOLT bundles + audit events)
  const handleExportAssurancePack = useCallback(async () => {
    setExportingPack(true)
    setPackError(null)
    setPackSuccess(null)
    try {
      // Interpret picker dates as whole days: from = start of day, to = end of day
      const from = new Date(`${packFrom}T00:00:00.000Z`)
      const to = new Date(`${packTo}T23:59:59.999Z`)
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
        throw new Error('Pick a valid period (the start date must not be after the end date).')
      }
      const res = await fetch('/collector/api/v1/governance/assurance-pack', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: from.toISOString(),
          to: to.toISOString(),
          include: { ward: true, volt: true, audit: true },
        }),
      })
      if (!res.ok) {
        const msg = await res.text().catch(() => '')
        throw new Error(`Export failed (${res.status}) ${msg.slice(0, 200)}`)
      }
      const pack = await res.json()
      const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `assurance-pack-${pack.pack_id || Date.now()}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setPackSuccess(`Pack ${pack.pack_id} signed and downloaded. manifest_hash: ${(pack.manifest_hash || '').slice(0, 16)}…`)
    } catch (err) {
      console.error('[Compliance] Assurance pack export failed:', err)
      setPackError(err.message || 'Assurance pack export failed')
    } finally {
      setExportingPack(false)
    }
  }, [packFrom, packTo])

  const handleCancelJob = useCallback(async (jobId) => {
    if (!confirm('Cancel this scheduled job?')) return
    await cancelScheduledJob(jobId)
    refresh()
  }, [refresh])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 12,
      height: '100%', minHeight: 0, padding: 0,
    }}>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontFamily: F, fontSize: 20, fontWeight: 800, color: '#fff', margin: 0 }}>
            Compliance Command Center
          </h1>
          <div style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, marginTop: 2 }}>
            Governance stack: VOLT + WARD + AOCL + AEE
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {!licensed && (
            <GlassPill color={COLORS.amber}>FREE TIER</GlassPill>
          )}
          <GlassPill color={posture?.protocols?.WARD?.status === 'active' ? COLORS.green : COLORS.red}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: COLORS.green, boxShadow: `0 0 6px ${COLORS.green}60` }} />
            {posture?.protocols?.WARD?.status === 'active' ? 'ALL PROTOCOLS ACTIVE' : 'LOADING'}
          </GlassPill>
        </div>
      </div>

      {/* Tab bar */}
      <GlassTabBar tabs={CRP_TABS} activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Main content + AUDITUS sidebar */}
      <div style={{
        flex: 1, minHeight: 0,
        display: 'grid',
        gridTemplateColumns: licensed ? (sidebarCollapsed ? '1fr 48px' : '1fr 300px') : '1fr',
        gap: 8,
      }}>
        {/* Tab content */}
        <div style={{ minHeight: 0, overflowY: 'auto' }}>
          {error && <GlassError message={error} onRetry={refresh} />}

          {loading && !error && <GlassSkeleton height={300} />}

          {!loading && !error && (
            <>
              {activeTab === 'posture' && <PostureDashboard data={posture} />}
              {activeTab === 'frameworks' && <FrameworksPanel frameworks={frameworks} />}
              {activeTab === 'reports' && (
                <ReportsPanel
                  reports={reports}
                  scheduledJobs={scheduledJobs}
                  onGenerateReport={handleGenerateReport}
                  onDownloadReport={handleDownloadReport}
                  onCancelJob={handleCancelJob}
                  generating={generating}
                  genError={genError}
                  genSuccess={genSuccess}
                  licensed={licensed}
                  onExportAssurancePack={handleExportAssurancePack}
                  exportingPack={exportingPack}
                  packError={packError}
                  packSuccess={packSuccess}
                  packFrom={packFrom}
                  packTo={packTo}
                  onPackFromChange={setPackFrom}
                  onPackToChange={setPackTo}
                />
              )}
              {activeTab === 'evidence' && (
                <Suspense fallback={<GlassSkeleton height={300} />}>
                  <EvidenceExplorerV2
                    frameworks={FRAMEWORKS}
                    evidence={evidence?.envelopes || []}
                    evidenceCounts={{}}
                  />
                </Suspense>
              )}
              {activeTab === 'certification' && <CertificationTracker data={certification} />}
              {activeTab === 'soa' && (
                <EnterpriseGate licensed={licensed} feature="ISO 27001 Controls">
                  <TabIntro tabId="soa" />
                  <Suspense fallback={<GlassSkeleton height={300} />}>
                    <SoABuilder
                      assessmentId={soaHook.assessment?.id}
                      controls={soaHook.assessment?.controls_json}
                      controlDefinitions={soaDefs}
                      status={soaHook.assessment?.status || 'draft'}
                      onSave={soaHook.saveControls}
                      onStatusChange={soaHook.updateStatus}
                    />
                  </Suspense>
                </EnterpriseGate>
              )}
              {activeTab === 'classification' && (
                <>
                  <TabIntro tabId="classification" />
                  <Suspense fallback={<GlassSkeleton height={300} />}>
                    <RiskClassificationWizard
                      questions={classHook.questions}
                      onClassify={classHook.classifyAnswers}
                      onSave={classHook.saveAnswers}
                      initialAnswers={classHook.classification?.answers_json || {}}
                      systemName={classHook.classification?.system_name || ''}
                    />
                  </Suspense>
                </>
              )}
              {activeTab === 'dpia' && (
                <EnterpriseGate licensed={licensed} feature="Privacy Impact Assessment">
                  <TabIntro tabId="dpia" />
                  <Suspense fallback={<GlassSkeleton height={300} />}>
                    <DPIAForm
                      dpia={dpiaHook.dpia ? { ...dpiaHook.dpia, sections: dpiaHook.dpia.sections_json || dpiaHook.dpia.sections } : null}
                      onUpdate={dpiaHook.updateField}
                      onStatusChange={dpiaHook.updateStatus}
                      onAddRisk={dpiaHook.addRisk}
                      onUpdateRisk={dpiaHook.updateRisk}
                      onAddMeasure={dpiaHook.addMeasure}
                    />
                  </Suspense>
                </EnterpriseGate>
              )}
              {activeTab === 'auditor' && (
                <EnterpriseGate licensed={licensed} feature="Auditor Portal">
                  <TabIntro tabId="auditor" />
                  <input
                    ref={pbcFileInputRef}
                    type="file"
                    accept=".txt,.csv"
                    style={{ display: 'none' }}
                    onChange={handlePbcFileChange}
                  />
                  {auditorHook.loading && <GlassSkeleton height={300} />}
                  {!auditorHook.loading && !auditorEngagement && (
                    <GlassPanel style={{ textAlign: 'center', padding: 32 }}>
                      <div style={{ fontSize: 24, opacity: 0.3, marginBottom: 10 }}>⊞</div>
                      <div style={{ fontFamily: "'Inter',system-ui,sans-serif", fontSize: 13, fontWeight: 600, color: '#fff' }}>
                        No active audit engagement
                      </div>
                      <div style={{ fontFamily: "'Inter',system-ui,sans-serif", fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 8, maxWidth: 420, margin: '8px auto 0' }}>
                        The Auditor Portal activates when an external audit engagement is created for this organisation. There is no fabricated preview data — this tab is empty because no engagement record exists yet.
                      </div>
                    </GlassPanel>
                  )}
                  {!auditorHook.loading && auditorEngagement && (
                    <Suspense fallback={<GlassSkeleton height={300} />}>
                      <AuditorPortal
                        engagement={auditorEngagement}
                        stats={auditorStats}
                        pbcResults={auditorHook.pbcResults}
                        workingPapers={[]}
                        onUploadPbc={handleUploadPbc}
                        evidenceComponent={
                          <Suspense fallback={<GlassSkeleton height={300} />}>
                            <EvidenceExplorerV2
                              frameworks={FRAMEWORKS}
                              evidence={evidence?.envelopes || []}
                              evidenceCounts={{}}
                            />
                          </Suspense>
                        }
                      />
                    </Suspense>
                  )}
                </EnterpriseGate>
              )}
              {activeTab === 'monitor' && (
                <Suspense fallback={<GlassSkeleton height={300} />}>
                  <ComplianceMonitorPanel />
                </Suspense>
              )}
              {activeTab === 'incidents' && (
                <Suspense fallback={<GlassSkeleton height={300} />}>
                  <GovernanceIncidents />
                </Suspense>
              )}
              {activeTab === 'glossary' && (
                <Suspense fallback={<GlassSkeleton height={300} />}>
                  <ComplianceGlossary />
                </Suspense>
              )}
            </>
          )}
        </div>

        {/* AUDITUS sidebar — enterprise only */}
        {licensed && (
          <AuditusSidebar
            protocolHealth={protocolHealth}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed(c => !c)}
            activeTab={activeTab}
            complianceData={{ posture, frameworks, reports, scheduledJobs, evidence, certification }}
          />
        )}
      </div>
    </div>
  )
}
