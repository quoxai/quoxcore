/**
 * EU AI Act Classification Engine — Frontend port
 *
 * Client-side branching logic for the risk classification wizard.
 * Questions are fetched from the collector API; this module provides
 * the classify() and next-question logic that can't be serialized.
 *
 * AUD-UX Phase 2 (frontend wiring)
 */

const BRANCHING = {
  q_prohibited: (answer) => answer === 'none' ? 'q_gpai' : null,
  q_gpai: (answer) => {
    if (answer === 'gpai_model') return 'q_gpai_systemic'
    return 'q_safety_component'
  },
  q_gpai_systemic: () => null,
  q_safety_component: (answer) => answer === 'yes' ? null : 'q_annex_iii',
  q_annex_iii: (answer) => answer === 'none' ? 'q_interacts_persons' : null,
  q_interacts_persons: () => null,
}

const CLASSIFICATION = {
  q_prohibited: (answer) => answer !== 'none' ? 'prohibited' : null,
  q_gpai: () => null,
  q_gpai_systemic: (answer) => answer === 'yes' ? 'gpai_systemic' : 'gpai_standard',
  q_safety_component: (answer) => answer === 'yes' ? 'high_risk_annex_i' : null,
  q_annex_iii: (answer) => answer !== 'none' ? 'high_risk_annex_iii' : null,
  q_interacts_persons: (answer) => {
    if (['chatbot', 'deepfake', 'emotion'].includes(answer)) return 'limited_risk'
    return 'minimal_risk'
  },
}

export function getNextQuestion(questionId, answer) {
  const fn = BRANCHING[questionId]
  return fn ? fn(answer) : null
}

export function classifyAtQuestion(questionId, answer) {
  const fn = CLASSIFICATION[questionId]
  return fn ? fn(answer) : null
}

export function classify(answers, questions) {
  const path = []
  let currentId = questions[0]?.id

  while (currentId) {
    const question = questions.find(q => q.id === currentId)
    if (!question) break

    const answer = answers[currentId]
    if (answer === undefined) {
      path.push({ question_id: currentId, answer: null, rule_ref: question.rule_ref, result: null })
      break
    }

    const tierId = classifyAtQuestion(currentId, answer)
    path.push({
      question_id: currentId,
      answer,
      rule_ref: question.rule_ref,
      result: tierId,
    })

    if (tierId) {
      return { tierId, path, complete: true }
    }

    currentId = getNextQuestion(currentId, answer)
  }

  return { tierId: null, path, complete: false }
}
