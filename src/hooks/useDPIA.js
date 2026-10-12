/**
 * useDPIA — hook for GDPR DPIA assessment CRUD
 */

import { useState, useEffect, useCallback } from 'react'

const BASE = '/collector/api/v1/compliance/dpia'

export function useDPIA(orgId = '') {
  const [dpia, setDpia] = useState(null)
  const [dpias, setDpias] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchList = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${BASE}?org_id=${encodeURIComponent(orgId)}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Failed to list DPIAs: ${res.status}`)
      const data = await res.json()
      setDpias(data.dpias || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [orgId])

  const fetchDpia = useCallback(async (id) => {
    setLoading(true)
    try {
      const res = await fetch(`${BASE}/${id}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Failed to fetch DPIA: ${res.status}`)
      const data = await res.json()
      setDpia(data.dpia)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const createDpia = useCallback(async (processingName = '') => {
    setLoading(true)
    try {
      const res = await fetch(BASE, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, processing_name: processingName }),
      })
      if (!res.ok) throw new Error(`Failed to create DPIA: ${res.status}`)
      const data = await res.json()
      setDpia(data.dpia)
      return data.dpia
    } catch (err) {
      setError(err.message)
      return null
    } finally {
      setLoading(false)
    }
  }, [orgId])

  const updateSections = useCallback(async (sections) => {
    if (!dpia?.id) return
    try {
      const res = await fetch(`${BASE}/${dpia.id}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sections }),
      })
      if (!res.ok) throw new Error(`Failed to save: ${res.status}`)
      const data = await res.json()
      setDpia(data.dpia)
    } catch (err) {
      setError(err.message)
    }
  }, [dpia?.id])

  const updateField = useCallback(async (fieldPath, value) => {
    if (!dpia?.id) return
    const sections = JSON.parse(JSON.stringify(dpia.sections_json || dpia.sections || {}))
    const parts = fieldPath.replace(/^sections\./, '').split('.')
    let obj = sections
    for (let i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]]) obj[parts[i]] = {}
      obj = obj[parts[i]]
    }
    obj[parts[parts.length - 1]] = value
    await updateSections(sections)
  }, [dpia, updateSections])

  const updateStatus = useCallback(async (newStatus) => {
    if (!dpia?.id) return
    try {
      const res = await fetch(`${BASE}/${dpia.id}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      if (!res.ok) throw new Error(`Failed to update status: ${res.status}`)
      const data = await res.json()
      setDpia(data.dpia)
    } catch (err) {
      setError(err.message)
    }
  }, [dpia?.id])

  const addRisk = useCallback(async () => {
    if (!dpia?.id) return
    const sections = JSON.parse(JSON.stringify(dpia.sections_json || dpia.sections || {}))
    if (!sections.risks) sections.risks = []
    sections.risks.push({
      id: `RISK_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: '', description: '', threat_type: '',
      likelihood: 0, severity: 0,
      existing_controls: '', residual_likelihood: 0, residual_severity: 0,
    })
    await updateSections(sections)
  }, [dpia, updateSections])

  const updateRisk = useCallback(async (riskId, field, value) => {
    if (!dpia?.id) return
    const sections = JSON.parse(JSON.stringify(dpia.sections_json || dpia.sections || {}))
    const risk = (sections.risks || []).find(r => r.id === riskId)
    if (risk) {
      risk[field] = value
      await updateSections(sections)
    }
  }, [dpia, updateSections])

  const addMeasure = useCallback(async () => {
    if (!dpia?.id) return
    const sections = JSON.parse(JSON.stringify(dpia.sections_json || dpia.sections || {}))
    if (!sections.measures) sections.measures = []
    sections.measures.push({
      id: `MEAS_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      risk_id: '', description: '', type: '', responsible: '',
      target_date: null, status: 'planned',
    })
    await updateSections(sections)
  }, [dpia, updateSections])

  useEffect(() => { fetchList() }, [fetchList])

  return {
    dpia, dpias, loading, error,
    fetchDpia, createDpia, updateSections, updateField, updateStatus,
    addRisk, updateRisk, addMeasure, refresh: fetchList,
  }
}
