import { useEffect, useState } from 'react';
import { onToast } from '../lib/toastBus.js';

/**
 * Mounted once in AppShell (alongside CommandPalette). Renders every
 * mutation-error/success toast fired via lib/toastBus.js. Read mode never
 * triggers a toast since it never mutates.
 */
export default function ToastStack() {
  const [toasts, setToasts] = useState([]);

  useEffect(
    () =>
      onToast((toast) => {
        setToasts((list) => [...list, toast]);
        if (toast.timeout) {
          setTimeout(() => {
            setToasts((list) => list.filter((t) => t.id !== toast.id));
          }, toast.timeout);
        }
      }),
    []
  );

  function dismiss(id) {
    setToasts((list) => list.filter((t) => t.id !== id));
  }

  if (toasts.length === 0) return null;

  return (
    <div className="qx-toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`qx-toast qx-toast--${t.variant}`}>
          <div className="qx-toast__body">
            {t.title && <div className="qx-toast__title">{t.title}</div>}
            <div className="qx-toast__msg">{t.message}</div>
          </div>
          <button type="button" className="qx-toast__close" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
