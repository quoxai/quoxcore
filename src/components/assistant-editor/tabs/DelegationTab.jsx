/**
 * DelegationTab — Delegation targets, direct reports, capabilities
 * Extracted from AssistantEditor.jsx (AUX-1: zero functional change)
 */

import { agentRegistry } from '../../../config/agentRegistry'

export default function DelegationTab({ registryEntry }) {
  return (
    <div className="editor-section">
      <div className="tools-section">
        <h3 className="section-label">Delegation Targets</h3>
        <p className="section-desc">Agents this assistant can delegate tasks to. Routing is handled by the delegation engine.</p>
        {registryEntry.canDelegateTo?.length > 0 ? (
          <div className="delegation-grid">
            {registryEntry.canDelegateTo.map(agentId => {
              const agentDef = agentRegistry.agents?.[agentId]
              return (
                <div key={agentId} className="delegation-target">
                  <span className="delegation-target__name">{agentDef?.name || agentId}</span>
                  <span className="delegation-target__domain">{agentDef?.domain || ''}</span>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="empty-state-small">No delegation targets configured</div>
        )}
      </div>

      {registryEntry.manages?.length > 0 && (
        <div className="tools-section" style={{ marginTop: 20 }}>
          <h3 className="section-label">Direct Reports</h3>
          <p className="section-desc">Agents that report directly to this assistant.</p>
          <div className="delegation-grid">
            {registryEntry.manages.map(agentId => {
              const agentDef = agentRegistry.agents?.[agentId]
              return (
                <div key={agentId} className="delegation-target">
                  <span className="delegation-target__name">{agentDef?.name || agentId}</span>
                  <span className="delegation-target__domain">{agentDef?.domain || ''}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {registryEntry.capabilities?.length > 0 && (
        <div className="tools-section" style={{ marginTop: 20 }}>
          <h3 className="section-label">Capabilities</h3>
          <div className="tool-grid">
            {registryEntry.capabilities.map(cap => (
              <div key={cap} className="tool-chip tool-chip--cap">
                <span className="tool-chip__name">{cap}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
