/**
 * YouTubeView — YouTube plugin dashboard.
 *
 * License-gated with two tabs: Dashboard (4 panels) and YouTube Agent (full chat).
 * Uses pluginConfigStorage for org-scoped config.
 * Mirrors LinkedInView patterns exactly.
 */

import { useState, useCallback, useEffect } from 'react'
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed'
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice'
import { getPluginConfig, savePluginConfig } from '../../services/pluginConfigStorage'
import * as youtube from '../../services/youtubeClient'
import ChannelOverviewPanel from '../../components/youtube/ChannelOverviewPanel'
import VideoListPanel from '../../components/youtube/VideoListPanel'
import UploadPanel from '../../components/youtube/UploadPanel'
import AnalyticsPanel from '../../components/youtube/AnalyticsPanel'
import CommentPanel from '../../components/youtube/CommentPanel'
import { YouTubeChatSidebar } from '../../components/youtube/YouTubeChatSidebar'
import YouTubeSetupWizard from '../../components/youtube/YouTubeSetupWizard'
import './YouTubeView.css'

// YouTube icon — play button in rounded rectangle, explicit fill, no currentColor
const YouTubeIcon = ({ size = 22 }) => (
  <svg viewBox="0 0 24 24" fill="none" style={{ width: size, height: size }}>
    <rect x="2" y="4" width="20" height="16" rx="4" stroke="rgba(255, 0, 0, 0.85)" strokeWidth="1.8"/>
    <path d="M10 8.5v7l6-3.5-6-3.5z" style={{ fill: 'rgba(255, 0, 0, 0.9)' }}/>
  </svg>
)

// ─── useYouTubeData Hook (inline) ─────────────────────────
function useYouTubeData(channelId) {
  const [channel, setChannel] = useState(null)
  const [videos, setVideos] = useState([])
  const [analytics, setAnalytics] = useState(null)
  const [comments, setComments] = useState([])
  const [credentialHealth, setCredentialHealth] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refreshChannel = useCallback(async () => {
    if (!channelId) return
    try {
      const result = await youtube.getChannel(channelId)
      setChannel(result || null)
    } catch (err) {
      console.warn('[YouTube] Failed to load channel:', err.message)
      setError(err.message)
    }
  }, [channelId])

  const refreshVideos = useCallback(async () => {
    if (!channelId) return
    try {
      const result = await youtube.listVideos(20)
      setVideos(result || [])
    } catch (err) {
      console.warn('[YouTube] Failed to load videos:', err.message)
    }
  }, [channelId])

  const refreshAnalytics = useCallback(async (days = 28) => {
    if (!channelId) return
    try {
      const end = new Date()
      const start = new Date()
      start.setDate(start.getDate() - days)
      const result = await youtube.getAnalytics({
        videoId: channelId,
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10),
        metrics: ['views', 'watchTime', 'averageDuration', 'subscribersGained'],
      })
      setAnalytics(result || null)
    } catch (err) {
      console.warn('[YouTube] Failed to load analytics:', err.message)
    }
  }, [channelId])

  const refreshComments = useCallback(async () => {
    if (!channelId) return
    try {
      // Get comments for the channel's recent videos
      const result = await youtube.getComments(channelId, 30)
      setComments(result || [])
    } catch (err) {
      console.warn('[YouTube] Failed to load comments:', err.message)
    }
  }, [channelId])

  const checkHealth = useCallback(async () => {
    const health = await youtube.checkCredentialHealth()
    setCredentialHealth(health)
  }, [])

  const refreshAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      await checkHealth()
      await refreshChannel()
      await refreshVideos()
      await refreshAnalytics()
      await refreshComments()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [checkHealth, refreshChannel, refreshVideos, refreshAnalytics, refreshComments])

  useEffect(() => {
    refreshAll()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    channel,
    videos,
    analytics,
    comments,
    credentialHealth,
    loading,
    error,
    refreshAll,
    refreshAnalytics,
    refreshComments,
  }
}

// ─── Error Boundary ──────────────────────────────────────────
import { Component } from 'react'

class YouTubeErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: '#f87171' }}>
          <h2>YouTube Plugin Error</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13, color: '#fbbf24' }}>
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

// ─── Main View ──────────────────────────────────────────────
function YouTubeViewInner() {
  const diag = usePluginLicenseDiagnosis('youtube')
  const licensed = diag.licensed

  // Plugin config via pluginConfigStorage (org-scoped, server-synced)
  const config = getPluginConfig('youtube')
  const channelId = config?.channelId || ''
  const defaultPrivacy = config?.defaultPrivacy || 'private'
  const defaultCategory = config?.defaultCategory || '28'

  const [activeTab, setActiveTab] = useState('dashboard')
  const [showChat, setShowChat] = useState(true)
  const [uploading, setUploading] = useState(false)

  const handleSaveConfig = useCallback((newConfig) => {
    savePluginConfig('youtube', newConfig)
    window.location.reload()
  }, [])

  const {
    channel,
    videos,
    analytics,
    comments,
    credentialHealth,
    loading,
    error,
    refreshAll,
    refreshAnalytics,
    refreshComments,
  } = useYouTubeData(channelId)

  const handleReply = useCallback(async (parentId, text) => {
    try {
      await youtube.replyComment(parentId, text)
      refreshComments()
    } catch (err) {
      console.error('[YouTube] Reply failed:', err.message)
    }
  }, [refreshComments])

  const handleModerate = useCallback(async (commentId, status) => {
    try {
      await youtube.moderateComment(commentId, status)
      refreshComments()
    } catch (err) {
      console.error('[YouTube] Moderation failed:', err.message)
    }
  }, [refreshComments])

  const handleUpload = useCallback(async (params) => {
    setUploading(true)
    try {
      const result = await youtube.uploadVideo(params)
      // Refresh videos after upload
      setTimeout(() => refreshAll(), 1500)
      return result
    } finally {
      setUploading(false)
    }
  }, [refreshAll])

  // ─── License gate ─────────────────────────────────
  if (!licensed) {
    return <PluginLicenseNotice diag={diag} displayName="YouTube Publisher" accentColor="#FF0000" />
  }

  // ─── Setup gate ───────────────────────────────────
  if (!channelId) {
    return (
      <div className="youtube-view">
        <div className="youtube-view__header">
          <div className="youtube-view__title-row">
            <YouTubeIcon />
            <h2 className="youtube-view__title">YouTube</h2>
          </div>
        </div>
        <YouTubeSetupWizard onComplete={handleSaveConfig} />
      </div>
    )
  }

  // ─── Main dashboard ───────────────────────────────
  return (
    <div className="youtube-view">
      <div className="youtube-view__header">
        <div className="youtube-view__title-row">
          <YouTubeIcon />
          <h2 className="youtube-view__title">YouTube</h2>

          {/* Tab switcher */}
          <div className="youtube-view__tabs">
            <button
              className={`youtube-view__tab ${activeTab === 'dashboard' ? 'youtube-view__tab--active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
            >
              {'\u{1F4CA}'} Dashboard
            </button>
            <button
              className={`youtube-view__tab ${activeTab === 'chat' ? 'youtube-view__tab--active' : ''}`}
              onClick={() => setActiveTab('chat')}
            >
              {'\u{1F4AC}'} YouTube Agent
            </button>
          </div>

          {error && <span className="youtube-view__error">{error}</span>}
        </div>
        <button className="youtube-view__refresh" onClick={refreshAll} disabled={loading}>
          {loading ? 'Refreshing...' : '\u21BB Refresh'}
        </button>
      </div>

      {activeTab === 'dashboard' && (
        <div className="youtube-view__layout">
          <div className={`youtube-view__grid ${showChat ? '' : 'youtube-view__grid--full'}`}>
            <div className="youtube-view__top">
              <ChannelOverviewPanel
                channel={channel}
                loading={loading}
                error={error}
                onRefresh={refreshAll}
              />
            </div>

            <div className="youtube-view__main">
              <div className="youtube-view__left">
                <VideoListPanel
                  videos={videos}
                  loading={loading}
                  error={error}
                  onSelectVideo={() => {}}
                  onRefresh={refreshAll}
                />
              </div>
              <div className="youtube-view__right">
                <UploadPanel
                  onUpload={handleUpload}
                  defaultPrivacy={defaultPrivacy}
                  defaultCategory={defaultCategory}
                  uploading={uploading}
                />
              </div>
            </div>

            <div className="youtube-view__bottom">
              <div className="youtube-view__left">
                <AnalyticsPanel
                  analytics={analytics}
                  loading={loading}
                  error={error}
                  onRefresh={() => refreshAnalytics()}
                  onPeriodChange={(days) => refreshAnalytics(days)}
                />
              </div>
              <div className="youtube-view__right">
                <CommentPanel
                  comments={comments}
                  loading={loading}
                  error={error}
                  onReply={handleReply}
                  onModerate={handleModerate}
                  onRefresh={refreshComments}
                />
              </div>
            </div>
          </div>

          {/* Collapsible chat sidebar on dashboard tab */}
          <div className={`youtube-view__chat-sidebar ${showChat ? '' : 'youtube-view__chat-sidebar--collapsed'}`}>
            <YouTubeChatSidebar
              channel={channel}
              videos={videos}
              credentialHealth={credentialHealth}
              config={config}
            />
          </div>

          <button
            className="youtube-view__chat-toggle"
            onClick={() => setShowChat(v => !v)}
            title={showChat ? 'Hide YouTube Agent' : 'Show YouTube Agent'}
          >
            {showChat ? '\u25A8' : '\u25A7'}
          </button>
        </div>
      )}

      {activeTab === 'chat' && (
        <div className="youtube-view__chat-full">
          <YouTubeChatSidebar
            channel={channel}
            videos={videos}
            credentialHealth={credentialHealth}
            config={config}
          />
        </div>
      )}
    </div>
  )
}

export default function YouTubeView() {
  return (
    <YouTubeErrorBoundary>
      <YouTubeViewInner />
    </YouTubeErrorBoundary>
  )
}
