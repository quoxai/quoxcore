/** A tiny local toast stack for ContactsQ ("Copied"). Global .qx-toast markup; no persistence, no provider needed to render a component. */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { AlertIcon, CheckIcon } from './icons'

const ToastCtx = createContext(null)
const SHOW_MS = 2200

export function ToastProvider({ children }) {
  const [items, setItems] = useState([])
  const seq = useRef(0)
  const timers = useRef(new Set())
  const toast = useCallback((message, { title, variant = 'success' } = {}) => {
    const id = ++seq.current
    setItems((l) => [...l.slice(-2), { id, message, title, variant }])
    const t = setTimeout(() => { timers.current.delete(t); setItems((l) => l.filter((x) => x.id !== id)) }, SHOW_MS)
    timers.current.add(t)
  }, [])
  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current.clear() }, [])
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="qx-toast-stack" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`qx-toast qx-toast--${t.variant}`} style={{ '--qx-toast-accent': t.variant === 'warn' ? '#fbbf24' : '#34d399' }}>
            {t.variant === 'warn' ? <AlertIcon size={20} /> : <CheckIcon size={20} />}
            <div className="qx-toast__body">
              {t.title ? <div className="qx-toast__title">{t.title}</div> : null}
              <div className={t.title ? 'qx-toast__msg' : 'qx-toast__title'}>{t.message}</div>
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

/** toast(message, { title?, variant: 'success' | 'warn' }). A no-op outside a provider, so a component never crashes for lack of one. */
export function useToast() {
  return useContext(ToastCtx) || (() => {})
}
