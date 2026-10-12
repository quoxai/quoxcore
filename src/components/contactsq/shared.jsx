/** Small shared pieces: skeleton, unavailable state, error banner, labelled field. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isUnavailable } from './lib/api'
import { explainError } from './lib/reasonCodes'
import { chipClass } from './lib/chips'
import { ChevronDownIcon, PlusIcon, XIcon } from './icons'

export function Skeleton({ rows = 3 }) {
  return (
    <div className="qx-stack qx-stack--tight" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="qx-skeleton qx-skeleton--line-lg" />)}
    </div>
  )
}

export function ErrorBanner({ error, onRetry }) {
  if (!error) return null
  return (
    <div className="qx-banner qx-banner--error" role="alert">
      <span>{explainError(error)}</span>
      {onRetry ? <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onRetry}>Retry</button> : null}
    </div>
  )
}

/** Shows the "not deployed yet" empty state for a 404 route, otherwise the error. */
export function AsyncGuard({ error, loading, onRetry, rows, what, children }) {
  if (loading) return <Skeleton rows={rows} />
  if (isUnavailable(error)) return <Unavailable what={what} />
  if (error) return <ErrorBanner error={error} onRetry={onRetry} />
  return children
}

export function Unavailable({ what = 'This section' }) {
  return (
    <div className="qx-empty">
      <div className="qx-empty__title">{what} is available after the next collector deploy</div>
      <div className="qx-empty__body">The collector you are connected to does not have this endpoint yet. Nothing is lost, it will appear here once it is deployed.</div>
    </div>
  )
}

/** A labelled field. In a .qx-form-grid, span / spanSm set its share of the 12 columns (wide / under 560px). */
/** 12-column proportional form grid: put Fields (with span/spanSm) inside. */
export function FormGrid({ children }) {
  return <div className="qx-form-grid"><div className="qx-form-grid__cells">{children}</div></div>
}

export function Field({ label, hint, children, span, spanSm }) {
  const style = span || spanSm ? { ...(span ? { '--span': span } : {}), ...(spanSm ? { '--span-sm': spanSm } : {}) } : undefined
  return (
    <label className="qx-field" style={style}>
      <span className="qx-field__label">{label}</span>
      {children}
      {hint ? <span className="qx-field__hint">{hint}</span> : null}
    </label>
  )
}

export const fmtDate = (v) => {
  const d = v ? new Date(v) : null
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleString() : '-'
}

/** Where a floating panel goes: under the trigger (or above it when there is no room), aligned to its start or end edge, kept inside the viewport. Pure, unit tested. */
export function placePanel({ rect, panel, viewport, align = 'start', gap = 6, margin = 8 }) {
  const below = viewport.h - rect.bottom - gap - margin
  const above = rect.top - gap - margin
  const openUp = panel.h > below && above > below
  const room = Math.max(120, openUp ? above : below)
  const h = Math.min(panel.h, room)
  const top = openUp ? rect.top - gap - h : rect.bottom + gap
  let left = align === 'end' ? rect.right - panel.w : rect.left
  left = Math.max(margin, Math.min(left, viewport.w - panel.w - margin))
  return { top: Math.round(top), left: Math.round(left), maxHeight: Math.round(room), openUp }
}

/**
 * A button that opens a floating .qx-menu. The panel is portalled to <body> and positioned from the trigger's rect,
 * so no overflow:hidden / scrolling ancestor (the address book panes) can clip it. Closes on outside click, Escape,
 * scroll of the page, or when a menu item calls close(). `children` is a function (close) => menu rows.
 */
export function Popover({ label, icon: Icon, children, align = 'start', buttonClass = 'qx-btn qx-btn--ghost qx-btn--sm', ariaLabel, caret = true }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const ref = useRef(null)
  const panelRef = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (ref.current && ref.current.contains(e.target)) return
      if (panelRef.current && panelRef.current.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false) } }
    const onScroll = (e) => { if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return; setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onScroll)
    }
  }, [open])
  useLayoutEffect(() => {
    if (!open || !ref.current || !panelRef.current) { setPos(null); return }
    const rect = ref.current.getBoundingClientRect()
    const pr = panelRef.current.getBoundingClientRect()
    setPos(placePanel({ rect, panel: { w: pr.width || 240, h: panelRef.current.scrollHeight || pr.height || 0 }, viewport: { w: window.innerWidth, h: window.innerHeight }, align }))
  }, [open, align])
  const close = () => setOpen(false)
  const panel = open ? (
    <div ref={panelRef} className="qx-menu qx-popover__panel qx-popover__panel--float" role="menu"
      style={pos ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight } : { top: 0, left: 0, visibility: 'hidden' }}>
      {children(close)}
    </div>
  ) : null
  return (
    <div className="qx-popover" ref={ref}>
      <button type="button" className={buttonClass} aria-haspopup="menu" aria-expanded={open} aria-label={ariaLabel} onClick={() => setOpen((o) => !o)}>
        {Icon ? <Icon /> : null}{label}{caret ? <ChevronDownIcon /> : null}
      </button>
      {panel ? createPortal(panel, document.body) : null}
    </div>
  )
}

/** A menu row with a title and a one-line explanation underneath. */
export function MenuItem({ title, help, icon: Icon, danger, onClick, disabled }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} className={`qx-menu__item${danger ? ' qx-menu__item--danger' : ''}`} onClick={onClick}>
      {Icon ? <Icon /> : null}
      <span className="qx-menu__item-text">{title}{help ? <small>{help}</small> : null}</span>
    </button>
  )
}

/**
 * Compact multi-select: the chosen values as removable tags plus ONE "Add" menu holding only the
 * options not chosen yet (each with its one-line explanation). `hueOf(key)` makes a tag a glassy
 * coloured .qx-chip--hue-* chip; without it tags use the neutral .qx-tagfield__tag look.
 * options: [{ key, label, help?, group? }]; groups: [{ id, label }] orders/headers the menu.
 */
export function ChoiceTags({ options, values, onChange, addLabel, noun, hueOf, groups, emptyText }) {
  const chosen = options.filter((o) => values.includes(o.key))
  const left = options.filter((o) => !values.includes(o.key))
  const row = (o, close) => <MenuItem key={o.key} title={o.label} help={o.help} onClick={() => { onChange([...values, o.key]); close() }} />
  return (
    <div className="qx-row qx-row--wrap qx-row--tight" style={{ alignItems: 'center' }}>
      {chosen.length === 0 && emptyText ? <span className="qx-hint">{emptyText}</span> : null}
      {chosen.map((o) => {
        const hue = hueOf?.(o.key)
        return (
          <span key={o.key} className={hue ? chipClass(hue, { size: '' }) : 'qx-tagfield__tag'} title={o.help}>
            {o.label}
            <button type="button" className="qx-tagfield__x" aria-label={`Remove ${noun || ''} ${o.label}`.replace('  ', ' ')} onClick={() => onChange(values.filter((x) => x !== o.key))}><XIcon size={10} /></button>
          </span>
        )
      })}
      {left.length ? (
        <Popover label={addLabel} icon={PlusIcon} caret={false}>
          {(close) => (groups
            ? groups.map((g) => {
              const inGroup = left.filter((o) => o.group === g.id)
              return inGroup.length ? <div key={g.id}><div className="qx-menu__header">{g.label}</div>{inGroup.map((o) => row(o, close))}</div> : null
            })
            : left.map((o) => row(o, close)))}
        </Popover>
      ) : null}
    </div>
  )
}

/** Free-form tags: Enter or comma adds, Backspace on an empty box removes the last. */
export function TagInput({ values, onChange, placeholder = 'Add tag', label = 'Add tag' }) {
  const [text, setText] = useState('')
  const commit = () => {
    const parts = text.split(',').map((t) => t.trim()).filter(Boolean).filter((t) => !values.includes(t))
    if (parts.length) onChange([...values, ...parts])
    setText('')
  }
  return (
    <div className="qx-tagfield">
      {values.map((t) => (
        <span key={t} className="qx-tagfield__tag">{t}
          <button type="button" className="qx-tagfield__x" aria-label={`Remove tag ${t}`} onClick={() => onChange(values.filter((x) => x !== t))}><XIcon size={10} /></button>
        </span>
      ))}
      <input className="qx-tagfield__input" value={text} placeholder={placeholder} aria-label={label}
        onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit() }
          else if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1))
        }} />
    </div>
  )
}

/** Flat section inside a panel: heading with its trailing rule, optional right-side action. */
export function Section({ title, action, children, label }) {
  return (
    <section className="qx-stack qx-stack--tight" aria-label={label || title}>
      <div className="qx-row qx-row--apart qx-row--tight" style={{ alignItems: 'center' }}>
        <h3 className="qx-section-title" style={{ margin: 0, flex: 1 }}>{title}</h3>
        {action || null}
      </div>
      {children}
    </section>
  )
}

/** The same header on every non-book tab: icon + title + one line of what this is, optional actions on the right. */
export function TabHeader({ icon: Icon, title, subtitle, action, testId }) {
  return (
    <header className="qx-row qx-row--apart qx-row--wrap cnq-tabhead" style={{ alignItems: 'flex-start' }}>
      <div className="qx-stack qx-stack--tight" style={{ gap: 4, minWidth: 0, flex: 1 }}>
        <h2 className="qx-section-title" style={{ margin: 0 }}>{Icon ? <Icon /> : null}{title}</h2>
        {subtitle ? <p className="qx-hint" style={{ margin: 0 }} data-testid={testId}>{subtitle}</p> : null}
      </div>
      {action || null}
    </header>
  )
}
