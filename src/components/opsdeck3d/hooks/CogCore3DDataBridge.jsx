/**
 * CogCore3DDataBridge — Tiny component that calls useCogCore3DState
 * and passes the result up via onData callback.
 *
 * This exists as a separate file so it can be lazy-loaded AFTER
 * the R3F Canvas is established. Importing useCogCore3DState statically
 * into the CC3D view breaks R3F's reconciler due to module-level side
 * effects in the useOpsDeckState import chain.
 */
import { useEffect } from 'react'
import useCogCore3DState from './useCogCore3DState'

export default function CogCore3DDataBridge({ onData }) {
  const coreState = useCogCore3DState()

  useEffect(() => {
    onData(coreState)
  }, [
    coreState.agents, coreState.objectives, coreState.implants,
    coreState.memories, coreState.systemState, coreState.isLive, coreState.aeeEnvelopes,
    onData,
  ])

  return null // Renders nothing — just a data pipe
}
