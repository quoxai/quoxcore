/**
 * ComplianceGlossary — Personal compliance course & reference
 *
 * A searchable glossary of compliance acronyms, frameworks, and concepts,
 * each explained in plain English with how it relates to Quox.
 */

import { useState, useMemo } from 'react'
import {
  GlassPanel,
  GlassPill,
  COLORS,
  M,
  F,
} from './glass-primitives'

const GLOSSARY = [
  // Frameworks
  { term: 'SOC 2', category: 'framework', short: 'Service Organisation Controls', definition: 'An audit standard from the AICPA that checks whether a service provider handles customer data securely. SOC 2 Type II means the auditor verified controls worked over a period (usually 6-12 months), not just that they exist.', quox: 'Quox maps your governance events to SOC 2 Trust Services Criteria (CC6 access, CC7 operations, CC8 change mgmt). The compliance formatter produces a readiness report.' },
  { term: 'ISO 27001', category: 'framework', short: 'Information Security Management System standard', definition: 'An international standard for running an information security program. It has mandatory management clauses (4-10) and 93 optional security controls (Annex A) that you pick based on your risks.', quox: 'The SoA Builder lists all 93 controls. Quox auto-detects evidence for the 34 technical controls (A.8) from your governance data.' },
  { term: 'GDPR', category: 'framework', short: 'General Data Protection Regulation', definition: 'The EU law governing how organisations collect, process, and store personal data. It gives individuals rights over their data (access, deletion, portability) and imposes fines up to 4% of global revenue.', quox: 'The DPIA form guides you through the mandatory risk assessment for high-risk processing. The compliance formatter maps your evidence to GDPR articles.' },
  { term: 'HIPAA', category: 'framework', short: 'Health Insurance Portability and Accountability Act', definition: 'US law protecting electronic health information (ePHI). The Security Rule requires administrative, physical, and technical safeguards. Each safeguard is either "required" (must implement) or "addressable" (must assess and document your decision).', quox: 'The HIPAA Risk Analysis wizard covers all 54 safeguards. Technical safeguards (§164.312) are auto-populated from AOCL/VOLT evidence.' },
  { term: 'EU AI Act', category: 'framework', short: 'European Union Artificial Intelligence Act', definition: 'The world\'s first comprehensive AI regulation (2024/1689). Classifies AI systems into risk tiers: prohibited, high-risk, limited risk, and minimal risk. Different obligations apply to each tier.', quox: 'The Risk Classification Wizard guides you through the decision tree. It\'s free — no license required. The result is a classification memo for your legal team.' },
  { term: 'NIST AI RMF', category: 'framework', short: 'NIST AI Risk Management Framework', definition: 'A voluntary US framework for managing AI risks. Four functions: Govern (set policies), Map (identify risks), Measure (track metrics), Manage (mitigate). Not legally required but widely adopted.', quox: 'Planned in the CTL-LIB stream. Will map AOCL policy events to Govern, VOLT metrics to Measure, and HITL events to Manage.' },

  // Quox Protocols
  { term: 'AEE', category: 'protocol', short: 'Agent Envelope Exchange', definition: 'Every interaction between agents, users, and tools is wrapped in a structured envelope with 14 fields: who sent it, who received it, what they intended, when it happened, and a correlation ID linking the full conversation.', quox: 'AEE envelopes are the foundation of your audit trail. Every chat message, tool call, and agent delegation produces one. They\'re stored server-side in SQLite.' },
  { term: 'AOCL', category: 'protocol', short: 'Agent Orchestration Control Layers', definition: 'An 11-layer processing stack (L0-L10) that every request passes through. Each layer is a governance checkpoint: identity verification (L1), policy evaluation (L3), response verification (L8), audit commit (L10).', quox: 'AOCL is what makes Quox compliant by design. Layer events are the raw evidence for SOC 2 access controls, HIPAA audit controls, and GDPR processing records.' },
  { term: 'VOLT', category: 'protocol', short: 'Verifiable Operations Ledger & Trace', definition: 'An append-only hash chain recording every operation. Each event is linked to the previous by a SHA-256 hash, making the chain tamper-evident. If anyone alters a past event, the chain breaks detectably.', quox: 'VOLT is your evidence ledger. Compliance formatters query it for real evidence. The hash chain integrity is checked by your auditor. Evidence bundles are auto-signed.' },
  { term: 'WARD', category: 'protocol', short: 'Write-once Append-only Receipt Digests', definition: 'External timestamping and witnessing of your VOLT chain. WARD tips are signed with Ed25519 keys and timestamped via RFC 3161 (an internet standard for trusted timestamps). They can be verified independently without Quox.', quox: 'WARD is what lets your auditor verify evidence without trusting Quox. The public verification endpoint (/public/verify/ward/:chainId) works without authentication.' },

  // Compliance Concepts
  { term: 'SoA', category: 'concept', short: 'Statement of Applicability', definition: 'The ISO 27001 document that lists every Annex A control and your decision about it. Your auditor uses it as the skeleton for their fieldwork — they walk every row and check if the control actually works.', quox: 'The SoA Builder in the ISO 27001 tab. 93 controls, tri-state applicability, auto-detection for technical controls.' },
  { term: 'DPIA', category: 'concept', short: 'Data Protection Impact Assessment', definition: 'A risk assessment required by GDPR Article 35 when processing personal data in ways likely to create high risk for individuals. Has 6 mandatory sections. Your DPO must review it before processing begins.', quox: 'The Privacy Impact tab. Sectioned form with risk matrix, DPO review lifecycle, and auto-populated fields from your system registry.' },
  { term: 'DPO', category: 'concept', short: 'Data Protection Officer', definition: 'The person in your organisation responsible for GDPR compliance. They advise on data protection, monitor compliance, and are the contact point for your supervisory authority. Some organisations are legally required to appoint one.', quox: 'The DPIA form has a DPO review stage. The DPO signs off before processing can proceed.' },
  { term: 'PBC List', category: 'concept', short: 'Prepared by Client', definition: 'The list of documents and evidence your auditor needs from you. Typically 80-200 items: access review records, change tickets, vulnerability scans, training records, incident logs, etc. Fulfilling it is the most time-consuming part of any audit.', quox: 'The Auditor Portal auto-matches PBC items against your evidence. Multi-word phrases like "access review" are matched to specific controls and evidence types.' },
  { term: 'Working Papers', category: 'concept', short: 'Auditor documentation', definition: 'The auditor\'s record of what they tested and what they found. For each control: the objective, population, sample, evidence reviewed, exceptions, and conclusion. This is what the auditor spends most of their time writing.', quox: 'The Auditor Portal generates pre-populated working paper templates. Population count, sample size, VOLT integrity, and WARD witness count are filled in automatically.' },
  { term: 'IPE', category: 'concept', short: 'Information Produced by Entity', definition: 'Any system-generated report or export you give your auditor as evidence. The auditor can\'t independently verify it came from an unaltered system, so they must test it: check the query criteria, verify completeness, sample-check rows.', quox: 'VOLT content hashes solve the IPE problem. The hash covers both the input (query parameters) and output (results), so the auditor can verify the evidence is complete and unaltered.' },
  { term: 'Assurance Pack', category: 'concept', short: 'Signed evidence bundle', definition: 'A self-contained JSON package containing WARD chain data, VOLT evidence bundles, and audit events for a specific period. Signed with Ed25519 and hash-verifiable.', quox: 'One-click export from the Reports tab. The pack is signed with the same Ed25519 key used for WARD tips. Your auditor can verify it independently.' },
  { term: 'Redaction', category: 'concept', short: 'Removing sensitive data from reports', definition: 'Before sharing a compliance report externally, you strip API keys, internal IPs, passwords, and detailed evidence. Three levels: internal (full detail), external (secrets removed), public (summary only).', quox: 'The PDF Report Engine has built-in redaction. The engine automatically detects and strips sk-* keys, Bearer tokens, passwords, and RFC 1918 IP addresses.' },

  // Risk / Audit
  { term: 'Material Weakness', category: 'audit', short: 'Serious control failure (SOC 2)', definition: 'A control deficiency so severe that a material misstatement could occur and not be prevented or detected. Results in a qualified audit opinion. The worst finding category in SOC 2.', quox: 'Quox reports are readiness assessments, not SOC 2 opinions (only a CPA firm can issue those). But the gap detection in the compliance formatters flags controls with no evidence — these are your material weakness candidates.' },
  { term: 'Nonconformity', category: 'audit', short: 'Control failure (ISO 27001)', definition: 'A failure to meet a clause or Annex A control requirement. Major nonconformities block certification. Minor nonconformities must be fixed before the next surveillance audit.', quox: 'The SoA Builder shows gap status per control. Controls with no evidence and no justification are your nonconformity risk areas.' },
  { term: 'Addressable vs Required', category: 'audit', short: 'HIPAA safeguard types', definition: 'HIPAA safeguards are either "required" (must implement, no exceptions) or "addressable" (must assess — then implement, implement an equivalent, or document why it doesn\'t apply). Addressable does NOT mean optional.', quox: 'The HIPAA Risk Analysis marks each safeguard as Required or Addressable. Addressable safeguards need a documented decision even if you don\'t implement them.' },
  { term: 'Annex III', category: 'audit', short: 'EU AI Act high-risk use cases', definition: 'Eight categories of AI use cases that the EU AI Act considers high-risk: biometric identification, critical infrastructure, education, employment, essential services, law enforcement, migration/asylum, justice/democracy.', quox: 'The Risk Classification Wizard asks if your system falls into any Annex III category. If it does, you\'re classified as High-Risk with full Article 6-15 obligations.' },
  { term: 'HITL', category: 'concept', short: 'Human-in-the-Loop', definition: 'A requirement that a human can intervene in, override, or shut down an AI system\'s actions. The EU AI Act requires human oversight measures for high-risk systems. SOC 2 and ISO 27001 also value approval workflows.', quox: 'Quox records HITL events in the audit trail. The human:task node in QuoxFlow triggers approval workflows. AOCL L3 policy gates can require human approval before proceeding.' },
]

const CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'framework', label: 'Frameworks' },
  { id: 'protocol', label: 'Quox Protocols' },
  { id: 'concept', label: 'Concepts' },
  { id: 'audit', label: 'Audit Terms' },
]

export default function ComplianceGlossary() {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [expandedTerm, setExpandedTerm] = useState(null)

  const filtered = useMemo(() => {
    return GLOSSARY.filter(g => {
      if (category !== 'all' && g.category !== category) return false
      if (search) {
        const q = search.toLowerCase()
        return g.term.toLowerCase().includes(q) || g.short.toLowerCase().includes(q) || g.definition.toLowerCase().includes(q)
      }
      return true
    })
  }, [search, category])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <GlassPanel>
        <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>
          Compliance Glossary
        </div>
        <div style={{ fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.75)', marginTop: 4, lineHeight: 1.5 }}>
          Every compliance acronym and concept used in Quox, explained in plain English. Each entry tells you what it means and how Quox handles it.
        </div>
      </GlassPanel>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {CATEGORIES.map(c => (
          <button
            key={c.id}
            onClick={() => setCategory(c.id)}
            style={{
              padding: '5px 12px', borderRadius: 6, border: 'none',
              fontFamily: M, fontSize: 10, fontWeight: category === c.id ? 700 : 500,
              color: category === c.id ? '#fff' : 'rgba(255,255,255,0.5)',
              background: category === c.id ? 'rgba(168,85,247,0.12)' : 'rgba(255,255,255,0.02)',
              cursor: 'pointer',
            }}
          >
            {c.label}
          </button>
        ))}
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search terms..."
          style={{
            marginLeft: 'auto', fontFamily: M, fontSize: 10, color: '#fff',
            background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 6, padding: '6px 12px', outline: 'none', width: 200,
          }}
        />
        <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>
          {filtered.length} terms
        </span>
      </div>

      {/* Terms */}
      {filtered.map(g => {
        const isExpanded = expandedTerm === g.term
        const catColor = g.category === 'framework' ? '#38bdf8' : g.category === 'protocol' ? '#a855f7' : g.category === 'audit' ? '#f59e0b' : COLORS.green

        return (
          <GlassPanel
            key={g.term}
            hoverable
            onClick={() => setExpandedTerm(isExpanded ? null : g.term)}
            style={{ padding: '12px 16px', cursor: 'pointer' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: M, fontSize: 13, fontWeight: 700, color: catColor }}>{g.term}</span>
                  <span style={{ fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>— {g.short}</span>
                </div>
              </div>
              <GlassPill color={catColor} style={{ fontSize: 8 }}>{g.category}</GlassPill>
              <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>{isExpanded ? '▼' : '▶'}</span>
            </div>

            {isExpanded && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                <div style={{ fontFamily: F, fontSize: 12, color: 'rgba(255,255,255,0.8)', lineHeight: 1.6, marginBottom: 10 }}>
                  {g.definition}
                </div>
                <div style={{
                  padding: '10px 14px', borderRadius: 8,
                  background: 'rgba(168,85,247,0.04)', border: '1px solid rgba(168,85,247,0.1)',
                }}>
                  <div style={{ fontFamily: M, fontSize: 9, color: COLORS.purple, fontWeight: 700, letterSpacing: 0.5, marginBottom: 4 }}>
                    HOW QUOX HANDLES THIS
                  </div>
                  <div style={{ fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5 }}>
                    {g.quox}
                  </div>
                </div>
              </div>
            )}
          </GlassPanel>
        )
      })}
    </div>
  )
}
