/**
 * HIPAA Security Risk Analysis Engine
 *
 * Structured risk analysis following OCR guidance and NIST SP 800-30.
 * Covers Administrative (§164.308), Physical (§164.310), Technical (§164.312),
 * and Organizational (§164.314) safeguards with Addressable/Required tracking.
 *
 * AUD-UX Phase 7
 */

const SAFEGUARD_CATEGORIES = [
  { id: 'administrative', label: 'Administrative Safeguards', ref: '§164.308' },
  { id: 'physical', label: 'Physical Safeguards', ref: '§164.310' },
  { id: 'technical', label: 'Technical Safeguards', ref: '§164.312' },
  { id: 'organizational', label: 'Organizational Requirements', ref: '§164.314' },
]

const HIPAA_SAFEGUARDS = [
  // §164.308 Administrative Safeguards
  { id: '308-a1i', ref: '§164.308(a)(1)(i)', name: 'Risk Analysis', category: 'administrative', spec: 'required', description: 'Conduct an accurate and thorough assessment of potential risks and vulnerabilities to ePHI.' },
  { id: '308-a1ii-A', ref: '§164.308(a)(1)(ii)(A)', name: 'Risk Management', category: 'administrative', spec: 'required', description: 'Implement security measures sufficient to reduce risks and vulnerabilities to a reasonable and appropriate level.' },
  { id: '308-a1ii-B', ref: '§164.308(a)(1)(ii)(B)', name: 'Sanction Policy', category: 'administrative', spec: 'required', description: 'Apply appropriate sanctions against workforce members who fail to comply with security policies.' },
  { id: '308-a1ii-C', ref: '§164.308(a)(1)(ii)(C)', name: 'Information System Activity Review', category: 'administrative', spec: 'required', description: 'Implement procedures to regularly review records of information system activity.' },
  { id: '308-a2', ref: '§164.308(a)(2)', name: 'Assigned Security Responsibility', category: 'administrative', spec: 'required', description: 'Identify the security official responsible for developing and implementing security policies.' },
  { id: '308-a3i', ref: '§164.308(a)(3)(i)', name: 'Workforce Security', category: 'administrative', spec: 'required', description: 'Implement policies and procedures to ensure all workforce members have appropriate access to ePHI.' },
  { id: '308-a3ii-A', ref: '§164.308(a)(3)(ii)(A)', name: 'Authorization and/or Supervision', category: 'administrative', spec: 'addressable', description: 'Implement procedures for the authorization and/or supervision of workforce members who work with ePHI.' },
  { id: '308-a3ii-B', ref: '§164.308(a)(3)(ii)(B)', name: 'Workforce Clearance Procedure', category: 'administrative', spec: 'addressable', description: 'Implement procedures to determine that workforce access to ePHI is appropriate.' },
  { id: '308-a3ii-C', ref: '§164.308(a)(3)(ii)(C)', name: 'Termination Procedures', category: 'administrative', spec: 'addressable', description: 'Implement procedures for terminating access to ePHI when employment ends.' },
  { id: '308-a4i', ref: '§164.308(a)(4)(i)', name: 'Information Access Management', category: 'administrative', spec: 'required', description: 'Implement policies and procedures for authorizing access to ePHI.' },
  { id: '308-a4ii-A', ref: '§164.308(a)(4)(ii)(A)', name: 'Isolating Healthcare Clearinghouse Functions', category: 'administrative', spec: 'required', description: 'If a clearinghouse is part of a larger organization, implement policies to protect ePHI from unauthorized access.' },
  { id: '308-a4ii-B', ref: '§164.308(a)(4)(ii)(B)', name: 'Access Authorization', category: 'administrative', spec: 'addressable', description: 'Implement policies and procedures for granting access to ePHI.' },
  { id: '308-a4ii-C', ref: '§164.308(a)(4)(ii)(C)', name: 'Access Establishment and Modification', category: 'administrative', spec: 'addressable', description: 'Implement policies and procedures that establish, document, review, and modify access rights.' },
  { id: '308-a5i', ref: '§164.308(a)(5)(i)', name: 'Security Awareness and Training', category: 'administrative', spec: 'required', description: 'Implement a security awareness and training program for all workforce members.' },
  { id: '308-a5ii-A', ref: '§164.308(a)(5)(ii)(A)', name: 'Security Reminders', category: 'administrative', spec: 'addressable', description: 'Periodic security updates and reminders.' },
  { id: '308-a5ii-B', ref: '§164.308(a)(5)(ii)(B)', name: 'Protection from Malicious Software', category: 'administrative', spec: 'addressable', description: 'Procedures for guarding against, detecting, and reporting malicious software.' },
  { id: '308-a5ii-C', ref: '§164.308(a)(5)(ii)(C)', name: 'Log-in Monitoring', category: 'administrative', spec: 'addressable', description: 'Procedures for monitoring log-in attempts and reporting discrepancies.' },
  { id: '308-a5ii-D', ref: '§164.308(a)(5)(ii)(D)', name: 'Password Management', category: 'administrative', spec: 'addressable', description: 'Procedures for creating, changing, and safeguarding passwords.' },
  { id: '308-a6i', ref: '§164.308(a)(6)(i)', name: 'Security Incident Procedures', category: 'administrative', spec: 'required', description: 'Implement policies and procedures to address security incidents.' },
  { id: '308-a6ii', ref: '§164.308(a)(6)(ii)', name: 'Response and Reporting', category: 'administrative', spec: 'required', description: 'Identify and respond to suspected or known security incidents; mitigate harmful effects; document incidents and outcomes.' },
  { id: '308-a7i', ref: '§164.308(a)(7)(i)', name: 'Contingency Plan', category: 'administrative', spec: 'required', description: 'Establish policies and procedures for responding to an emergency or other occurrence that damages ePHI systems.' },
  { id: '308-a7ii-A', ref: '§164.308(a)(7)(ii)(A)', name: 'Data Backup Plan', category: 'administrative', spec: 'required', description: 'Establish and implement procedures to create and maintain retrievable exact copies of ePHI.' },
  { id: '308-a7ii-B', ref: '§164.308(a)(7)(ii)(B)', name: 'Disaster Recovery Plan', category: 'administrative', spec: 'required', description: 'Establish and implement procedures to restore any loss of data.' },
  { id: '308-a7ii-C', ref: '§164.308(a)(7)(ii)(C)', name: 'Emergency Mode Operation Plan', category: 'administrative', spec: 'required', description: 'Establish and implement procedures to enable continuation of critical business processes for ePHI protection during emergency.' },
  { id: '308-a7ii-D', ref: '§164.308(a)(7)(ii)(D)', name: 'Testing and Revision Procedures', category: 'administrative', spec: 'addressable', description: 'Implement procedures for periodic testing and revision of contingency plans.' },
  { id: '308-a7ii-E', ref: '§164.308(a)(7)(ii)(E)', name: 'Applications and Data Criticality Analysis', category: 'administrative', spec: 'addressable', description: 'Assess the relative criticality of specific applications and data in support of contingency plan components.' },
  { id: '308-a8', ref: '§164.308(a)(8)', name: 'Evaluation', category: 'administrative', spec: 'required', description: 'Perform periodic technical and nontechnical evaluation in response to environmental or operational changes.' },

  // §164.310 Physical Safeguards
  { id: '310-a1', ref: '§164.310(a)(1)', name: 'Facility Access Controls', category: 'physical', spec: 'required', description: 'Implement policies and procedures to limit physical access to electronic information systems and facilities.' },
  { id: '310-a2i', ref: '§164.310(a)(2)(i)', name: 'Contingency Operations', category: 'physical', spec: 'addressable', description: 'Establish procedures that allow facility access to support restoration of lost data under the disaster recovery and emergency plans.' },
  { id: '310-a2ii', ref: '§164.310(a)(2)(ii)', name: 'Facility Security Plan', category: 'physical', spec: 'addressable', description: 'Implement policies and procedures to safeguard the facility and equipment from unauthorized access, tampering, and theft.' },
  { id: '310-a2iii', ref: '§164.310(a)(2)(iii)', name: 'Access Control and Validation Procedures', category: 'physical', spec: 'addressable', description: 'Implement procedures to control and validate physical access based on role or function.' },
  { id: '310-a2iv', ref: '§164.310(a)(2)(iv)', name: 'Maintenance Records', category: 'physical', spec: 'addressable', description: 'Implement policies and procedures to document repairs and modifications to facility security components.' },
  { id: '310-b', ref: '§164.310(b)', name: 'Workstation Use', category: 'physical', spec: 'required', description: 'Implement policies and procedures specifying proper functions and physical attributes of workstations accessing ePHI.' },
  { id: '310-c', ref: '§164.310(c)', name: 'Workstation Security', category: 'physical', spec: 'required', description: 'Implement physical safeguards for workstations that access ePHI to restrict access to authorized users.' },
  { id: '310-d1', ref: '§164.310(d)(1)', name: 'Device and Media Controls', category: 'physical', spec: 'required', description: 'Implement policies and procedures governing receipt and removal of hardware and electronic media containing ePHI.' },
  { id: '310-d2i', ref: '§164.310(d)(2)(i)', name: 'Disposal', category: 'physical', spec: 'required', description: 'Implement policies and procedures to address final disposition of ePHI and hardware or media on which it is stored.' },
  { id: '310-d2ii', ref: '§164.310(d)(2)(ii)', name: 'Media Re-use', category: 'physical', spec: 'required', description: 'Implement procedures for removal of ePHI from electronic media before re-use.' },
  { id: '310-d2iii', ref: '§164.310(d)(2)(iii)', name: 'Accountability', category: 'physical', spec: 'addressable', description: 'Maintain a record of movements of hardware and electronic media and the person responsible.' },
  { id: '310-d2iv', ref: '§164.310(d)(2)(iv)', name: 'Data Backup and Storage', category: 'physical', spec: 'addressable', description: 'Create a retrievable, exact copy of ePHI before movement of equipment.' },

  // §164.312 Technical Safeguards
  { id: '312-a1', ref: '§164.312(a)(1)', name: 'Access Control', category: 'technical', spec: 'required', description: 'Implement technical policies and procedures for electronic information systems that maintain ePHI to allow access only to authorized persons or software programs.' },
  { id: '312-a2i', ref: '§164.312(a)(2)(i)', name: 'Unique User Identification', category: 'technical', spec: 'required', description: 'Assign a unique name and/or number for identifying and tracking user identity.' },
  { id: '312-a2ii', ref: '§164.312(a)(2)(ii)', name: 'Emergency Access Procedure', category: 'technical', spec: 'required', description: 'Establish procedures for obtaining necessary ePHI during an emergency.' },
  { id: '312-a2iii', ref: '§164.312(a)(2)(iii)', name: 'Automatic Logoff', category: 'technical', spec: 'addressable', description: 'Implement electronic procedures that terminate a session after a predetermined time of inactivity.' },
  { id: '312-a2iv', ref: '§164.312(a)(2)(iv)', name: 'Encryption and Decryption', category: 'technical', spec: 'addressable', description: 'Implement a mechanism to encrypt and decrypt ePHI.' },
  { id: '312-b', ref: '§164.312(b)', name: 'Audit Controls', category: 'technical', spec: 'required', description: 'Implement hardware, software, and/or procedural mechanisms that record and examine activity in systems that contain or use ePHI.' },
  { id: '312-c1', ref: '§164.312(c)(1)', name: 'Integrity', category: 'technical', spec: 'required', description: 'Implement policies and procedures to protect ePHI from improper alteration or destruction.' },
  { id: '312-c2', ref: '§164.312(c)(2)', name: 'Mechanism to Authenticate ePHI', category: 'technical', spec: 'addressable', description: 'Implement electronic mechanisms to corroborate that ePHI has not been altered or destroyed.' },
  { id: '312-d', ref: '§164.312(d)', name: 'Person or Entity Authentication', category: 'technical', spec: 'required', description: 'Implement procedures to verify that a person or entity seeking access to ePHI is the one claimed.' },
  { id: '312-e1', ref: '§164.312(e)(1)', name: 'Transmission Security', category: 'technical', spec: 'required', description: 'Implement technical security measures to guard against unauthorized access to ePHI transmitted over electronic communications networks.' },
  { id: '312-e2i', ref: '§164.312(e)(2)(i)', name: 'Integrity Controls', category: 'technical', spec: 'addressable', description: 'Implement security measures to ensure that electronically transmitted ePHI is not improperly modified without detection.' },
  { id: '312-e2ii', ref: '§164.312(e)(2)(ii)', name: 'Encryption', category: 'technical', spec: 'addressable', description: 'Implement a mechanism to encrypt ePHI whenever deemed appropriate.' },

  // §164.314 Organizational Requirements
  { id: '314-a1', ref: '§164.314(a)(1)', name: 'Business Associate Contracts or Other Arrangements', category: 'organizational', spec: 'required', description: 'A covered entity may permit a business associate to create, receive, maintain, or transmit ePHI only if satisfactory assurances are obtained via contract or arrangement.' },
  { id: '314-a2i', ref: '§164.314(a)(2)(i)', name: 'Business Associate Contracts', category: 'organizational', spec: 'required', description: 'Contract must provide that the BA will comply with applicable Security Rule requirements.' },
  { id: '314-b1', ref: '§164.314(b)(1)', name: 'Requirements for Group Health Plans', category: 'organizational', spec: 'required', description: 'Group health plan sponsor must implement safeguards to ensure reasonable and appropriate protection of ePHI.' },
]

const EVIDENCE_AUTO_MAP = {
  '312-a1': { evidenceType: 'AOCL L1/L3', description: 'L1 identity resolution + L3 policy gate enforce access control' },
  '312-a2i': { evidenceType: 'AOCL L1', description: 'L1 resolves unique user identity per request' },
  '312-b': { evidenceType: 'AEE + VOLT', description: 'AEE envelopes + VOLT event chain provide audit trail' },
  '312-c1': { evidenceType: 'VOLT hash chain', description: 'VOLT cryptographic hash chain protects data integrity' },
  '312-c2': { evidenceType: 'VOLT verify', description: 'VOLT chain verification authenticates ePHI integrity' },
  '312-d': { evidenceType: 'AOCL L1', description: 'L1 identity resolution verifies person/entity' },
  '312-e1': { evidenceType: 'AOCL L3', description: 'L3 policy gate enforces transmission security policies' },
}

function getAllSafeguards() {
  return HIPAA_SAFEGUARDS
}

function getSafeguardsByCategory(category) {
  return HIPAA_SAFEGUARDS.filter(s => s.category === category)
}

function getSafeguard(id) {
  return HIPAA_SAFEGUARDS.find(s => s.id === id) || null
}

function getSafeguardCounts() {
  return SAFEGUARD_CATEGORIES.map(cat => ({
    ...cat,
    total: HIPAA_SAFEGUARDS.filter(s => s.category === cat.id).length,
    required: HIPAA_SAFEGUARDS.filter(s => s.category === cat.id && s.spec === 'required').length,
    addressable: HIPAA_SAFEGUARDS.filter(s => s.category === cat.id && s.spec === 'addressable').length,
  }))
}

function getAutoPopulatableSafeguards() {
  return Object.keys(EVIDENCE_AUTO_MAP)
}

function createBlankRiskAnalysis(orgId = '') {
  return {
    org_id: orgId,
    status: 'draft',
    version: 1,
    safeguards: HIPAA_SAFEGUARDS.map(s => ({
      safeguard_id: s.id,
      implementation_status: 'not_assessed',
      risk_level: null,
      likelihood: 0,
      impact: 0,
      existing_controls: '',
      recommended_controls: '',
      responsible: '',
      target_date: null,
      notes: '',
      auto_detected: !!EVIDENCE_AUTO_MAP[s.id],
    })),
  }
}

function computeRiskLevel(likelihood, impact) {
  const score = likelihood * impact
  if (score >= 16) return 'high'
  if (score >= 6) return 'medium'
  if (score >= 1) return 'low'
  return 'not_assessed'
}

function generateHipaaMarkdown(analysis) {
  const lines = [
    '# HIPAA Security Risk Analysis Report',
    '',
    `**Organisation:** ${analysis.org_id || '[Not specified]'}`,
    `**Status:** ${analysis.status}`,
    `**Date:** ${new Date().toISOString().split('T')[0]}`,
    '',
    '---',
    '',
  ]

  for (const cat of SAFEGUARD_CATEGORIES) {
    const safeguards = analysis.safeguards.filter(s => {
      const def = getSafeguard(s.safeguard_id)
      return def?.category === cat.id
    })

    lines.push(`## ${cat.label} (${cat.ref})`, '')
    lines.push('| Ref | Safeguard | Spec | Status | Risk | L | I |')
    lines.push('|-----|-----------|------|--------|------|---|---|')

    for (const s of safeguards) {
      const def = getSafeguard(s.safeguard_id)
      if (!def) continue
      const risk = computeRiskLevel(s.likelihood, s.impact)
      lines.push(`| ${def.ref} | ${def.name} | ${def.spec} | ${s.implementation_status} | ${risk} | ${s.likelihood} | ${s.impact} |`)
    }
    lines.push('')
  }

  lines.push('---', '')
  lines.push('*This risk analysis is an internal assessment tool. It does not constitute a formal HIPAA compliance certification. Consult qualified legal counsel and healthcare compliance professionals.*')

  return lines.join('\n')
}

module.exports = {
  SAFEGUARD_CATEGORIES,
  HIPAA_SAFEGUARDS,
  EVIDENCE_AUTO_MAP,
  getAllSafeguards,
  getSafeguardsByCategory,
  getSafeguard,
  getSafeguardCounts,
  getAutoPopulatableSafeguards,
  createBlankRiskAnalysis,
  computeRiskLevel,
  generateHipaaMarkdown,
}
