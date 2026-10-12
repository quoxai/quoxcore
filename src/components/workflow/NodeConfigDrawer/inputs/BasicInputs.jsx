/**
 * BasicInputs — primitive inputs for SchemaInput. Each component delegates
 * to a global `.qx-*` class from `qx-components.css` so the drawer matches
 * the rest of the dashboard. Custom add-ons (placeholder-token highlighting,
 * URL scheme pill) live in NodeConfigDrawer.css under .ncd-* prefixes.
 *
 * Uniform contract per component:
 *   props: { value, onChange, disabled, autoFocus, options?, placeholder? }
 *   onChange receives the new value (already cast to the right JS type).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { PLACEHOLDER_RE } from '../fieldSchema'

const PLACEHOLDER_GLOBAL = new RegExp(PLACEHOLDER_RE.source, 'g')

function highlightPlaceholders(str) {
  if (typeof str !== 'string' || str === '') return null
  const parts = []
  let lastIndex = 0
  let match
  PLACEHOLDER_GLOBAL.lastIndex = 0
  while ((match = PLACEHOLDER_GLOBAL.exec(str)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<span key={`p-${parts.length}`}>{str.slice(lastIndex, match.index)}</span>)
    }
    parts.push(
      <span key={`m-${parts.length}`} className="ncd-token">
        {match[0]}
      </span>
    )
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < str.length) {
    parts.push(<span key={`p-${parts.length}`}>{str.slice(lastIndex)}</span>)
  }
  return parts
}

export function TextInput({ value, onChange, disabled, autoFocus, placeholder }) {
  return (
    <input
      type="text"
      className="qx-input"
      value={value ?? ''}
      disabled={disabled}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function NumberInput({ value, onChange, disabled, autoFocus, placeholder }) {
  return (
    <input
      type="number"
      className="qx-input"
      value={value ?? ''}
      disabled={disabled}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value
        if (raw === '') return onChange('')
        const n = Number(raw)
        if (Number.isFinite(n)) onChange(n)
      }}
    />
  )
}

export function ToggleInput({ value, onChange, disabled }) {
  const checked = value === true
  return (
    <label className="qx-toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="qx-toggle__track" />
    </label>
  )
}

export function TextAreaInput({ value, onChange, disabled, autoFocus, placeholder }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`
  }, [value])

  const showOverlay = typeof value === 'string' && PLACEHOLDER_RE.test(value)

  return (
    <div className="ncd-textarea-wrap">
      <textarea
        ref={ref}
        className="qx-textarea"
        value={value ?? ''}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        rows={4}
        onChange={(e) => onChange(e.target.value)}
      />
      {showOverlay && (
        <div className="ncd-textarea-wrap__overlay" aria-hidden="true">
          {highlightPlaceholders(value)}
        </div>
      )}
    </div>
  )
}

export function SegmentedControl({ value, onChange, disabled, options = [] }) {
  return (
    <div className="qx-seg" role="radiogroup">
      {options.map((opt) => {
        const id = typeof opt === 'string' ? opt : opt.id
        const label = typeof opt === 'string' ? opt : opt.label
        const active = value === id
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            className={`qx-seg__btn ${active ? 'qx-seg__btn--active' : ''}`}
            onClick={() => onChange(id)}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

export function DropdownInput({ value, onChange, disabled, options = [] }) {
  return (
    <select
      className="qx-select"
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {(value === undefined || value === '') && (
        <option value="" disabled>Select…</option>
      )}
      {options.map((opt) => {
        const id = typeof opt === 'string' ? opt : opt.id
        const label = typeof opt === 'string' ? opt : opt.label
        return <option key={id} value={id}>{label}</option>
      })}
    </select>
  )
}

export function TagInput({ value, onChange, disabled, placeholder }) {
  const arr = Array.isArray(value) ? value : []
  const [draft, setDraft] = useState('')

  const commit = useCallback(() => {
    const trimmed = draft.trim()
    if (!trimmed) return
    if (arr.includes(trimmed)) { setDraft(''); return }
    onChange([...arr, trimmed])
    setDraft('')
  }, [draft, arr, onChange])

  const remove = (tag) => onChange(arr.filter((t) => t !== tag))

  return (
    <div className={`qx-tagfield ${disabled ? 'qx-tagfield--disabled' : ''}`}>
      {arr.map((tag) => (
        <span key={tag} className="qx-tagfield__tag">
          <span>{tag}</span>
          {!disabled && (
            <button type="button" className="qx-tagfield__x" onClick={() => remove(tag)} aria-label={`Remove ${tag}`}>
              ×
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          type="text"
          className="qx-tagfield__input"
          value={draft}
          placeholder={placeholder || 'Add…'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Backspace' && draft === '' && arr.length) {
              remove(arr[arr.length - 1])
            }
          }}
          onBlur={commit}
        />
      )}
    </div>
  )
}

export function URLInput({ value, onChange, disabled, autoFocus, placeholder }) {
  const str = typeof value === 'string' ? value : ''
  const scheme = (() => {
    const m = str.match(/^(https?|ws|wss|file):/i)
    return m ? m[1].toLowerCase() : null
  })()

  return (
    <div className="ncd-url">
      <input
        type="text"
        className="qx-input qx-input--mono"
        value={str}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder || 'https://…  or  /path/{{PARAM}}'}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      {scheme && <span className={`ncd-url__scheme ncd-url__scheme--${scheme}`}>{scheme}</span>}
      {PLACEHOLDER_RE.test(str) && (
        <div className="ncd-url__overlay" aria-hidden="true">
          {highlightPlaceholders(str)}
        </div>
      )}
    </div>
  )
}

export function ExpressionInput({ value, onChange, disabled, autoFocus, placeholder }) {
  const str = typeof value === 'string' ? value : (value == null ? '' : String(value))
  return (
    <div className="ncd-expression">
      <input
        type="text"
        className="qx-input qx-input--mono"
        value={str}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder || '$input.field  or  {{TOKEN}}'}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      {PLACEHOLDER_RE.test(str) && (
        <div className="ncd-expression__overlay" aria-hidden="true">
          {highlightPlaceholders(str)}
        </div>
      )}
    </div>
  )
}
