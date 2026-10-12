/**
 * Feedback & Error Report API Client
 * Communicates with collector endpoints for feedback submission and admin management
 */

const COLLECTOR_API = '/collector'

// ── Feedback ──

export async function submitFeedback({ type = 'feedback', message, name, email, website }) {
  const res = await fetch(`${COLLECTOR_API}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ type, message, name, email, website })
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || 'Failed to submit feedback')
  }
  return res.json()
}

export async function getFeedback({ status, type, page = 1, limit = 50 } = {}) {
  const params = new URLSearchParams()
  if (status && status !== 'all') params.set('status', status)
  if (type && type !== 'all') params.set('type', type)
  params.set('page', String(page))
  params.set('limit', String(limit))

  const res = await fetch(`${COLLECTOR_API}/feedback?${params}`, { credentials: 'include' })
  if (!res.ok) throw new Error('Failed to fetch feedback')
  return res.json()
}

export async function getFeedbackUnreadCount() {
  const res = await fetch(`${COLLECTOR_API}/feedback/unread-count`, { credentials: 'include' })
  if (!res.ok) throw new Error('Failed to fetch unread count')
  return res.json()
}

export async function updateFeedbackStatus(id, status) {
  const res = await fetch(`${COLLECTOR_API}/feedback/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ status })
  })
  if (!res.ok) throw new Error('Failed to update feedback')
  return res.json()
}

export async function deleteFeedback(id) {
  const res = await fetch(`${COLLECTOR_API}/feedback/${id}`, {
    method: 'DELETE',
    credentials: 'include'
  })
  if (!res.ok) throw new Error('Failed to delete feedback')
  return res.json()
}

// ── Error Reports ──

export async function submitErrorReport({ error_type, message, stack, component_stack, url, context, user_description }) {
  const res = await fetch(`${COLLECTOR_API}/error-reports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ error_type, message, stack, component_stack, url, context, user_description })
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || 'Failed to submit error report')
  }
  return res.json()
}

export async function getErrorReports({ status, error_type, page = 1, limit = 50 } = {}) {
  const params = new URLSearchParams()
  if (status && status !== 'all') params.set('status', status)
  if (error_type && error_type !== 'all') params.set('error_type', error_type)
  params.set('page', String(page))
  params.set('limit', String(limit))

  const res = await fetch(`${COLLECTOR_API}/error-reports?${params}`, { credentials: 'include' })
  if (!res.ok) throw new Error('Failed to fetch error reports')
  return res.json()
}

export async function getErrorReportsUnreadCount() {
  const res = await fetch(`${COLLECTOR_API}/error-reports/unread-count`, { credentials: 'include' })
  if (!res.ok) throw new Error('Failed to fetch unread count')
  return res.json()
}

export async function updateErrorReportStatus(id, status) {
  const res = await fetch(`${COLLECTOR_API}/error-reports/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ status })
  })
  if (!res.ok) throw new Error('Failed to update error report')
  return res.json()
}

export async function deleteErrorReport(id) {
  const res = await fetch(`${COLLECTOR_API}/error-reports/${id}`, {
    method: 'DELETE',
    credentials: 'include'
  })
  if (!res.ok) throw new Error('Failed to delete error report')
  return res.json()
}
