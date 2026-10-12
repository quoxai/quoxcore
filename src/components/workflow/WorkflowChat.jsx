/**
 * WorkflowChat - Conversational Workflow Builder UI
 *
 * The main chat interface for the Workflow Lab plugin.
 * Guides users through building n8n workflows via natural language.
 *
 * Features:
 * - Conversational workflow building
 * - Template loading and customization
 * - Auto-save drafts to localStorage
 * - Resume from saved drafts
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  WorkflowAssistant,
  createWorkflowAssistant,
  WORKFLOW_PHASES,
  PHASE_LABELS,
  explainWorkflow
} from '../../services/workflowAssistant'
import { createWorkflow, parseWorkflowJson } from '../../services/workflowEngine'
import { activateWorkflow } from '../../services/quoxflowClient'
import { loadWorkflowJson } from '../../services/workflowLoader'
import { saveDraft as saveDraftToStorage } from '../../services/workflowDraftService'
import { WireMap } from './WireMap'
import recipes from '../../config/workflow-recipes.json'
import './WorkflowChat.css'

// Markdown components for workflow chat
const mdComponents = {
  p: ({ children }) => <p className="wf-md-p">{children}</p>,
  strong: ({ children }) => <strong className="wf-md-bold">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  code: ({ inline, children }) => inline
    ? <code className="wf-md-code">{children}</code>
    : <pre className="wf-md-pre"><code>{children}</code></pre>,
  ul: ({ children }) => <ul className="wf-md-list">{children}</ul>,
  ol: ({ children }) => <ol className="wf-md-list wf-md-ol">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
}

// =============================================================================
// CHAT MESSAGE COMPONENT
// =============================================================================

function ChatMessage({ message, isUser }) {
  return (
    <div className={`wf-chat-message ${isUser ? 'wf-chat-message--user' : 'wf-chat-message--assistant'}`}>
      <div className="wf-chat-message__avatar">
        {isUser ? 'U' : 'M'}
      </div>
      <div className="wf-chat-message__content">
        <div className="wf-chat-message__text">
          {isUser ? (
            <p>{message.content}</p>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {message.content}
            </ReactMarkdown>
          )}
        </div>
        {message.timestamp && (
          <div className="wf-chat-message__time">
            {new Date(message.timestamp).toLocaleTimeString()}
          </div>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// QUICK OPTIONS COMPONENT
// =============================================================================

function QuickOptions({ options, onSelect, multiSelect = false }) {
  const [selected, setSelected] = useState([])

  const handleClick = (option) => {
    if (multiSelect) {
      const newSelected = selected.includes(option.value)
        ? selected.filter(v => v !== option.value)
        : [...selected, option.value]
      setSelected(newSelected)
    } else {
      onSelect(option.value)
    }
  }

  const handleConfirm = () => {
    if (selected.length > 0) {
      onSelect(selected.join(', '))
    }
  }

  if (!options || options.length === 0) return null

  return (
    <div className="wf-quick-options">
      <div className="wf-quick-options__list">
        {options.map((option, index) => (
          <button
            key={index}
            className={`wf-quick-option ${option.primary ? 'wf-quick-option--primary' : ''} ${
              multiSelect && selected.includes(option.value) ? 'wf-quick-option--selected' : ''
            }`}
            onClick={() => handleClick(option)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {multiSelect && selected.length > 0 && (
        <button className="wf-quick-options__confirm" onClick={handleConfirm}>
          Confirm Selection ({selected.length})
        </button>
      )}
    </div>
  )
}

// =============================================================================
// PHASE INDICATOR COMPONENT
// =============================================================================

const PHASE_DESCRIPTIONS = {
  brief: 'Describe what you want to automate',
  trigger: 'Choose what starts this workflow',
  source: 'Define where data comes from',
  transform: 'Set up processing and logic',
  dest: 'Choose where output goes',
  approval: 'Configure human approval steps',
  review: 'Review and confirm your workflow'
}

function PhaseIndicator({ phase, onBack, canGoBack }) {
  const phases = Object.values(WORKFLOW_PHASES).filter(p => p !== 'complete' && p !== 'generate')

  const currentIndex = phases.indexOf(phase)

  return (
    <div className="wf-phase-indicator">
      {canGoBack && (
        <button
          className="wf-phase-back-btn"
          onClick={onBack}
          title="Go to previous phase"
          style={{
            background: 'none',
            border: '1px solid var(--m-border-default)',
            borderRadius: 'var(--m-radius-md)',
            padding: 'var(--m-space-1) var(--m-space-2)',
            cursor: 'pointer',
            color: 'var(--m-text-tertiary)',
            fontSize: 'var(--m-text-xs)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--m-space-1)',
            marginRight: 'var(--m-space-3)',
            flexShrink: 0
          }}
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="19" y1="12" x2="5" y2="12"/>
            <polyline points="12 19 5 12 12 5"/>
          </svg>
          Back
        </button>
      )}
      {phases.map((p, index) => (
        <div
          key={p}
          className={`wf-phase-step ${index < currentIndex ? 'wf-phase-step--complete' : ''} ${
            index === currentIndex ? 'wf-phase-step--active' : ''
          }`}
          title={PHASE_LABELS[p]}
          aria-current={index === currentIndex ? 'step' : undefined}
        >
          <div className="wf-phase-step__dot" />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span className="wf-phase-step__label" style={{ fontSize: 'var(--m-text-xs, 0.75rem)' }}>{PHASE_LABELS[p]}</span>
            {index === currentIndex && PHASE_DESCRIPTIONS[p] && (
              <span style={{ fontSize: '10px', color: 'var(--m-text-tertiary)', marginTop: '1px' }}>
                {PHASE_DESCRIPTIONS[p]}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// =============================================================================
// WORKFLOW PREVIEW COMPONENT
// =============================================================================

function WorkflowPreview({ workflow }) {
  if (!workflow) return null

  return (
    <div className="wf-preview">
      <div className="wf-preview__header">
        <h4>{workflow.name}</h4>
        <span className="wf-preview__badge">{workflow.nodes?.length || 0} nodes</span>
      </div>
      <div className="wf-preview__nodes">
        {workflow.nodes?.map((node, index) => (
          <div key={node.id || index} className="wf-preview__node">
            <span className="wf-preview__node-icon">
              {node.type?.includes('Trigger') ? '>' :
               node.type?.includes('httpRequest') ? '@' :
               node.type?.includes('telegram') ? 'T' :
               node.type?.includes('email') ? 'E' :
               node.type?.includes('wait') ? 'W' :
               node.type?.includes('filter') ? 'F' :
               node.type?.includes('code') ? 'C' : '*'}
            </span>
            <span className="wf-preview__node-name">{node.name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// =============================================================================
// RECIPE PICKER COMPONENT
// =============================================================================

function RecipePicker({ onSelect, onClose }) {
  const [selectedCategory, setSelectedCategory] = useState(null)

  const categories = recipes.categories
  const categoryRecipes = selectedCategory
    ? recipes.recipes.filter(r => r.category === selectedCategory)
    : []

  return (
    <div className="wf-recipe-picker">
      <div className="wf-recipe-picker__header">
        <h3>Choose a Recipe</h3>
        <button className="wf-recipe-picker__close" onClick={onClose}>x</button>
      </div>

      <div className="wf-recipe-picker__categories">
        {Object.entries(categories).map(([key, cat]) => (
          <button
            key={key}
            className={`wf-category-btn ${selectedCategory === key ? 'wf-category-btn--active' : ''}`}
            onClick={() => setSelectedCategory(key)}
          >
            <span className="wf-category-btn__icon">{cat.icon}</span>
            <span className="wf-category-btn__name">{cat.name}</span>
          </button>
        ))}
      </div>

      {selectedCategory && (
        <div className="wf-recipe-picker__list">
          {categoryRecipes.map(recipe => (
            <div
              key={recipe.id}
              className="wf-recipe-card"
              onClick={() => onSelect(recipe)}
            >
              <div className="wf-recipe-card__header">
                <span className="wf-recipe-card__name">{recipe.name}</span>
                <span className="wf-recipe-card__nodes">{recipe.estimatedNodes} nodes</span>
              </div>
              <p className="wf-recipe-card__description">{recipe.description}</p>
              <div className="wf-recipe-card__triggers">
                {recipe.triggers.map(t => (
                  <span key={t} className="wf-recipe-card__trigger">{t}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// =============================================================================
// MAIN WORKFLOW CHAT COMPONENT
// =============================================================================

export function WorkflowChat({
  onWorkflowCreated,
  onClose,
  templateContext,
  resumeState = null,    // State to resume from (from useWorkflows.resumeDraft)
  onDraftSaved           // Callback when draft is saved
}) {
  const [assistant] = useState(() => createWorkflowAssistant())
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [currentPhase, setCurrentPhase] = useState(WORKFLOW_PHASES.BRIEF)
  const [options, setOptions] = useState(null)
  const [workflow, setWorkflow] = useState(null)
  const [showRecipes, setShowRecipes] = useState(false)
  const [deploying, setDeploying] = useState(false)
  /* The id of the workflow createWorkflow() actually returned. Without this, the
     activate option below had nothing to act on and simply asserted success. */
  const [deployedId, setDeployedId] = useState(null)
  const [templateLoaded, setTemplateLoaded] = useState(false)

  // Draft tracking
  const [draftId, setDraftId] = useState(resumeState?.id || null)
  const [resumeLoaded, setResumeLoaded] = useState(false)

  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)
  const autoSaveTimeoutRef = useRef(null)

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Resume from saved draft
  useEffect(() => {
    if (resumeState && !resumeLoaded) {
      setResumeLoaded(true)

      // Restore assistant state
      const restored = assistant.deserialize(resumeState)
      if (restored) {
        // Convert conversation format
        const restoredMessages = (resumeState.conversation || []).map(msg => ({
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp
        }))

        setMessages(restoredMessages)
        setCurrentPhase(resumeState.phase || WORKFLOW_PHASES.BRIEF)
        setWorkflow(resumeState.generatedWorkflow || null)
        setDraftId(resumeState.id)

        // Add resume notification
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `Resumed draft from where you left off.\n\n**Current Phase:** ${PHASE_LABELS[resumeState.phase] || 'Getting Started'}\n\nContinue where you left off, or type "reset" to start fresh.`,
          timestamp: new Date().toISOString()
        }])

        console.log('[WorkflowChat] Resumed draft:', resumeState.id)
      } else {
        console.warn('[WorkflowChat] Failed to restore draft state')
      }
    }
  }, [resumeState, resumeLoaded, assistant])

  // Auto-save draft on phase change (debounced)
  useEffect(() => {
    // Don't auto-save for BRIEF phase or COMPLETE phase
    if (currentPhase === WORKFLOW_PHASES.BRIEF || currentPhase === WORKFLOW_PHASES.COMPLETE) {
      return
    }

    // Don't save if we have no messages
    if (messages.length === 0) {
      return
    }

    // Clear existing timeout
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current)
    }

    // Debounce auto-save by 2 seconds
    autoSaveTimeoutRef.current = setTimeout(() => {
      try {
        const state = assistant.serialize()
        const saved = saveDraftToStorage({
          id: draftId,
          phase: currentPhase,
          conversation: state.conversation,
          config: state.config,
          intent: state.intent,
          generatedWorkflow: workflow
        })

        setDraftId(saved.id)
        onDraftSaved?.(saved)
        console.log('[WorkflowChat] Auto-saved draft:', saved.id)
      } catch (err) {
        console.error('[WorkflowChat] Failed to auto-save:', err)
      }
    }, 2000)

    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current)
      }
    }
  }, [currentPhase, messages.length, assistant, draftId, workflow, onDraftSaved])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current)
      }
    }
  }, [])

  const [showImportPanel, setShowImportPanel] = useState(false)
  const [importJson, setImportJson] = useState('')
  const [showPreview, setShowPreview] = useState(true)

  // Handle template context - when a template is passed in, load it
  // Skip if we're resuming from a saved state
  useEffect(() => {
    if (resumeState) return // Don't load template if resuming
    if (templateContext && !templateLoaded) {
      setTemplateLoaded(true)
      const template = templateContext

      // If it's a library template with n8nWorkflowJson
      if (template.n8nWorkflowJson) {
        setWorkflow(template.n8nWorkflowJson)
        const explanation = explainWorkflow(template.n8nWorkflowJson)

        const mode = template.mode || 'customize'
        let greeting = ''

        if (mode === 'explain') {
          greeting = `**Analyzing: ${template.identity?.name || template.n8nWorkflowJson?.name || 'Template'}**

${explanation.summary}

**Trigger:** ${explanation.trigger}
**Node Types:** ${explanation.nodeTypes.join(', ')}
${explanation.credentials ? `**Credentials:** ${explanation.credentials}` : ''}

${explanation.suggestions.length > 0 ? '**Suggestions:**\n' + explanation.suggestions.map(s => '• ' + s).join('\n') : ''}

What would you like to know about this workflow?`
        } else {
          greeting = `**Loaded Template: ${template.identity?.name || 'Workflow'}**

${template.identity?.description || explanation.summary}

**Category:** ${template.identity?.category || 'unknown'}
**Integrations:** ${template.capabilities?.integrations?.join(', ') || 'None detected'}
**Nodes:** ${template.n8nWorkflowJson?.nodes?.length || 0}

I can help you:
• **Customize** this workflow for your needs
• **Explain** how it works step-by-step
• **Deploy** it directly to n8n
• **Modify** specific parts

What would you like to do?`
        }

        setMessages([{
          role: 'assistant',
          content: greeting,
          timestamp: new Date().toISOString()
        }])
        setOptions([
          { label: 'Customize for my needs', value: 'customize', primary: true },
          { label: 'Explain step-by-step', value: 'explain_steps' },
          { label: 'Deploy Workflow', value: 'deploy' },
          { label: 'Start fresh instead', value: 'reset' }
        ])
        setCurrentPhase(WORKFLOW_PHASES.REVIEW)
        return
      }

      // If it's a manifest-only template — try loading JSON from workflowFile
      if (template.identity) {
        const fileRef = template.workflowFile || template.n8nWorkflowFile
        if (fileRef) {
          // Load the workflow JSON asynchronously
          setMessages([{
            role: 'assistant',
            content: `**Loading Template: ${template.identity.name}**\n\nFetching workflow definition...`,
            timestamp: new Date().toISOString()
          }])

          loadWorkflowJson(fileRef).then(json => {
            if (json) {
              setWorkflow(json)
              const nodeCount = json.nodes?.length || 0
              const edgeCount = json.edges?.length || 0
              setMessages([{
                role: 'assistant',
                content: `**Loaded Template: ${template.identity.name}**\n\n${template.identity.description || ''}\n\n**Category:** ${template.identity.category}\n**Integrations:** ${template.capabilities?.integrations?.join(', ') || 'None'}\n**Trigger Type:** ${template.trigger?.type || 'manual'}\n**Structure:** ${nodeCount} nodes, ${edgeCount} edges\n\nI can help you:\n- **Customize** this workflow for your needs\n- **Explain** how it works step-by-step\n- **Deploy** it to QuoxFlow\n- **Modify** specific parts\n\nWhat would you like to do?`,
                timestamp: new Date().toISOString()
              }])
              setOptions([
                { label: 'Customize for my needs', value: 'customize', primary: true },
                { label: 'Explain step-by-step', value: 'explain_steps' },
                { label: 'Deploy Workflow', value: 'deploy' },
                { label: 'Start fresh instead', value: 'reset' }
              ])
              setCurrentPhase(WORKFLOW_PHASES.REVIEW)
            } else {
              setMessages([{
                role: 'assistant',
                content: `**Selected Template: ${template.identity.name}**\n\n${template.identity.description || ''}\n\n**Category:** ${template.identity.category}\n**Integrations:** ${template.capabilities?.integrations?.join(', ') || 'None'}\n\nCould not load the workflow file. I can help you:\n- **Build** a similar workflow from scratch\n- **Choose** a different template\n\nWhat would you like to do?`,
                timestamp: new Date().toISOString()
              }])
              setOptions([
                { label: 'Build similar workflow', value: `build a ${template.identity.name} workflow`, primary: true },
                { label: 'Choose different template', value: 'reset' }
              ])
            }
          })
          return
        }

        setMessages([{
          role: 'assistant',
          content: `**Selected Template: ${template.identity.name}**\n\n${template.identity.description || ''}\n\n**Category:** ${template.identity.category}\n**Integrations:** ${template.capabilities?.integrations?.join(', ') || 'None'}\n\nI can help you **build** a similar workflow from scratch, or **choose** a different template.`,
          timestamp: new Date().toISOString()
        }])
        setOptions([
          { label: 'Build similar workflow', value: `build a ${template.identity.name} workflow`, primary: true },
          { label: 'Choose different template', value: 'reset' }
        ])
        return
      }
    }
  }, [templateContext, templateLoaded])

  // Initial greeting (only if no template and not resuming)
  useEffect(() => {
    if (!templateContext && !resumeState) {
      const greeting = {
        role: 'assistant',
        content: `Welcome to the Workflow Lab!

I'll help you build n8n workflows through conversation.

**Start fresh** - Describe what you want to automate
**Browse recipes** - Choose from pre-built templates
**Import JSON** - Start from an existing n8n workflow

What would you like to create?`,
        timestamp: new Date().toISOString()
      }
      setMessages([greeting])
      setOptions([
        { label: 'Build from scratch', value: 'scratch', primary: true },
        { label: 'Browse recipes', value: 'recipes' },
        { label: 'Import Workflow JSON', value: 'show_import' }
      ])
    }
  }, [templateContext])

  // Handle sending a message
  const handleSend = useCallback(async (text) => {
    if (!text.trim()) return

    setLoading(true)
    setOptions(null)

    // Handle special commands
    if (text.toLowerCase() === 'recipes') {
      setShowRecipes(true)
      setLoading(false)
      return
    }

    if (text.toLowerCase() === 'show_import') {
      setShowImportPanel(true)
      setLoading(false)
      return
    }

    if (text.toLowerCase() === 'import') {
      setMessages(prev => [...prev, {
        role: 'user',
        content: text,
        timestamp: new Date().toISOString()
      }, {
        role: 'assistant',
        content: 'Paste your n8n workflow JSON below:',
        timestamp: new Date().toISOString()
      }])
      setLoading(false)
      return
    }

    // Check if it's JSON import
    if (text.trim().startsWith('{')) {
      const parseResult = parseWorkflowJson(text)
      if (parseResult.valid) {
        const explanation = explainWorkflow(parseResult.workflow)
        setWorkflow(parseResult.workflow)
        setMessages(prev => [...prev, {
          role: 'user',
          content: '[Workflow JSON imported]',
          timestamp: new Date().toISOString()
        }, {
          role: 'assistant',
          content: `Imported workflow: "${parseResult.workflow.name}"

${explanation.summary}
${explanation.trigger}

Node types: ${explanation.nodeTypes.join(', ')}
${explanation.credentials}

${explanation.suggestions.length > 0 ? 'Suggestions:\n' + explanation.suggestions.map(s => '- ' + s).join('\n') : ''}

What would you like to do with this workflow?`,
          timestamp: new Date().toISOString()
        }])
        setOptions([
          { label: 'Deploy Workflow', value: 'deploy', primary: true },
          { label: 'Modify workflow', value: 'modify' },
          { label: 'Download JSON', value: 'download' }
        ])
        setLoading(false)
        return
      } else {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `Invalid JSON: ${parseResult.error}\n\nPlease check the format and try again.`,
          timestamp: new Date().toISOString()
        }])
        setLoading(false)
        return
      }
    }

    try {
      const response = await assistant.processMessage(text)

      // Update messages
      setMessages(prev => [
        ...prev,
        { role: 'user', content: text, timestamp: new Date().toISOString() },
        { role: 'assistant', content: response.text, timestamp: new Date().toISOString() }
      ])

      // Update state
      setCurrentPhase(response.phase)
      setOptions(response.options)

      if (response.workflow) {
        setWorkflow(response.workflow)
      }

      // Handle actions
      if (response.action === 'deploy') {
        handleDeploy(response.workflow)
      }
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Error: ${err.message}`,
        timestamp: new Date().toISOString()
      }])
    } finally {
      setLoading(false)
    }
  }, [assistant])

  // Handle option selection
  const handleOptionSelect = useCallback(async (value) => {
    /* Handle post-deploy actions directly.
     *
     * `activate` used to push "Workflow activated successfully! It will now run according
     * to its trigger configuration." without calling anything at all. The workflow stayed
     * inactive and the user was told it would run on its trigger. activateWorkflow() has
     * existed in services/quoxflowClient.js the whole time; it was simply never called.
     * Found by the quox-execution-integrity Lens while its eval corpus was being built,
     * which is precisely the class it exists to catch: a success message with no
     * underlying action. Claiming success is now conditional on the call succeeding, and a
     * failure says so instead of staying silent. */
    if (value === 'activate') {
      if (!deployedId) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: 'Cannot activate: no deployed workflow id was recorded. Deploy the workflow first.',
          timestamp: new Date().toISOString()
        }])
        return
      }
      try {
        await activateWorkflow(deployedId)
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: 'Workflow activated. It will now run according to its trigger configuration.',
          timestamp: new Date().toISOString()
        }])
        setOptions([
          { label: 'View in Workflow Builder', value: 'view_builder', primary: true },
          { label: 'Create another', value: 'reset' }
        ])
      } catch (err) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `Activation failed: ${err.message}. The workflow is deployed but NOT active, so it will not run on its trigger.`,
          timestamp: new Date().toISOString()
        }])
        setOptions([
          { label: 'Try activating again', value: 'activate', primary: true },
          { label: 'View in Workflow Builder', value: 'view_builder' }
        ])
      }
      return
    }
    if (value === 'open_n8n') {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Your workflow has been deployed to the workflow engine. You can manage and monitor it from the Workflow Builder.',
        timestamp: new Date().toISOString()
      }])
      setOptions([
        { label: 'Open Workflow Builder', value: 'view_builder', primary: true },
        { label: 'Create another', value: 'reset' }
      ])
      return
    }
    if (value === 'view_builder') {
      window.location.href = '/workflow-builder'
      return
    }
    setInput('')
    handleSend(value)
  }, [handleSend, deployedId])

  // Handle recipe selection
  const handleRecipeSelect = useCallback((recipe) => {
    setShowRecipes(false)
    handleSend(`I want to create a "${recipe.name}" workflow - ${recipe.description}`)
  }, [handleSend])

  // Handle deploy
  const handleDeploy = useCallback(async (workflowToDeply) => {
    setDeploying(true)
    try {
      const created = await createWorkflow(workflowToDeply || workflow)
      setDeployedId(created.id)
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Workflow deployed successfully!

Name: ${created.name}
ID: ${created.id}

The workflow is now available in n8n. Would you like to activate it?`,
        timestamp: new Date().toISOString()
      }])
      setOptions([
        { label: 'Activate workflow', value: 'activate', primary: true },
        { label: 'View Workflow', value: 'open_n8n' },
        { label: 'Create another', value: 'reset' }
      ])
      onWorkflowCreated?.(created)
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Failed to deploy: ${err.message}

Make sure n8n is running and the API key is configured.`,
        timestamp: new Date().toISOString()
      }])
    } finally {
      setDeploying(false)
    }
  }, [workflow, onWorkflowCreated])

  // Handle form submit
  const handleSubmit = (e) => {
    e.preventDefault()
    if (input.trim() && !loading) {
      handleSend(input)
      setInput('')
    }
  }

  // Handle reset
  const handleReset = () => {
    assistant.reset()
    setMessages([{
      role: 'assistant',
      content: 'Starting fresh. What would you like to create?',
      timestamp: new Date().toISOString()
    }])
    setCurrentPhase(WORKFLOW_PHASES.BRIEF)
    setWorkflow(null)
    setDraftId(null) // Clear draft ID on reset
    setOptions([
      { label: 'Build from scratch', value: 'scratch' },
      { label: 'Browse recipes', value: 'recipes' },
      { label: 'Import JSON', value: 'import' }
    ])
  }

  // Handle manual save
  const handleSaveDraft = useCallback(() => {
    try {
      const state = assistant.serialize()
      const saved = saveDraftToStorage({
        id: draftId,
        phase: currentPhase,
        conversation: state.conversation,
        config: state.config,
        intent: state.intent,
        generatedWorkflow: workflow
      })

      setDraftId(saved.id)
      onDraftSaved?.(saved)

      // Show confirmation in chat
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Draft saved as "${saved.title}". You can resume this from the My Workflows tab.`,
        timestamp: new Date().toISOString()
      }])
    } catch (err) {
      console.error('[WorkflowChat] Failed to save draft:', err)
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Failed to save draft: ${err.message}`,
        timestamp: new Date().toISOString()
      }])
    }
  }, [assistant, draftId, currentPhase, workflow, onDraftSaved])

  const hasPreview = workflow && showPreview

  return (
    <div className={`wf-chat ${hasPreview ? 'wf-chat--split' : ''}`}>
      {/* Header */}
      <div className="wf-chat__header">
        <div className="wf-chat__title">
          <h3>Workflow Lab</h3>
          <PhaseIndicator
            phase={currentPhase}
            canGoBack={assistant?.canGoBack?.()}
            onBack={() => {
              if (assistant?.goToPreviousPhase) {
                const prevPhase = assistant.goToPreviousPhase()
                if (prevPhase) {
                  setCurrentPhase(prevPhase)
                }
              }
            }}
          />
        </div>
        <div className="wf-chat__actions">
          {workflow && (
            <button
              className={`wf-chat__btn ${showPreview ? 'wf-chat__btn--preview-active' : ''}`}
              onClick={() => setShowPreview(!showPreview)}
              title={showPreview ? 'Hide preview' : 'Show preview'}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
              {showPreview ? 'Hide Map' : 'Show Map'}
            </button>
          )}
          {currentPhase !== WORKFLOW_PHASES.BRIEF && (
            <button
              className="wf-chat__btn wf-chat__btn--save"
              onClick={handleSaveDraft}
              title="Save draft"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
              Save
            </button>
          )}
          <button className="wf-chat__btn" onClick={handleReset} title="Start over">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Reset
          </button>
          {onClose && (
            <button className="wf-chat__btn wf-chat__btn--close" onClick={onClose}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          )}
        </div>
      </div>

      {/* Split pane: chat + wiremap */}
      <div className="wf-chat__split">
        {/* Chat pane */}
        <div className="wf-chat__chat-pane">
          {/* Main content */}
          <div className="wf-chat__body">
            {/* Messages */}
            <div className="wf-chat__messages">
              {messages.map((msg, index) => (
                <ChatMessage key={index} message={msg} isUser={msg.role === 'user'} />
              ))}

              {loading && (
                <div className="wf-chat-message wf-chat-message--assistant">
                  <div className="wf-chat-message__avatar">M</div>
                  <div className="wf-chat-message__content">
                    <div className="wf-chat-loading">
                      <span></span><span></span><span></span>
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Inline workflow preview (when WireMap is hidden) */}
            {workflow && !showPreview && <WorkflowPreview workflow={workflow} />}

            {/* Quick options */}
            {options && !loading && (
              <QuickOptions options={options} onSelect={handleOptionSelect} />
            )}
          </div>

          {/* Input */}
          <form className="wf-chat__input-area" onSubmit={handleSubmit}>
            <input
              ref={inputRef}
              type="text"
              className="wf-chat__input"
              placeholder={loading ? 'Thinking...' : 'Describe what you want to automate...'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={loading || deploying}
            />
            <button
              type="submit"
              className="wf-chat__send"
              disabled={!input.trim() || loading || deploying}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
              {deploying ? 'Deploying...' : 'Send'}
            </button>
          </form>
        </div>

        {/* WireMap preview pane */}
        {hasPreview && (
          <div className="wf-chat__preview-pane">
            <div className="wf-chat__preview-header">
              <h4>Workflow Preview</h4>
              <span className="wf-chat__preview-badge">{workflow.nodes?.length || 0} nodes</span>
            </div>
            <div className="wf-chat__preview-map">
              <WireMap workflowJson={workflow} />
            </div>
          </div>
        )}
      </div>

      {/* Recipe picker modal */}
      {showRecipes && (
        <div className="wf-modal-overlay">
          <RecipePicker
            onSelect={handleRecipeSelect}
            onClose={() => setShowRecipes(false)}
          />
        </div>
      )}

      {/* Import JSON panel */}
      {showImportPanel && (
        <div className="wf-modal-overlay">
          <div className="wf-import-panel">
            <div className="wf-import-panel__header">
              <h3>Import Workflow JSON</h3>
              <button
                className="wf-import-panel__close"
                onClick={() => {
                  setShowImportPanel(false)
                  setImportJson('')
                }}
              >
                x
              </button>
            </div>
            <div className="wf-import-panel__body">
              <p className="wf-import-panel__hint">
                Paste your n8n workflow JSON below. You can export from n8n using
                the "Download" option in the workflow menu.
              </p>
              <textarea
                className="wf-import-panel__textarea"
                placeholder='{"name": "My Workflow", "nodes": [...], "connections": {...}}'
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                rows={12}
              />
            </div>
            <div className="wf-import-panel__actions">
              <button
                className="btn"
                onClick={() => {
                  setShowImportPanel(false)
                  setImportJson('')
                }}
              >
                Cancel
              </button>
              <button
                className="btn btn--primary"
                disabled={!importJson.trim()}
                onClick={() => {
                  setShowImportPanel(false)
                  handleSend(importJson)
                  setImportJson('')
                }}
              >
                Import & Analyze
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default WorkflowChat
