/**
 * KeeperChatSidebar — thin wrapper around AgentChatSidebar.
 */

import { useCallback } from 'react'
import AgentChatSidebar from '../chat/AgentChatSidebar'

const SUGGESTIONS = [
  'What is my backup status?',
  'When was the last successful backup?',
  'Is there an update available?',
  'Create a full system backup',
  'Walk me through restoring from a backup',
  'Set up a daily backup schedule',
  'Show the maintenance audit log',
  'Check system version',
]

export function KeeperChatSidebar({ backups, schedules, components, updateStatus, selectedBackup, collapsed, onToggle }) {
  const contextBuilder = useCallback(async () => {
    const totalBackups = backups?.length || 0
    const completedBackups = backups?.filter(b => b.status === 'completed' || b.status === 'verified') || []
    const failedBackups = backups?.filter(b => b.status === 'failed') || []
    const lastBackup = completedBackups[0]
    const activeSchedules = schedules?.filter(s => s.enabled) || []
    const totalComponents = components?.length || 0
    const summary = [
      { label: 'Successful backups', value: `${completedBackups.length}/${totalBackups}` },
      { label: 'Failed backups', value: failedBackups.length },
      { label: 'Active schedules', value: activeSchedules.length },
      { label: 'Backup components', value: totalComponents },
    ]
    const evidence = []

    if (lastBackup) {
      summary.push({
        label: 'Last successful backup',
        value: new Date(lastBackup.completed_at || lastBackup.created_at).toLocaleString()
      })
      evidence.push({
        label: `Last backup ${lastBackup.name || lastBackup.id || 'recent'}`,
        text: [
          lastBackup.backup_type || 'full',
          lastBackup.status,
          lastBackup.archive_size_bytes ? `${(lastBackup.archive_size_bytes / 1024 / 1024).toFixed(1)} MB` : null,
          lastBackup.duration_ms ? `${(lastBackup.duration_ms / 1000).toFixed(1)}s` : null,
        ].filter(Boolean).join(' • ')
      })
    }

    if (updateStatus) {
      summary.push({ label: 'Current version', value: updateStatus.current_version || 'Unknown' })
      summary.push({
        label: 'Update status',
        value: updateStatus.update_available ? `Update available: ${updateStatus.available_version}` : 'Up to date'
      })
      if (updateStatus.last_checked) {
        summary.push({ label: 'Last checked', value: new Date(updateStatus.last_checked).toLocaleString() })
      }
    } else {
      summary.push({ label: 'Update status', value: 'Not available' })
    }

    failedBackups.slice(0, 3).forEach((b) => {
      evidence.push({
        label: b.name || b.id || 'Backup failure',
        text: `${b.error_message || 'Unknown error'} • ${new Date(b.created_at).toLocaleDateString()}`
      })
    })

    if (selectedBackup) {
      let componentCount = null
      if (selectedBackup.components_json) {
        try {
          componentCount = JSON.parse(selectedBackup.components_json)?.length || null
        } catch {
          componentCount = null
        }
      }
      evidence.unshift({
        label: `Focused backup ${selectedBackup.name || selectedBackup.id}`,
        text: [
          selectedBackup.backup_type || 'full',
          selectedBackup.status,
          new Date(selectedBackup.created_at).toLocaleString(),
          componentCount != null ? `${componentCount} components` : null,
          selectedBackup.error_message || null,
        ].filter(Boolean).join(' • ')
      })
    }

    return {
      surface: 'sidebar',
      page: 'Backup & Recovery',
      panel: 'KEEPER continuity sidebar',
      focus: selectedBackup
        ? {
            type: 'Backup archive',
            label: selectedBackup.name || selectedBackup.id,
            id: selectedBackup.id,
            detail: `${selectedBackup.backup_type || 'full'} • ${selectedBackup.status}`
          }
        : {
            type: 'Continuity overview',
            label: 'Backup and update posture',
            detail: `${completedBackups.length} successful backups • ${activeSchedules.length} active schedules`
          },
      summary,
      evidenceTitle: selectedBackup ? 'Focused backup and continuity signals' : 'Continuity signals',
      evidence,
      instructions: ['You are KEEPER, the system continuity specialist. Help the user manage backups, restores, updates, and migrations. Always explain what you will do before doing it. Use DEFCON levels (GREEN/AMBER/RED) when reporting status.'],
    }
  }, [backups, schedules, components, updateStatus, selectedBackup])

  return (
    <AgentChatSidebar
      agentId="keeper"
      agentName="KEEPER"
      agentColor="#a78bfa"
      agentRole="Continuity"
      contextBuilder={contextBuilder}
      suggestions={SUGGESTIONS}
      collapsed={collapsed}
      onToggle={onToggle}
      placeholder="Ask KEEPER..."
      sessionPrefix="KEEPER_CHAT"
    />
  )
}

export default KeeperChatSidebar
