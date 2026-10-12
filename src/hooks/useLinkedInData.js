/**
 * useLinkedInData — data hook for the LinkedIn plugin dashboard.
 *
 * Fetches posts, engagement, org info, and credential health through
 * linkedinClient, which drives the collector's connector execute route with
 * the caller's auth (LI-OVERHAUL P2 — the first version of this hook called
 * routes that never existed, with no auth, and its tests mocked it wholesale).
 */

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useWorkspace } from '../contexts/WorkspaceContext'
import * as linkedin from '../services/linkedinClient'

export function useLinkedInData(authorUrn, orgId) {
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const quoxOrgId = currentOrg?.id
  const [posts, setPosts] = useState([])
  const [engagement, setEngagement] = useState({})
  const [orgInfo, setOrgInfo] = useState(null)
  const [credentialHealth, setCredentialHealth] = useState(null)
  const [tokenExpiry, setTokenExpiry] = useState(null)
  const [activity, setActivity] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refreshPosts = useCallback(async () => {
    if (!authorUrn) return
    try {
      const result = await linkedin.getPosts(authFetch, authorUrn, 20)
      setPosts(result || [])
    } catch (err) {
      console.warn('[LinkedIn] Failed to load posts:', err.message)
      setError(err.message)
    }
  }, [authFetch, authorUrn])

  const refreshEngagement = useCallback(async (postList) => {
    const target = postList || posts
    if (!target.length) return

    const results = {}
    for (const post of target.slice(0, 10)) {
      try {
        results[post.id] = await linkedin.getEngagement(authFetch, post.id)
      } catch {
        // Per-post engagement is decorative; a null renders as "unavailable"
        // rather than asserting a false zero.
        results[post.id] = null
      }
    }
    setEngagement(prev => ({ ...prev, ...results }))
  }, [authFetch, posts])

  const checkHealth = useCallback(async () => {
    // Org-scoped: drives get_org_info (or a 1-post read for member-only
    // setups) through the org's own vaulted credential. The health result
    // carries orgInfo when the org-page path ran, so it is not fetched twice.
    const health = await linkedin.checkCredentialHealth(authFetch, { orgId, authorUrn })
    setCredentialHealth(health)
    if (health.orgInfo) setOrgInfo(health.orgInfo)
    return health
  }, [authFetch, orgId, authorUrn])

  const refreshOrgInfo = useCallback(async () => {
    if (!orgId) return
    try {
      const result = await linkedin.getOrgInfo(authFetch, orgId)
      setOrgInfo(result)
    } catch (err) {
      console.warn('[LinkedIn] Failed to load org info:', err.message)
    }
  }, [authFetch, orgId])

  const refreshTokenExpiry = useCallback(async () => {
    try {
      setTokenExpiry(await linkedin.getTokenExpiry(authFetch, quoxOrgId))
    } catch (err) {
      // Expiry is advisory; its absence must not take the panel down.
      console.warn('[LinkedIn] Failed to read token expiry:', err.message)
    }
  }, [authFetch, quoxOrgId])

  const refreshActivity = useCallback(async () => {
    try {
      // Free read: the collector's own approval-store table, no LinkedIn call.
      setActivity(await linkedin.getActivity(authFetch, { limit: 50 }))
    } catch (err) {
      console.warn('[LinkedIn] Failed to load activity:', err.message)
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
      } else if (health.reason !== 'not_configured') {
        // Surface the credential problem instead of stacking three failed
        // calls' worth of noise on top of it.
        setError(health.error)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [checkHealth, refreshPosts, refreshTokenExpiry, refreshActivity])

  useEffect(() => {
    refreshAll()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (posts.length > 0) {
      refreshEngagement(posts)
    }
  }, [posts]) // eslint-disable-line react-hooks/exhaustive-deps

  const publishPost = useCallback((args) => linkedin.publishPost(authFetch, args), [authFetch])
  const uploadMedia = useCallback((args) => linkedin.uploadMedia(authFetch, args), [authFetch])
  const createComment = useCallback((args) => linkedin.createComment(authFetch, args), [authFetch])

  return {
    posts,
    engagement,
    orgInfo,
    credentialHealth,
    tokenExpiry,
    activity,
    loading,
    error,
    refreshAll,
    refreshActivity,
    refreshPosts,
    refreshEngagement,
    refreshOrgInfo,
    publishPost,
    uploadMedia,
    createComment,
  }
}
