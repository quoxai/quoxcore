/**
 * useWorkflowChat — Freeform AI chat for the workflow builder.
 *
 * Sends messages through the collector chat pipeline with the workflow builder
 * system prompt, parses structured actions from assistant responses, and
 * executes them against the workflow builder state.
 */

import { useState, useCallback, useRef } from 'react'
import { getSystemPrompt } from '../services/workflowBuilderPrompt'
import { parseActions, executeActions, buildWorkflowContext } from '../services/workflowActions'

/**
 * @param {object} builder - Return value from useWorkflowBuilder()
 */
export function useWorkflowChat(builder) {
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const abortRef = useRef(null)

  // Add a message to the conversation
  const addMessage = useCallback((role, content, meta = {}) => {
    const msg = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role,
      content,
      timestamp: new Date().toISOString(),
      ...meta,
    }
    setMessages(prev => [...prev, msg])
    return msg
  }, [])

  // Send a message via the collector pipeline
  const sendMessage = useCallback(async (text) => {
    if (!text.trim() || loading) return

    setError(null)
    addMessage('user', text)
    setLoading(true)

    // Build context-aware system prompt
    const workflowContext = buildWorkflowContext(builder)
    const systemPrompt = getSystemPrompt(workflowContext)

    // Build conversation history for the collector chat request (last 20 messages max)
    const recentMessages = [...messages.slice(-18), { role: 'user', content: text }]
    const chatMessages = recentMessages.map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }))

    try {
      abortRef.current = new AbortController()

      const response = await fetch('/collector/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          messages: chatMessages,
          system: systemPrompt,
          context: 'workflow-builder',
        }),
      })

      if (!response.ok) {
        throw new Error(`Chat request failed: ${response.status}`)
      }

      const data = await response.json()
      const rawText = data.result || data.response || data.text || ''

      if (!rawText) {
        throw new Error('Empty response from assistant')
      }

      // Parse actions from Claude's response
      const { actions, cleanText } = parseActions(rawText)

      // Execute any workflow actions
      let actionSummary = null
      if (actions.length > 0) {
        const result = executeActions(actions, builder)
        actionSummary = {
          applied: result.applied,
          errors: result.errors,
          actions: actions.map(a => a.type),
        }
      }

      // Add assistant message (cleaned of action blocks)
      addMessage('assistant', cleanText || 'Done.', {
        actions: actionSummary,
        raw: rawText,
      })
    } catch (err) {
      if (err.name === 'AbortError') return
      setError(err.message)
      addMessage('assistant', `Something went wrong: ${err.message}. Try again or rephrase your request.`, {
        isError: true,
      })
    } finally {
      setLoading(false)
      abortRef.current = null
    }
  }, [loading, messages, builder, addMessage])

  // Cancel in-flight request
  const cancel = useCallback(() => {
    abortRef.current?.abort()
    setLoading(false)
  }, [])

  // Clear conversation
  const clearChat = useCallback(() => {
    setMessages([])
    setError(null)
  }, [])

  // Seed conversation with a greeting
  const greet = useCallback((text) => {
    if (messages.length === 0) {
      addMessage('assistant', text)
    }
  }, [messages.length, addMessage])

  return {
    messages,
    loading,
    error,
    sendMessage,
    cancel,
    clearChat,
    addMessage,
    greet,
  }
}

export default useWorkflowChat
