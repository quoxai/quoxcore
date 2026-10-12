/**
 * useCommsData Hook
 *
 * Combines channel config, vault status, and delivery stats
 * for the Communications Command Centre.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useWorkspace } from '../contexts/WorkspaceContext'
import { useAuth } from '../contexts/AuthContext'
import {
  getConfig,
  saveConfig,
  resetConfig,
  getChannelStatus,
  isCoreCommsActive,
  testTelegram,
  testSlack,
  testEmail,
  testWebhookChannel,
  getTelegramWebhookInfo,
  registerTelegramWebhook,
  deactivateTelegramWebhook,
  getSlackWebhookInfo,
  registerSlackWebhook,
  deactivateSlackWebhook,
  listTelegramBots,
  getDiscordWebhookInfo,
  registerDiscordWebhook,
  deactivateDiscordWebhook,
  listWebhookEndpoints,
  createWebhookEndpoint,
  updateWebhookEndpoint,
  deleteWebhookEndpoint,
  PRIORITIES
} from '../services/coreCommsService'

export { PRIORITIES }

export function useCommsData() {
  const { currentOrg } = useWorkspace()
  const { authFetch } = useAuth()
  const orgId = currentOrg?.id
  const mountedRef = useRef(true)

  const [config, setConfig] = useState(null)
  const [channelStatus, setChannelStatus] = useState(null)
  const [deliveryStats, setDeliveryStats] = useState({ sent: 0, failed: 0, total: 0 })
  const [recentDeliveries, setRecentDeliveries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [isActive, setIsActive] = useState(true)
  const [webhookInfo, setWebhookInfo] = useState(null)
  const [slackWebhookInfo, setSlackWebhookInfo] = useState(null)
  const [telegramBots, setTelegramBots] = useState([])
  const [discordWebhookInfo, setDiscordWebhookInfo] = useState(null)
  const [webhookEndpoints, setWebhookEndpoints] = useState([])

  const loadConfig = useCallback(() => {
    try {
      const cfg = getConfig(orgId)
      if (mountedRef.current) {
        setConfig(cfg)
        setChannelStatus(getChannelStatus(orgId))
        setError(null)
      }
    } catch (err) {
      if (mountedRef.current) setError('Failed to load configuration')
    }
  }, [orgId])

  const loadDeliveryStats = useCallback(async () => {
    if (!orgId) return
    try {
      // 5s timeout so a slow backend doesn't hang the page
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const resp = await authFetch(`/api/orgs/${orgId}/notification-deliveries?limit=10`, {
        signal: controller.signal
      })
      clearTimeout(timeout)
      if (!resp.ok) return
      const data = await resp.json()
      if (!mountedRef.current) return

      const items = data.data || data.items || []
      setRecentDeliveries(items)

      // Calculate stats from available data
      const sent = items.filter(d => d.status === 'sent' || d.status === 'delivered').length
      const failed = items.filter(d => d.status === 'failed').length
      const total = items.length
      setDeliveryStats({ sent, failed, total })
    } catch {
      // Non-critical — stats will just show zeros (includes AbortError on timeout)
    }
  }, [orgId, authFetch])

  const loadWebhookInfo = useCallback(async () => {
    try {
      const info = await getTelegramWebhookInfo()
      if (mountedRef.current) setWebhookInfo(info)
    } catch {
      // Non-critical
    }
  }, [])

  const loadSlackWebhookInfo = useCallback(async () => {
    try {
      const info = await getSlackWebhookInfo()
      if (mountedRef.current) setSlackWebhookInfo(info)
    } catch {
      // Non-critical
    }
  }, [])

  const loadTelegramBots = useCallback(async () => {
    if (!orgId) return
    try {
      const bots = await listTelegramBots(orgId)
      if (mountedRef.current) setTelegramBots(bots)
    } catch {
      // Non-critical
    }
  }, [orgId])

  const loadDiscordWebhookInfo = useCallback(async () => {
    try {
      const info = await getDiscordWebhookInfo()
      if (mountedRef.current) setDiscordWebhookInfo(info)
    } catch {
      // Non-critical
    }
  }, [])

  const loadWebhookEndpoints = useCallback(async () => {
    if (!orgId) return
    try {
      const endpoints = await listWebhookEndpoints(orgId)
      if (mountedRef.current) setWebhookEndpoints(endpoints)
    } catch {
      // Non-critical
    }
  }, [orgId])

  // Load everything on mount and org change
  // Only block the loading spinner on config + delivery stats (needed for overview).
  // Webhook info calls (telegram/slack/discord/endpoints) load in the background —
  // they're only needed when the user opens a specific channel config panel.
  useEffect(() => {
    mountedRef.current = true
    setIsActive(isCoreCommsActive())
    setLoading(true)
    loadConfig()
    // Critical path: just delivery stats (overview needs these)
    loadDeliveryStats()
      .finally(() => { if (mountedRef.current) setLoading(false) })
    // Non-critical: webhook info loads in background (no loading gate)
    loadWebhookInfo()
    loadSlackWebhookInfo()
    loadTelegramBots()
    loadDiscordWebhookInfo()
    loadWebhookEndpoints()
    return () => { mountedRef.current = false }
  }, [loadConfig, loadDeliveryStats, loadWebhookInfo, loadSlackWebhookInfo, loadTelegramBots, loadDiscordWebhookInfo, loadWebhookEndpoints])

  const handleSave = useCallback((newConfig) => {
    const cfg = newConfig || config
    if (!cfg) return false
    const ok = saveConfig(cfg, orgId)
    if (ok) loadConfig()
    return ok
  }, [config, orgId, loadConfig])

  const handleReset = useCallback(() => {
    resetConfig(orgId)
    loadConfig()
  }, [orgId, loadConfig])

  const updateChannel = useCallback((channel, updates) => {
    setConfig(prev => {
      if (!prev) return prev
      return { ...prev, [channel]: { ...prev[channel], ...updates } }
    })
  }, [])

  const updateSmtp = useCallback((field, value) => {
    setConfig(prev => {
      if (!prev) return prev
      return {
        ...prev,
        email: {
          ...prev.email,
          smtp: { ...prev.email.smtp, [field]: value }
        }
      }
    })
  }, [])

  const togglePriority = useCallback((channel, priority) => {
    if (!config) return
    const current = config[channel]?.priorities || []
    const updated = current.includes(priority)
      ? current.filter(p => p !== priority)
      : [...current, priority]
    updateChannel(channel, { priorities: updated })
  }, [config, updateChannel])

  const refresh = useCallback(() => {
    loadConfig()
    loadDeliveryStats()
    loadWebhookInfo()
    loadSlackWebhookInfo()
    loadTelegramBots()
    loadDiscordWebhookInfo()
    loadWebhookEndpoints()
  }, [loadConfig, loadDeliveryStats, loadWebhookInfo, loadSlackWebhookInfo, loadTelegramBots, loadDiscordWebhookInfo, loadWebhookEndpoints])

  return {
    config,
    channelStatus,
    deliveryStats,
    recentDeliveries,
    loading,
    error,
    isActive,
    webhookInfo,
    slackWebhookInfo,
    telegramBots,
    discordWebhookInfo,
    webhookEndpoints,
    orgId,
    currentOrg,
    // Actions
    handleSave,
    handleReset,
    updateChannel,
    updateSmtp,
    togglePriority,
    refresh,
    loadConfig,
    setConfig,
    // Forwarded service functions
    testTelegram,
    testSlack,
    testEmail,
    testWebhookChannel,
    registerTelegramWebhook,
    deactivateTelegramWebhook,
    getTelegramWebhookInfo: loadWebhookInfo,
    setWebhookInfo,
    registerSlackWebhook,
    deactivateSlackWebhook,
    getSlackWebhookInfo: loadSlackWebhookInfo,
    setSlackWebhookInfo,
    listTelegramBots: loadTelegramBots,
    setTelegramBots,
    registerDiscordWebhook,
    deactivateDiscordWebhook,
    getDiscordWebhookInfo: loadDiscordWebhookInfo,
    setDiscordWebhookInfo,
    listWebhookEndpoints: loadWebhookEndpoints,
    setWebhookEndpoints,
    createWebhookEndpoint,
    updateWebhookEndpoint,
    deleteWebhookEndpoint
  }
}
