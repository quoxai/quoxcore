/**
 * WorkflowExplainer - Import and Explain n8n Workflows
 *
 * A dedicated component for importing n8n workflow JSON and getting
 * detailed explanations of what the workflow does.
 */

import { useState, useCallback } from 'react'
import { parseWorkflowJson } from '../../services/workflowEngine'
import { explainWorkflow } from '../../services/workflowAssistant'
import './WorkflowExplainer.css'

// =============================================================================
// NODE ICON MAPPING
// =============================================================================

const NODE_ICONS = {
  trigger: '>',
  webhook: 'W',
  schedule: 'S',
  http: '@',
  telegram: 'T',
  email: 'E',
  slack: '#',
  code: 'C',
  function: 'f',
  if: '?',
  switch: '/',
  merge: 'M',
  split: 'Y',
  wait: 'W',
  set: '=',
  filter: 'F',
  loop: 'O',
  default: '*'
}

function getNodeIcon(nodeType) {
  if (!nodeType) return NODE_ICONS.default
  const type = nodeType.toLowerCase()

  if (type.includes('trigger')) return NODE_ICONS.trigger
  if (type.includes('webhook')) return NODE_ICONS.webhook
  if (type.includes('schedule') || type.includes('cron')) return NODE_ICONS.schedule
  if (type.includes('http') || type.includes('request')) return NODE_ICONS.http
  if (type.includes('telegram')) return NODE_ICONS.telegram
  if (type.includes('email') || type.includes('mail')) return NODE_ICONS.email
  if (type.includes('slack')) return NODE_ICONS.slack
  if (type.includes('code') || type.includes('function')) return NODE_ICONS.code
  if (type.includes('if')) return NODE_ICONS.if
  if (type.includes('switch')) return NODE_ICONS.switch
  if (type.includes('merge')) return NODE_ICONS.merge
  if (type.includes('split')) return NODE_ICONS.split
  if (type.includes('wait')) return NODE_ICONS.wait
  if (type.includes('set')) return NODE_ICONS.set
  if (type.includes('filter')) return NODE_ICONS.filter
  if (type.includes('loop')) return NODE_ICONS.loop

  return NODE_ICONS.default
}

// =============================================================================
// NODE FLOW VISUALIZATION
// =============================================================================

function NodeFlow({ nodes, connections }) {
  if (!nodes || nodes.length === 0) {
    return <div className="wf-explainer__empty">No nodes in workflow</div>
  }

  // Build connection map
  const connectionMap = {}
  if (connections) {
    Object.entries(connections).forEach(([fromNode, outputs]) => {
      if (outputs?.main) {
        outputs.main.forEach((outputConnections, outputIndex) => {
          if (outputConnections) {
            outputConnections.forEach(conn => {
              if (!connectionMap[fromNode]) connectionMap[fromNode] = []
              connectionMap[fromNode].push(conn.node)
            })
          }
        })
      }
    })
  }

  return (
    <div className="wf-node-flow">
      {nodes.map((node, index) => {
        const nextNodes = connectionMap[node.name] || []
        const isLast = index === nodes.length - 1

        return (
          <div key={node.id || index} className="wf-node-flow__item">
            <div className="wf-node-flow__node">
              <div className="wf-node-flow__icon">
                {getNodeIcon(node.type)}
              </div>
              <div className="wf-node-flow__details">
                <div className="wf-node-flow__name">{node.name}</div>
                <div className="wf-node-flow__type">
                  {node.type?.replace('n8n-nodes-base.', '') || 'Unknown'}
                </div>
              </div>
            </div>
            {!isLast && nextNodes.length > 0 && (
              <div className="wf-node-flow__connector">
                <div className="wf-node-flow__line" />
                <div className="wf-node-flow__arrow">v</div>
              </div>
            )}
            {!isLast && nextNodes.length === 0 && (
              <div className="wf-node-flow__connector">
                <div className="wf-node-flow__line wf-node-flow__line--dashed" />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// =============================================================================
// EXPLANATION PANEL
// =============================================================================

function ExplanationPanel({ explanation }) {
  if (!explanation) return null

  return (
    <div className="wf-explanation">
      <div className="wf-explanation__section">
        <h4>Summary</h4>
        <p>{explanation.summary}</p>
      </div>

      <div className="wf-explanation__section">
        <h4>Trigger</h4>
        <p>{explanation.trigger}</p>
      </div>

      <div className="wf-explanation__section">
        <h4>Node Types Used</h4>
        <div className="wf-explanation__tags">
          {explanation.nodeTypes.map((type, i) => (
            <span key={i} className="wf-explanation__tag">{type}</span>
          ))}
        </div>
      </div>

      {explanation.credentials && (
        <div className="wf-explanation__section">
          <h4>Credentials Required</h4>
          <p>{explanation.credentials}</p>
        </div>
      )}

      {explanation.suggestions && explanation.suggestions.length > 0 && (
        <div className="wf-explanation__section wf-explanation__section--suggestions">
          <h4>Suggestions</h4>
          <ul>
            {explanation.suggestions.map((suggestion, i) => (
              <li key={i}>{suggestion}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// =============================================================================
// IMPORT FORM
// =============================================================================

function ImportForm({ onImport }) {
  const [jsonInput, setJsonInput] = useState('')
  const [error, setError] = useState(null)
  const [dragOver, setDragOver] = useState(false)

  const handleParse = useCallback(() => {
    if (!jsonInput.trim()) {
      setError('Please paste n8n workflow JSON')
      return
    }

    const result = parseWorkflowJson(jsonInput)
    if (result.valid) {
      setError(null)
      onImport(result.workflow)
    } else {
      setError(result.error)
    }
  }, [jsonInput, onImport])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setDragOver(false)

    const file = e.dataTransfer.files[0]
    if (file && file.type === 'application/json') {
      const reader = new FileReader()
      reader.onload = (event) => {
        setJsonInput(event.target.result)
      }
      reader.readAsText(file)
    }
  }, [])

  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOver(false)
  }, [])

  return (
    <div className="wf-import-form">
      <div className="wf-import-form__header">
        <h3>Import Workflow</h3>
        <p>Paste workflow JSON or drag and drop a .json file</p>
      </div>

      <div
        className={`wf-import-form__dropzone ${dragOver ? 'wf-import-form__dropzone--active' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <textarea
          className="wf-import-form__textarea"
          placeholder='{"name": "My Workflow", "nodes": [...], "connections": {...}}'
          value={jsonInput}
          onChange={(e) => setJsonInput(e.target.value)}
          rows={12}
        />
      </div>

      {error && (
        <div className="wf-import-form__error">
          {error}
        </div>
      )}

      <div className="wf-import-form__actions">
        <button
          className="btn btn--primary"
          onClick={handleParse}
          disabled={!jsonInput.trim()}
        >
          Analyze Workflow
        </button>
      </div>
    </div>
  )
}

// =============================================================================
// MAIN WORKFLOW EXPLAINER COMPONENT
// =============================================================================

export function WorkflowExplainer({ onDeploy, onModify, onClose }) {
  const [workflow, setWorkflow] = useState(null)
  const [explanation, setExplanation] = useState(null)
  const [activeTab, setActiveTab] = useState('explanation')

  const handleImport = useCallback((wf) => {
    setWorkflow(wf)
    const exp = explainWorkflow(wf)
    setExplanation(exp)
  }, [])

  const handleReset = useCallback(() => {
    setWorkflow(null)
    setExplanation(null)
  }, [])

  const handleDownload = useCallback(() => {
    if (!workflow) return

    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${workflow.name || 'workflow'}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [workflow])

  return (
    <div className="wf-explainer">
      <div className="wf-explainer__header">
        <h2>Workflow Explainer</h2>
        {onClose && (
          <button className="wf-explainer__close" onClick={onClose}>x</button>
        )}
      </div>

      {!workflow ? (
        <ImportForm onImport={handleImport} />
      ) : (
        <div className="wf-explainer__content">
          {/* Workflow Info Header */}
          <div className="wf-explainer__info">
            <div className="wf-explainer__title">
              <h3>{workflow.name}</h3>
              <span className="wf-explainer__badge">
                {workflow.nodes?.length || 0} nodes
              </span>
            </div>
            {workflow.settings?.executionOrder && (
              <div className="wf-explainer__meta">
                Execution Order: {workflow.settings.executionOrder}
              </div>
            )}
          </div>

          {/* Tabs */}
          <div className="wf-explainer__tabs">
            <button
              className={`wf-explainer__tab ${activeTab === 'explanation' ? 'wf-explainer__tab--active' : ''}`}
              onClick={() => setActiveTab('explanation')}
            >
              Explanation
            </button>
            <button
              className={`wf-explainer__tab ${activeTab === 'flow' ? 'wf-explainer__tab--active' : ''}`}
              onClick={() => setActiveTab('flow')}
            >
              Node Flow
            </button>
            <button
              className={`wf-explainer__tab ${activeTab === 'json' ? 'wf-explainer__tab--active' : ''}`}
              onClick={() => setActiveTab('json')}
            >
              Raw JSON
            </button>
          </div>

          {/* Tab Content */}
          <div className="wf-explainer__panel">
            {activeTab === 'explanation' && (
              <ExplanationPanel explanation={explanation} />
            )}
            {activeTab === 'flow' && (
              <NodeFlow nodes={workflow.nodes} connections={workflow.connections} />
            )}
            {activeTab === 'json' && (
              <pre className="wf-explainer__json">
                {JSON.stringify(workflow, null, 2)}
              </pre>
            )}
          </div>

          {/* Actions */}
          <div className="wf-explainer__actions">
            <button className="btn" onClick={handleReset}>
              Import Another
            </button>
            <button className="btn" onClick={handleDownload}>
              Download JSON
            </button>
            {onModify && (
              <button className="btn btn--secondary" onClick={() => onModify(workflow)}>
                Modify in Lab
              </button>
            )}
            {onDeploy && (
              <button className="btn btn--primary" onClick={() => onDeploy(workflow)}>
                Deploy Workflow
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default WorkflowExplainer
