/**
 * useInstagramData — data hook for the Instagram plugin dashboard. IG-3,
 * mirrors src/hooks/useFacebookData.js.
 *
 * Fetches the linked account, recent media, publishing quota, and
 * credential health through instagramClient, which drives the collector's
 * connector execute route with the caller's auth. The credential is the
 * SAME vaulted 'meta' token the facebook plugin uses.
 */

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useWorkspace } from '../contexts/WorkspaceContext'
import * as instagram from '../services/instagramClient'

export function useInstagramData(igUserId) {
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const quoxOrgId = currentOrg?.id
  const [account, setAccount] = useState(null)
  const [media, setMedia] = useState([])
  const [quota, setQuota] = useState(null)
  const [credentialHealth, setCredentialHealth] = useState(null)
  const [tokenExpiry, setTokenExpiry] = useState(null)
  const [activity, setActivity] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const checkHealth = useCallback(async () => {
    // Cheap probe: discover_account proves the shared meta token works AND
    // resolves the linked Instagram account in one call.
    const health = await instagram.checkCredentialHealth(authFetch, {})
    setCredentialHealth(health)
    return health
  }, [authFetch])

  const refreshAccount = useCallback(async () => {
    if (!igUserId) return
    try {
      const result = await instagram.getAccount(authFetch, igUserId)
      setAccount(result || null)
    } catch (err) {
      console.warn('[Instagram] Failed to load account:', err.message)
      setError(err.message)
    }
  }, [authFetch, igUserId])

  const refreshMedia = useCallback(async () => {
    if (!igUserId) return
    try {
      const result = await instagram.listMedia(authFetch, igUserId, 12)
      setMedia(result || [])
    } catch (err) {
      console.warn('[Instagram] Failed to load media:', err.message)
      setError(err.message)
    }
  }, [authFetch, igUserId])

  const refreshQuota = useCallback(async () => {
    if (!igUserId) return
    try {
      const result = await instagram.getPublishingLimit(authFetch, igUserId)
      setQuota(result || null)
    } catch (err) {
      // Quota is decorative; a null renders as "unavailable" rather than
      // asserting a false zero.
      console.warn('[Instagram] Failed to load publishing quota:', err.message)
      setQuota(null)
    }
  }, [authFetch, igUserId])

  const refreshTokenExpiry = useCallback(async () => {
    try {
      setTokenExpiry(await instagram.getTokenExpiry(authFetch, quoxOrgId))
    } catch (err) {
      // Expiry is advisory; its absence must not take the panel down.
      console.warn('[Instagram] Failed to read token expiry:', err.message)
    }
  }, [authFetch, quoxOrgId])

  const refreshActivity = useCallback(async () => {
    try {
      // Free read: the collector's own approval-store table, no Meta call.
      setActivity(await instagram.getActivity(authFetch, { limit: 50 }))
    } catch (err) {
      console.warn('[Instagram] Failed to load activity:', err.message)
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
        await Promise.all([refreshAccount(), refreshMedia(), refreshQuota()])
      } else {
        // Surface the credential problem instead of stacking failed calls'
        // worth of noise on top of it.
        setError(health.error)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [checkHealth, refreshAccount, refreshMedia, refreshQuota, refreshTokenExpiry, refreshActivity])

  useEffect(() => {
    refreshAll()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const publishMedia = useCallback((args) => instagram.publishMedia(authFetch, args), [authFetch])
  const replyComment = useCallback((commentId, message) => instagram.replyComment(authFetch, commentId, message), [authFetch])
  const getComments = useCallback((mediaId) => instagram.getComments(authFetch, mediaId), [authFetch])
  const discoverAccount = useCallback((pageId) => instagram.discoverAccount(authFetch, pageId), [authFetch])

  return {
    account,
    media,
    quota,
    credentialHealth,
    tokenExpiry,
    activity,
    loading,
    error,
    refreshAll,
    refreshActivity,
    refreshMedia,
    publishMedia,
    replyComment,
    getComments,
    discoverAccount,
  }
}
