/**
 * useSoAAssessment — hook for SoA assessment CRUD via collector API
 *
 * AUD-UX Phase 1
 */

import { useState, useEffect, useCallback } from 'react'

const BASE = '/collector/api/v1/compliance/soa'

export function useSoAAssessment(orgId = '') {
  const [assessment, setAssessment] = useState(null)
  const [assessments, setAssessments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchList = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${BASE}?org_id=${encodeURIComponent(orgId)}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Failed to list assessments: ${res.status}`)
      const data = await res.json()
      setAssessments(data.assessments || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [orgId])

  const fetchAssessment = useCallback(async (id) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${BASE}/${id}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Failed to fetch assessment: ${res.status}`)
      const data = await res.json()
      setAssessment(data.assessment)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const createAssessment = useCallback(async (framework = 'iso27001_2022') => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(BASE, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, framework }),
      })
      if (!res.ok) throw new Error(`Failed to create assessment: ${res.status}`)
      const data = await res.json()
      setAssessment(data.assessment)
      return data.assessment
    } catch (err) {
      setError(err.message)
      return null
    } finally {
      setLoading(false)
    }
  }, [orgId])

  const saveControls = useCallback(async (controls) => {
    if (!assessment?.id) return
    try {
      const res = await fetch(`${BASE}/${assessment.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ controls }),
      })
      if (!res.ok) throw new Error(`Failed to save: ${res.status}`)
      const data = await res.json()
      setAssessment(data.assessment)
    } catch (err) {
      setError(err.message)
    }
  }, [assessment?.id])

  const updateStatus = useCallback(async (newStatus) => {
    if (!assessment?.id) return
    try {
      const res = await fetch(`${BASE}/${assessment.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      if (!res.ok) throw new Error(`Failed to update status: ${res.status}`)
      const data = await res.json()
      setAssessment(data.assessment)
    } catch (err) {
      setError(err.message)
    }
  }, [assessment?.id])

  const exportAssessment = useCallback(async (format = 'json') => {
    if (!assessment?.id) return null
    try {
      const res = await fetch(`${BASE}/${assessment.id}/export?format=${format}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Failed to export: ${res.status}`)
      if (format === 'csv') {
        const text = await res.text()
        const blob = new Blob([text], { type: 'text/csv' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `soa-${assessment.id}.csv`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 200)
        return text
      }
      return await res.json()
    } catch (err) {
      setError(err.message)
      return null
    }
  }, [assessment?.id])

  useEffect(() => { fetchList() }, [fetchList])

  return {
    assessment,
    assessments,
    loading,
    error,
    fetchAssessment,
    createAssessment,
    saveControls,
    updateStatus,
    exportAssessment,
    refresh: fetchList,
  }
}
