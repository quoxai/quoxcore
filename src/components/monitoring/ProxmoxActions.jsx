/**
 * ProxmoxActions — Quick actions sidebar for VM lifecycle + cluster ops + alerts.
 *
 * Uses useActionExecution for streaming execution and ActionResultsPanel
 * for output display. Three sections: VM Actions (contextual), Cluster Ops
 * (always visible), and Alert Rules (collapsible).
 */

import { useState, useMemo } from 'react'
import { useActionExecution } from '../core/actions/useActionExecution'
import { ActionResultsPanel } from '../core/actions/ActionResultsPanel'
import { ProxmoxAlertConfig } from './ProxmoxAlertConfig'
import { buildVMActions } from './vmActions'
import './proxmox-actions.css'

function ActionButton({ action, onClick, disabled, executing }) {
  const isRunning = executing === action.id
  return (
    <button
      className={`pxa-btn ${isRunning ? 'pxa-btn--running' : ''} ${action.danger ? 'pxa-btn--danger' : ''}`}
      onClick={() => onClick(action)}
      disabled={disabled || isRunning}
      title={action.description}
    >
      <span className="pxa-btn__icon">{action.icon}</span>
      <span className="pxa-btn__label">{action.label}</span>
    </button>
  )
}

export function ProxmoxActions({ selectedVM, cluster, onDiagnose }) {
  const {
    currentAction,
    actionHistory,
    executingActionId,
    executeAction,
    cancelAction,
    clearHistory
  } = useActionExecution({ source: 'proxmox', assistant: 'atlas' })

  const [alertsCollapsed, setAlertsCollapsed] = useState(true)

  // Diagnose opens the VM Doctor panel; every other action runs through the chat action flow.
  const runAction = (action) => {
    if (action.id === 'vm-diagnose' && onDiagnose && selectedVM) { onDiagnose(selectedVM); return }
    executeAction(action)
  }

  // VM actions — contextual to selected VM (using shared builder)
  const vmActions = useMemo(() => {
    if (!selectedVM) return []
    const actions = buildVMActions(selectedVM)
    // Add display name prefix for sidebar (context menu uses short labels)
    const displayName = selectedVM.name || `${selectedVM.type === 'lxc' ? 'CT' : 'VM'} ${selectedVM.vmid}`
    return actions.map(a => ({
      ...a,
      label: a.id === 'vm-start' ? `Start ${displayName}`
        : a.id === 'vm-stop' ? `Stop ${displayName}`
        : a.id === 'vm-restart' ? `Restart ${displayName}`
        : a.id === 'vm-snapshot' ? 'Create Snapshot'
        : a.id === 'vm-status' ? 'Detailed Status'
        : a.id === 'vm-diagnose' ? 'Diagnose (why is it slow?)'
        : a.label,
    }))
  }, [selectedVM])

  // Cluster ops — always visible
  const clusterActions = useMemo(() => [
    {
      id: 'cluster-health',
      icon: '♥',
      label: 'Cluster Health',
      description: 'Check overall cluster health and quorum',
      prompt: 'Check the Proxmox cluster health. Show node status, quorum, and any warnings. Use proxmox_cluster_status tool.',
    },
    {
      id: 'cluster-storage',
      icon: '◫',
      label: 'Storage Overview',
      description: 'Show storage pools and usage',
      prompt: 'Show Proxmox storage overview. List all storage pools with usage percentages. Flag any pools above 80% usage. Use proxmox_storage tool.',
    },
    {
      id: 'cluster-nodes',
      icon: '⊞',
      label: 'Node Resources',
      description: 'Show per-node resource usage',
      prompt: 'Show resource usage for each Proxmox node. Include CPU, memory, load average, and uptime for every node in the cluster.',
    },
    {
      id: 'cluster-backups',
      icon: '⬒',
      label: 'Recent Backups',
      description: 'List recent backup tasks',
      prompt: 'List recent backup tasks from the Proxmox cluster. Show which VMs/containers were backed up, when, and whether they succeeded.',
    },
  ], [])

  const isExecuting = !!executingActionId

  return (
    <div className="pxa">
      {/* VM Actions — contextual */}
      <div className="pxa-section">
        <div className="pxa-section__title">
          {selectedVM ? (
            <>
              <span className="pxa-section__icon">◆</span>
              VM Actions
            </>
          ) : (
            <>
              <span className="pxa-section__icon" style={{ opacity: 0.3 }}>◇</span>
              <span style={{ color: 'rgba(255,255,255,0.3)' }}>Select a guest</span>
            </>
          )}
        </div>
        {selectedVM && (
          <div className="pxa-section__meta">
            {selectedVM.name || selectedVM.vmid} · {selectedVM.node}
          </div>
        )}
        <div className="pxa-btn-group">
          {vmActions.map(action => (
            <ActionButton
              key={action.id}
              action={action}
              onClick={runAction}
              disabled={isExecuting}
              executing={executingActionId}
            />
          ))}
          {!selectedVM && (
            <div className="pxa-empty-hint">Click a row in the table to see actions</div>
          )}
        </div>
      </div>

      {/* Cluster Ops — always visible */}
      <div className="pxa-section">
        <div className="pxa-section__title">
          <span className="pxa-section__icon">⊕</span>
          Cluster Ops
        </div>
        <div className="pxa-btn-group">
          {clusterActions.map(action => (
            <ActionButton
              key={action.id}
              action={action}
              onClick={executeAction}
              disabled={isExecuting}
              executing={executingActionId}
            />
          ))}
        </div>
      </div>

      {/* Alert Rules */}
      <ProxmoxAlertConfig
        collapsed={alertsCollapsed}
        onToggleCollapsed={() => setAlertsCollapsed(c => !c)}
      />

      {/* Results */}
      <div className="pxa-results">
        <ActionResultsPanel
          currentAction={currentAction}
          history={actionHistory}
          onClearHistory={clearHistory}
          onCancelAction={cancelAction}
        />
      </div>
    </div>
  )
}

export default ProxmoxActions
