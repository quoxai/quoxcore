/**
 * EU AI Act Risk Classification Engine
 *
 * Branching decision tree for determining the risk tier of an AI system
 * under Regulation (EU) 2024/1689 (EU AI Act).
 *
 * AUD-UX Phase 2
 */

const RISK_TIERS = {
  PROHIBITED: { id: 'prohibited', label: 'Prohibited', severity: 4, articles: ['Art.5'] },
  HIGH_RISK_ANNEX_I: { id: 'high_risk_annex_i', label: 'High-Risk (Annex I — Safety Component)', severity: 3, articles: ['Art.6(1)', 'Annex I'] },
  HIGH_RISK_ANNEX_III: { id: 'high_risk_annex_iii', label: 'High-Risk (Annex III — Use Case)', severity: 3, articles: ['Art.6(2)', 'Annex III'] },
  GPAI_SYSTEMIC: { id: 'gpai_systemic', label: 'GPAI with Systemic Risk', severity: 3, articles: ['Art.51', 'Art.52'] },
  GPAI_STANDARD: { id: 'gpai_standard', label: 'General-Purpose AI Model', severity: 2, articles: ['Art.53', 'Art.55'] },
  LIMITED_RISK: { id: 'limited_risk', label: 'Limited Risk (Transparency)', severity: 1, articles: ['Art.50'] },
  MINIMAL_RISK: { id: 'minimal_risk', label: 'Minimal Risk', severity: 0, articles: ['Art.4'] },
}

const ANNEX_III_CATEGORIES = [
  { id: 'biometric', label: 'Biometric identification and categorisation of natural persons', article: 'Annex III(1)' },
  { id: 'critical_infra', label: 'Management and operation of critical infrastructure', article: 'Annex III(2)' },
  { id: 'education', label: 'Education and vocational training', article: 'Annex III(3)' },
  { id: 'employment', label: 'Employment, workers management, and access to self-employment', article: 'Annex III(4)' },
  { id: 'essential_services', label: 'Access to and enjoyment of essential private and public services', article: 'Annex III(5)' },
  { id: 'law_enforcement', label: 'Law enforcement', article: 'Annex III(6)' },
  { id: 'migration', label: 'Migration, asylum, and border control management', article: 'Annex III(7)' },
  { id: 'justice', label: 'Administration of justice and democratic processes', article: 'Annex III(8)' },
]

const QUESTIONS = [
  {
    id: 'q_prohibited',
    text: 'Is your AI system used for any of the following prohibited practices?',
    help: 'Article 5 of the EU AI Act bans certain AI practices outright. These include social scoring by governments, real-time remote biometric identification in public spaces (with limited exceptions), subliminal manipulation, and exploitation of vulnerabilities of specific groups.',
    options: [
      { id: 'social_scoring', label: 'Social scoring by or on behalf of public authorities' },
      { id: 'realtime_biometric', label: 'Real-time remote biometric identification in publicly accessible spaces for law enforcement' },
      { id: 'subliminal', label: 'Subliminal techniques to materially distort behaviour causing harm' },
      { id: 'exploit_vulnerable', label: 'Exploiting vulnerabilities of specific groups (age, disability, social situation)' },
      { id: 'emotion_workplace', label: 'Emotion recognition in workplace or educational institutions (without medical/safety basis)' },
      { id: 'biometric_scraping', label: 'Untargeted scraping of facial images from internet or CCTV to build facial recognition databases' },
      { id: 'none', label: 'None of the above' },
    ],
    multiple: false,
    rule_ref: 'Art.5',
    next: (answer) => answer === 'none' ? 'q_gpai' : null,
    classify: (answer) => answer !== 'none' ? RISK_TIERS.PROHIBITED : null,
  },
  {
    id: 'q_gpai',
    text: 'Is this a General-Purpose AI (GPAI) model or a system built on one?',
    help: 'A GPAI model is an AI model trained with large amounts of data using self-supervision at scale, that displays significant generality and can competently perform a wide range of distinct tasks (e.g. Claude, GPT, Gemini, Llama). Systems that use these models as a component are also covered.',
    options: [
      { id: 'gpai_model', label: 'Yes — this IS a foundation/GPAI model (we trained it)' },
      { id: 'gpai_system', label: 'Yes — this system USES a GPAI model as a component (e.g. built on Claude/GPT)' },
      { id: 'no', label: 'No — this is a purpose-built AI system (not GPAI-based)' },
    ],
    multiple: false,
    rule_ref: 'Art.3(63)',
    next: (answer) => {
      if (answer === 'gpai_model') return 'q_gpai_systemic'
      if (answer === 'gpai_system') return 'q_safety_component'
      return 'q_safety_component'
    },
    classify: () => null,
  },
  {
    id: 'q_gpai_systemic',
    text: 'Does the GPAI model have systemic risk?',
    help: 'A GPAI model is presumed to have systemic risk if the cumulative amount of compute used for its training is greater than 10^25 FLOPs, or if the Commission designates it as having systemic risk based on other criteria (Art.51(2)).',
    options: [
      { id: 'yes', label: 'Yes — training compute ≥ 10²⁵ FLOPs or designated by Commission' },
      { id: 'no', label: 'No — below the systemic risk threshold' },
    ],
    multiple: false,
    rule_ref: 'Art.51',
    next: () => null,
    classify: (answer) => answer === 'yes' ? RISK_TIERS.GPAI_SYSTEMIC : RISK_TIERS.GPAI_STANDARD,
  },
  {
    id: 'q_safety_component',
    text: 'Is the AI system a safety component of a product covered by EU harmonisation legislation listed in Annex I?',
    help: 'Annex I lists Union harmonisation legislation: machinery, toys, recreational craft, lifts, pressure equipment, radio equipment, cableways, personal protective equipment, medical devices, aviation, motor vehicles, rail systems, marine equipment. If the AI system is a safety component of any of these products, it is high-risk under Art.6(1).',
    options: [
      { id: 'yes', label: 'Yes — it is a safety component of a product listed in Annex I' },
      { id: 'no', label: 'No' },
    ],
    multiple: false,
    rule_ref: 'Art.6(1), Annex I',
    next: (answer) => answer === 'yes' ? null : 'q_annex_iii',
    classify: (answer) => answer === 'yes' ? RISK_TIERS.HIGH_RISK_ANNEX_I : null,
  },
  {
    id: 'q_annex_iii',
    text: 'Is the AI system used in any of the following high-risk use case areas (Annex III)?',
    help: 'Annex III defines 8 areas where AI systems are considered high-risk based on their use case. Select any that apply to your system.',
    options: [
      ...ANNEX_III_CATEGORIES.map(c => ({ id: c.id, label: c.label })),
      { id: 'none', label: 'None of the above' },
    ],
    multiple: false,
    rule_ref: 'Art.6(2), Annex III',
    next: (answer) => answer === 'none' ? 'q_interacts_persons' : null,
    classify: (answer) => {
      if (answer !== 'none') {
        const cat = ANNEX_III_CATEGORIES.find(c => c.id === answer)
        return { ...RISK_TIERS.HIGH_RISK_ANNEX_III, annexIiiCategory: cat?.article || 'Annex III' }
      }
      return null
    },
  },
  {
    id: 'q_interacts_persons',
    text: 'Does the AI system interact directly with natural persons?',
    help: 'Under Art.50, certain AI systems that interact with people have transparency obligations: chatbots must disclose they are AI, deepfake generators must label outputs, emotion recognition must inform subjects.',
    options: [
      { id: 'chatbot', label: 'Yes — it is a chatbot or conversational system (must disclose it is AI)' },
      { id: 'deepfake', label: 'Yes — it generates or manipulates images, audio, or video (deepfakes)' },
      { id: 'emotion', label: 'Yes — it performs emotion recognition or biometric categorisation' },
      { id: 'other_interact', label: 'Yes — it interacts with persons but not in the above ways' },
      { id: 'no', label: 'No — it does not interact directly with natural persons' },
    ],
    multiple: false,
    rule_ref: 'Art.50',
    next: () => null,
    classify: (answer) => {
      if (['chatbot', 'deepfake', 'emotion'].includes(answer)) return RISK_TIERS.LIMITED_RISK
      return RISK_TIERS.MINIMAL_RISK
    },
  },
]

function getQuestion(questionId) {
  return QUESTIONS.find(q => q.id === questionId) || null
}

function getFirstQuestionId() {
  return QUESTIONS[0].id
}

function classify(answers) {
  const path = []
  let currentId = getFirstQuestionId()

  while (currentId) {
    const question = getQuestion(currentId)
    if (!question) break

    const answer = answers[currentId]
    if (answer === undefined) {
      path.push({ question_id: currentId, answer: null, rule_ref: question.rule_ref, result: null })
      break
    }

    const result = question.classify(answer)
    path.push({
      question_id: currentId,
      answer,
      rule_ref: question.rule_ref,
      result: result ? result.id : null,
    })

    if (result) {
      return { tier: result, path, complete: true }
    }

    const nextId = question.next(answer)
    currentId = nextId
  }

  return { tier: null, path, complete: false }
}

function generateMemo(answers, orgName = '', systemName = '') {
  const { tier, path, complete } = classify(answers)

  const lines = [
    `# EU AI Act Risk Classification Memo`,
    ``,
    `**Organisation:** ${orgName || '[Not specified]'}`,
    `**AI System:** ${systemName || '[Not specified]'}`,
    `**Classification Date:** ${new Date().toISOString().split('T')[0]}`,
    `**Status:** ${complete ? 'Complete' : 'Incomplete'}`,
    ``,
    `## Classification Result`,
    ``,
  ]

  if (complete && tier) {
    lines.push(`**Risk Tier:** ${tier.label}`)
    lines.push(`**Applicable Articles:** ${tier.articles.join(', ')}`)
    if (tier.annexIiiCategory) {
      lines.push(`**Annex III Category:** ${tier.annexIiiCategory}`)
    }
    lines.push(`**Severity Level:** ${tier.severity}/4`)
  } else {
    lines.push(`**Risk Tier:** Pending (assessment incomplete)`)
  }

  lines.push(``, `## Decision Path`, ``)
  lines.push(`| Step | Question | Answer | Rule Reference | Result |`)
  lines.push(`|------|----------|--------|---------------|--------|`)

  for (let i = 0; i < path.length; i++) {
    const step = path[i]
    const q = getQuestion(step.question_id)
    const answerLabel = q?.options?.find(o => o.id === step.answer)?.label || step.answer || '—'
    lines.push(`| ${i + 1} | ${q?.text?.slice(0, 60) || step.question_id}... | ${answerLabel.slice(0, 40)} | ${step.rule_ref} | ${step.result || '→ next'} |`)
  }

  lines.push(``, `## Disclaimer`, ``)
  lines.push(`This classification is a technical readiness assessment, not a legal determination. Consult qualified legal counsel before relying on this classification for regulatory compliance purposes.`)

  return lines.join('\n')
}

module.exports = {
  RISK_TIERS,
  ANNEX_III_CATEGORIES,
  QUESTIONS,
  getQuestion,
  getFirstQuestionId,
  classify,
  generateMemo,
}
