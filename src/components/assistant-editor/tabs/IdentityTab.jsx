/**
 * IdentityTab — Name, shortName, tagline, description, colours
 * Extracted from AssistantEditor.jsx (AUX-1: zero functional change)
 */

export default function IdentityTab({ draft, updateField, validationErrors }) {
  return (
    <div className="editor-section">
      <div className={`form-group ${validationErrors.name ? 'form-group--error' : ''}`}>
        <label htmlFor="assistant-name">Display Name *</label>
        <input
          id="assistant-name"
          type="text"
          value={draft.identity.name}
          onChange={(e) => {
            updateField('identity.name', e.target.value)
            if (validationErrors.name) {
              // Clear error on change — parent manages validationErrors state
            }
          }}
          aria-invalid={!!validationErrors.name}
          aria-describedby={validationErrors.name ? 'name-error' : undefined}
          placeholder="e.g., QuoxCORE"
          maxLength={50}
        />
        {validationErrors.name && (
          <span className="form-error" id="name-error" role="alert">{validationErrors.name}</span>
        )}
      </div>
      <div className={`form-group ${validationErrors.shortName ? 'form-group--error' : ''}`}>
        <label htmlFor="assistant-shortname">Short Name (1-2 chars) *</label>
        <input
          id="assistant-shortname"
          type="text"
          maxLength={2}
          value={draft.identity.shortName}
          onChange={(e) => {
            updateField('identity.shortName', e.target.value.toUpperCase())
          }}
          aria-invalid={!!validationErrors.shortName}
          aria-describedby={validationErrors.shortName ? 'shortname-error' : undefined}
          placeholder="e.g., M"
        />
        {validationErrors.shortName && (
          <span className="form-error" id="shortname-error" role="alert">{validationErrors.shortName}</span>
        )}
      </div>
      <div className={`form-group ${validationErrors.tagline ? 'form-group--error' : ''}`}>
        <label htmlFor="assistant-tagline">Tagline</label>
        <input
          id="assistant-tagline"
          type="text"
          value={draft.identity.tagline}
          onChange={(e) => {
            updateField('identity.tagline', e.target.value)
          }}
          aria-invalid={!!validationErrors.tagline}
          aria-describedby={validationErrors.tagline ? 'tagline-error' : undefined}
          placeholder="A brief description of this assistant"
          maxLength={100}
        />
        {validationErrors.tagline && (
          <span className="form-error" id="tagline-error" role="alert">{validationErrors.tagline}</span>
        )}
      </div>
      <div className="form-group">
        <label htmlFor="assistant-description">Description</label>
        <textarea
          id="assistant-description"
          rows={3}
          value={draft.identity.description}
          onChange={(e) => updateField('identity.description', e.target.value)}
          placeholder="Detailed description of the assistant's purpose and capabilities"
        />
      </div>
      <div className="form-row">
        <div className="form-group">
          <label htmlFor="identity-color-primary">Primary Color</label>
          <input
            id="identity-color-primary"
            type="color"
            value={draft.identity.color.primary}
            onChange={(e) => updateField('identity.color.primary', e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="identity-color-secondary">Secondary Color</label>
          <input
            id="identity-color-secondary"
            type="color"
            value={draft.identity.color.secondary}
            onChange={(e) => updateField('identity.color.secondary', e.target.value)}
          />
        </div>
      </div>
    </div>
  )
}
