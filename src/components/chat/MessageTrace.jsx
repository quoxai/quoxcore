/**
 * MessageTrace — collapsed AOCL waterfall attached to a chat message.
 *
 * AOCL-DISPATCH-B7: each assistant message stores the conversation corr
 * plus the timestamp WINDOW of its turn (turnStart/turnEnd). The trace
 * filters the conversation's envelopes to that window so each turn shows
 * ONLY its own layer envelopes, even though all turns share the same
 * conversation-level corr. This preserves Continue Conversation grouping
 * in Activity Log (single row per whole conversation) while still giving
 * per-message trace persistence.
 */
import { useMemo } from 'react'
import { useAoclLayerSteps } from '../../hooks/useAoclLayerSteps'
import { ThinkingDisplay } from './ThinkingDisplay'

export function MessageTrace({ corr, turnStart, turnEnd }) {
    if (!corr) return null
    return <MessageTraceInner corr={corr} turnStart={turnStart} turnEnd={turnEnd} />
}

function MessageTraceInner({ corr, turnStart, turnEnd }) {
    const steps = useAoclLayerSteps(corr, false, { turnStart, turnEnd })
    return useMemo(() => (
        <div className="message-trace">
            <ThinkingDisplay steps={steps} isActive={false} collapsed={true} />
        </div>
    ), [steps])
}

export default MessageTrace
