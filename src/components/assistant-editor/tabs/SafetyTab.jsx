/**
 * SafetyTab — DEFCON level, approval requirements, auto-approved actions
 * Extracted from AssistantEditor.jsx (AUX-1), a11y fixed (AUX-7)
 */

export default function SafetyTab({ draft, updateField }) {
  return (
    <div className="editor-section">
      <div className="form-group">
        <label htmlFor="safety-defcon">DEFCON Level</label>
        <select
          id="safety-defcon"
          value={draft.safety.defconLevel}
          onChange={(e) => updateField('safety.defconLevel', e.target.value)}
        >
          <option value="GREEN">GREEN - Low risk, mostly read-only</option>
          <option value="AMBER">AMBER - Moderate risk, requires caution</option>
          <option value="RED">RED - High risk, destructive operations</option>
        </select>
      </div>
      <div className="form-group">
        <label htmlFor="safety-approval">Requires Approval (one per line)</label>
        <textarea
          id="safety-approval"
          rows={4}
          value={(draft.safety.requiresApproval || []).join('\n')}
          onChange={(e) => updateField('safety.requiresApproval',
            e.target.value.split('\n').filter(Boolean)
          )}
        />
      </div>
      <div className="form-group">
        <label htmlFor="safety-autoapproved">Auto-Approved (one per line)</label>
        <textarea
          id="safety-autoapproved"
          rows={4}
          value={(draft.safety.autoApproved || []).join('\n')}
          onChange={(e) => updateField('safety.autoApproved',
            e.target.value.split('\n').filter(Boolean)
          )}
        />
      </div>
    </div>
  )
}
