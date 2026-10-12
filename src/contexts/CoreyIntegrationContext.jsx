/**
 * CoreyIntegrationContext
 *
 * Provides cross-tab communication between Topology and COREY tabs.
 * Allows sidebar quick actions to switch to COREY tab and send messages.
 */

import { createContext, useContext, useState, useRef, useCallback } from 'react'

const CoreyIntegrationContext = createContext(null)

/**
 * CoreyIntegrationProvider
 *
 * Wraps the CognitiveTopologyView to enable:
 * - Tab switching from sidebar actions
 * - Message passing to COREY chat
 * - Pending message queue for cross-tab communication
 */
export function CoreyIntegrationProvider({ children }) {
  const [activeTab, setActiveTab] = useState('topology')
  const [pendingMessage, setPendingMessage] = useState(null)
  const sendMessageRef = useRef(null)

  // Register the sendMessage function from ChatEngine
  const registerSendMessage = useCallback((sendFn) => {
    sendMessageRef.current = sendFn
  }, [])

  // Unregister when ChatEngine unmounts
  const unregisterSendMessage = useCallback(() => {
    sendMessageRef.current = null
  }, [])

  /**
   * Ask COREY - switches to COREY tab and sends a message
   * @param {string} message - The message to send
   * @param {Object} context - Optional context about the action
   */
  const askCorey = useCallback((message, context = {}) => {
    // Store the pending message
    setPendingMessage({ message, context, timestamp: Date.now() })

    // Switch to COREY tab
    setActiveTab('corey')

    // If sendMessage is already registered, send immediately
    if (sendMessageRef.current) {
      setTimeout(() => {
        if (sendMessageRef.current) {
          sendMessageRef.current(message)
          setPendingMessage(null)
        }
      }, 100) // Small delay to ensure tab switch renders
    }
  }, [])

  /**
   * Consume pending message - called by CoreyContent when it mounts
   */
  const consumePendingMessage = useCallback(() => {
    if (pendingMessage && sendMessageRef.current) {
      sendMessageRef.current(pendingMessage.message)
      setPendingMessage(null)
    }
  }, [pendingMessage])

  const value = {
    // Tab state
    activeTab,
    setActiveTab,

    // Message passing
    pendingMessage,
    hasPendingMessage: !!pendingMessage,
    askCorey,
    consumePendingMessage,

    // ChatEngine registration
    registerSendMessage,
    unregisterSendMessage
  }

  return (
    <CoreyIntegrationContext.Provider value={value}>
      {children}
    </CoreyIntegrationContext.Provider>
  )
}

/**
 * Hook to access the COREY integration context
 */
export function useCoreyIntegration() {
  const context = useContext(CoreyIntegrationContext)
  if (!context) {
    throw new Error('useCoreyIntegration must be used within CoreyIntegrationProvider')
  }
  return context
}

export default CoreyIntegrationContext
