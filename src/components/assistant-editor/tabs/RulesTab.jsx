/**
 * RulesTab — Always/never rules, escalation
 * Extracted from AssistantEditor.jsx (AUX-1), a11y fixed (AUX-7)
 */

export default function RulesTab({ draft, updateField }) {
  return (
    <div className="editor-section">
      <div className="form-group">
        <label htmlFor="rules-always">ALWAYS Rules (one per line)</label>
        <textarea
          id="rules-always"
          rows={5}
          value={draft.rules.always.join('\n')}
          onChange={(e) => updateField('rules.always',
            e.target.value.split('\n').filter(Boolean)
          )}
        />
      </div>
      <div className="form-group">
        <label htmlFor="rules-never">NEVER Rules (one per line)</label>
        <textarea
          id="rules-never"
          rows={5}
          value={draft.rules.never.join('\n')}
          onChange={(e) => updateField('rules.never',
            e.target.value.split('\n').filter(Boolean)
          )}
        />
      </div>
      <div className="form-group">
        <label htmlFor="rules-escalate-to">Escalate To</label>
        <input
          id="rules-escalate-to"
          type="text"
          value={draft.rules.escalateTo?.agent || ''}
          onChange={(e) => updateField('rules.escalateTo', {
            ...draft.rules.escalateTo,
            agent: e.target.value
          })}
        />
      </div>
      <div className="form-group">
        <label htmlFor="rules-escalate-when">Escalate When (one per line)</label>
        <textarea
          id="rules-escalate-when"
          rows={3}
          value={(draft.rules.escalateTo?.when || []).join('\n')}
          onChange={(e) => updateField('rules.escalateTo', {
            ...draft.rules.escalateTo,
            when: e.target.value.split('\n').filter(Boolean)
          })}
        />
      </div>
    </div>
  )
}
