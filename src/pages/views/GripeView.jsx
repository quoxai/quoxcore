/**
 * GripeView: /gripe. File a one-liner as a GitHub issue from the dashboard,
 * through the governed POST /github/issues (policy, entitlement, rate limit,
 * vault credential, approval gate). The GRIPE agent sits in the right sidebar
 * for the conversational route. Built on AgentActivitySurface like /vulcan.
 */
import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AgentActivitySurface from '../../components/agents/AgentActivitySurface'
import GripePad from '../../components/gripe/GripePad'
import GripeRecent from '../../components/gripe/GripeRecent'
import LicenceGate from '../../components/plugins/LicenceGate'
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed'
import './views.css'

const GRIPE_AGENT_ID = 'gripe'
const GRIPE_COLOR = '#ff6b35'

const GRIPE_SUGGESTIONS = [
  'File a gripe: the sidebar tooltip clips on resize',
  'Which repo should a pricing page typo go to?',
  'What labels can I use?',
]

export default function GripeView() {
  const diag = usePluginLicenseDiagnosis('gripe')
  const chatHandleRef = useRef(null)
  const navigate = useNavigate()
  const [refreshKey, setRefreshKey] = useState(0)

  const onSendToVulcan = useCallback((seed) => {
    if (seed) navigate('/vulcan', { state: { vulcanSeed: seed } })
  }, [navigate])

  if (!diag.licensed && diag.code !== 'loading') {
    return <LicenceGate diag={diag} displayName="Gripe" locked={<div className="qx-view"><div className="qx-card">{diag.detail || 'Gripe is not available for this organisation.'}</div></div>} />
  }

  const tabs = [
    {
      id: 'gripe',
      label: 'Gripe',
      render: () => (
        <div className="qx-stack">
          <GripePad onFiled={() => setRefreshKey((k) => k + 1)} onSendToVulcan={onSendToVulcan} />
          <GripeRecent refreshKey={refreshKey} onSendToVulcan={onSendToVulcan} />
        </div>
      ),
    },
  ]

  return (
    <AgentActivitySurface
      agentId={GRIPE_AGENT_ID}
      agentName="Gripe"
      agentColor={GRIPE_COLOR}
      agentRole="Issue filer"
      subtitle="One line in, a filed GitHub issue out, through the governed GitHub proxy"
      suggestions={GRIPE_SUGGESTIONS}
      tabs={tabs}
      defaultTab="gripe"
      chatHandleRef={chatHandleRef}
      emptyHint={<>No Gripe agent activity yet. File a gripe from the pad, or chat with Gripe on the right.</>}
    />
  )
}
