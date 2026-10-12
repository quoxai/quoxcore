/**
 * useRiskClassification — hook for EU AI Act classification CRUD + question fetching
 */

import { useState, useEffect, useCallback } from 'react'
import { classify } from '../services/compliance/classificationEngine'

const BASE = '/collector/api/v1/compliance/classification'

export function useRiskClassification(orgId = '') {
  const [questions, setQuestions] = useState([])
  const [riskTiers, setRiskTiers] = useState({})
  const [classification, setClassification] = useState(null)
  const [classifications, setClassifications] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchQuestions = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/questions`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Failed to load questions: ${res.status}`)
      const data = await res.json()
      setQuestions(data.questions || [])
      setRiskTiers(data.riskTiers || {})
    } catch (err) {
      setError(err.message)
    }
  }, [])

  const fetchList = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${BASE}?org_id=${encodeURIComponent(orgId)}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Failed to list: ${res.status}`)
      const data = await res.json()
      setClassifications(data.classifications || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [orgId])

  const createClassification = useCallback(async (systemName = '', answers = {}) => {
    setLoading(true)
    try {
      const res = await fetch(BASE, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, system_name: systemName, answers }),
      })
      if (!res.ok) throw new Error(`Failed to create: ${res.status}`)
      const data = await res.json()
      setClassification(data.classification)
      return data.classification
    } catch (err) {
      setError(err.message)
      return null
    } finally {
      setLoading(false)
    }
  }, [orgId])

  const saveAnswers = useCallback(async (answers, systemName) => {
    if (!classification?.id) {
      return createClassification(systemName, answers)
    }
    try {
      const res = await fetch(`${BASE}/${classification.id}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers, system_name: systemName }),
      })
      if (!res.ok) throw new Error(`Failed to save: ${res.status}`)
      const data = await res.json()
      setClassification(data.classification)
    } catch (err) {
      setError(err.message)
    }
  }, [classification?.id, createClassification])

  const classifyAnswers = useCallback((answers) => {
    return classify(answers, questions)
  }, [questions])

  useEffect(() => { fetchQuestions() }, [fetchQuestions])
  useEffect(() => { fetchList() }, [fetchList])

  return {
    questions, riskTiers, classification, classifications,
    loading, error,
    createClassification, saveAnswers, classifyAnswers, refresh: fetchList,
  }
}
