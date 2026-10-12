/**
 * PersonalityTab — Enhanced with tone/style presets, trait chips, org voice toggle
 * AUX-3: Replaces the basic text fields with structured personality builder.
 * Backward compatible — saves to same draft.identity.personality fields.
 */

import { useState } from 'react'
import { TONE_PRESETS, STYLE_PRESETS, AVAILABLE_TRAITS, generatePersonalityPrompt } from '../personalityUtils'

export default function PersonalityTab({ draft, updateField }) {
  const personality = draft?.identity?.personality || {}
  const [showPreview, setShowPreview] = useState(true)

  const currentTone = personality.tone || ''
  const currentStyle = personality.style || 'detailed'
  const currentTraits = personality.traits || []
  const isPresetTone = !!TONE_PRESETS[currentTone]

  const toggleTrait = (trait) => {
    const next = currentTraits.includes(trait)
      ? currentTraits.filter(t => t !== trait)
      : [...currentTraits, trait]
    updateField('identity.personality.traits', next)
  }

  const preview = generatePersonalityPrompt(personality)

  return (
    <div className="editor-section">
      {/* Tone */}
      <div className="form-group">
        <label>Tone</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {Object.entries(TONE_PRESETS).map(([key, preset]) => (
            <button
              key={key}
              onClick={() => updateField('identity.personality.tone', key)}
              style={{
                padding: '5px 12px', fontSize: 11, fontWeight: currentTone === key ? 700 : 500,
                background: currentTone === key ? 'rgba(168,85,247,0.12)' : 'rgba(255,255,255,0.03)',
                border: currentTone === key ? '1px solid rgba(168,85,247,0.3)' : '1px solid rgba(255,255,255,0.08)',
                borderRadius: 6, cursor: 'pointer', color: currentTone === key ? '#fff' : 'rgba(255,255,255,0.6)',
                transition: 'all 0.15s', fontFamily: 'inherit',
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
        {/* Custom tone input for non-preset values */}
        {!isPresetTone && currentTone && (
          <input
            type="text"
            value={currentTone}
            onChange={(e) => updateField('identity.personality.tone', e.target.value)}
            placeholder="Custom tone description"
            style={{ marginTop: 4 }}
          />
        )}
        <button
          onClick={() => updateField('identity.personality.tone', isPresetTone ? '' : 'professional')}
          style={{
            fontSize: 10, color: 'rgba(255,255,255,0.6)', background: 'none', border: 'none',
            cursor: 'pointer', padding: '4px 0', fontFamily: 'inherit', textDecoration: 'underline',
          }}
        >
          {isPresetTone ? 'Use custom tone text instead' : 'Use preset'}
        </button>
      </div>

      {/* Style */}
      <div className="form-group">
        <label>Response Style</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {Object.entries(STYLE_PRESETS).map(([key, preset]) => (
            <button
              key={key}
              onClick={() => updateField('identity.personality.style', key)}
              style={{
                padding: '5px 12px', fontSize: 11, fontWeight: currentStyle === key ? 700 : 500,
                background: currentStyle === key ? 'rgba(56,189,248,0.12)' : 'rgba(255,255,255,0.03)',
                border: currentStyle === key ? '1px solid rgba(56,189,248,0.3)' : '1px solid rgba(255,255,255,0.08)',
                borderRadius: 6, cursor: 'pointer', color: currentStyle === key ? '#fff' : 'rgba(255,255,255,0.6)',
                transition: 'all 0.15s', fontFamily: 'inherit',
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Traits */}
      <div className="form-group">
        <label>Personality Traits</label>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {AVAILABLE_TRAITS.map(trait => {
            const active = currentTraits.includes(trait)
            return (
              <button
                key={trait}
                onClick={() => toggleTrait(trait)}
                style={{
                  padding: '4px 10px', fontSize: 10, fontWeight: active ? 600 : 400,
                  background: active ? 'rgba(168,85,247,0.1)' : 'transparent',
                  border: active ? '1px solid rgba(168,85,247,0.25)' : '1px solid rgba(255,255,255,0.06)',
                  borderRadius: 5, cursor: 'pointer', color: active ? '#fff' : 'rgba(255,255,255,0.6)',
                  transition: 'all 0.15s', fontFamily: 'inherit',
                  boxShadow: active ? '0 0 8px rgba(168,85,247,0.1)' : 'none',
                }}
              >
                {trait}
              </button>
            )
          })}
        </div>
      </div>

      {/* Catchphrases */}
      <div className="form-group">
        <label>Catchphrases (one per line)</label>
        <textarea
          rows={3}
          value={(personality.catchphrases || []).join('\n')}
          onChange={(e) => updateField('identity.personality.catchphrases',
            e.target.value.split('\n').filter(Boolean)
          )}
          placeholder='e.g., "Let me look into that for you"'
        />
      </div>

      {/* Org voice toggle */}
      <div style={{
        padding: '10px 0', borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: 8,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <input
          type="checkbox"
          id="use-org-voice"
          checked={draft?._persona?.use_org_voice || false}
          onChange={(e) => updateField('_persona.use_org_voice', e.target.checked)}
          style={{ accentColor: '#a855f7' }}
        />
        <label htmlFor="use-org-voice" style={{
          fontSize: 12, color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontWeight: 400,
          textTransform: 'none', letterSpacing: 0,
        }}>
          Use organisation brand voice
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginLeft: 6 }}>
            (requires VoiceOps plugin)
          </span>
        </label>
      </div>

      {/* Preview */}
      {showPreview && preview && (
        <div style={{
          marginTop: 12, padding: 14, background: 'rgba(0,0,0,0.2)',
          border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10,
        }}>
          <div style={{
            fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.6)',
            textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6,
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            Personality Prompt Preview
          </div>
          <div style={{ fontSize: 12, color: '#fff', lineHeight: 1.6, fontStyle: 'italic' }}>
            {preview}
          </div>
        </div>
      )}
    </div>
  )
}
