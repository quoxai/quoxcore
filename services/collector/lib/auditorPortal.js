/**
 * Auditor Portal Engine — Engagement management, PBC matching, working papers
 *
 * Provides:
 * - Engagement lifecycle (create → active → completed → archived)
 * - PBC (Prepared by Client) list auto-matching against evidence mapping
 * - Working paper template generation from VOLT/WARD/AEE data
 *
 * AUD-UX Phase 6
 */

const ENGAGEMENT_STATUSES = ['draft', 'active', 'completed', 'archived']

const VALID_ENGAGEMENT_TRANSITIONS = {
  draft: ['active'],
  active: ['completed'],
  completed: ['archived', 'active'],
  archived: [],
}

function createEngagement(opts = {}) {
  const now = new Date()
  const durationDays = opts.duration_days || 90
  const expiresAt = new Date(now.getTime() + durationDays * 86400000)

  return {
    id: `ENG_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    org_id: opts.org_id || '',
    auditor_email: opts.auditor_email || '',
    auditor_name: opts.auditor_name || '',
    firm_name: opts.firm_name || '',
    framework: opts.framework || '',
    period_start: opts.period_start || null,
    period_end: opts.period_end || null,
    duration_days: durationDays,
    status: 'draft',
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    notes: opts.notes || '',
  }
}

function isEngagementExpired(engagement) {
  if (!engagement.expires_at) return false
  return new Date(engagement.expires_at) < new Date()
}

function isValidEngagementTransition(from, to) {
  const valid = VALID_ENGAGEMENT_TRANSITIONS[from]
  return valid ? valid.includes(to) : false
}

// ─── PBC Auto-Match ──────────────────────────────────────────────────────────

const EVIDENCE_KEYWORDS = {
  'access review': { frameworks: ['soc2'], controls: ['CC6.1', 'CC6.2'], evidenceType: 'AOCL L1' },
  'access control': { frameworks: ['soc2', 'iso27001'], controls: ['CC6.1', 'A.5.15', 'A.8.3'], evidenceType: 'AOCL L1/L3' },
  'user access': { frameworks: ['soc2'], controls: ['CC6.1', 'CC6.2', 'CC6.3'], evidenceType: 'AOCL L1' },
  'change management': { frameworks: ['soc2', 'iso27001'], controls: ['CC7.3', 'CC8.1', 'A.8.32'], evidenceType: 'VOLT runs' },
  'change control': { frameworks: ['soc2'], controls: ['CC7.3', 'CC8.1'], evidenceType: 'VOLT runs' },
  'incident response': { frameworks: ['soc2', 'iso27001'], controls: ['CC7.4', 'A.5.24', 'A.5.26'], evidenceType: 'AEE error envelopes' },
  'vulnerability': { frameworks: ['soc2', 'iso27001'], controls: ['CC7.1', 'A.8.8'], evidenceType: 'VOLT events' },
  'penetration test': { frameworks: ['soc2'], controls: ['CC7.1'], evidenceType: 'manual upload' },
  'security awareness': { frameworks: ['soc2', 'iso27001', 'hipaa'], controls: ['CC1.4', 'A.6.3'], evidenceType: 'manual upload' },
  'training': { frameworks: ['soc2', 'hipaa', 'iso27001'], controls: ['CC1.4', 'A.6.3'], evidenceType: 'manual upload' },
  'encryption': { frameworks: ['soc2', 'hipaa', 'iso27001'], controls: ['CC6.1', 'A.8.24'], evidenceType: 'AOCL L3' },
  'backup': { frameworks: ['iso27001'], controls: ['A.8.13'], evidenceType: 'VOLT events' },
  'logging': { frameworks: ['soc2', 'hipaa', 'iso27001'], controls: ['CC7.1', 'A.8.15'], evidenceType: 'AEE + VOLT' },
  'audit log': { frameworks: ['soc2', 'hipaa', 'iso27001'], controls: ['CC7.1', 'A.8.15'], evidenceType: 'AEE envelopes' },
  'monitoring': { frameworks: ['soc2', 'iso27001'], controls: ['CC7.1', 'CC7.2', 'A.8.16'], evidenceType: 'AOCL L8/L10' },
  'risk assessment': { frameworks: ['hipaa', 'iso27001', 'gdpr'], controls: ['A.5.7'], evidenceType: 'manual upload' },
  'data protection': { frameworks: ['gdpr'], controls: ['Art.5', 'Art.32'], evidenceType: 'AOCL L3' },
  'privacy notice': { frameworks: ['gdpr'], controls: ['Art.13', 'Art.14'], evidenceType: 'manual upload' },
  'consent': { frameworks: ['gdpr'], controls: ['Art.6', 'Art.7'], evidenceType: 'manual upload' },
  'data subject': { frameworks: ['gdpr'], controls: ['Art.15', 'Art.16', 'Art.17'], evidenceType: 'manual upload' },
  'breach notification': { frameworks: ['gdpr', 'hipaa'], controls: ['Art.33', 'Art.34'], evidenceType: 'AEE error envelopes' },
  'business associate': { frameworks: ['hipaa'], controls: ['§164.314'], evidenceType: 'manual upload' },
  'phi': { frameworks: ['hipaa'], controls: ['§164.312'], evidenceType: 'AOCL L1/L3' },
  'ephi': { frameworks: ['hipaa'], controls: ['§164.312'], evidenceType: 'AOCL L1/L3' },
  'human oversight': { frameworks: ['euAiAct'], controls: ['Art.14'], evidenceType: 'HITL events' },
  'risk management': { frameworks: ['euAiAct', 'iso27001'], controls: ['Art.9'], evidenceType: 'AOCL L3/L8' },
  'transparency': { frameworks: ['euAiAct'], controls: ['Art.13', 'Art.50'], evidenceType: 'AEE envelopes' },
  'technical documentation': { frameworks: ['euAiAct'], controls: ['Art.11'], evidenceType: 'VOLT bundles' },
  'model accuracy': { frameworks: ['euAiAct'], controls: ['Art.15'], evidenceType: 'VOLT metrics' },
  'data governance': { frameworks: ['euAiAct'], controls: ['Art.10'], evidenceType: 'AOCL L0/L1' },
  'post-market': { frameworks: ['euAiAct'], controls: ['Art.72'], evidenceType: 'VOLT continuous' },
  'policy': { frameworks: ['soc2', 'iso27001'], controls: ['CC1.1', 'A.5.1'], evidenceType: 'AOCL L3 policy events' },
  'vendor': { frameworks: ['soc2', 'iso27001'], controls: ['CC9.2', 'A.5.19'], evidenceType: 'manual upload' },
  'supplier': { frameworks: ['iso27001'], controls: ['A.5.19', 'A.5.20', 'A.5.21'], evidenceType: 'manual upload' },
}

function matchPbcItem(itemText) {
  if (!itemText) return { matched: false, confidence: 0, matches: [] }

  const lower = itemText.toLowerCase()
  const matches = []

  for (const [keyword, mapping] of Object.entries(EVIDENCE_KEYWORDS)) {
    const pattern = new RegExp('\\b' + keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b')
    if (pattern.test(lower)) {
      matches.push({
        keyword,
        frameworks: mapping.frameworks,
        controls: mapping.controls,
        evidenceType: mapping.evidenceType,
        confidence: keyword.split(' ').length > 1 ? 0.9 : 0.7,
      })
    }
  }

  matches.sort((a, b) => b.confidence - a.confidence)

  if (matches.length === 0) {
    return { matched: false, confidence: 0, matches: [] }
  }

  const best = matches[0]
  return {
    matched: true,
    confidence: best.confidence,
    matches: matches.slice(0, 3),
    primary: best,
  }
}

function matchPbcList(items) {
  return items.map((item, index) => ({
    index,
    text: typeof item === 'string' ? item : item.text || item.description || '',
    ...matchPbcItem(typeof item === 'string' ? item : item.text || item.description || ''),
  }))
}

// ─── Working Paper Templates ─────────────────────────────────────────────────

function generateWorkingPaper(controlId, controlName, evidenceStats = {}) {
  return {
    control_id: controlId,
    control_name: controlName,
    template: {
      objective: `Verify that ${controlName} operates effectively during the audit period.`,
      population: `All ${evidenceStats.eventType || 'governance events'} recorded during the audit period.`,
      population_count: evidenceStats.totalEvents || 0,
      sample_size: evidenceStats.totalEvents > 250 ? 25 : evidenceStats.totalEvents > 50 ? 15 : evidenceStats.totalEvents,
      sample_method: evidenceStats.totalEvents > 25 ? 'Random selection from population' : 'Full population review',
      evidence_source: evidenceStats.evidenceType || 'VOLT runs + AEE envelopes',
      volt_integrity: evidenceStats.chainIntact ? 'INTACT — hash chain verified' : 'Not verified',
      ward_witnessed: evidenceStats.wardWitnessed || 0,
      test_procedure: [
        `1. Obtain population of ${evidenceStats.eventType || 'events'} from VOLT evidence store`,
        `2. Verify VOLT chain integrity (hash chain ${evidenceStats.chainIntact ? 'INTACT' : 'pending verification'})`,
        `3. Select sample of ${evidenceStats.totalEvents > 25 ? 25 : evidenceStats.totalEvents || 'N/A'} items`,
        `4. For each sample item, verify: timestamp, actor identity (L1), policy gate result (L3)`,
        `5. Check WARD witness status for each sampled event`,
        `6. Document exceptions and note management response`,
      ],
      exceptions_noted: '',
      conclusion: '',
      reviewer: '',
      review_date: null,
    },
  }
}

module.exports = {
  ENGAGEMENT_STATUSES,
  VALID_ENGAGEMENT_TRANSITIONS,
  createEngagement,
  isEngagementExpired,
  isValidEngagementTransition,
  EVIDENCE_KEYWORDS,
  matchPbcItem,
  matchPbcList,
  generateWorkingPaper,
}
