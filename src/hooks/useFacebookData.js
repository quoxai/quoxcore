/**
 * useFacebookData — data hook for the Facebook plugin dashboard. FB-3,
 * mirrors src/hooks/useLinkedInData.js.
 *
 * Fetches pages, posts, insights, and credential health through
 * facebookClient, which drives the collector's connector execute route with
 * the caller's auth.
 */

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useWorkspace } from '../contexts/WorkspaceContext'
import * as facebook from '../services/facebookClient'

export function useFacebookData(defaultPageId) {
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const quoxOrgId = currentOrg?.id
  const [pageInfo, setPageInfo] = useState(null)
  const [posts, setPosts] = useState([])
  const [insights, setInsights] = useState(null)
  const [credentialHealth, setCredentialHealth] = useState(null)
  const [tokenExpiry, setTokenExpiry] = useState(null)
  const [activity, setActivity] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const checkHealth = useCallback(async () => {
    // Page-scoped: drives get_page_info (or a cheap get_pages read when no
    // default page is configured) through the org's own vaulted credential.
    // The health result carries pageInfo when the page-info path ran, so it
    // is not fetched twice.
    const health = await facebook.checkCredentialHealth(authFetch, { pageId: defaultPageId })
    setCredentialHealth(health)
    if (health.pageInfo) setPageInfo(health.pageInfo)
    return health
  }, [authFetch, defaultPageId])

  const refreshPosts = useCallback(async () => {
    if (!defaultPageId) return
    try {
      const result = await facebook.getPagePosts(authFetch, defaultPageId, 10)
      setPosts(result || [])
    } catch (err) {
      console.warn('[Facebook] Failed to load posts:', err.message)
      setError(err.message)
    }
  }, [authFetch, defaultPageId])

  const refreshInsights = useCallback(async () => {
    if (!defaultPageId) return
    try {
      const result = await facebook.getPageInsights(authFetch, defaultPageId)
      setInsights(result || [])
    } catch (err) {
      // Insights are decorative; a null renders as "unavailable" rather
      // than asserting a false zero.
      console.warn('[Facebook] Failed to load insights:', err.message)
      setInsights(null)
    }
  }, [authFetch, defaultPageId])

  const refreshTokenExpiry = useCallback(async () => {
    try {
      setTokenExpiry(await facebook.getTokenExpiry(authFetch, quoxOrgId))
    } catch (err) {
      // Expiry is advisory; its absence must not take the panel down.
      console.warn('[Facebook] Failed to read token expiry:', err.message)
    }
  }, [authFetch, quoxOrgId])

  const refreshActivity = useCallback(async () => {
    try {
      // Free read: the collector's own approval-store table, no Facebook call.
      setActivity(await facebook.getActivity(authFetch, { limit: 50 }))
    } catch (err) {
      console.warn('[Facebook] Failed to load activity:', err.message)
    }
  }, [authFetch])

  const refreshAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      refreshTokenExpiry()
      refreshActivity()
      const health = await checkHealth()
      if (health.connected) {
        await refreshPosts()
        await refreshInsights()
      } else if (health.reason !== 'not_configured') {
        // Surface the credential problem instead of stacking failed calls'
        // worth of noise on top of it.
        setError(health.error)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [checkHealth, refreshPosts, refreshInsights, refreshTokenExpiry, refreshActivity])

  useEffect(() => {
    refreshAll()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const publishPagePost = useCallback((args) => facebook.publishPagePost(authFetch, args), [authFetch])
  const getLeadForms = useCallback((pageId) => facebook.getLeadForms(authFetch, pageId), [authFetch])
  const getLeads = useCallback((formId) => facebook.getLeads(authFetch, formId), [authFetch])
  const getPages = useCallback((limit) => facebook.getPages(authFetch, limit), [authFetch])

  return {
    pageInfo,
    posts,
    insights,
    credentialHealth,
    tokenExpiry,
    activity,
    loading,
    error,
    refreshAll,
    refreshActivity,
    refreshPosts,
    refreshInsights,
    publishPagePost,
    getLeadForms,
    getLeads,
    getPages,
  }
}
