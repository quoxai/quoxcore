/**
 * UISettingsTab — Settings enabled, visualizer type, pulse speed, suggestions
 * Extracted from AssistantEditor.jsx (AUX-1), a11y fixed (AUX-7)
 */

export default function UISettingsTab({ draft, updateField }) {
  return (
    <div className="editor-section">
      <div className="form-group">
        <label>
          <input
            type="checkbox"
            checked={draft.ui.settingsEnabled}
            onChange={(e) => updateField('ui.settingsEnabled', e.target.checked)}
          />
          {' '}Settings Enabled
        </label>
      </div>
      <div className="form-group">
        <label htmlFor="ui-viz-type">Visualizer Type</label>
        <select
          id="ui-viz-type"
          value={draft.ui.visualizer.type}
          onChange={(e) => updateField('ui.visualizer.type', e.target.value)}
        >
          <option value="commander-sigil">Commander Sigil</option>
          <option value="hal">Eye-Q</option>
          <option value="wave">Wave</option>
          <option value="grid">Grid</option>
        </select>
      </div>
      <div className="form-group">
        <label htmlFor="ui-pulse-speed">Pulse Speed</label>
        <select
          id="ui-pulse-speed"
          value={draft.ui.visualizer.pulseSpeed}
          onChange={(e) => updateField('ui.visualizer.pulseSpeed', e.target.value)}
        >
          <option value="slow">Slow</option>
          <option value="normal">Normal</option>
          <option value="fast">Fast</option>
        </select>
      </div>
      <div className="form-group">
        <label htmlFor="ui-suggestions">Suggestions (one per line)</label>
        <textarea
          id="ui-suggestions"
          rows={5}
          value={(draft.ui.suggestions || []).join('\n')}
          onChange={(e) => updateField('ui.suggestions',
            e.target.value.split('\n').filter(Boolean)
          )}
        />
      </div>
    </div>
  )
}
