/**
 * BackupChatSidebar — thin wrapper around AgentChatSidebar.
 */

import { useCallback } from 'react'
import AgentChatSidebar from '../chat/AgentChatSidebar'

const SUGGESTIONS = [
  'What is my current backup status?',
  'When was the last successful backup?',
  'Walk me through restoring from a backup',
  'Are there any components not being backed up?',
  'Help me set up a backup schedule',
]

export function BackupChatSidebar({ backups, schedules, components, selectedBackup, collapsed, onToggle }) {
  const contextBuilder = useCallback(async () => {
    const totalBackups = backups?.length || 0
    const completedBackups = backups?.filter(b => b.status === 'completed' || b.status === 'verified') || []
    const failedBackups = backups?.filter(b => b.status === 'failed') || []
    const lastBackup = completedBackups[0]
    const activeSchedules = schedules?.filter(s => s.enabled) || []
    const totalComponents = components?.length || 0

    const lines = [
      `## Backup & Recovery Context`,
      `- **Total backups:** ${totalBackups} (${completedBackups.length} successful, ${failedBackups.length} failed)`,
      `- **Last successful backup:** ${lastBackup ? new Date(lastBackup.completed_at || lastBackup.created_at).toLocaleString() : 'Never'}`,
      `- **Active schedules:** ${activeSchedules.length}`,
      `- **Backup components:** ${totalComponents}`,
    ]

    if (lastBackup) {
      lines.push('')
      lines.push(`### Last Backup`)
      lines.push(`- Type: ${lastBackup.backup_type || 'full'}`)
      lines.push(`- Status: ${lastBackup.status}`)
      if (lastBackup.archive_size_bytes) {
        lines.push(`- Size: ${(lastBackup.archive_size_bytes / 1024 / 1024).toFixed(1)} MB`)
      }
      if (lastBackup.duration_ms) {
        lines.push(`- Duration: ${(lastBackup.duration_ms / 1000).toFixed(0)}s`)
      }
    }

    if (selectedBackup) {
      lines.push('')
      lines.push(`### Currently Selected Backup`)
      lines.push(`- ID: ${selectedBackup.id}`)
      lines.push(`- Type: ${selectedBackup.backup_type}`)
      lines.push(`- Status: ${selectedBackup.status}`)
      lines.push(`- Created: ${new Date(selectedBackup.created_at).toLocaleString()}`)
      if (selectedBackup.error_message) {
        lines.push(`- Error: ${selectedBackup.error_message}`)
      }
    }

    if (failedBackups.length > 0) {
      lines.push('')
      lines.push(`### Recent Failures`)
      for (const f of failedBackups.slice(0, 3)) {
        lines.push(`- ${new Date(f.created_at).toLocaleDateString()}: ${f.error_message || 'Unknown error'}`)
      }
    }

    lines.push('')
    lines.push(`You are DAEDALUS, the DevOps and automation specialist. You are assisting the operator with backup, restore, and migration operations. Be calm, confident, and reassuring. Guide them step by step through any restore or migration — make it feel safe and easy. Use concise, actionable language. If they ask about restoring, always recommend a dry run first.`)

    return lines.join('\n')
  }, [backups, schedules, components, selectedBackup])

  return (
    <AgentChatSidebar
      agentId="nova"
      agentName="DAEDALUS"
      agentColor="#30ff90"
      agentRole="Backup & Recovery"
      contextBuilder={contextBuilder}
      suggestions={SUGGESTIONS}
      collapsed={collapsed}
      onToggle={onToggle}
      placeholder="Ask DAEDALUS about backups..."
      sessionPrefix="BACKUP_NOVA_CHAT"
    />
  )
}

export default BackupChatSidebar
