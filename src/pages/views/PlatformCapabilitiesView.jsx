/**
 * PlatformCapabilitiesView — Platform Capabilities
 *
 * Phase 24 (owner hard rule #setecastronomy, 2026-08-05): "NO MORE .env ONLY
 * CONFIG. NO HIDDEN FEATURES WITHOUT VISIBILITY IN DASHBOARD." This view is
 * the read-only visibility surface for every environment flag that changes
 * product behaviour: current state, default, and which service reads it.
 *
 * READ-ONLY. There is no toggle here on purpose — turning a runtime setting
 * into something that overrides an env default is an architectural change
 * (needs a settings-store design) and is scoped to a later phase.
 *
 * Data: GET /collector/api/v1/platform/capabilities
 * (services/collector/lib/platformCapabilities.js is the source registry)
 *
 * Route: /platform-capabilities
 */

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import GovernancePageLayout from '../../components/compliance/GovernancePageLayout'
import { COLORS, GlassPanel, GlassButton, GlassPill, M, F } from '../../components/compliance/glass-primitives'
// VAULT-INTEG P17: this view was read-only-by-design (Phase 24) before the
// Phase 25 write path existed. QUOXCHAT_EMBED_PROVIDER (plus the older
// GEMINI_CLI_TIMEOUT/PERPLEXITY_TIMEOUT tool-timeout entries) share the
// registry's 'integrations' group with TELEGRAM_DEFAULT_AGENT (now homed in
// Settings > Notifications), but have no owning product page of their own —
// this is the documented fallback ("extend the platform flags panel page")
// for settable entries that don't fit an existing settings surface.
import PlatformFlagsPanel from '../../components/settings/PlatformFlagsPanel'
import '../../components/settings/settings.css'
import '../../components/ui/ui.css'

// VAULT-INTEG P17: settable entries with no dedicated settings page yet.
// Keyed explicitly (not the whole 'integrations' group) because
// TELEGRAM_DEFAULT_AGENT in that same group already has a home in
// Settings > Notifications — showing it twice would be confusing, not
// findable.
// VAULT-INTEG P17 (auth + quoxbrain configResolvers slice): four more
// settable entries with no dedicated settings page — BACKUP_* have no
// existing backup-settings surface at all, and MATRIX_ROOMS shares the
// 'integrations' group with TELEGRAM_DEFAULT_AGENT (already homed
// elsewhere), same "don't show it twice" reasoning as that entry above.
const UNPLACED_SETTABLE_KEYS = [
  'QUOXCHAT_EMBED_PROVIDER', 'GEMINI_CLI_TIMEOUT', 'PERPLEXITY_TIMEOUT',
  'MATRIX_ROOMS', 'BACKUP_SCHEDULER_INTERVAL_MS', 'BACKUP_STALE_MINUTES', 'BACKUP_TIMEOUT_MS',
  'QUOX_MAX_SPLINTERS',
  'MCP_INVOKE_TIMEOUT_MS', 'POWERS_BUILD_TIMEOUT_MS', 'QUOX_VOLT_MAX_EVENTS_PER_RUN',
  'REAPER_INTERVAL_MS', 'REAPER_STALE_DECOMPOSED_MS', 'REAPER_STUCK_RUNNING_MS',
  'SCHEDULER_POLL_MS', 'SCREENCAP_RUN_DEADLINE_MS', 'SERVICE_HEALTH_CHECK_INTERVAL_MS',
  'WARD_S3_RETENTION_DAYS',
  'ALERTMANAGER_URL', // quox#1061: Alertmanager base URL for the alerts tools
]

const GROUPS = [
  {
    id: 'user',
    label: 'User-Relevant',
    description: 'Deserves its own Settings surface eventually, so an org admin can change it without a redeploy. Read-only here for now.',
  },
  {
    id: 'operator',
    label: 'Operator-Relevant',
    description: 'Visibility only — rollout modes, security posture, and infra behaviour switches operators should be able to see at a glance.',
  },
]

function CapabilityRow({ cap }) {
  return (
    <GlassPanel style={{ padding: '12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: '1 1 260px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: F, fontSize: 13, fontWeight: 700, color: '#fff' }}>{cap.name}</span>
            <span style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText }}>{cap.key}</span>
          </div>
          <p style={{ fontFamily: F, fontSize: 11.5, color: COLORS.dimText, lineHeight: 1.5, margin: '4px 0 0' }}>
            {cap.description}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText }}>
            default {cap.default}
          </span>
          <GlassPill color={COLORS.subtleText}>{cap.service}</GlassPill>
          <GlassPill color={cap.on ? COLORS.green : COLORS.dimText}>
            {cap.on ? 'ON' : 'OFF'}
          </GlassPill>
        </div>
      </div>
    </GlassPanel>
  )
}

export default function PlatformCapabilitiesView() {
  const { authFetch } = useAuth()
  const [capabilities, setCapabilities] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    authFetch('/collector/api/v1/platform/capabilities')
      .then(r => r.json())
      .then(d => setCapabilities(d.capabilities || []))
      .catch(e => setError(String(e?.message || e)))
      .finally(() => setLoading(false))
  }, [authFetch])

  useEffect(() => { load() }, [load])

  const onCount = capabilities.filter(c => c.on).length

  return (
    <GovernancePageLayout
      title="Platform Capabilities"
      subtitle="Every product-behaviour flag: current state, default, and which service reads it"
      statusPill={loading ? null : { label: `${onCount}/${capabilities.length} ON`, color: COLORS.cyan }}
      crumbs={[{ label: 'System', to: '/system' }, { label: 'Platform Capabilities' }]}
      actions={<GlassButton size="sm" onClick={load}>Refresh</GlassButton>}
    >
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 20,
        minHeight: 0, overflowY: 'auto', padding: '4px 4px 16px',
      }}>
        <GlassPanel style={{ padding: 18 }}>
          <p style={{ fontFamily: F, fontSize: 13, color: '#fff', lineHeight: 1.6, margin: 0 }}>
            Every feature flag that changes product behaviour, in one place: its current state,
            its shipped default, and the service that reads it. This surface is read-only —
            changing a flag still means editing the environment and redeploying that service.
          </p>
        </GlassPanel>

        {error && (
          <GlassPanel highlight={COLORS.red} style={{ padding: 12 }}>
            <span style={{ fontFamily: M, fontSize: 11, color: COLORS.red }}>
              Capabilities unavailable: {error}
            </span>
          </GlassPanel>
        )}

        {/* VAULT-INTEG P17: the write surface for settable entries that
            don't have an owning settings page (see UNPLACED_SETTABLE_KEYS
            comment above) — everything else on this page stays read-only. */}
        <PlatformFlagsPanel
          keys={UNPLACED_SETTABLE_KEYS}
          title="Settable, Not Yet Homed"
          subtitle="Settable platform settings with no dedicated settings page yet — changeable here so they stay findable"
          authFetch={authFetch}
        />

        {loading ? (
          <GlassPanel style={{ padding: 24, textAlign: 'center' }}>
            <span style={{ fontFamily: M, fontSize: 11, color: COLORS.dimText }}>Loading capabilities…</span>
          </GlassPanel>
        ) : capabilities.length === 0 ? (
          <GlassPanel style={{ padding: 24, textAlign: 'center' }}>
            <span style={{ fontFamily: M, fontSize: 12, color: COLORS.dimText }}>
              No capabilities registered yet.
            </span>
          </GlassPanel>
        ) : (
          GROUPS.map(group => {
            const rows = capabilities.filter(c => c.classification === group.id)
            if (rows.length === 0) return null
            return (
              <div key={group.id}>
                <h2 style={{
                  fontFamily: M, fontSize: 11, fontWeight: 700, letterSpacing: 1.2,
                  textTransform: 'uppercase', color: COLORS.dimText, margin: '0 0 4px',
                }}>
                  {group.label} ({rows.length})
                </h2>
                <p style={{ fontFamily: F, fontSize: 11, color: COLORS.subtleText, margin: '0 0 8px' }}>
                  {group.description}
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {rows.map(cap => <CapabilityRow key={cap.key} cap={cap} />)}
                </div>
              </div>
            )
          })
        )}
      </div>
    </GovernancePageLayout>
  )
}
