/**
 * VulcanView — the featured /vulcan shortcut and the GitQ Vulcan cockpit.
 *
 * "Vulcan" is the product/surface name; the underlying AGENT identity is
 * `forge` (the GitQ plugin's governed issue-triage agent, registry id 'github').
 * The page is a thin wrapper over the reusable AgentActivitySurface. GITQ
 * Stream A adds an Issues tab alongside the Activity history:
 *   - Issues: open issues across connected repos, each with a Send-to-Vulcan
 *     button that seeds the persistent chat for triage (data is server-gated on
 *     the 'github' entitlement, so an unlicensed org sees a Connect-GitQ state).
 * The Issues tab uses the githubClient service (which proxies through the
 * entitlement-gated collector), NOT the stripped GitHubPanel, so the free build
 * stays stripped. The Gripe pad lives at /gripe (GripeView) and hands gripes and
 * issues here through router state ({ vulcanSeed }).
 */

import { useRef, useCallback, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import AgentActivitySurface from '../../components/agents/AgentActivitySurface'
import GitQIssuesTab from '../../components/gitq/GitQIssuesTab'
import './views.css'

const VULCAN_AGENT_ID = 'forge'
const VULCAN_PURPLE = '#a855f7'

const VULCAN_SUGGESTIONS = [
  'Where did we leave off?',
  'What did you triage most recently?',
  'Which issues did you flag for me?',
  'Summarise your last session handoff.',
]

export default function VulcanView() {
  const chatHandleRef = useRef(null)
  const location = useLocation()
  const navigate = useNavigate()

  // Gripe page hand-off: /gripe navigates here with { vulcanSeed } in router
  // state. Send it once the persistent chat has mounted, then clear the state so
  // a refresh does not re-send it.
  useEffect(() => {
    const seed = location.state?.vulcanSeed
    if (!seed) return undefined
    let tries = 0
    const t = setInterval(() => {
      tries += 1
      if (chatHandleRef.current?.send) {
        clearInterval(t)
        chatHandleRef.current.send(seed)
        navigate(location.pathname, { replace: true, state: null })
      } else if (tries > 30) {
        clearInterval(t)
      }
    }, 100)
    return () => clearInterval(t)
  }, [location.state, location.pathname, navigate])

  // Send-to-Vulcan: inject a turn into the persistent chat sidebar. The chat is
  // always mounted on the right, so no tab switch is needed.
  const onSendToVulcan = useCallback((seed) => {
    if (seed) chatHandleRef.current?.send?.(seed)
  }, [])

  const tabs = [
    {
      id: 'issues',
      label: 'Issues',
      render: () => <GitQIssuesTab accent={VULCAN_PURPLE} onSendToVulcan={onSendToVulcan} />,
    },
  ]

  return (
    <AgentActivitySurface
      agentId={VULCAN_AGENT_ID}
      agentName="Vulcan"
      agentColor={VULCAN_PURPLE}
      agentRole="Issue triage"
      subtitle="GitQ's governed issue-triage agent: activity and open issues, wired to the chat"
      suggestions={VULCAN_SUGGESTIONS}
      tabs={tabs}
      chatHandleRef={chatHandleRef}
      emptyHint={<>No Vulcan activity yet. Attach a Vulcan CLI session and leave a handoff on detach, or send an issue over from the Issues tab.</>}
    />
  )
}
