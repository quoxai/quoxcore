/**
 * useTikTokData — data hook for the TikTok plugin dashboard. TT-4, mirrors
 * src/hooks/useInstagramData.js.
 *
 * Fetches the connected profile, recent videos, credential health, and
 * token expiry through tiktokClient, which drives the collector's connector
 * execute route with the caller's auth. TikTok has its own dedicated vault
 * credential (not shared with any other plugin), and that credential's
 * access_token lives 24 hours with no auto-refresh, so tokenExpiry is
 * reported in HOURS.
 */

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useWorkspace } from '../contexts/WorkspaceContext'
import * as tiktok from '../services/tiktokClient'

export function useTikTokData() {
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const quoxOrgId = currentOrg?.id
  const [profile, setProfile] = useState(null)
  const [videos, setVideos] = useState([])
  const [credentialHealth, setCredentialHealth] = useState(null)
  const [tokenExpiry, setTokenExpiry] = useState(null)
  const [activity, setActivity] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const checkHealth = useCallback(async () => {
    // Cheap probe: get_profile proves the vaulted access token still works.
    const health = await tiktok.checkCredentialHealth(authFetch)
    setCredentialHealth(health)
    return health
  }, [authFetch])

  const refreshProfile = useCallback(async () => {
    try {
      const result = await tiktok.getProfile(authFetch)
      setProfile(result || null)
    } catch (err) {
      console.warn('[TikTok] Failed to load profile:', err.message)
      setError(err.message)
    }
  }, [authFetch])

  const refreshVideos = useCallback(async () => {
    try {
      const result = await tiktok.listVideos(authFetch, 12)
      setVideos(result?.videos || [])
    } catch (err) {
      console.warn('[TikTok] Failed to load videos:', err.message)
      setVideos([])
    }
  }, [authFetch])

  const refreshTokenExpiry = useCallback(async () => {
    try {
      setTokenExpiry(await tiktok.getTokenExpiry(authFetch, quoxOrgId))
    } catch (err) {
      // Expiry is advisory; its absence must not take the panel down.
      console.warn('[TikTok] Failed to read token expiry:', err.message)
    }
  }, [authFetch, quoxOrgId])

  const refreshActivity = useCallback(async () => {
    try {
      // Free read: the collector's own approval-store table, no TikTok call.
      setActivity(await tiktok.getActivity(authFetch, { limit: 50 }))
    } catch (err) {
      console.warn('[TikTok] Failed to load activity:', err.message)
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
        await Promise.all([refreshProfile(), refreshVideos()])
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
  }, [checkHealth, refreshProfile, refreshVideos, refreshTokenExpiry, refreshActivity])

  useEffect(() => {
    refreshAll()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const publishVideo = useCallback((args) => tiktok.publishVideo(authFetch, args), [authFetch])
  const uploadDraft = useCallback((args) => tiktok.uploadDraft(authFetch, args), [authFetch])
  const getPublishStatus = useCallback((publishId) => tiktok.getPublishStatus(authFetch, publishId), [authFetch])
  const getVideoStats = useCallback((videoIds) => tiktok.getVideoStats(authFetch, videoIds), [authFetch])

  return {
    profile,
    videos,
    credentialHealth,
    tokenExpiry,
    activity,
    loading,
    error,
    refreshAll,
    refreshActivity,
    refreshVideos,
    publishVideo,
    uploadDraft,
    getPublishStatus,
    getVideoStats,
  }
}
