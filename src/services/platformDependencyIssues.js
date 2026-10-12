import {
  TASKS_CONNECTION_ERROR,
  TASKS_HTML_RESPONSE_ERROR,
  TASKS_INVALID_JSON_ERROR,
} from './taskServiceClient'
import {
  QUOXFLOW_CONNECTION_ERROR,
  QUOXFLOW_HTML_RESPONSE_ERROR,
  QUOXFLOW_INVALID_JSON_ERROR,
} from './quoxflowClient'

const SERVICE_ISSUES = {
  tasks: {
    title: 'Tasks service unavailable',
    serviceLabel: 'Tasks',
    summary: 'This area depends on the Tasks service for objectives, team state, schedules, and Mission Control data.',
    checks: [
      'Check the Tasks service is running and /tasks/health responds.',
      'Check the /tasks proxy is returning JSON instead of the dashboard HTML shell.',
      'Run scripts/post-install-smoke.sh after recovery to confirm the platform is really ready.',
    ],
  },
  quoxflow: {
    title: 'QuoxFlow unavailable',
    serviceLabel: 'QuoxFlow',
    summary: 'This area depends on QuoxFlow for workflows, approvals, schedules, and policy execution.',
    checks: [
      'Check QuoxFlow is running and /quoxflow/health responds.',
      'Check the /quoxflow proxy is returning JSON instead of the dashboard HTML shell.',
      'Run scripts/post-install-smoke.sh after recovery to confirm workflow features are healthy.',
    ],
  },
}

function normalizeMessage(error) {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (typeof error?.message === 'string') return error.message
  return String(error || '')
}

function inferService(message = '') {
  const lower = String(message || '').toLowerCase()
  if (
    lower.includes('/tasks') ||
    lower.includes('task service') ||
    lower.includes('objectives') ||
    lower.includes('agentic teams')
  ) {
    return 'tasks'
  }
  if (
    lower.includes('/quoxflow') ||
    lower.includes('quoxflow') ||
    lower.includes('workflow builder') ||
    lower.includes('policy')
  ) {
    return 'quoxflow'
  }
  return null
}

function isStandardizedMessage(message, service) {
  const known = service === 'tasks'
    ? [TASKS_CONNECTION_ERROR, TASKS_HTML_RESPONSE_ERROR, TASKS_INVALID_JSON_ERROR]
    : [QUOXFLOW_CONNECTION_ERROR, QUOXFLOW_HTML_RESPONSE_ERROR, QUOXFLOW_INVALID_JSON_ERROR]
  return known.includes(message)
}

export function getPlatformDependencyIssue(error, { service, feature } = {}) {
  const message = normalizeMessage(error)
  if (!message) return null

  const resolvedService = service || inferService(message)
  if (!resolvedService || !SERVICE_ISSUES[resolvedService]) return null

  const config = SERVICE_ISSUES[resolvedService]
  const featureSummary = feature
    ? `${feature} depends on ${config.serviceLabel}.`
    : config.summary

  return {
    service: resolvedService,
    title: config.title,
    summary: feature ? `${featureSummary} ${config.summary}` : config.summary,
    checks: config.checks,
    detail: isStandardizedMessage(message, resolvedService) ? null : message,
    rawMessage: message,
  }
}

