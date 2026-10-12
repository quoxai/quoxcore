/**
 * Input Components
 *
 * A collection of form input components with consistent styling.
 *
 * @example
 * // Basic input
 * <Input placeholder="Enter name" value={name} onChange={e => setName(e.target.value)} />
 *
 * // Input with icon
 * <Input icon={<SearchIcon />} placeholder="Search..." />
 *
 * // Input with error state
 * <Input error placeholder="Invalid input" />
 *
 * // Textarea
 * <Textarea rows={4} placeholder="Enter description..." />
 *
 * // Select
 * <Select value={selected} onChange={e => setSelected(e.target.value)}>
 *   <option value="opt1">Option 1</option>
 *   <option value="opt2">Option 2</option>
 * </Select>
 */

import { forwardRef } from 'react'

/**
 * Input - Standard text input
 *
 * Props:
 * - size: 'sm' | 'md' | 'lg'
 * - error: boolean
 * - success: boolean
 * - icon: ReactNode - Left-aligned icon
 * - mono: boolean - Use monospace font
 * - className: string
 */
export const Input = forwardRef(function Input(
  {
    size = 'md',
    error = false,
    success = false,
    icon,
    mono = false,
    className = '',
    ...props
  },
  ref
) {
  const classes = [
    'ui-input',
    size !== 'md' && `ui-input-${size}`,
    error && 'ui-input-error',
    success && 'ui-input-success',
    mono && 'ui-input-mono',
    className
  ].filter(Boolean).join(' ')

  if (icon) {
    return (
      <div className="ui-input-group">
        <span className="ui-input-icon">{icon}</span>
        <input ref={ref} className={classes} {...props} />
      </div>
    )
  }

  return <input ref={ref} className={classes} {...props} />
})

/**
 * Textarea - Multi-line text input
 */
export const Textarea = forwardRef(function Textarea(
  {
    size = 'md',
    error = false,
    success = false,
    mono = false,
    className = '',
    ...props
  },
  ref
) {
  const classes = [
    'ui-input',
    'ui-textarea',
    size !== 'md' && `ui-input-${size}`,
    error && 'ui-input-error',
    success && 'ui-input-success',
    mono && 'ui-input-mono',
    className
  ].filter(Boolean).join(' ')

  return (
    <textarea
      ref={ref}
      className={classes}
      style={{
        resize: 'vertical',
        minHeight: '80px'
      }}
      {...props}
    />
  )
})

/**
 * Select - Dropdown select input
 */
export const Select = forwardRef(function Select(
  {
    size = 'md',
    error = false,
    className = '',
    children,
    ...props
  },
  ref
) {
  const classes = [
    'ui-input',
    'ui-select',
    size !== 'md' && `ui-input-${size}`,
    error && 'ui-input-error',
    className
  ].filter(Boolean).join(' ')

  return (
    <select ref={ref} className={classes} {...props}>
      {children}
    </select>
  )
})

/**
 * FormField - Wrapper for form inputs with label and error message
 *
 * @example
 * <FormField label="Email" error="Invalid email address" required>
 *   <Input type="email" error />
 * </FormField>
 */
export function FormField({
  label,
  htmlFor,
  error,
  hint,
  required = false,
  className = '',
  children
}) {
  return (
    <div className={`ui-form-field ${className}`} style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--ui-space-2, 0.5rem)'
    }}>
      {label && (
        <label
          htmlFor={htmlFor}
          style={{
            fontSize: 'var(--ui-text-sm, 0.75rem)',
            fontWeight: 500,
            color: 'var(--ui-text-secondary)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--ui-space-1, 0.25rem)'
          }}
        >
          {label}
          {required && (
            <span style={{ color: 'var(--ui-red)' }}>*</span>
          )}
        </label>
      )}
      {children}
      {error && (
        <span style={{
          fontSize: 'var(--ui-text-xs, 0.65rem)',
          color: 'var(--ui-red-light, #ff6060)'
        }}>
          {error}
        </span>
      )}
      {hint && !error && (
        <span style={{
          fontSize: 'var(--ui-text-xs, 0.65rem)',
          color: 'var(--ui-text-muted)'
        }}>
          {hint}
        </span>
      )}
    </div>
  )
}

/**
 * SearchInput - Specialized search input with icon
 */
export const SearchInput = forwardRef(function SearchInput(
  { className = '', ...props },
  ref
) {
  return (
    <Input
      ref={ref}
      icon={
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      }
      type="search"
      className={className}
      {...props}
    />
  )
})

/**
 * CodeInput - Monospace input for codes, IDs, etc.
 */
export const CodeInput = forwardRef(function CodeInput(
  { className = '', ...props },
  ref
) {
  return (
    <Input
      ref={ref}
      mono
      className={className}
      style={{
        textTransform: 'uppercase',
        letterSpacing: '2px',
        textAlign: 'center'
      }}
      {...props}
    />
  )
})

/**
 * Checkbox - Styled checkbox input
 */
export const Checkbox = forwardRef(function Checkbox(
  {
    label,
    description,
    className = '',
    ...props
  },
  ref
) {
  const id = props.id || `checkbox-${Math.random().toString(36).substr(2, 9)}`

  if (label || description) {
    return (
      <label className={`ui-checkbox ${className}`} htmlFor={id}>
        <input
          ref={ref}
          type="checkbox"
          id={id}
          className="ui-checkbox-input"
          {...props}
        />
        <div>
          {label && <span className="ui-checkbox-label">{label}</span>}
          {description && <span className="ui-field-description">{description}</span>}
        </div>
      </label>
    )
  }

  return (
    <input
      ref={ref}
      type="checkbox"
      id={id}
      className={`ui-checkbox-input ${className}`}
      {...props}
    />
  )
})

/**
 * Toggle - Switch toggle input
 *
 * @example
 * <Toggle checked={enabled} onChange={e => setEnabled(e.target.checked)} label="Enable feature" />
 */
export const Toggle = forwardRef(function Toggle(
  {
    label,
    description,
    size = 'md',
    className = '',
    ...props
  },
  ref
) {
  const id = props.id || `toggle-${Math.random().toString(36).substr(2, 9)}`
  const sizeClass = size === 'sm' ? 'ui-toggle-sm' : ''

  return (
    <label className={`ui-toggle ${sizeClass} ${className}`} htmlFor={id}>
      <input
        ref={ref}
        type="checkbox"
        id={id}
        className="ui-toggle-input"
        {...props}
      />
      <span className="ui-toggle-track">
        <span className="ui-toggle-thumb" />
      </span>
      {(label || description) && (
        <div>
          {label && <span className="ui-toggle-label">{label}</span>}
          {description && <span className="ui-field-description">{description}</span>}
        </div>
      )}
    </label>
  )
})

/**
 * SettingItem - Toggle/Checkbox with label and description in a card-like container
 *
 * @example
 * <SettingItem
 *   label="Enable notifications"
 *   description="Receive alerts and updates"
 *   checked={settings.notifications}
 *   onChange={e => updateSetting('notifications', e.target.checked)}
 * />
 */
export function SettingItem({
  label,
  description,
  checked,
  onChange,
  disabled = false,
  type = 'toggle', // 'toggle' or 'checkbox'
  className = ''
}) {
  const id = `setting-${Math.random().toString(36).substr(2, 9)}`

  return (
    <div className={`ui-setting-item ${className}`}>
      <div className="ui-setting-info">
        <label htmlFor={id} className="ui-setting-label">{label}</label>
        {description && <p className="ui-setting-description">{description}</p>}
      </div>
      {type === 'toggle' ? (
        <Toggle
          id={id}
          checked={checked}
          onChange={onChange}
          disabled={disabled}
        />
      ) : (
        <Checkbox
          id={id}
          checked={checked}
          onChange={onChange}
          disabled={disabled}
        />
      )}
    </div>
  )
}

/**
 * RadioGroup - Group of radio buttons
 */
export function RadioGroup({
  name,
  value,
  onChange,
  options = [],
  variant = 'default', // 'default' or 'cards'
  horizontal = false,
  className = ''
}) {
  const groupClass = horizontal ? 'ui-radio-group ui-radio-group-horizontal' : 'ui-radio-group'

  if (variant === 'cards') {
    return (
      <div className={`${groupClass} ${className}`}>
        {options.map(opt => (
          <label key={opt.value} className="ui-radio-option">
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={value === opt.value}
              onChange={e => onChange?.(e.target.value)}
              className="ui-radio-input"
            />
            <div className="ui-radio-option-content">
              <div className="ui-radio-option-title">{opt.label}</div>
              {opt.description && (
                <div className="ui-radio-option-desc">{opt.description}</div>
              )}
            </div>
          </label>
        ))}
      </div>
    )
  }

  return (
    <div className={`${groupClass} ${className}`}>
      {options.map(opt => (
        <label key={opt.value} className="ui-radio">
          <input
            type="radio"
            name={name}
            value={opt.value}
            checked={value === opt.value}
            onChange={e => onChange?.(e.target.value)}
            className="ui-radio-input"
          />
          <span className="ui-radio-label">{opt.label}</span>
        </label>
      ))}
    </div>
  )
}

/**
 * Alert - Feedback message component
 */
export function Alert({
  variant = 'info', // 'error' | 'success' | 'warning' | 'info'
  children,
  className = ''
}) {
  return (
    <div className={`ui-alert ui-alert-${variant} ${className}`}>
      {children}
    </div>
  )
}

export default Input
