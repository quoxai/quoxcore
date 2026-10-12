/**
 * AssistantHierarchy Component
 *
 * Visual tree view of the assistant hierarchy.
 * Shows reporting structure and delegation paths.
 */

import React from 'react'
import { getHierarchyTree, getAssistant } from '../../services/entityRegistry'

function HierarchyNode({ node, level = 0, onSelect, onEdit }) {
  const roleColors = {
    orchestrator: '#38bdf8',
    manager: '#30ff90',
    analyst: '#4285f4',
    specialist: '#ffcc00'
  }

  return (
    <div className="hierarchy-node" style={{ '--level': level }}>
      <div
        className="node-content"
        style={{
          '--node-color': node.identity.color.primary,
          '--role-color': roleColors[node.hierarchy.role]
        }}
        onClick={() => onSelect(node.id)}
      >
        <div className="node-connector" />

        <div className="node-card">
          <div className="node-avatar" style={{ backgroundColor: `${node.identity.color.primary}20` }}>
            <span style={{ color: node.identity.color.primary }}>{node.identity.shortName}</span>
          </div>

          <div className="node-info">
            <div className="node-name">{node.identity.name}</div>
            <div className="node-role">{node.hierarchy.role}</div>
          </div>

          <div className="node-domains">
            {node.capabilities.domains.slice(0, 2).map(d => (
              <span key={d} className="domain-chip">{d}</span>
            ))}
          </div>

          <button
            className="node-edit-btn"
            onClick={(e) => {
              e.stopPropagation()
              onEdit(node.id)
            }}
          >
            Edit
          </button>
        </div>
      </div>

      {node.children && node.children.length > 0 && (
        <div className="node-children">
          {node.children.map(child => (
            <HierarchyNode
              key={child.id}
              node={child}
              level={level + 1}
              onSelect={onSelect}
              onEdit={onEdit}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function AssistantHierarchy({ onSelect, onEdit }) {
  const tree = getHierarchyTree()

  if (!tree) {
    return (
      <div className="hierarchy-empty">
        No hierarchy available
      </div>
    )
  }

  return (
    <div className="assistant-hierarchy">
      <div className="hierarchy-legend">
        <div className="legend-item">
          <span className="legend-dot" style={{ background: '#38bdf8' }} />
          <span>Orchestrator</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot" style={{ background: '#30ff90' }} />
          <span>Manager</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot" style={{ background: '#4285f4' }} />
          <span>Analyst</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot" style={{ background: '#ffcc00' }} />
          <span>Specialist</span>
        </div>
      </div>

      <div className="hierarchy-tree">
        <HierarchyNode
          node={tree}
          onSelect={onSelect}
          onEdit={onEdit}
        />
      </div>

      <style>{`
        .assistant-hierarchy {
          padding: 20px;
        }

        .hierarchy-legend {
          display: flex;
          gap: 20px;
          margin-bottom: 24px;
          padding: 12px 16px;
          background: rgba(0, 0, 0, 0.3);
          border-radius: 6px;
        }

        .legend-item {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          color: var(--hal-text-dim);
        }

        .legend-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
        }

        .hierarchy-tree {
          overflow-x: auto;
          padding: 20px 0;
        }

        .hierarchy-node {
          position: relative;
        }

        .node-content {
          display: flex;
          align-items: center;
          margin-bottom: 16px;
          padding-left: calc(var(--level) * 40px);
        }

        .node-connector {
          position: absolute;
          left: calc(var(--level) * 40px - 20px);
          top: 0;
          width: 20px;
          height: 50%;
          border-left: 2px solid var(--role-color, var(--hal-border-color));
          border-bottom: 2px solid var(--role-color, var(--hal-border-color));
          display: var(--level) > 0 ? block : none;
        }

        .hierarchy-node:first-child > .node-content > .node-connector {
          display: none;
        }

        .node-card {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
          background: rgba(0, 0, 0, 0.4);
          border: 1px solid var(--node-color);
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .node-card:hover {
          background: rgba(0, 0, 0, 0.6);
          transform: translateX(4px);
        }

        .node-avatar {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: bold;
          flex-shrink: 0;
        }

        .node-info {
          min-width: 100px;
        }

        .node-name {
          font-weight: bold;
          color: var(--hal-text-color);
          font-size: 14px;
        }

        .node-role {
          font-size: 11px;
          color: var(--role-color);
          text-transform: uppercase;
        }

        .node-domains {
          display: flex;
          gap: 4px;
          margin-left: auto;
        }

        .domain-chip {
          font-size: 10px;
          padding: 2px 8px;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 3px;
          color: var(--hal-text-dim);
        }

        .node-edit-btn {
          padding: 6px 12px;
          background: transparent;
          border: 1px solid var(--node-color);
          color: var(--node-color);
          border-radius: 4px;
          font-size: 11px;
          cursor: pointer;
          opacity: 0;
          transition: all 0.2s ease;
        }

        .node-card:hover .node-edit-btn {
          opacity: 1;
        }

        .node-edit-btn:hover {
          background: var(--node-color);
          color: black;
        }

        .node-children {
          position: relative;
          margin-left: 40px;
        }

        .node-children::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0;
          bottom: 24px;
          width: 2px;
          background: var(--hal-border-color);
        }

        .hierarchy-empty {
          text-align: center;
          padding: 40px;
          color: var(--hal-text-dim);
        }
      `}</style>
    </div>
  )
}
