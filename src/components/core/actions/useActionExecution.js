/**
 * useActionExecution - Hook for executing SOC/NOC actions
 *
 * Provides:
 * - Action execution via /collector/chat (OAuth-compatible)
 * - AEE event logging for audit trail
 * - Action history management
 */

import { useState, useCallback, useRef } from 'react'
import { createChatQuery, createChatResponse, createError, prefixedUlid } from '../../../lib/aee'
import { storeEnvelopeSafe } from '../../../services/aeeStatusService'
import { getRuntimeAssistantConfig } from '../../../services/entityRegistry'
import { DEFAULT_LLM_CONFIG } from '../../../services/llmService'

const COLLECTOR_URL = '/collector'

/**
 * Render a structured tool-execution result into a readable, DETERMINISTIC
 * text block (no LLM). Handles the common `{ <arrayKey>: [...] }` tool shapes
 * (containers, certificates, events, monitors…) and falls back to a summary
 * field or compact JSON. Same input → same output, every time.
 */
export function formatToolResult(result) {
    if (result == null) return 'No data returned.'
    if (typeof result === 'string') return result
    if (result.success === false) return `Error: ${result.error || 'tool execution failed'}`

    const arrKey = ['containers', 'certificates', 'certs', 'events', 'results', 'items', 'monitors', 'alerts', 'hosts', 'data']
        .find(k => Array.isArray(result[k]))
    if (arrKey) {
        const arr = result[arrKey]
        const scope = result.hosts_queried ? ` across ${result.hosts_queried} host(s)` : ''
        const header = `${arr.length} ${arrKey}${scope}`
        if (arr.length === 0) return `${header} — nothing to report.`
        const lines = arr.slice(0, 60).map(item => {
            if (item && typeof item === 'object') {
                const name = item.name || item.domain || item.action || item.rule?.description || item.id || item.host || '(item)'
                const detail = item.status || item.image || item.expiry || item.expires_in || item.days_remaining || item.message || item.level || ''
                const host = item.host ? ` @${item.host}` : ''
                return `• ${name}${detail !== '' ? ` — ${detail}` : ''}${host}`
            }
            return `• ${String(item)}`
        })
        const more = arr.length > 60 ? `\n…and ${arr.length - 60} more` : ''
        return `${header}\n${lines.join('\n')}${more}`
    }

    if (result.message || result.summary || result.text) {
        return result.message || result.summary || result.text
    }
    return JSON.stringify(result, null, 2).slice(0, 2000)
}

/**
 * Hook for executing actions with AEE logging
 *
 * @param {Object} options
 * @param {string} options.source - Source identifier (e.g., 'soc', 'noc')
 * @param {string} options.assistant - Assistant to use (default: 'quox')
 * @param {number} options.maxHistory - Max history items to keep (default: 10)
 * @returns {Object} Action execution state and methods
 */
export function useActionExecution({
    source = 'dashboard',
    assistant = 'quox',
    maxHistory = 10
} = {}) {
    const assistantLlm = getRuntimeAssistantConfig(assistant)?.llm || DEFAULT_LLM_CONFIG
    const [currentAction, setCurrentAction] = useState(null)
    const [actionHistory, setActionHistory] = useState([])
    const [executingActionId, setExecutingActionId] = useState(null)

    // Track active request for cancellation
    const abortControllerRef = useRef(null)

    /**
     * Execute an action via the OAuth-compatible chat endpoint
     */
    const executeAction = useCallback(async (action) => {
        // Cancel any existing request
        if (abortControllerRef.current) {
            abortControllerRef.current.abort()
        }

        const controller = new AbortController()
        abortControllerRef.current = controller

        const startTime = Date.now()
        const actionId = `${action.id}-${startTime}`
        const corr = prefixedUlid('ACTION')

        // Create initial action entry
        const actionEntry = {
            id: actionId,
            label: action.label,
            status: 'running',
            timestamp: startTime,
            thinkingSteps: [
                { id: `${actionId}_0`, agent: 'ROUTER', message: action.tool ? `Executing ${action.tool}...` : `Routing to ${assistant.toUpperCase()}...`, stage: 'routing' }
            ],
            streamedText: '',
            corr
        }

        setCurrentAction(actionEntry)
        setExecutingActionId(action.id)

        // Log AEE query event
        const queryEnvelope = createChatQuery(action.prompt, {
            agent: `agent.${assistant}`,
            user: `${source}.action`,
            corr,
            context: {
                actionId: action.id,
                actionLabel: action.label,
                source
            }
        })
        await storeEnvelopeSafe(queryEnvelope, `${source.toUpperCase()} Action: ${action.label}`)

        // Update to thinking state
        setCurrentAction(prev => prev ? {
            ...prev,
            status: 'thinking',
            thinkingSteps: [
                ...prev.thinkingSteps,
                { id: `${actionId}_1`, agent: assistant.toUpperCase(), message: 'Processing query...', stage: 'processing' }
            ],
            currentStep: 'Processing query...'
        } : null)

        // Deterministic path: when an action declares a real `tool`, call the
        // evidenced /api/v1/tools/execute endpoint directly (structured output,
        // VOLT+AEE+AOCL, no LLM). Reproducible: same action → same query, every
        // time. Actions without a `tool` keep the AI-assisted chat path below.
        if (action.tool) {
            try {
                const response = await fetch(`${COLLECTOR_URL}/api/v1/tools/execute`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ tool_name: action.tool, input: action.toolInput || {}, agent_id: assistant }),
                    signal: controller.signal,
                })
                if (!response.ok) {
                    const errorText = await response.text()
                    throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 200)}`)
                }
                const result = await response.json()
                const duration = Date.now() - startTime
                const formatted = formatToolResult(result)
                const ok = result?.success !== false
                const completedAction = {
                    id: actionId, label: action.label, status: ok ? 'success' : 'error',
                    timestamp: startTime, result: formatted, duration,
                    thinkingSteps: actionEntry.thinkingSteps, corr, deterministic: true, tool: action.tool,
                }
                const responseEnvelope = createChatResponse(queryEnvelope, formatted, {
                    duration, actionId: action.id, actionLabel: action.label, deterministic: true, tool: action.tool,
                })
                await storeEnvelopeSafe(responseEnvelope, `${source.toUpperCase()} Action Response: ${action.label}`)
                setCurrentAction(null)
                setActionHistory(prev => [completedAction, ...prev].slice(0, maxHistory))
                setExecutingActionId(null)
                abortControllerRef.current = null
                return
            } catch (err) {
                if (err.name === 'AbortError') return
                const duration = Date.now() - startTime
                const errorAction = {
                    id: actionId, label: action.label, status: 'error', timestamp: startTime,
                    result: err.message || 'Tool execution failed', duration, corr, deterministic: true,
                }
                const errorEnvelope = createError(queryEnvelope, {
                    code: 'TOOL_EXEC_FAILED', message: err.message,
                    details: { actionId: action.id, actionLabel: action.label, tool: action.tool },
                })
                await storeEnvelopeSafe(errorEnvelope, `${source.toUpperCase()} Action Error: ${action.label}`)
                setCurrentAction(null)
                setActionHistory(prev => [errorAction, ...prev].slice(0, maxHistory))
                setExecutingActionId(null)
                abortControllerRef.current = null
                return
            }
        }

        try {
            // Use the OAuth-compatible collector chat endpoint
            const response = await fetch(`${COLLECTOR_URL}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    prompt: action.prompt,
                    selected_agent: assistant,
                    provider: assistantLlm.provider,
                    model: assistantLlm.model,
                    quox_context: `NOC action: ${action.label}. Source: ${source}. Action ID: ${action.id}.`,
                }),
                signal: controller.signal
            })

            if (!response.ok) {
                const errorText = await response.text()
                throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 200)}`)
            }

            const data = await response.json()
            const duration = Date.now() - startTime

            if (!data.success) {
                throw new Error(data.result || data.error || 'Action failed')
            }

            // Create completed action entry
            const completedAction = {
                id: actionId,
                label: action.label,
                status: 'success',
                timestamp: startTime,
                result: data.result,
                cost: data.cost_usd,
                duration,
                thinkingSteps: actionEntry.thinkingSteps,
                sessionId: data.session_id,
                corr
            }

            // Log AEE response event
            const responseEnvelope = createChatResponse(queryEnvelope, data.result, {
                duration,
                cost: data.cost_usd,
                actionId: action.id,
                actionLabel: action.label
            })
            await storeEnvelopeSafe(responseEnvelope, `${source.toUpperCase()} Action Response: ${action.label}`)

            setCurrentAction(null)
            setActionHistory(prev => [completedAction, ...prev].slice(0, maxHistory))
            setExecutingActionId(null)
            abortControllerRef.current = null

        } catch (err) {
            if (err.name === 'AbortError') {
                // Cancelled by user — handled in cancelAction
                return
            }

            const duration = Date.now() - startTime

            const errorAction = {
                id: actionId,
                label: action.label,
                status: 'error',
                timestamp: startTime,
                result: err.message || 'Unknown error occurred',
                duration,
                corr
            }

            // Log AEE error event
            const errorEnvelope = createError(queryEnvelope, {
                code: 'ACTION_FAILED',
                message: err.message,
                details: { actionId: action.id, actionLabel: action.label }
            })
            await storeEnvelopeSafe(errorEnvelope, `${source.toUpperCase()} Action Error: ${action.label}`)

            setCurrentAction(null)
            setActionHistory(prev => [errorAction, ...prev].slice(0, maxHistory))
            setExecutingActionId(null)
            abortControllerRef.current = null
        }
    }, [source, assistant, maxHistory, assistantLlm])

    /**
     * Cancel the current action
     */
    const cancelAction = useCallback(() => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort()
            abortControllerRef.current = null

            if (currentAction) {
                const cancelledAction = {
                    ...currentAction,
                    status: 'cancelled',
                    result: 'Action cancelled by user',
                    duration: Date.now() - currentAction.timestamp
                }
                setActionHistory(prev => [cancelledAction, ...prev].slice(0, maxHistory))
            }

            setCurrentAction(null)
            setExecutingActionId(null)
        }
    }, [currentAction, maxHistory])

    /**
     * Clear action history
     */
    const clearHistory = useCallback(() => {
        setActionHistory([])
    }, [])

    return {
        currentAction,
        actionHistory,
        executingActionId,
        executeAction,
        cancelAction,
        clearHistory
    }
}

export default useActionExecution
