/**
 * LayerPluginsView - Layer Plugin Management Page
 *
 * Manage, create, and browse custom AOCL layer plugins.
 * Part of AOCL Developer Kit (Free — LICENSE-LAUNCH #3081)
 */

import { useState } from 'react'
import LayerPluginManager from '../../components/plugins/LayerPluginManager'
import LayerPluginEditor from '../../components/plugins/LayerPluginEditor'
import LayerPluginMarketplace from '../../components/plugins/LayerPluginMarketplace'
import '../../components/plugins/layer-plugins.css'

export default function LayerPluginsView() {
  const [activeTab, setActiveTab] = useState('installed')
  const [editingPlugin, setEditingPlugin] = useState(null)

  const handleEditPlugin = (plugin) => {
    setEditingPlugin(plugin)
    setActiveTab('editor')
  }

  const handleEditorSave = () => {
    setEditingPlugin(null)
    setActiveTab('installed')
  }

  const handleEditorCancel = () => {
    setEditingPlugin(null)
    if (activeTab === 'editor') {
      setActiveTab('installed')
    }
  }

  const handleNewPlugin = () => {
    setEditingPlugin(null)
    setActiveTab('editor')
  }

  return (
    <div className="layer-plugins-view licensed">
      {/* Header with tabs */}
      <div className="plugins-header">
        <div className="header-left">
          <h1>Layer Plugins</h1>
        </div>

        <div className="plugins-tabs">
          <button
            className={`tab-btn ${activeTab === 'installed' ? 'active' : ''}`}
            onClick={() => setActiveTab('installed')}
          >
            Installed
          </button>
          <button
            className={`tab-btn ${activeTab === 'editor' ? 'active' : ''}`}
            onClick={handleNewPlugin}
          >
            {editingPlugin ? 'Editor' : '+ New Plugin'}
          </button>
          <button
            className={`tab-btn ${activeTab === 'marketplace' ? 'active' : ''}`}
            onClick={() => setActiveTab('marketplace')}
          >
            Marketplace
          </button>
        </div>
      </div>

      {/* Tab Content */}
      <div className="plugins-content">
        {activeTab === 'installed' && (
          <LayerPluginManager onEditPlugin={handleEditPlugin} />
        )}

        {activeTab === 'editor' && (
          <LayerPluginEditor
            editingPlugin={editingPlugin}
            onSave={handleEditorSave}
            onCancel={handleEditorCancel}
          />
        )}

        {activeTab === 'marketplace' && (
          <LayerPluginMarketplace />
        )}
      </div>

      <style>{`
        .layer-plugins-view.licensed {
          height: 100%;
          display: flex;
          flex-direction: column;
          background: transparent;
        }

        .plugins-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 24px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.14);
          background: var(--m-bg-base);
        }

        .header-left {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .plugins-header h1 {
          margin: 0;
          font-size: 1.25rem;
          color: #fff;
        }

        .plugins-tabs {
          display: flex;
          gap: 4px;
        }

        .tab-btn {
          padding: 8px 16px;
          background: transparent;
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 4px;
          color: rgba(255, 255, 255, 0.7);
          font-size: 0.875rem;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .tab-btn:hover {
          background: var(--m-bg-base);
          color: #fff;
        }

        .tab-btn.active {
          background: var(--m-bg-base);
          border-color: #38bdf8;
          color: #38bdf8;
        }

        .plugins-content {
          flex: 1;
          overflow: auto;
          padding: 24px;
        }
      `}</style>
    </div>
  )
}
